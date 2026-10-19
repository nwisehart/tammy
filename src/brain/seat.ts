// The seat: Claude through the Claude subscription signed in on this host
// with `claude /login`, by way of the Claude Agent SDK. Every message runs
// the `claude` CLI as a child process; the CLI runs the tool loop and calls
// Tammy's tools back through an in-process MCP server.
//
// The CLI is a coding agent, so this file takes everything else away from
// it. No built-in tool is available (`tools: []`) and every one is also
// disallowed by name; only the tools this turn is offered are allowed; and
// `canUseTool` denies anything else that asks. The CLI starts in an empty
// directory with no settings sources and no MCP config but Tammy's, so no
// CLAUDE.md, project settings, hooks or plugins load, and it saves no
// session transcript. A prompt injection in a customer's message can reach
// Tammy's four tools and nothing on the host.

import { mkdirSync } from 'node:fs';

import type Anthropic from '@anthropic-ai/sdk';
import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  Options,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { seatEnv, type SeatConfig } from '../config.js';
import { silentLogger, type Logger } from '../log.js';
import { findExecutable } from './claude-cli.js';
import { CLASSIFIER_TEXT_PROMPT } from './prompts.js';
import {
  NO_USAGE,
  ProviderUnavailableError,
  type Answer,
  type AnswerRequest,
  type ClassifyRequest,
  type CompleteRequest,
  type LlmProvider,
  type UnavailableReason,
  type Usage,
} from './provider.js';

/** The MCP server name: Tammy's tools reach the model as `mcp__tammy__…`. */
export const MCP_SERVER = 'tammy';

export const mcpToolName = (name: string) => `mcp__${MCP_SERVER}__${name}`;

/**
 * Built-in tools disallowed by name, on top of `tools: []` and whatever
 * the SDK's own BUILTIN_TOOL_NAMES lists. Older names for the same tools
 * are included so an older CLI cannot offer them either.
 */
export const DISALLOWED_BUILTINS = [
  'Agent',
  'Bash',
  'BashOutput',
  'Edit',
  'Glob',
  'Grep',
  'KillBash',
  'KillShell',
  'LS',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'PowerShell',
  'Read',
  'Skill',
  'SlashCommand',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
] as const;

/** The parts of the Agent SDK the seat uses; tests pass a fake. */
export interface AgentSdk {
  query(params: {
    prompt: string;
    options: Options;
  }): AsyncIterable<SDKMessage>;
  createSdkMcpServer: typeof ClaudeAgentSdk.createSdkMcpServer;
  tool: typeof ClaudeAgentSdk.tool;
  BUILTIN_TOOL_NAMES?: readonly string[];
}

export interface SeatProviderOptions {
  seat: SeatConfig;
  /** The environment the CLI's is built from (Tammy's secrets removed). */
  env?: NodeJS.ProcessEnv;
  /** The Agent SDK; loaded on first use when not given. */
  sdk?: AgentSdk;
  findBinary?: (binary: string, env: NodeJS.ProcessEnv) => string | null;
  log?: Logger;
}

interface JsonSchema {
  type?: string;
  description?: string;
  enum?: string[];
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

function toZod(schema: JsonSchema): z.ZodType {
  let out: z.ZodType;
  switch (schema.type) {
    case 'string':
      out = schema.enum?.length
        ? z.enum(schema.enum as [string, ...string[]])
        : z.string();
      break;
    case 'number':
      out = z.number();
      break;
    case 'integer':
      out = z.number().int();
      break;
    case 'boolean':
      out = z.boolean();
      break;
    case 'array': {
      let array = z.array(toZod(schema.items ?? {}));
      if (schema.minItems !== undefined) array = array.min(schema.minItems);
      if (schema.maxItems !== undefined) array = array.max(schema.maxItems);
      out = array;
      break;
    }
    case 'object':
      out = z.object(zodShape(schema));
      break;
    default:
      out = z.unknown();
  }
  return schema.description ? out.describe(schema.description) : out;
}

/**
 * A tool's input schema as the zod shape the SDK's `tool()` takes, built
 * from the same definition the API path sends, so the two cannot drift.
 */
export function zodShape(
  schema: Anthropic.Messages.Tool['input_schema'] | JsonSchema
): Record<string, z.ZodType> {
  const s = schema as JsonSchema;
  const required = new Set(s.required ?? []);
  return Object.fromEntries(
    Object.entries(s.properties ?? {}).map(([key, value]) => {
      const type = toZod(value);
      return [key, required.has(key) ? type : type.optional()];
    })
  );
}

/**
 * The thread as one prompt: the CLI takes a single user message, so the
 * earlier turns are written out in order, each marked with who wrote it.
 */
export function transcript(
  messages: Anthropic.Messages.MessageParam[]
): string {
  const body = messages
    .map((m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .filter((b): b is Anthropic.Messages.TextBlockParam =>
                Boolean(b && b.type === 'text')
              )
              .map((b) => b.text)
              .join('\n');
      const tag = m.role === 'user' ? 'them' : 'tammy';
      const clean = text.replace(/<\/?(?:them|tammy)>/gi, '');
      return `<${tag}>\n${clean.trim()}\n</${tag}>`;
    })
    .join('\n\n');
  return `The Slack thread so far, oldest first. <tammy> messages are yours; <them> messages are from the person you are helping. Reply to their latest message.\n\n${body}`;
}

const SIGNED_OUT =
  /not logged in|please run \/login|claude \/login|run \/login|invalid api key|oauth token (?:has )?(?:expired|revoked)|authentication[_ ]failed|log in again/i;
const USAGE_LIMIT =
  /you've hit your|you've reached your|usage limit|limit reached|out of (?:extra )?usage|usage credits|rate[_ ]limit|session limit|weekly limit/i;
const BINARY_MISSING =
  /executable not found|native binary not found|spawn \S+ ENOENT|\bENOENT\b/i;

/**
 * Why the seat cannot answer, when it is something a person has to fix:
 * from the CLI's error text and the SDK's error codes. Null for anything
 * else (a transient error is an ordinary failure).
 */
export function detectUnavailable(
  text: string,
  codes: readonly string[] = []
): UnavailableReason | null {
  if (BINARY_MISSING.test(text)) return 'binary_missing';
  if (
    codes.some(
      (c) => c === 'authentication_failed' || c === 'oauth_org_not_allowed'
    ) ||
    SIGNED_OUT.test(text)
  ) {
    return 'signed_out';
  }
  if (
    codes.some((c) => c === 'rate_limit' || c === 'billing_error') ||
    USAGE_LIMIT.test(text)
  ) {
    return 'usage_limit';
  }
  return null;
}

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function usageOf(result: Extract<SDKMessage, { type: 'result' }>): Usage {
  return {
    inputTokens:
      (result.usage?.input_tokens ?? 0) +
      (result.usage?.cache_read_input_tokens ?? 0) +
      (result.usage?.cache_creation_input_tokens ?? 0),
    outputTokens: result.usage?.output_tokens ?? 0,
    costUsd: result.total_cost_usd ?? 0,
  };
}

interface Run {
  text: string;
  /** Text the model wrote alongside the call that ended the turn. */
  lead: string;
  usage: Usage;
}

export class SeatProvider implements LlmProvider {
  readonly name = 'seat' as const;
  private readonly log: Logger;
  private sdk: Promise<AgentSdk> | undefined;

  constructor(private readonly options: SeatProviderOptions) {
    this.log = options.log ?? silentLogger;
  }

  async classify(request: ClassifyRequest) {
    const run = await this.run(transcript(request.messages), {
      model: request.model,
      system: CLASSIFIER_TEXT_PROMPT,
      maxTurns: 1,
    });
    const kind = /\b(question|problem_report|other)\b/i
      .exec(run.text)?.[1]
      ?.toLowerCase();
    return { kind: kind ?? run.text.trim(), usage: run.usage };
  }

  async complete(request: CompleteRequest): Promise<string> {
    const run = await this.run(request.prompt, {
      model: request.model,
      system: request.system,
      maxTurns: 1,
    });
    return run.text;
  }

  async answer(request: AnswerRequest): Promise<Answer> {
    const sdk = await this.load();
    let ended: string | undefined;
    const server = sdk.createSdkMcpServer({
      name: MCP_SERVER,
      version: '1.0.0',
      tools: request.tools.map((t) =>
        sdk.tool(
          t.name,
          t.description ?? '',
          zodShape(t.input_schema),
          async (args) => {
            const outcome = await request.runTool({
              name: t.name,
              input: args,
            });
            if (outcome.endsTurn !== undefined) ended ??= outcome.endsTurn;
            return {
              content: [{ type: 'text' as const, text: outcome.content }],
              ...(outcome.isError ? { isError: true } : {}),
            };
          }
        )
      ),
    });
    const run = await this.run(
      transcript(request.messages),
      {
        model: request.model,
        system: request.system,
        maxTurns: this.options.seat.maxTurns,
        tools: request.tools.map((t) => mcpToolName(t.name)),
        mcpServers: { [MCP_SERVER]: server },
      },
      { ended: () => ended, endingTool: mcpToolName('ask_customer') }
    );
    if (ended !== undefined) {
      return {
        text: run.lead ? `${run.lead}\n\n${ended}` : ended,
        endedByTool: true,
        usage: run.usage,
      };
    }
    return { text: run.text, endedByTool: false, usage: run.usage };
  }

  private load(): Promise<AgentSdk> {
    this.sdk ??= this.options.sdk
      ? Promise.resolve(this.options.sdk)
      : import('@anthropic-ai/claude-agent-sdk').then((m): AgentSdk => m);
    return this.sdk;
  }

  /** The `claude` CLI's absolute path, or why there is none. */
  private binary(env: NodeJS.ProcessEnv): string {
    const find = this.options.findBinary ?? findExecutable;
    const found = find(this.options.seat.claudeBinary, env);
    if (found) return found;
    throw this.unavailable(
      'binary_missing',
      `${this.options.seat.claudeBinary} not found`
    );
  }

  private unavailable(
    reason: UnavailableReason,
    detail: string
  ): ProviderUnavailableError {
    const seat = this.options.seat;
    switch (reason) {
      case 'signed_out':
        return new ProviderUnavailableError(
          reason,
          `the Claude seat is not signed in (${detail})`,
          `Run \`${seat.claudeConfigDir ? `CLAUDE_CONFIG_DIR=${seat.claudeConfigDir} ` : ''}claude /login\` on the Tammy host as the user Tammy runs as.`
        );
      case 'usage_limit':
        return new ProviderUnavailableError(
          reason,
          `the Claude seat's usage limit is reached (${detail})`,
          'Tammy answers again when the usage window resets; set [brain] provider = "api" if she must not pause.'
        );
      case 'binary_missing':
        return new ProviderUnavailableError(
          reason,
          `the claude CLI is missing (${detail})`,
          'Install Claude Code on the Tammy host, or set [brain] claude_binary to its path.'
        );
    }
  }

  /** The SDK options every seat query uses: the sandbox, in one place. */
  private queryOptions(input: {
    binary: string;
    env: Record<string, string>;
    model: string;
    system: string;
    maxTurns: number;
    tools: string[];
    mcpServers: Options['mcpServers'];
    abortController: AbortController;
    onStderr: (data: string) => void;
    builtins: readonly string[];
  }): Options {
    const allowed = new Set(input.tools);
    const canUseTool: CanUseTool = async (toolName, toolInput) =>
      allowed.has(toolName)
        ? { behavior: 'allow', updatedInput: toolInput }
        : {
            behavior: 'deny',
            message: `${toolName} is not available to Tammy.`,
          };
    return {
      model: input.model,
      systemPrompt: input.system,
      pathToClaudeCodeExecutable: input.binary,
      cwd: this.options.seat.cwd,
      env: input.env,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: input.mcpServers,
      tools: [],
      allowedTools: [...allowed],
      disallowedTools: [
        ...new Set([...DISALLOWED_BUILTINS, ...input.builtins]),
      ],
      permissionMode: 'default',
      canUseTool,
      maxTurns: input.maxTurns,
      persistSession: false,
      abortController: input.abortController,
      stderr: input.onStderr,
    };
  }

  /**
   * One query: streams the CLI's messages, keeps the final answer and the
   * usage, and turns the failures a person has to fix into
   * ProviderUnavailableError. With `watch`, stops the CLI as soon as the
   * turn-ending tool has run.
   */
  private async run(
    prompt: string,
    request: {
      model: string;
      system: string;
      maxTurns: number;
      tools?: string[];
      mcpServers?: Options['mcpServers'];
    },
    watch?: { ended: () => string | undefined; endingTool: string }
  ): Promise<Run> {
    const sdk = await this.load();
    const env = seatEnv(this.options.seat, this.options.env ?? process.env);
    const binary = this.binary(env);
    mkdirSync(this.options.seat.cwd, { recursive: true });

    let stderr = '';
    const abortController = new AbortController();
    const options = this.queryOptions({
      binary,
      env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'tammy' },
      model: request.model,
      system: request.system,
      maxTurns: request.maxTurns,
      tools: request.tools ?? [],
      mcpServers: request.mcpServers ?? {},
      abortController,
      onStderr: (data) => {
        stderr = (stderr + data).slice(-2000);
      },
      builtins: sdk.BUILTIN_TOOL_NAMES ?? [],
    });

    // Text by API message id: a streamed message can arrive a block at a time.
    const texts = new Map<string, string[]>();
    let lastId: string | undefined;
    let endingId: string | undefined;
    const signals: string[] = [];
    const codes: string[] = [];
    let usage = NO_USAGE;
    let result: string | undefined;
    const textFor = (id: string | undefined) =>
      (id ? (texts.get(id) ?? []) : []).join('\n').trim();

    try {
      for await (const message of sdk.query({ prompt, options })) {
        if (message.type === 'assistant' && !message.parent_tool_use_id) {
          const id = message.message.id ?? message.uuid;
          lastId = id;
          for (const block of message.message.content) {
            if (block.type === 'text') {
              texts.set(id, [...(texts.get(id) ?? []), block.text]);
            } else if (
              block.type === 'tool_use' &&
              watch &&
              block.name === watch.endingTool
            ) {
              endingId = id;
            }
          }
          if (message.error) {
            codes.push(message.error);
            signals.push(textFor(id));
          }
        } else if (
          message.type === 'rate_limit_event' &&
          message.rate_limit_info.status === 'rejected'
        ) {
          const resets = message.rate_limit_info.resetsAt;
          codes.push('rate_limit');
          signals.push(
            `usage limit reached${resets ? `, resets ${new Date(resets * 1000).toISOString()}` : ''}`
          );
        } else if (message.type === 'result') {
          usage = usageOf(message);
          if (message.subtype === 'success' && !message.is_error) {
            result = message.result;
          } else if (message.subtype === 'error_max_turns') {
            this.log.warn(
              `the seat used all ${request.maxTurns} turn(s) without answering`
            );
            result = '';
          } else {
            const failure =
              message.subtype === 'success'
                ? message.result
                : message.errors?.join('; ') || message.subtype;
            signals.push(failure);
            throw new Error(`claude: ${excerpt(failure)}`);
          }
        }
        if (watch?.ended() !== undefined && endingId !== undefined) {
          abortController.abort();
          break;
        }
      }
    } catch (error) {
      if (watch?.ended() === undefined) {
        if (error instanceof ProviderUnavailableError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const reason = detectUnavailable(
          [message, ...signals, stderr].join('\n'),
          codes
        );
        if (reason) {
          const detail =
            [...signals, message].find((s) => detectUnavailable(s, [])) ??
            signals.find(Boolean) ??
            message;
          throw this.unavailable(reason, excerpt(detail));
        }
        throw error;
      }
    }
    // A rejected usage window can still end in an empty "success".
    if (result === undefined || (!result && codes.length)) {
      const reason = detectUnavailable(signals.join('\n'), codes);
      if (reason) {
        throw this.unavailable(
          reason,
          excerpt(signals.find(Boolean) ?? reason)
        );
      }
    }
    return {
      text: (result ?? textFor(lastId)).trim(),
      lead: textFor(endingId),
      usage,
    };
  }
}

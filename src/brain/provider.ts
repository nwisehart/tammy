// How Tammy reaches Claude. The brain decides what a turn needs (the
// classification, the persona, which tools, what each tool does); a provider
// only carries that to a model and back. There are two:
//
// - ApiProvider: the Messages API with ANTHROPIC_API_KEY. Tammy runs the tool
//   loop herself, one request per round.
// - SeatProvider (seat.ts): a Claude subscription signed in with
//   `claude /login`, through the Claude Agent SDK. The `claude` CLI runs the
//   tool loop and calls Tammy's tools back in-process.

import type Anthropic from '@anthropic-ai/sdk';

import { CLASSIFIER_PROMPT, CLASSIFY_TOOL } from './prompts.js';

export type ProviderName = 'api' | 'seat';

/** The slice of the Anthropic SDK Tammy uses; tests pass a fake. */
export interface MessagesClient {
  messages: {
    create(
      params: Anthropic.Messages.MessageCreateParamsNonStreaming
    ): Promise<Anthropic.Messages.Message>;
  };
}

/** A tool call the model made, by Tammy's own tool name. */
export interface ToolCall {
  name: string;
  input: unknown;
}

/** What running one tool hands back to the model. */
export interface ToolOutcome {
  content: string;
  isError?: boolean;
  /**
   * Set when the tool ends the turn (ask_customer): the text to post. The
   * provider stops the model and returns it, after any text the model wrote
   * alongside the call.
   */
  endsTurn?: string;
}

/** Runs one tool call with the brain's handlers; never throws. */
export type RunTool = (call: ToolCall) => Promise<ToolOutcome>;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** The estimated cost, when the provider reports one (the seat does). */
  costUsd?: number;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  if (a.costUsd !== undefined || b.costUsd !== undefined) {
    out.costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  }
  return out;
}

export function describeUsage(u: Usage): string {
  const cost = u.costUsd !== undefined ? `, ~$${u.costUsd.toFixed(4)}` : '';
  return `${u.inputTokens} in / ${u.outputTokens} out tokens${cost}`;
}

export interface ClassifyRequest {
  model: string;
  /** The thread, as alternating user/assistant messages. */
  messages: Anthropic.Messages.MessageParam[];
}

export interface AnswerRequest {
  model: string;
  /** Tammy's persona prompt for this turn. */
  system: string;
  messages: Anthropic.Messages.MessageParam[];
  /** The tools this turn is offered; nothing else may run. */
  tools: Anthropic.Messages.Tool[];
  maxTokens: number;
  maxToolRounds: number;
  runTool: RunTool;
}

export interface Answer {
  /** The reply; empty when the model gave none. */
  text: string;
  /** True when a tool ended the turn and `text` is what it posted. */
  endedByTool: boolean;
  usage: Usage;
}

export interface CompleteRequest {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface LlmProvider {
  readonly name: ProviderName;
  /** The classifier's answer, unchecked: the brain validates it. */
  classify(
    request: ClassifyRequest
  ): Promise<{ kind: string | undefined; usage: Usage }>;
  /** One turn: the model's tool loop until it answers. */
  answer(request: AnswerRequest): Promise<Answer>;
  /** One tool-less completion (the plain-English report). */
  complete(request: CompleteRequest): Promise<string>;
}

export type UnavailableReason = 'signed_out' | 'usage_limit' | 'binary_missing';

/**
 * Claude cannot be reached for a reason a person has to fix (a login, a
 * usage window, a missing CLI). The brain answers with a holding reply and
 * tells the team; anything else that fails is an ordinary error.
 */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly reason: UnavailableReason,
    message: string,
    /** What the team should do about it. */
    readonly action: string
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

function textOf(message: Anthropic.Messages.Message): string {
  return message.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function usageOf(message: Anthropic.Messages.Message): Usage {
  return {
    inputTokens: message.usage?.input_tokens ?? 0,
    outputTokens: message.usage?.output_tokens ?? 0,
  };
}

/** The Messages API with an API key: Tammy runs the tool loop. */
export class ApiProvider implements LlmProvider {
  readonly name = 'api' as const;

  constructor(private readonly client: MessagesClient) {}

  async classify(request: ClassifyRequest) {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: 200,
      system: CLASSIFIER_PROMPT,
      messages: request.messages,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: CLASSIFY_TOOL.name },
    });
    const call = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
    );
    return {
      kind: (call?.input as { kind?: string } | undefined)?.kind,
      usage: usageOf(response),
    };
  }

  async answer(request: AnswerRequest): Promise<Answer> {
    const messages = [...request.messages];
    const rounds = request.maxToolRounds;
    let usage = NO_USAGE;
    for (let round = 0; round <= rounds; round++) {
      // The last round offers no tools, so the model has to answer.
      const offer = round < rounds ? request.tools : [];
      const response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages,
        ...(offer.length ? { tools: offer } : {}),
      });
      usage = addUsage(usage, usageOf(response));
      const calls = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
      );
      if (response.stop_reason !== 'tool_use' || calls.length === 0) {
        return { text: textOf(response), endedByTool: false, usage };
      }

      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const outcome = await request.runTool({
          name: call.name,
          input: call.input,
        });
        if (outcome.endsTurn !== undefined) {
          const lead = textOf(response);
          return {
            text: lead ? `${lead}\n\n${outcome.endsTurn}` : outcome.endsTurn,
            endedByTool: true,
            usage,
          };
        }
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: outcome.content,
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: '', endedByTool: false, usage };
  }

  async complete(request: CompleteRequest): Promise<string> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
    });
    return response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
}

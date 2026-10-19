// One turn of a conversation: classify the latest message, offer the tools
// that kind of message needs, and let the provider run Claude's tool loop
// until it answers. When Claude cannot be reached for a reason a person must
// fix, the customer gets a holding reply and the team is told.

import type Anthropic from '@anthropic-ai/sdk';

import { errorMessage, silentLogger, type Logger } from '../log.js';
import type { Citation } from '../menu/retrieve.js';
import { systemPrompt } from './prompts.js';
import {
  addUsage,
  ApiProvider,
  describeUsage,
  NO_USAGE,
  ProviderUnavailableError,
  type LlmProvider,
  type MessagesClient,
  type Usage,
} from './provider.js';
import {
  ToolRunner,
  toolsFor,
  type Classification,
  type ToolHost,
} from './tools.js';

export type { MessagesClient } from './provider.js';

export interface Turn {
  role: 'customer' | 'tammy';
  text: string;
  /** The writer's display name, for threads with more than one person. */
  name?: string;
}

export interface BrainOptions {
  /** The API path: a Messages client, wrapped in an ApiProvider. */
  client?: MessagesClient;
  /** Or any provider (the seat). Wins over `client`. */
  provider?: LlmProvider;
  model: string;
  classifierModel?: string;
  product: string;
  maxTokens?: number;
  maxToolRounds?: number;
  log?: Logger;
  today?: () => string;
  /**
   * Tells the team Claude is unavailable (posted to the internal channel).
   * Called at most once per `alertIntervalMs`; the log line is every time.
   */
  onUnavailable?: (text: string) => Promise<void> | void;
  alertIntervalMs?: number;
  now?: () => number;
}

export interface Reply {
  kind: Classification;
  text: string;
  /** The menu passages the reply cites, in the order first cited. */
  citations: Citation[];
  /** Set when this turn filed an investigation. */
  filed?: { key: string; url: string };
  /** Set when the turn ended by asking the customer for details. */
  asked?: boolean;
}

export const UNAVAILABLE_REPLY =
  "Sorry, I can't answer right now. The team has been told, and someone will pick this up.";

export const ALERT_INTERVAL_MS = 60 * 60 * 1000;

export const FALLBACK_REPLY =
  "Sorry, I got myself in a muddle there. Could you say that again? If it's urgent, someone on the team can help too.";

/** Turns the Slack thread into alternating user/assistant messages. */
export function toMessages(turns: Turn[]): Anthropic.Messages.MessageParam[] {
  const named = new Set(
    turns.filter((t) => t.role === 'customer').map((t) => t.name)
  );
  const out: Anthropic.Messages.MessageParam[] = [];
  for (const turn of turns) {
    const text = turn.text.trim();
    if (!text) continue;
    const role = turn.role === 'customer' ? 'user' : 'assistant';
    const body =
      role === 'user' && named.size > 1 && turn.name
        ? `${turn.name}: ${text}`
        : text;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content as string}\n\n${body}`;
    } else {
      out.push({ role, content: body });
    }
  }
  while (out.length && out[0]!.role === 'assistant') out.shift();
  return out;
}

/**
 * Keeps the citations the reply actually uses, renumbered from 1 in order
 * of first use, and rewrites the markers to match.
 */
export function resolveCitations(
  text: string,
  available: Map<number, Citation>
): { text: string; citations: Citation[] } {
  const order: number[] = [];
  const rewritten = text.replace(/\[(\d+)\]/g, (match, n: string) => {
    const num = Number(n);
    if (!available.has(num)) return '';
    if (!order.includes(num)) order.push(num);
    return `[${order.indexOf(num) + 1}]`;
  });
  return {
    text: rewritten
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      .replace(/[ \t]{2,}/g, ' '),
    citations: order.map((n) => available.get(n)!),
  };
}

export class Brain {
  private readonly log: Logger;
  private readonly provider: LlmProvider;
  private lastAlert: number | undefined;

  constructor(private readonly options: BrainOptions) {
    this.log = options.log ?? silentLogger;
    if (options.provider) this.provider = options.provider;
    else if (options.client) this.provider = new ApiProvider(options.client);
    else throw new Error('Brain needs a client or a provider');
  }

  /** question, problem_report or other. Falls back to question on failure. */
  async classify(
    turns: Turn[],
    tally: { usage: Usage } = { usage: NO_USAGE }
  ): Promise<Classification> {
    const messages = toMessages(turns);
    if (!messages.length) return 'other';
    try {
      const { kind, usage } = await this.provider.classify({
        model: this.options.classifierModel ?? this.options.model,
        messages,
      });
      tally.usage = addUsage(tally.usage, usage);
      if (
        kind === 'question' ||
        kind === 'problem_report' ||
        kind === 'other'
      ) {
        return kind;
      }
      this.log.warn(
        `classifier answered ${JSON.stringify(kind)}; treating as a question`
      );
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      this.log.warn(
        `classifier failed: ${errorMessage(error)}; treating as a question`
      );
    }
    return 'question';
  }

  async respond(input: {
    turns: Turn[];
    host: ToolHost;
    audience: 'customer' | 'internal';
  }): Promise<Reply> {
    // Per call, not per Brain: Slack runs several turns at once.
    const tally = { usage: NO_USAGE };
    let kind: Classification = 'question';
    try {
      kind = await this.classify(input.turns, tally);
      return await this.answer(kind, input, tally);
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error;
      await this.unavailable(error);
      return { kind, text: UNAVAILABLE_REPLY, citations: [] };
    } finally {
      if (tally.usage.inputTokens || tally.usage.outputTokens) {
        this.log.debug(
          `${this.provider.name}: ${describeUsage(tally.usage)} this turn`
        );
      }
    }
  }

  private async answer(
    kind: Classification,
    input: {
      turns: Turn[];
      host: ToolHost;
      audience: 'customer' | 'internal';
    },
    tally: { usage: Usage }
  ): Promise<Reply> {
    const tools = toolsFor(kind, input.host.canCheckOrders());
    this.log.debug(
      `classified as ${kind}; tools: ${tools.map((t) => t.name).join(', ') || 'none'}`
    );
    const messages = toMessages(input.turns);
    if (!messages.length) return { kind, text: FALLBACK_REPLY, citations: [] };

    const system = systemPrompt({
      product: this.options.product,
      audience: input.audience,
      today: this.options.today?.() ?? new Date().toISOString().slice(0, 10),
    });
    const runner = new ToolRunner(input.host, tools, this.log);
    const answer = await this.provider.answer({
      model: this.options.model,
      system,
      messages,
      tools,
      maxTokens: this.options.maxTokens ?? 1024,
      maxToolRounds: this.options.maxToolRounds ?? 6,
      runTool: runner.run,
    });
    tally.usage = addUsage(tally.usage, answer.usage);
    const filed = runner.filed ? { filed: runner.filed } : {};
    if (answer.endedByTool) {
      return {
        kind,
        text: answer.text,
        citations: [],
        ...(runner.asked ? { asked: true } : {}),
        ...filed,
      };
    }
    if (!answer.text) {
      return { kind, text: FALLBACK_REPLY, citations: [], ...filed };
    }
    return {
      kind,
      ...resolveCitations(answer.text, runner.available),
      ...filed,
    };
  }

  /** Logs every time; tells the team at most once per alert interval. */
  private async unavailable(error: ProviderUnavailableError): Promise<void> {
    this.log.error(
      `Claude is unavailable (${this.provider.name}, ${error.reason}): ${error.message}. ${error.action}`
    );
    const notify = this.options.onUnavailable;
    if (!notify) return;
    const now = this.options.now?.() ?? Date.now();
    const interval = this.options.alertIntervalMs ?? ALERT_INTERVAL_MS;
    if (this.lastAlert !== undefined && now - this.lastAlert < interval) return;
    this.lastAlert = now;
    try {
      await notify(
        `Tammy can't answer anyone right now: ${error.message}. ${error.action} Customers are getting a holding reply until it is fixed.`
      );
    } catch (alertError) {
      this.log.warn(`telling the team failed: ${errorMessage(alertError)}`);
    }
  }
}

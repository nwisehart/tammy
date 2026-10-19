// The tools Tammy can use, and which of them a turn is offered. There is
// deliberately no tool that converts a card: converting is the team's call,
// made through `/tammy convert`, never from a conversation.

import type Anthropic from '@anthropic-ai/sdk';

import { errorMessage, silentLogger, type Logger } from '../log.js';
import type { Citation, SearchResult } from '../menu/retrieve.js';
import type { ToolCall, ToolOutcome } from './provider.js';

export type Classification = 'question' | 'problem_report' | 'other';

export const FOLLOW_UP_FIELDS = [
  'steps',
  'expected',
  'actual',
  'environment',
  'started',
  'frequency',
] as const;

export type FollowUpField = (typeof FOLLOW_UP_FIELDS)[number];

export const DEFAULT_QUESTIONS: Record<FollowUpField, string> = {
  steps: 'What did you do, step by step, just before it went wrong?',
  expected: 'What did you expect to happen?',
  actual: 'What happened instead? The exact message on screen helps.',
  environment: 'Which browser and device were you using?',
  started: 'When did you first notice it?',
  frequency: 'Does it happen every time, or only sometimes?',
};

export interface AskCustomerInput {
  intro?: string;
  questions: { field: FollowUpField; question?: string }[];
}

export interface FileInvestigationArgs {
  title: string;
  summary: string;
  steps: string;
  expected: string;
  actual: string;
  environment?: string;
  started?: string;
  frequency?: string;
  customer?: string;
}

export interface OrderStatus {
  key: string;
  title: string;
  /** Where the card is, in words a customer understands. */
  stage: string;
  reportReady: boolean;
}

/** What the brain needs from the outside world for one conversation. */
export interface ToolHost {
  searchMenu(query: string): Promise<SearchResult>;
  fileInvestigation(
    args: FileInvestigationArgs
  ): Promise<{ key: string; url: string } | { refused: string }>;
  checkOrder(key?: string): Promise<OrderStatus[] | { error: string }>;
  /** Whether this thread already has an order, or the writer is the team. */
  canCheckOrders(): boolean;
}

export const SEARCH_MENU: Anthropic.Messages.Tool = {
  name: 'search_menu',
  description:
    "Search the product documentation (the menu). Returns numbered passages with their section headings, and says when nothing relevant was found. Use the customer's own words as the query; search again with different words if the first results miss.",
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for.' },
    },
    required: ['query'],
  },
};

export const ASK_CUSTOMER: Anthropic.Messages.Tool = {
  name: 'ask_customer',
  description:
    'Ask the customer for the details needed to take a problem to the kitchen. Only ask for what is missing. This ends your turn: the questions are posted and you wait for their reply.',
  input_schema: {
    type: 'object',
    properties: {
      intro: {
        type: 'string',
        description:
          'One short, warm sentence before the questions, acknowledging the problem.',
      },
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: [...FOLLOW_UP_FIELDS] },
            question: {
              type: 'string',
              description:
                'The question in plain words, specific to what they said.',
            },
          },
          required: ['field'],
        },
      },
    },
    required: ['questions'],
  },
};

export const FILE_INVESTIGATION: Anthropic.Messages.Tool = {
  name: 'file_investigation',
  description:
    "Take a problem to the kitchen: files an investigation for the engineering team, who will reproduce it and explain what is happening. Use the customer's words. Only once per conversation.",
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'A short, specific title in plain words, e.g. "Sharing a list says no user with that email".',
      },
      summary: {
        type: 'string',
        description: 'Two or three sentences: what the customer reported.',
      },
      steps: { type: 'string', description: 'Steps they took, in order.' },
      expected: { type: 'string', description: 'What they expected.' },
      actual: {
        type: 'string',
        description: 'What happened, with any message they saw, verbatim.',
      },
      environment: { type: 'string' },
      started: { type: 'string', description: 'When it started.' },
      frequency: { type: 'string', description: 'How often it happens.' },
      customer: {
        type: 'string',
        description: "The customer's organisation, when they said it.",
      },
    },
    required: ['title', 'summary', 'steps', 'expected', 'actual'],
  },
};

export const CHECK_ORDER: Anthropic.Messages.Tool = {
  name: 'check_order',
  description:
    'Check on a problem already taken to the kitchen from this conversation (or, for the team, any reference like PC-42): where it is and whether the findings are in.',
  input_schema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'A reference such as PC-42; leave out for this thread.',
      },
    },
  },
};

/** The tools a turn of this kind is offered. */
export function toolsFor(
  kind: Classification,
  canCheckOrders: boolean
): Anthropic.Messages.Tool[] {
  const tools: Anthropic.Messages.Tool[] = [];
  if (kind === 'question' || kind === 'problem_report') tools.push(SEARCH_MENU);
  if (kind === 'problem_report') tools.push(ASK_CUSTOMER, FILE_INVESTIGATION);
  if (canCheckOrders) tools.push(CHECK_ORDER);
  return tools;
}

/** The numbered passages search_menu hands the model. */
export function renderPassages(
  result: SearchResult,
  firstNumber: number
): string {
  if (result.passages.length === 0) {
    return 'Nothing in the menu matches this. Say you do not know and offer to ask the team.';
  }
  const lines = result.passages.map((p, i) => {
    const where = [p.title, ...p.trail.filter((h) => h !== p.title)].join(
      ' › '
    );
    return `[${firstNumber + i}] ${where} (score ${p.score.toFixed(2)})\n${p.text}`;
  });
  const note = result.thin
    ? 'These passages are a weak match: the menu probably does not cover this. Unless one clearly answers it, say you do not know and offer to ask the team.'
    : 'Answer only from these passages and cite them by number.';
  return `${note}\n\n${lines.join('\n\n')}`;
}

/**
 * The handlers behind Tammy's tools for one turn, shared by every provider:
 * the API path calls `run` from its own loop, the seat path from the MCP
 * server the `claude` CLI calls back into. It numbers the passages it hands
 * out (for citations), remembers a filed investigation, and refuses any tool
 * the turn was not offered.
 */
export class ToolRunner {
  /** Passages handed to the model so far, by the number it cites. */
  readonly available = new Map<number, Citation>();
  filed: { key: string; url: string } | undefined;
  asked = false;
  private nextNumber = 1;

  constructor(
    private readonly host: ToolHost,
    private readonly offered: Anthropic.Messages.Tool[],
    private readonly log: Logger = silentLogger
  ) {}

  readonly run = async (call: ToolCall): Promise<ToolOutcome> => {
    if (call.name === 'ask_customer') {
      this.asked = true;
      return {
        content: 'The questions are posted. Your turn is over.',
        endsTurn: renderQuestions(call.input as AskCustomerInput),
      };
    }
    try {
      if (!this.offered.some((t) => t.name === call.name)) {
        throw new Error(`${call.name} is not available for this message`);
      }
      if (call.name === 'search_menu') {
        const query = String((call.input as { query?: unknown }).query ?? '');
        const result = await this.host.searchMenu(query);
        const content = renderPassages(result, this.nextNumber);
        result.passages.forEach((p) =>
          this.available.set(this.nextNumber++, p.citation)
        );
        return { content };
      }
      if (call.name === 'file_investigation') {
        const outcome = await this.host.fileInvestigation(
          call.input as FileInvestigationArgs
        );
        if ('refused' in outcome) {
          return { content: outcome.refused, isError: true };
        }
        this.filed = outcome;
        return {
          content: `Filed as ${outcome.key}. Tell the customer you have taken it to the kitchen under reference ${outcome.key}, and that you will explain what the team finds in this thread. Do not guess the cause or promise a fix.`,
        };
      }
      if (call.name === 'check_order') {
        const key = (call.input as { key?: string }).key;
        const status = await this.host.checkOrder(key || undefined);
        if ('error' in status) return { content: status.error, isError: true };
        return { content: JSON.stringify(status) };
      }
      throw new Error(`unknown tool ${call.name}`);
    } catch (error) {
      const content = errorMessage(error);
      this.log.warn(`${call.name} failed: ${content}`);
      return { content, isError: true };
    }
  };
}

export function renderQuestions(input: AskCustomerInput): string {
  const intro =
    input.intro?.trim() ||
    "I'm sorry that's happening. So I can take it to the kitchen, could you tell me:";
  const seen = new Set<FollowUpField>();
  const questions: string[] = [];
  for (const q of input.questions ?? []) {
    if (!FOLLOW_UP_FIELDS.includes(q.field) || seen.has(q.field)) continue;
    seen.add(q.field);
    questions.push(q.question?.trim() || DEFAULT_QUESTIONS[q.field]);
  }
  return `${intro}\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
}

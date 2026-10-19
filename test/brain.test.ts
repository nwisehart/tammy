import { describe, expect, it } from 'vitest';

import {
  Brain,
  resolveCitations,
  toMessages,
  type Turn,
} from '../src/brain/brain.js';
import type { ToolHost } from '../src/brain/tools.js';
import type { Citation, SearchResult } from '../src/menu/retrieve.js';
import { classify, FakeClaude, text, toolUse } from './helpers.js';

const toolNames = (tools: unknown[] | undefined) =>
  (tools ?? []).map((t) => (t as { name: string }).name);

const SHARING: Citation = {
  heading: 'Sharing a list with someone',
  source: 'docs/sharing.md',
  url: null,
  anchor: 'sharing-a-list-with-someone',
  line: 8,
};

function result(thin = false): SearchResult {
  return {
    query: 'share a list',
    thin,
    best: thin ? 0.1 : 0.7,
    passages: [
      {
        chunkId: 1,
        score: thin ? 0.1 : 0.7,
        text: "Under Share, type the other person's email address and press Share.",
        heading: SHARING.heading,
        trail: ['Sharing a list', SHARING.heading],
        anchor: SHARING.anchor,
        line: 8,
        source: '/x/docs/sharing.md',
        label: 'docs/sharing.md',
        url: null,
        title: 'Sharing a list',
        citation: SHARING,
      },
    ],
  };
}

function host(
  overrides: Partial<ToolHost> = {}
): ToolHost & { filed: unknown[]; searched: string[] } {
  const filed: unknown[] = [];
  const searched: string[] = [];
  return {
    filed,
    searched,
    searchMenu: async (q) => {
      searched.push(q);
      return result();
    },
    fileInvestigation: async (args) => {
      filed.push(args);
      return { key: 'PC-42', url: 'http://localhost:4100/projects/p/issues/i' };
    },
    checkOrder: async () => [],
    canCheckOrders: () => false,
    ...overrides,
  };
}

const ask: Turn[] = [
  { role: 'customer', text: 'how do I share a list?', name: 'Ben' },
];

function brain(claude: FakeClaude) {
  return new Brain({
    client: claude,
    model: 'claude-main',
    classifierModel: 'claude-small',
    product: 'Pantry',
    today: () => '2026-10-18',
  });
}

describe('the classifier', () => {
  it('runs first, on the classifier model, with the classify tool forced', async () => {
    const claude = new FakeClaude([
      classify('question'),
      text('Open the list and use Share. [1]'),
    ]);
    await brain(claude).respond({
      turns: ask,
      host: host(),
      audience: 'customer',
    });
    const first = claude.calls[0]!;
    expect(first.model).toBe('claude-small');
    expect(first.tool_choice).toEqual({ type: 'tool', name: 'classify' });
    expect(toolNames(first.tools)).toEqual(['classify']);
    expect(first.messages).toEqual([
      { role: 'user', content: 'how do I share a list?' },
    ]);
  });

  it.each([
    ['question', ['search_menu']],
    ['problem_report', ['search_menu', 'ask_customer', 'file_investigation']],
    ['other', []],
  ])('offers a %s the right tools', async (kind, tools) => {
    const claude = new FakeClaude([classify(kind), text('Hello!')]);
    await brain(claude).respond({
      turns: ask,
      host: host(),
      audience: 'customer',
    });
    const answer = claude.calls[1]!;
    expect(answer.model).toBe('claude-main');
    expect(toolNames(answer.tools)).toEqual(tools);
  });

  it('adds check_order when the thread has an order, and never a convert tool', async () => {
    const claude = new FakeClaude([classify('problem_report'), text('ok')]);
    await brain(claude).respond({
      turns: ask,
      host: host({ canCheckOrders: () => true }),
      audience: 'internal',
    });
    const names = toolNames(claude.calls[1]!.tools);
    expect(names).toContain('check_order');
    expect(names.some((n) => /convert/.test(n))).toBe(false);
  });

  it('treats a failed classification as a question', async () => {
    const claude = new FakeClaude([
      new Error('overloaded'),
      text('Here you go.'),
    ]);
    const reply = await brain(claude).respond({
      turns: ask,
      host: host(),
      audience: 'customer',
    });
    expect(reply.kind).toBe('question');
  });
});

describe('answering', () => {
  it('searches the menu and keeps the citations the answer uses', async () => {
    const claude = new FakeClaude([
      classify('question'),
      toolUse('search_menu', { query: 'share a list' }),
      text(
        "Open the list, type their email under Share, and press Share [1]. That's it!"
      ),
    ]);
    const h = host();
    const reply = await brain(claude).respond({
      turns: ask,
      host: h,
      audience: 'customer',
    });
    expect(h.searched).toEqual(['share a list']);
    expect(reply.citations).toEqual([SHARING]);
    expect(reply.text).toContain('press Share [1].');
    // The passages went back to the model as a tool result, numbered.
    const toolResult = claude.calls[2]!.messages.at(-1)!;
    expect(JSON.stringify(toolResult)).toContain(
      '[1] Sharing a list › Sharing a list with someone'
    );
  });

  it('tells the model when retrieval is thin', async () => {
    const claude = new FakeClaude([
      classify('question'),
      toolUse('search_menu', { query: 'export to PDF' }),
      text("I don't know, I'm afraid — want me to ask the team?"),
    ]);
    await brain(claude).respond({
      turns: [{ role: 'customer', text: 'can I export to PDF?' }],
      host: host({ searchMenu: async () => result(true) }),
      audience: 'customer',
    });
    expect(JSON.stringify(claude.calls[2]!.messages.at(-1))).toContain(
      'weak match'
    );
  });

  it('sets the persona in one system prompt', async () => {
    const claude = new FakeClaude([classify('other'), text('Hi!')]);
    await brain(claude).respond({
      turns: ask,
      host: host(),
      audience: 'customer',
    });
    const system = String(claude.calls[1]!.system);
    expect(system).toContain('You are Tammy');
    expect(system).toContain('Pantry');
    expect(system).toContain("say plainly that you don't know");
    expect(system).toMatch(/Never:[\s\S]*Promise a fix/);
    expect(system).toContain('2026-10-18');
  });

  it('ends the turn with structured follow-up questions', async () => {
    const claude = new FakeClaude([
      classify('problem_report'),
      toolUse('ask_customer', {
        intro: 'Sorry about that! A couple of things so I can pass it on:',
        questions: [
          {
            field: 'steps',
            question: 'Which list were you sharing, and what did you type?',
          },
          { field: 'frequency' },
          { field: 'steps' },
        ],
      }),
    ]);
    const reply = await brain(claude).respond({
      turns: [
        {
          role: 'customer',
          text: 'sharing my list says no user with that email but she has an account',
        },
      ],
      host: host(),
      audience: 'customer',
    });
    expect(reply.asked).toBe(true);
    expect(reply.text).toBe(
      'Sorry about that! A couple of things so I can pass it on:\n1. Which list were you sharing, and what did you type?\n2. Does it happen every time, or only sometimes?'
    );
    expect(claude.calls).toHaveLength(2);
  });

  it('files an investigation and reports the order', async () => {
    const claude = new FakeClaude([
      classify('problem_report'),
      toolUse('file_investigation', {
        title: 'Sharing a list says no user with that email',
        summary: 'Ben cannot share Weekend with Ann.',
        steps: 'Open Weekend, type Ann@Example.com under Share, press Share.',
        expected: 'The list is shared with Ann.',
        actual: '"No user with that email".',
      }),
      text(
        "Thanks Ben — I've taken this to the kitchen as PC-42. I'll explain what they find here."
      ),
    ]);
    const h = host();
    const reply = await brain(claude).respond({
      turns: ask,
      host: h,
      audience: 'customer',
    });
    expect(h.filed).toHaveLength(1);
    expect(reply.filed).toEqual({
      key: 'PC-42',
      url: 'http://localhost:4100/projects/p/issues/i',
    });
    expect(JSON.stringify(claude.calls[2]!.messages.at(-1))).toContain(
      'Do not guess the cause'
    );
  });

  it('refuses a tool the turn was not offered', async () => {
    const claude = new FakeClaude([
      classify('question'),
      toolUse('file_investigation', {
        title: 'x',
        summary: 'x',
        steps: 'x',
        expected: 'x',
        actual: 'x',
      }),
      text('Let me just answer that.'),
    ]);
    const h = host();
    await brain(claude).respond({ turns: ask, host: h, audience: 'customer' });
    expect(h.filed).toHaveLength(0);
    expect(JSON.stringify(claude.calls[2]!.messages.at(-1))).toContain(
      'not available'
    );
  });

  it('stops offering tools after max_tool_rounds', async () => {
    const claude = new FakeClaude([
      classify('question'),
      toolUse('search_menu', { query: 'a' }),
      toolUse('search_menu', { query: 'b' }),
      text('Done.'),
    ]);
    const b = new Brain({
      client: claude,
      model: 'm',
      product: 'Pantry',
      maxToolRounds: 2,
    });
    const reply = await b.respond({
      turns: ask,
      host: host(),
      audience: 'customer',
    });
    expect(reply.text).toBe('Done.');
    expect(claude.calls[3]!.tools).toBeUndefined();
  });
});

describe('the thread', () => {
  it('becomes alternating messages that start with the customer', () => {
    expect(
      toMessages([
        { role: 'tammy', text: 'Hi, I am Tammy.' },
        { role: 'customer', text: 'one', name: 'Ann' },
        { role: 'customer', text: 'two', name: 'Ben' },
        { role: 'tammy', text: 'three' },
      ])
    ).toEqual([
      { role: 'user', content: 'Ann: one\n\nBen: two' },
      { role: 'assistant', content: 'three' },
    ]);
  });

  it('renumbers citations in order of use and drops unknown ones', () => {
    const other: Citation = { ...SHARING, heading: 'Other' };
    const out = resolveCitations(
      'A [3]. B [1] [9]. C [3].',
      new Map([
        [1, SHARING],
        [3, other],
      ])
    );
    expect(out.text).toBe('A [1]. B [2]. C [1].');
    expect(out.citations).toEqual([other, SHARING]);
  });
});

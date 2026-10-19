import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Brain } from '../src/brain/brain.js';
import type { SlackConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import type { CardView, Kitchen } from '../src/kitchen/client.js';
import { Orders } from '../src/kitchen/orders.js';
import { silentLogger } from '../src/log.js';
import type { SearchResult } from '../src/menu/retrieve.js';
import {
  registerHandlers,
  type CommandArgs,
  type HandlerRegistry,
  type MentionArgs,
  type MessageArgs,
} from '../src/slack/app.js';
import { SNAG_REPLY } from '../src/slack/conversation.js';
import { PLACEHOLDER } from '../src/slack/format.js';
import { Conversations, Team } from '../src/slack/people.js';
import {
  classify,
  FakeClaude,
  fakeWebClient,
  tempDir,
  text,
  toolUse,
} from './helpers.js';

const BOT = 'UTAMMY';
const CARD_ID = '3f1e9b52-0000-4000-8000-000000000002';
const CARD_URL = `http://localhost:4100/projects/p/issues/${CARD_ID}`;

const SLACK: SlackConfig = {
  customerChannels: ['CCUST'],
  internalChannels: ['CTEAM'],
  internalUsers: [],
  notifyChannel: 'CTEAM',
  answerDms: true,
};

const SEARCH: SearchResult = {
  query: 'share',
  thin: false,
  best: 0.7,
  passages: [
    {
      chunkId: 1,
      score: 0.7,
      text: "Under Share, type the other person's email address and press Share.",
      heading: 'Sharing a list with someone',
      trail: ['Sharing a list', 'Sharing a list with someone'],
      anchor: 'sharing-a-list-with-someone',
      line: 8,
      source: '/x/docs/sharing.md',
      label: 'docs/sharing.md',
      url: null,
      title: 'Sharing a list',
      citation: {
        heading: 'Sharing a list with someone',
        source: 'docs/sharing.md',
        url: null,
        anchor: 'sharing-a-list-with-someone',
        line: 8,
      },
    },
  ],
};

const dirs: { cleanup: () => void }[] = [];
afterEach(() => dirs.splice(0).forEach((d) => d.cleanup()));

function fakeKitchen(): Kitchen & {
  [K in keyof Kitchen]: ReturnType<typeof vi.fn>;
} {
  const card: CardView = {
    id: CARD_ID,
    key: 'PC-42',
    title: 'Sharing a list says no user with that email',
    url: CARD_URL,
    project_id: 'p',
    status: 'planning',
    column: 'Plan',
    work_class: 'investigation',
    report: null,
    confidence: null,
    harness: null,
    comments: 1,
    rca_id: null,
    origin: null,
  };
  return {
    fileInvestigation: vi.fn(async () => ({
      id: CARD_ID,
      url: CARD_URL,
      key: 'PC-42',
    })),
    getCard: vi.fn(async () => card),
    convert: vi.fn(async () => ({
      id: CARD_ID,
      from: 'investigation',
      to: 'bug',
      column: 'Execute',
      plan_carried_over: true,
    })),
  };
}

function setup(
  options: {
    script?: ConstructorParameters<typeof FakeClaude>[0];
    slack?: Partial<SlackConfig>;
    thread?: { ts: string; user?: string; bot_id?: string; text: string }[];
  } = {}
) {
  const d = tempDir();
  dirs.push(d);
  const db = openDb(join(d.path, 'tammy.db'));
  const claude = new FakeClaude(options.script ?? []);
  const kitchen = fakeKitchen();
  const orders = new Orders(db);
  const conversations = new Conversations(db);
  const config = { ...SLACK, ...options.slack };
  const handlers: {
    mention?: (a: MentionArgs) => Promise<void>;
    message?: (a: MessageArgs) => Promise<void>;
    command?: (a: CommandArgs) => Promise<void>;
  } = {};
  const registry: HandlerRegistry = {
    event: (_name, h) => (handlers.mention = h),
    message: (h) => (handlers.message = h),
    command: (_name, h) => (handlers.command = h),
  };
  registerHandlers(registry, {
    brain: new Brain({ client: claude, model: 'm', product: 'Pantry' }),
    search: async () => SEARCH,
    kitchen,
    orders,
    conversations,
    team: new Team(config),
    product: 'Pantry',
    notifyChannel: config.notifyChannel,
    answerDms: config.answerDms,
    log: silentLogger,
  });
  const web = fakeWebClient({
    thread: options.thread,
    members: { CTEAM: ['UADA'] },
    names: { UBEN: 'Ben', UADA: 'Ada Lovelace' },
  });
  const ctx = { botUserId: BOT };
  const client = web.client as unknown as MentionArgs['client'];
  return {
    claude,
    kitchen,
    orders,
    conversations,
    calls: web.calls,
    mention: (event: Partial<MentionArgs['event']>) =>
      handlers.mention!({
        event: {
          channel: 'CCUST',
          user: 'UBEN',
          text: `<@${BOT}> hi`,
          ts: '100.000100',
          ...event,
        },
        client,
        context: ctx,
      }),
    message: (message: Partial<MessageArgs['message']>) =>
      handlers.message!({
        message: {
          channel: 'CCUST',
          user: 'UBEN',
          text: 'hello',
          ts: '200.000100',
          ...message,
        },
        client,
        context: ctx,
      }),
    command: async (text: string, user = 'UBEN', channel = 'CCUST') => {
      const responses: string[] = [];
      const ack = vi.fn(async () => {});
      await handlers.command!({
        command: { text, user_id: user, channel_id: channel },
        ack,
        respond: async (m) => {
          responses.push(m.text);
        },
        client,
      });
      expect(ack).toHaveBeenCalled();
      return responses;
    },
  };
}

const methods = (calls: { method: string }[]) => calls.map((c) => c.method);

describe('answering in Slack', () => {
  it('answers an @-mention in a customer channel, in a thread, with a citation', async () => {
    const t = setup({
      script: [
        classify('question'),
        toolUse('search_menu', { query: 'share a list' }),
        text(
          'Open the list, type their email under **Share** and press Share [1].'
        ),
      ],
    });
    await t.mention({ text: `<@${BOT}> how do I share a list?` });
    const post = t.calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.args).toMatchObject({
      channel: 'CCUST',
      thread_ts: '100.000100',
      text: PLACEHOLDER,
    });
    const update = t.calls.find((c) => c.method === 'chat.update')!;
    expect(update.args.text).toBe(
      'Open the list, type their email under *Share* and press Share.\n\n_From the menu: Sharing a list with someone_'
    );
    // The mention is stripped before the model sees it.
    expect(t.claude.calls[1]!.messages[0]).toEqual({
      role: 'user',
      content: 'how do I share a list?',
    });
  });

  it('ignores mentions in channels it is not configured for', async () => {
    const t = setup();
    await t.mention({ channel: 'CRANDOM' });
    expect(t.calls).toEqual([]);
  });

  it('answers direct messages, unless told not to', async () => {
    const t = setup({ script: [classify('other'), text('Hi Ben!')] });
    await t.message({ channel: 'DBEN', channel_type: 'im', text: 'hi' });
    expect(methods(t.calls)).toContain('chat.update');

    const quiet = setup({ slack: { answerDms: false } });
    await quiet.message({ channel: 'DBEN', channel_type: 'im', text: 'hi' });
    expect(quiet.calls).toEqual([]);
  });

  it('answers replies in a thread it is in, without a fresh mention', async () => {
    const t = setup({
      script: [
        classify('question'),
        text('First.'),
        classify('question'),
        text('Second.'),
      ],
      thread: [
        { ts: '100.000100', user: 'UBEN', text: `<@${BOT}> how do I share?` },
        { ts: '100.000200', user: BOT, text: 'First.' },
        { ts: '100.000300', user: 'UBEN', text: 'and can Ann rename it?' },
      ],
    });
    await t.mention({ text: `<@${BOT}> how do I share?` });
    await t.message({
      text: 'and can Ann rename it?',
      ts: '100.000300',
      thread_ts: '100.000100',
    });
    expect(t.calls.filter((c) => c.method === 'chat.update')).toHaveLength(2);
    expect(t.claude.calls[3]!.messages).toEqual([
      { role: 'user', content: 'how do I share?' },
      { role: 'assistant', content: 'First.' },
      { role: 'user', content: 'and can Ann rename it?' },
    ]);
  });

  it('does not answer a channel mention twice', async () => {
    const t = setup();
    await t.message({ text: `<@${BOT}> hello`, ts: '300.000100' });
    expect(t.calls).toEqual([]);
  });

  it('steps aside when someone on the team writes in the thread', async () => {
    const t = setup({ script: [classify('other'), text('Hello!')] });
    await t.mention({});
    await t.message({
      user: 'UADA',
      text: "I'll take this one, Ben",
      ts: '100.000400',
      thread_ts: '100.000100',
    });
    await t.message({
      user: 'UBEN',
      text: 'thanks Ada',
      ts: '100.000500',
      thread_ts: '100.000100',
    });
    expect(t.calls.filter((c) => c.method === 'chat.update')).toHaveLength(1);
    expect(
      t.conversations.get('CCUST', '100.000100')?.handedOverAt
    ).not.toBeNull();
  });

  it('files an investigation with the thread permalink and posts the link in both places', async () => {
    const t = setup({
      script: [
        classify('problem_report'),
        toolUse('file_investigation', {
          title: 'Sharing a list says no user with that email',
          summary: 'Ben cannot share Weekend with Ann.',
          steps: 'Open Weekend, type Ann@Example.com, press Share.',
          expected: 'Shared with Ann.',
          actual: 'No user with that email',
        }),
        text(
          "I've taken this to the kitchen as PC-42 and will explain what they find here."
        ),
      ],
      thread: [
        {
          ts: '100.000100',
          user: 'UBEN',
          text: `<@${BOT}> sharing says no user with that email`,
        },
      ],
    });
    await t.mention({ text: `<@${BOT}> sharing says no user with that email` });
    expect(t.kitchen.fileInvestigation).toHaveBeenCalledTimes(1);
    const input = t.kitchen.fileInvestigation.mock.calls[0]![0];
    expect(input).toMatchObject({
      title: 'Sharing a list says no user with that email',
      origin: {
        kind: 'tammy',
        ref: 'https://acme.slack.com/archives/CCUST/p100000100',
        reporter: 'Ben',
      },
      metadata: { channel: 'CCUST' },
      start: true,
    });
    expect(input.description).toContain('## Expected\n\nShared with Ann.');
    expect(t.orders.forThread('CCUST', '100.000100')[0]?.cardKey).toBe('PC-42');

    const team = t.calls.find(
      (c) => c.method === 'chat.postMessage' && c.args.channel === 'CTEAM'
    );
    expect(team?.args.text).toContain(`<${CARD_URL}|PC-42>`);
    const update = t.calls.find((c) => c.method === 'chat.update')!;
    expect(update.args.text).toContain(
      `Order <${CARD_URL}|PC-42> is with the kitchen.`
    );
  });

  it('says sorry in place of the placeholder when something breaks', async () => {
    const t = setup({
      script: [classify('question'), new Error('overloaded')],
    });
    await t.mention({});
    const update = t.calls.find((c) => c.method === 'chat.update')!;
    expect(update.args.text).toBe(SNAG_REPLY);
  });
});

describe('/tammy', () => {
  function withOrder() {
    const t = setup();
    t.orders.add({
      cardId: CARD_ID,
      cardKey: 'PC-42',
      cardUrl: CARD_URL,
      title: 'Sharing fails',
      channel: 'CCUST',
      threadTs: '100.000100',
      permalink: 'https://acme.slack.com/archives/CCUST/p100000100',
      reporter: 'Ben',
      reporterId: 'UBEN',
      customer: null,
    });
    return t;
  }

  it('refuses convert to a customer and sends nothing to the kitchen', async () => {
    const t = withOrder();
    const [answer] = await t.command('convert PC-42', 'UBEN');
    expect(answer).toMatch(/Only the team can do that/);
    expect(t.kitchen.convert).not.toHaveBeenCalled();
  });

  it('converts for the team, naming who did it', async () => {
    const t = withOrder();
    const [answer] = await t.command('convert PC-42', 'UADA', 'CTEAM');
    expect(t.kitchen.convert).toHaveBeenCalledWith(
      CARD_ID,
      'bug',
      'Ada Lovelace'
    );
    expect(answer).toContain('PC-42 is now a bug and went to *Execute*');
    expect(t.orders.byCardId(CARD_ID)?.status).toBe('converted');
  });

  it('tells a customer where their order is, in plain words', async () => {
    const t = withOrder();
    const [answer] = await t.command('status PC-42', 'UBEN');
    expect(answer).toBe('*PC-42*: the team is looking into it.');
  });

  it('keeps other channels’ orders from customers', async () => {
    const t = withOrder();
    const [answer] = await t.command('status PC-42', 'UCAROL', 'COTHER');
    expect(answer).toMatch(
      /only tell you about problems reported in this channel/
    );
    expect(t.kitchen.getCard).not.toHaveBeenCalled();
  });

  it('gives the team the card details', async () => {
    const t = withOrder();
    const [answer] = await t.command('status PC-42', 'UADA', 'CTEAM');
    expect(answer).toContain(`<${CARD_URL}|PC-42>`);
    expect(answer).toContain('Plan (planning) · investigation');
  });

  it('explains itself', async () => {
    const t = setup();
    const [answer] = await t.command('');
    expect(answer).toContain('/tammy status PC-42');
  });
});

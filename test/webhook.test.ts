import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDb } from '../src/db.js';
import { Orders } from '../src/kitchen/orders.js';
import { silentLogger } from '../src/log.js';
import { parseTriageReport } from '../src/plain-english/report.js';
import { translateReport } from '../src/plain-english/translate.js';
import type { SlackApi } from '../src/slack/api.js';
import type { Envelope } from '../src/webhook/events.js';
import { createEventHandler } from '../src/webhook/handlers.js';
import {
  createWebhookServer,
  DbDeliveries,
  receive,
} from '../src/webhook/server.js';
import {
  signPrepCookBody,
  verifyPrepCookSignature,
} from '../src/webhook/verify.js';
import { tempDir } from './helpers.js';

const SECRET = 'test-webhook-secret';
const CARD_ID = '3f1e9b52-0000-4000-8000-000000000002';
const CARD_URL = `http://localhost:4100/projects/7d0c6a0e-0000-4000-8000-000000000001/issues/${CARD_ID}`;
const PERMALINK = 'https://acme.slack.com/archives/C1/p1760000000000100';

const report = parseTriageReport(
  readFileSync(
    join(
      import.meta.dirname,
      '..',
      'src',
      'plain-english',
      'fixtures',
      'sharing-letter-case.md'
    ),
    'utf8'
  )
);

function envelope(type: string, data: unknown): Envelope {
  return {
    type,
    severity: 'info',
    occurred_at: '2026-10-18T15:00:00.000Z',
    prepcook: {
      version: '0.1.0',
      board_url: 'http://localhost:4100/projects/7d0c',
    },
    data,
  };
}

const completed = envelope('investigation_completed', {
  issue: {
    key: 'PC-42',
    title: 'Sharing fails',
    url: null,
    card_url: CARD_URL,
  },
  report,
  rca_url: null,
  rca_id: null,
  harness: { path: '.repro/PC-42/repro.mjs', outcome: 'reproduced' },
  confidence: 'high',
  source: { kind: 'tammy', ref: PERMALINK, reporter: 'Ben' },
});

const converted = envelope('card_converted', {
  issue: {
    key: 'PC-42',
    title: 'Sharing fails',
    url: null,
    card_url: CARD_URL,
  },
  from: 'investigation',
  to: 'bug',
  by: 'Ada Lovelace',
  column: 'Execute',
});

const dirs: { cleanup: () => void }[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  dirs.splice(0).forEach((d) => d.cleanup());
});

function recordingSlack() {
  const posts: { channel: string; text: string; threadTs?: string }[] = [];
  const slack: SlackApi = {
    post: async (channel, text, threadTs) => {
      posts.push({ channel, text, threadTs });
      return { ts: `${posts.length}.0` };
    },
    update: async () => {},
    permalink: async () => PERMALINK,
    replies: async () => [],
    members: async () => [],
    userName: async (id) => id,
  };
  return { slack, posts };
}

async function setup() {
  const d = tempDir();
  dirs.push(d);
  const db = openDb(join(d.path, 'tammy.db'));
  const orders = new Orders(db);
  orders.add({
    cardId: CARD_ID,
    cardKey: 'PC-42',
    cardUrl: CARD_URL,
    title: 'Sharing a list says no user with that email',
    channel: 'C1',
    threadTs: '1760000000.000100',
    permalink: PERMALINK,
    reporter: 'Ben',
    reporterId: 'U1',
    customer: null,
  });
  const { slack, posts } = recordingSlack();
  const events: Envelope[] = [];
  const handle = createEventHandler({
    orders,
    slack,
    translate: (r, ctx) =>
      translateReport(r, ctx, { client: null, model: 'm' }),
    product: 'Pantry',
    notifyChannel: 'CTEAM',
    log: silentLogger,
  });
  const webhook = createWebhookServer({
    path: '/prepcook/webhook',
    secret: SECRET,
    deliveries: new DbDeliveries(db),
    onEvent: async (event) => {
      events.push(event);
      await handle(event);
    },
  });
  await new Promise<void>((r) =>
    webhook.server.listen(0, '127.0.0.1', () => r())
  );
  closers.push(() => new Promise((r) => webhook.server.close(() => r())));
  const { port } = webhook.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/prepcook/webhook`;
  const deliver = async (
    event: Envelope,
    options: {
      delivery?: string;
      signature?: string | null;
      body?: string;
    } = {}
  ) => {
    const body = options.body ?? JSON.stringify(event);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-PrepCook-Event': event.type,
      'X-PrepCook-Delivery': options.delivery ?? crypto.randomUUID(),
    };
    const signature =
      options.signature === undefined
        ? signPrepCookBody(body, SECRET)
        : options.signature;
    if (signature !== null) headers['X-PrepCook-Signature'] = signature;
    const res = await fetch(url, { method: 'POST', headers, body });
    await webhook.idle();
    return { status: res.status, text: await res.text() };
  };
  return { orders, posts, events, deliver, url };
}

describe('the signature', () => {
  it('verifies exactly as Prepcook documents it', () => {
    const body = Buffer.from('{"type":"ping","severity":"info","data":{}}');
    const header = signPrepCookBody(body, SECRET);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyPrepCookSignature(body, header, SECRET)).toBe(true);
    expect(verifyPrepCookSignature(body, header, 'another-secret')).toBe(false);
    expect(
      verifyPrepCookSignature(Buffer.from(`${body} `), header, SECRET)
    ).toBe(false);
    expect(verifyPrepCookSignature(body, header.toUpperCase(), SECRET)).toBe(
      false
    );
    expect(verifyPrepCookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyPrepCookSignature(body, header.slice(7), SECRET)).toBe(false);
  });

  it('accepts a good delivery', async () => {
    const { deliver, events } = await setup();
    const res = await deliver(envelope('ping', {}));
    expect(res.status).toBe(202);
    expect(events).toHaveLength(1);
  });

  it('refuses a bad signature and does nothing', async () => {
    const { deliver, events, posts } = await setup();
    const res = await deliver(completed, {
      signature: signPrepCookBody('{}', SECRET),
    });
    expect(res.status).toBe(401);
    expect(events).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it('refuses a delivery with no signature', async () => {
    const { deliver, events } = await setup();
    expect((await deliver(completed, { signature: null })).status).toBe(401);
    expect(events).toHaveLength(0);
  });

  it('drops a replayed delivery', async () => {
    const { deliver, events, posts } = await setup();
    const id = crypto.randomUUID();
    expect((await deliver(completed, { delivery: id })).status).toBe(202);
    const again = await deliver(completed, { delivery: id });
    expect(again).toEqual({ status: 200, text: 'duplicate' });
    expect(events).toHaveLength(1);
    expect(posts.filter((p) => p.threadTs)).toHaveLength(1);
  });

  it('judges a delivery without a socket', () => {
    const seen = new Set<string>();
    const deliveries = {
      claim: (id: string) => (seen.has(id) ? false : (seen.add(id), true)),
    };
    const raw = Buffer.from('not json');
    const headers = { 'x-prepcook-signature': signPrepCookBody(raw, SECRET) };
    expect(receive(raw, headers, SECRET, deliveries).status).toBe(400);
  });
});

describe('investigation_completed', () => {
  it('explains the report in the thread, in plain English, and tells the team', async () => {
    const { deliver, posts, orders } = await setup();
    await deliver(completed);
    const [customer, team] = posts;
    expect(customer).toMatchObject({
      channel: 'C1',
      threadTs: '1760000000.000100',
    });
    expect(customer!.text).toMatch(/^<@U1> the kitchen is back on PC-42\./);
    expect(customer!.text).toContain('In the meantime, you can type');
    expect(customer!.text).not.toMatch(/src\/|\.js\b|harness|`/);
    expect(team).toMatchObject({ channel: 'CTEAM' });
    expect(team!.threadTs).toBeUndefined();
    expect(team!.text).toContain(`<${CARD_URL}|PC-42>`);
    expect(team!.text).toContain(
      'confidence high · harness reproduced · a defect'
    );
    expect(team!.text).toContain('/tammy convert PC-42');
    expect(orders.byCardId(CARD_ID)?.status).toBe('reported');
  });

  it('posts a report once even when Prepcook sends it twice under new ids', async () => {
    const { deliver, posts } = await setup();
    await deliver(completed);
    await deliver(completed);
    expect(posts.filter((p) => p.channel === 'C1')).toHaveLength(1);
  });

  it('ignores a card Tammy did not file', async () => {
    const { deliver, posts } = await setup();
    const other = envelope('investigation_completed', {
      ...(completed.data as object),
      issue: {
        key: 'PC-7',
        title: 'x',
        url: null,
        card_url:
          'http://localhost:4100/projects/p/issues/00000000-0000-4000-8000-000000000009',
      },
      source: {
        kind: 'incident',
        ref: 'https://status.example.com/incidents/1',
        reporter: null,
      },
    });
    expect((await deliver(other)).status).toBe(202);
    expect(posts).toHaveLength(0);
  });
});

describe('card_converted', () => {
  it('tells the thread the kitchen has taken it on as a bug', async () => {
    const { deliver, posts, orders } = await setup();
    await deliver(converted);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      channel: 'C1',
      threadTs: '1760000000.000100',
    });
    expect(posts[0]!.text).toContain('the kitchen has taken this on as a bug');
    expect(posts[0]!.text).not.toMatch(/will be fixed|fixed by/i);
    expect(orders.byCardId(CARD_ID)?.status).toBe('converted');
  });
});

describe('everything else', () => {
  it('is accepted and ignored', async () => {
    const { deliver, posts } = await setup();
    const res = await deliver(
      envelope('daily_digest', { date: '2026-10-18', sections: [] })
    );
    expect(res.status).toBe(202);
    expect(posts).toHaveLength(0);
  });

  it('answers 404 off the webhook path and 405 for a GET on it', async () => {
    const { url } = await setup();
    expect(
      (
        await fetch(url.replace('/prepcook/webhook', '/other'), {
          method: 'POST',
        })
      ).status
    ).toBe(404);
    expect((await fetch(url)).status).toBe(405);
  });
});

import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDb } from '../src/db.js';
import {
  cardIdFromUrl,
  KitchenClient,
  KitchenError,
} from '../src/kitchen/client.js';
import { investigationDescription } from '../src/kitchen/description.js';
import { Orders } from '../src/kitchen/orders.js';
import { fakeServer, json, tempDir, type FakeServer } from './helpers.js';

const TOKEN = 'test-prepcook-token';
const CARD_ID = '3f1e9b52-0000-4000-8000-000000000002';
const BOARD = '7d0c6a0e-0000-4000-8000-000000000001';
const CARD_URL = `http://localhost:4100/projects/${BOARD}/issues/${CARD_ID}`;

const servers: FakeServer[] = [];
const dirs: { cleanup: () => void }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  dirs.splice(0).forEach((d) => d.cleanup());
});

/** A fake Prepcook: answers the card API the way docs/api.md says. */
async function prepcook(options: { failFirst?: number; status?: number } = {}) {
  let failures = options.failFirst ?? 0;
  const server = await fakeServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return json(res, 401, {
        success: false,
        data: null,
        error_data: null,
        message: 'bad token',
      });
    }
    if (failures > 0) {
      failures--;
      return json(res, options.status ?? 503, {
        success: false,
        data: null,
        error_data: null,
        message: 'the board could not be reached',
      });
    }
    if (req.method === 'POST' && req.path === '/api/cards') {
      return json(res, 201, {
        success: true,
        data: { id: CARD_ID, url: CARD_URL, key: 'PC-42' },
        error_data: null,
        message: null,
      });
    }
    if (req.method === 'GET' && req.path === `/api/cards/${CARD_ID}`) {
      return json(res, 200, {
        success: true,
        data: {
          id: CARD_ID,
          key: 'PC-42',
          title: 'Sharing a list says no user with that email',
          url: CARD_URL,
          project_id: BOARD,
          status: 'triaged',
          column: 'Triaged',
          work_class: 'investigation',
          report: null,
          confidence: 'high',
          harness: { path: '.repro/PC-42/repro.mjs', outcome: 'reproduced' },
          comments: 6,
          rca_id: null,
          origin: {
            kind: 'tammy',
            ref: 'https://acme.slack.com/archives/C1/p1',
            reporter: 'Ben',
          },
        },
        error_data: null,
        message: null,
      });
    }
    if (req.method === 'POST' && req.path === `/api/cards/${CARD_ID}/convert`) {
      return json(res, 200, {
        success: true,
        data: {
          id: CARD_ID,
          from: 'investigation',
          to: 'bug',
          column: 'Execute',
          plan_carried_over: true,
        },
        error_data: null,
        message: null,
      });
    }
    return json(res, 404, {
      success: false,
      data: null,
      error_data: null,
      message: 'no such card',
    });
  });
  servers.push(server);
  return server;
}

function client(
  url: string,
  extra: Partial<ConstructorParameters<typeof KitchenClient>[0]> = {}
) {
  return new KitchenClient({
    baseUrl: url,
    token: TOKEN,
    backoffMs: 1,
    ...extra,
  });
}

const INPUT = {
  title: 'Sharing a list says no user with that email',
  description: 'Ben cannot share Weekend with Ann.',
  origin: {
    kind: 'tammy' as const,
    ref: 'https://acme.slack.com/archives/C1/p1760000000000100',
    reporter: 'Ben',
  },
  attachments: [
    {
      name: 'screenshot.png',
      url: 'https://acme.slack.com/files/U1/F1/screenshot.png',
    },
  ],
  metadata: { channel: 'C1', customer: 'acme' },
  start: true,
};

describe('KitchenClient', () => {
  it('files an investigation with the bearer token and the documented body', async () => {
    const server = await prepcook();
    const card = await client(server.url, { board: BOARD }).fileInvestigation(
      INPUT
    );
    expect(card).toEqual({ id: CARD_ID, url: CARD_URL, key: 'PC-42' });
    const req = server.requests[0]!;
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['content-type']).toBe('application/json');
    expect(JSON.parse(req.body)).toEqual({
      project_id: BOARD,
      title: INPUT.title,
      description: INPUT.description,
      work_class: 'investigation',
      origin: INPUT.origin,
      attachments: INPUT.attachments,
      metadata: INPUT.metadata,
      start: true,
    });
  });

  it('leaves the board to Prepcook when none is configured', async () => {
    const server = await prepcook();
    await client(server.url).fileInvestigation(INPUT);
    expect(JSON.parse(server.requests[0]!.body)).not.toHaveProperty(
      'project_id'
    );
  });

  it('retries a filing only when nothing was written (503)', async () => {
    const server = await prepcook({ failFirst: 2, status: 503 });
    const card = await client(server.url).fileInvestigation(INPUT);
    expect(card.key).toBe('PC-42');
    expect(server.requests).toHaveLength(3);
  });

  it('does not retry a filing that failed with a 500', async () => {
    const server = await prepcook({ failFirst: 1, status: 500 });
    await expect(
      client(server.url).fileInvestigation(INPUT)
    ).rejects.toMatchObject({
      status: 500,
    });
    expect(server.requests).toHaveLength(1);
  });

  it('retries a read on any 5xx, up to the limit', async () => {
    const server = await prepcook({ failFirst: 5, status: 502 });
    await expect(
      client(server.url, { retries: 2 }).getCard(CARD_ID)
    ).rejects.toBeInstanceOf(KitchenError);
    expect(server.requests).toHaveLength(3);
  });

  it('does not retry a 4xx, and says why without the token', async () => {
    const server = await prepcook();
    const error = (await client(server.url, { token: 'wrong' })
      .getCard(CARD_ID)
      .catch((e: unknown) => e)) as KitchenError;
    expect(error).toBeInstanceOf(KitchenError);
    expect(error.status).toBe(401);
    expect(error.message).toContain('bad token');
    expect(error.message).not.toContain('wrong');
    expect(server.requests).toHaveLength(1);
  });

  it('reads a card', async () => {
    const server = await prepcook();
    const card = await client(server.url).getCard(CARD_ID);
    expect(card).toMatchObject({
      key: 'PC-42',
      status: 'triaged',
      confidence: 'high',
    });
  });

  it('converts a card, naming who asked', async () => {
    const server = await prepcook();
    const converted = await client(server.url).convert(
      CARD_ID,
      'bug',
      'Ada Lovelace'
    );
    expect(converted).toMatchObject({
      to: 'bug',
      column: 'Execute',
      plan_carried_over: true,
    });
    expect(JSON.parse(server.requests[0]!.body)).toEqual({
      work_class: 'bug',
      by: 'Ada Lovelace',
    });
  });

  it('reports a Prepcook it cannot reach', async () => {
    const dead = client('http://127.0.0.1:9', { retries: 1 });
    await expect(dead.getCard(CARD_ID)).rejects.toMatchObject({ status: 0 });
  });

  it('reads the card id from a card URL', () => {
    expect(cardIdFromUrl(CARD_URL)).toBe(CARD_ID);
    expect(cardIdFromUrl('https://example.com/elsewhere')).toBeNull();
  });
});

describe('orders', () => {
  it('ties a card to its thread and finds it by id, key, thread and permalink', () => {
    const d = tempDir();
    dirs.push(d);
    const orders = new Orders(openDb(join(d.path, 'tammy.db')));
    orders.add({
      cardId: CARD_ID,
      cardKey: 'PC-42',
      cardUrl: CARD_URL,
      title: 'Sharing fails',
      channel: 'C1',
      threadTs: '1760000000.000100',
      permalink: 'https://acme.slack.com/archives/C1/p1760000000000100',
      reporter: 'Ben',
      reporterId: 'U1',
      customer: null,
    });
    expect(orders.byCardId(CARD_ID)?.cardKey).toBe('PC-42');
    expect(orders.find('pc-42')?.cardId).toBe(CARD_ID);
    expect(orders.forThread('C1', '1760000000.000100')).toHaveLength(1);
    expect(
      orders.byPermalink('https://acme.slack.com/archives/C1/p1760000000000100')
    ).toBeDefined();
    orders.markReported(CARD_ID);
    expect(orders.byCardId(CARD_ID)?.status).toBe('reported');
    orders.markConverted(CARD_ID);
    expect(orders.byCardId(CARD_ID)?.status).toBe('converted');
  });
});

describe('the card description', () => {
  it('lays out the report and quotes the customer', () => {
    const description = investigationDescription(
      {
        title: 'Sharing fails',
        summary: 'Ben cannot share Weekend with Ann.',
        steps: '1. Open Weekend\n2. Type Ann@Example.com\n3. Press Share',
        expected: 'Shared with Ann.',
        actual: '"No user with that email"',
        frequency: 'Every time',
      },
      {
        reporter: 'Ben',
        permalink: 'https://acme.slack.com/archives/C1/p1',
        product: 'Pantry',
        thread: [{ name: 'Ben', text: 'sharing my list fails\nfor Ann' }],
      }
    );
    expect(description).toContain('Reported in Slack by Ben');
    expect(description).toContain('## Steps to reproduce\n\n1. Open Weekend');
    expect(description).toContain('## How often\n\nEvery time');
    expect(description).not.toContain('## Environment');
    expect(description).toContain(
      '**Ben:**\n> sharing my list fails\n> for Ann'
    );
  });
});

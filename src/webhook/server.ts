// `POST /prepcook/webhook`: where Prepcook's webhook target delivers events.
// A delivery is verified against the shared secret, de-duplicated on
// `X-PrepCook-Delivery` (Prepcook retries a delivery with the same id), and
// answered at once; the work it causes — a model call, Slack posts — runs
// after the answer, so a slow translation never makes Prepcook retry.

import { createServer, type IncomingMessage, type Server } from 'node:http';

import { now, type Db } from '../db.js';
import { errorMessage, silentLogger, type Logger } from '../log.js';
import { isEnvelope, type Envelope } from './events.js';
import { verifyPrepCookSignature } from './verify.js';

const MAX_BODY = 1024 * 1024;

export interface Deliveries {
  /** Records the delivery; false when it was already seen. */
  claim(id: string, kind: string): boolean;
}

export class DbDeliveries implements Deliveries {
  constructor(private readonly db: Db) {}

  claim(id: string, kind: string): boolean {
    const result = this.db
      .prepare(
        'INSERT INTO deliveries (id, kind, received_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING'
      )
      .run(id, kind, now());
    return result.changes === 1;
  }
}

export interface ReceiveResult {
  status: number;
  body: string;
  /** The event to act on: set only for a verified, first-time delivery. */
  event?: Envelope;
}

/**
 * Judges one delivery from its raw body and headers. Pure apart from the
 * delivery record, so it is tested without a socket.
 */
export function receive(
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  deliveries: Deliveries
): ReceiveResult {
  const header = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  if (!verifyPrepCookSignature(raw, header('x-prepcook-signature'), secret)) {
    return { status: 401, body: 'bad signature' };
  }
  let event: unknown;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: 'not JSON' };
  }
  if (!isEnvelope(event)) return { status: 400, body: 'not an event' };
  const delivery = header('x-prepcook-delivery');
  if (delivery && !deliveries.claim(delivery, event.type)) {
    return { status: 200, body: 'duplicate' };
  }
  return { status: 202, body: 'accepted', event };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface WebhookServerOptions {
  path: string;
  secret: string;
  deliveries: Deliveries;
  onEvent: (event: Envelope) => Promise<void>;
  log?: Logger;
}

export interface WebhookServer {
  server: Server;
  /** Resolves when every event handed to `onEvent` so far has settled. */
  idle(): Promise<void>;
}

export function createWebhookServer(
  options: WebhookServerOptions
): WebhookServer {
  const log = options.log ?? silentLogger;
  const pending = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (url.pathname !== options.path) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    readBody(req)
      .then((raw) => {
        const result = receive(
          raw,
          req.headers,
          options.secret,
          options.deliveries
        );
        res.writeHead(result.status, { 'Content-Type': 'text/plain' });
        res.end(result.body);
        if (result.status === 401) {
          log.warn('refused a delivery with a bad or missing signature');
        } else if (result.body === 'duplicate') {
          log.debug(
            `dropped a repeated delivery ${String(req.headers['x-prepcook-delivery'])}`
          );
        }
        if (!result.event) return;
        const event = result.event;
        const work = options
          .onEvent(event)
          .catch((error: unknown) => {
            log.error(`handling ${event.type} failed: ${errorMessage(error)}`);
          })
          .finally(() => pending.delete(work));
        pending.add(work);
      })
      .catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(413).end();
        log.warn(`could not read a delivery: ${errorMessage(error)}`);
      });
  });
  return {
    server,
    idle: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

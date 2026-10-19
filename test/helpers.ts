// Fakes shared by the tests: an offline embedder, a scripted Anthropic
// client, a recording Slack client, and a tiny HTTP server.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import type Anthropic from '@anthropic-ai/sdk';

import type { MessagesClient } from '../src/brain/brain.js';
import { HashEmbedder as BuiltinHashEmbedder } from '../src/menu/embed.js';

export const FIXTURES = join(import.meta.dirname, 'fixtures');
export const MENU = join(FIXTURES, 'menu');

export function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'tammy-test-'));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

/**
 * The built-in word-hashing embedder, counting the texts it embeds. Good
 * enough to rank a tiny corpus, and needs no model download.
 */
export class HashEmbedder extends BuiltinHashEmbedder {
  calls = 0;

  override async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls += texts.length;
    return super.embed(texts);
  }
}

type Block = Anthropic.Messages.ContentBlock;

export function message(
  content: Block[],
  stop: Anthropic.Messages.StopReason = 'end_turn'
): Anthropic.Messages.Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    } as Anthropic.Messages.Usage,
  } as Anthropic.Messages.Message;
}

export function text(t: string): Anthropic.Messages.Message {
  return message([{ type: 'text', text: t, citations: null } as Block]);
}

let toolIds = 0;
export function toolUse(
  name: string,
  input: Record<string, unknown>,
  lead?: string
): Anthropic.Messages.Message {
  const blocks: Block[] = [];
  if (lead) blocks.push({ type: 'text', text: lead, citations: null } as Block);
  blocks.push({
    type: 'tool_use',
    id: `toolu_${++toolIds}`,
    name,
    input,
  } as Block);
  return message(blocks, 'tool_use');
}

export function classify(kind: string): Anthropic.Messages.Message {
  return toolUse('classify', { kind });
}

/**
 * A scripted Anthropic client: each create() returns the next response and
 * records the request.
 */
export class FakeClaude implements MessagesClient {
  readonly calls: Anthropic.Messages.MessageCreateParamsNonStreaming[] = [];
  constructor(
    private readonly script: (Anthropic.Messages.Message | Error)[]
  ) {}

  messages = {
    create: async (
      params: Anthropic.Messages.MessageCreateParamsNonStreaming
    ): Promise<Anthropic.Messages.Message> => {
      this.calls.push(structuredClone(params));
      const next = this.script.shift();
      if (!next) throw new Error('FakeClaude: no scripted response left');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

export interface Posted {
  method: string;
  args: Record<string, unknown>;
}

/**
 * A recording stand-in for Bolt's WebClient, with the methods Tammy calls.
 * `thread` is what conversations.replies returns.
 */
export function fakeWebClient(
  options: {
    thread?: { ts: string; user?: string; bot_id?: string; text: string }[];
    members?: Record<string, string[]>;
    names?: Record<string, string>;
  } = {}
) {
  const calls: Posted[] = [];
  let ts = 1000;
  const record = (method: string) => async (args: Record<string, unknown>) => {
    calls.push({ method, args });
    switch (method) {
      case 'chat.postMessage':
        return { ok: true, ts: `${++ts}.000100` };
      case 'chat.getPermalink':
        return {
          ok: true,
          permalink: `https://acme.slack.com/archives/${String(args.channel)}/p${String(args.message_ts).replace('.', '')}`,
        };
      case 'conversations.replies':
        return { ok: true, messages: options.thread ?? [] };
      case 'conversations.members':
        return {
          ok: true,
          members: options.members?.[String(args.channel)] ?? [],
        };
      case 'users.info': {
        const id = String(args.user);
        return {
          ok: true,
          user: { id, profile: { real_name: options.names?.[id] ?? id } },
        };
      }
      default:
        return { ok: true };
    }
  };
  const client = {
    chat: {
      postMessage: record('chat.postMessage'),
      update: record('chat.update'),
      getPermalink: record('chat.getPermalink'),
    },
    conversations: {
      replies: record('conversations.replies'),
      members: record('conversations.members'),
    },
    users: { info: record('users.info') },
  };
  return { client, calls };
}

export interface FakeServer {
  url: string;
  requests: {
    method: string;
    path: string;
    headers: IncomingMessage['headers'];
    body: string;
  }[];
  close: () => Promise<void>;
}

/** An HTTP server answering with `handler`, on a free local port. */
export async function fakeServer(
  handler: (
    req: {
      method: string;
      path: string;
      headers: IncomingMessage['headers'];
      body: string;
    },
    res: ServerResponse
  ) => void
): Promise<FakeServer> {
  const requests: FakeServer['requests'] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

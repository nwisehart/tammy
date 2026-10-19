// The Slack calls Tammy makes, behind a small interface. `fromWebClient`
// adapts Bolt's WebClient to it; tests hand the same adapter a fake client.

import type { webApi } from '@slack/bolt';

type WebClient = webApi.WebClient;

export interface SlackFile {
  name: string;
  url: string;
}

export interface SlackMessage {
  ts: string;
  user?: string;
  botId?: string;
  text: string;
  files: SlackFile[];
}

export interface SlackApi {
  post(
    channel: string,
    text: string,
    threadTs?: string
  ): Promise<{ ts: string }>;
  update(channel: string, ts: string, text: string): Promise<void>;
  permalink(channel: string, ts: string): Promise<string>;
  /** The thread's messages, oldest first (the parent included). */
  replies(channel: string, threadTs: string): Promise<SlackMessage[]>;
  members(channel: string): Promise<string[]>;
  userName(userId: string): Promise<string>;
}

interface RawMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: { name?: string; title?: string; permalink?: string }[];
}

export function fromWebClient(client: WebClient): SlackApi {
  const names = new Map<string, string>();
  return {
    async post(channel, text, threadTs) {
      const res = await client.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        unfurl_links: false,
        unfurl_media: false,
      });
      return { ts: String(res.ts) };
    },
    async update(channel, ts, text) {
      await client.chat.update({ channel, ts, text });
    },
    async permalink(channel, ts) {
      const res = await client.chat.getPermalink({ channel, message_ts: ts });
      return String(res.permalink);
    },
    async replies(channel, threadTs) {
      const out: SlackMessage[] = [];
      let cursor: string | undefined;
      do {
        const res = await client.conversations.replies({
          channel,
          ts: threadTs,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        for (const m of (res.messages ?? []) as RawMessage[]) {
          out.push({
            ts: String(m.ts),
            user: m.user,
            botId: m.bot_id,
            text: m.text ?? '',
            files: (m.files ?? [])
              .filter((f) => f.permalink)
              .map((f) => ({
                name: f.name ?? f.title ?? 'file',
                url: f.permalink!,
              })),
          });
        }
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor && out.length < 1000);
      return out;
    },
    async members(channel) {
      const out: string[] = [];
      let cursor: string | undefined;
      do {
        const res = await client.conversations.members({
          channel,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        });
        out.push(...(res.members ?? []));
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out;
    },
    async userName(userId) {
      const known = names.get(userId);
      if (known) return known;
      try {
        const res = await client.users.info({ user: userId });
        const name =
          res.user?.profile?.real_name ||
          res.user?.real_name ||
          res.user?.name ||
          userId;
        names.set(userId, name);
        return name;
      } catch {
        return userId;
      }
    },
  };
}

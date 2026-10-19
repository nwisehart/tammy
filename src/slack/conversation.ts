// One message to Tammy, from Slack event to posted answer: decide whether
// she should answer, show that she is writing, read the thread, let the
// brain answer with the tools for this thread, and edit the answer in.

import type { Brain, Turn } from '../brain/brain.js';
import type {
  FileInvestigationArgs,
  OrderStatus,
  ToolHost,
} from '../brain/tools.js';
import { investigationDescription } from '../kitchen/description.js';
import type { Kitchen } from '../kitchen/client.js';
import type { Orders } from '../kitchen/orders.js';
import { errorMessage, type Logger } from '../log.js';
import type { SearchResult } from '../menu/retrieve.js';
import type { SlackApi, SlackFile, SlackMessage } from './api.js';
import { formatReply, link, PLACEHOLDER } from './format.js';
import type { Conversations, Team } from './people.js';

export interface ConversationDeps {
  brain: Pick<Brain, 'respond'>;
  search: (query: string) => Promise<SearchResult>;
  kitchen: Kitchen;
  orders: Orders;
  conversations: Conversations;
  team: Team;
  product: string;
  notifyChannel: string | null;
  answerDms: boolean;
  log: Logger;
}

export interface IncomingMessage {
  channel: string;
  /** `im` for a direct message. */
  channelType?: string;
  user: string;
  text: string;
  ts: string;
  threadTs?: string;
  /** True when the message @-mentions Tammy. */
  mentioned: boolean;
  botUserId: string;
}

export const SNAG_REPLY =
  "Sorry, I hit a snag on my side and couldn't finish that. Could you try again in a minute? If it keeps happening, someone on the team will help.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Plain words for where a card is, for customers. */
export function stageInWords(status: string): string {
  switch (status) {
    case 'backlog':
      return 'waiting for the team to pick it up';
    case 'planning':
      return 'the team is looking into it';
    case 'triaged':
      return 'the team has finished looking into it';
    case 'executing':
    case 'reviewing':
    case 'pushed_mr':
      return 'the engineers are working on it';
    case 'closed':
    case 'cleanup':
      return 'the team has closed it';
    default:
      return 'it is with the team';
  }
}

function stripMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, 'g'), '').trim();
}

export function isPlaceholder(text: string): boolean {
  return text.trim() === PLACEHOLDER;
}

/** Decides whether Tammy answers this message at all. */
export async function shouldAnswer(
  msg: IncomingMessage,
  deps: ConversationDeps,
  slack: SlackApi
): Promise<boolean> {
  if (msg.channelType === 'im') return deps.answerDms;
  if (!deps.team.answersIn(msg.channel)) return false;
  if (msg.mentioned) return true;
  if (!msg.threadTs) return false;
  const conversation = deps.conversations.get(msg.channel, msg.threadTs);
  if (!conversation || conversation.handedOverAt) return false;
  // Someone on the team writing in the thread takes it over.
  if (await deps.team.isInternal(msg.user, slack)) {
    deps.conversations.handOver(msg.channel, msg.threadTs);
    deps.log.info(`${msg.channel}/${msg.threadTs}: handed over to the team`);
    return false;
  }
  return true;
}

async function threadTurns(
  slack: SlackApi,
  messages: SlackMessage[],
  botUserId: string
): Promise<{
  turns: Turn[];
  files: SlackFile[];
  lines: { name: string; text: string }[];
}> {
  const turns: Turn[] = [];
  const files: SlackFile[] = [];
  const lines: { name: string; text: string }[] = [];
  for (const m of messages) {
    if (isPlaceholder(m.text)) continue;
    const fromTammy = m.user === botUserId || (!!m.botId && !m.user);
    const text = stripMention(m.text, botUserId);
    if (fromTammy) {
      turns.push({ role: 'tammy', text });
      lines.push({ name: 'Tammy', text });
      continue;
    }
    const name = m.user ? await slack.userName(m.user) : 'someone';
    turns.push({ role: 'customer', text, name });
    lines.push({ name, text });
    files.push(...m.files);
  }
  return { turns, files, lines };
}

/** Handles one message Tammy should answer. */
export async function handleMessage(
  msg: IncomingMessage,
  deps: ConversationDeps,
  slack: SlackApi
): Promise<void> {
  const threadTs = msg.threadTs ?? msg.ts;
  deps.conversations.start(msg.channel, threadTs, msg.user);
  const placeholder = await slack.post(msg.channel, PLACEHOLDER, threadTs);
  try {
    const history = msg.threadTs
      ? await slack.replies(msg.channel, threadTs)
      : [{ ts: msg.ts, user: msg.user, text: msg.text, files: [] }];
    if (!history.some((m) => m.ts === msg.ts)) {
      history.push({ ts: msg.ts, user: msg.user, text: msg.text, files: [] });
    }
    const { turns, files, lines } = await threadTurns(
      slack,
      history,
      msg.botUserId
    );
    const internal = await deps.team.isInternal(msg.user, slack);
    const host = toolHost(msg, threadTs, internal, deps, slack, {
      files,
      lines,
    });
    const reply = await deps.brain.respond({
      turns,
      host,
      audience: internal ? 'internal' : 'customer',
    });
    deps.log.info(
      `${msg.channel}/${threadTs}: ${reply.kind}${reply.filed ? `, filed ${reply.filed.key}` : ''}${reply.asked ? ', asked for details' : ''}`
    );
    await slack.update(msg.channel, placeholder.ts, formatReply(reply));
  } catch (error) {
    deps.log.error(`${msg.channel}/${threadTs}: ${errorMessage(error)}`);
    await slack.update(msg.channel, placeholder.ts, SNAG_REPLY).catch(() => {});
  }
}

function toolHost(
  msg: IncomingMessage,
  threadTs: string,
  internal: boolean,
  deps: ConversationDeps,
  slack: SlackApi,
  thread: { files: SlackFile[]; lines: { name: string; text: string }[] }
): ToolHost {
  return {
    searchMenu: (query) => deps.search(query),

    canCheckOrders: () =>
      internal || deps.orders.forThread(msg.channel, threadTs).length > 0,

    async fileInvestigation(args: FileInvestigationArgs) {
      const existing = deps.orders.forThread(msg.channel, threadTs);
      if (existing.length) {
        return {
          refused: `This conversation was already taken to the kitchen as ${existing[0]!.cardKey}. Use check_order instead of filing again.`,
        };
      }
      const permalink = await slack.permalink(msg.channel, threadTs);
      const reporter = await slack.userName(msg.user);
      const card = await deps.kitchen.fileInvestigation({
        title: args.title,
        description: investigationDescription(args, {
          reporter,
          permalink,
          product: deps.product,
          thread: thread.lines,
        }),
        origin: { kind: 'tammy', ref: permalink, reporter },
        attachments: thread.files.slice(0, 20),
        metadata: {
          channel: msg.channel,
          ...(args.customer ? { customer: args.customer } : {}),
        },
        start: true,
      });
      deps.orders.add({
        cardId: card.id,
        cardKey: card.key,
        cardUrl: card.url,
        title: args.title,
        channel: msg.channel,
        threadTs,
        permalink,
        reporter,
        reporterId: msg.user,
        customer: args.customer ?? null,
      });
      if (deps.notifyChannel) {
        await slack
          .post(
            deps.notifyChannel,
            `New order ${link(card.url, card.key)}: ${args.title}\nReported by ${reporter} in ${link(permalink, 'this thread')}. Prepcook is investigating; I'll post the report here when it's in.`
          )
          .catch((error: unknown) =>
            deps.log.warn(
              `could not tell the team about ${card.key}: ${errorMessage(error)}`
            )
          );
      }
      return { key: card.key, url: card.url };
    },

    async checkOrder(key?: string) {
      let orders = deps.orders.forThread(msg.channel, threadTs);
      if (key) {
        const found = deps.orders.find(key);
        if (
          found &&
          (internal || orders.some((o) => o.cardId === found.cardId))
        ) {
          orders = [found];
        } else if (!found && internal && UUID.test(key)) {
          const card = await deps.kitchen.getCard(key);
          return [
            {
              key: card.key,
              title: card.title,
              stage: `${card.column} (${card.status})`,
              reportReady: card.report !== null,
            },
          ];
        } else {
          return {
            error: internal
              ? `I have no order ${key}.`
              : `I can only check on problems reported in this conversation.`,
          };
        }
      }
      if (!orders.length)
        return {
          error: 'Nothing from this conversation has gone to the kitchen.',
        };
      const out: OrderStatus[] = [];
      for (const order of orders) {
        const card = await deps.kitchen.getCard(order.cardId);
        out.push({
          key: card.key,
          title: card.title,
          stage: internal
            ? `${card.column} (${card.status})`
            : stageInWords(card.status),
          reportReady: card.report !== null,
        });
      }
      return out;
    },
  };
}

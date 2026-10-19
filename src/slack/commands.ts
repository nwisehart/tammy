// `/tammy status <key>` and `/tammy convert <key> [bug|story]`.
//
// Anyone can ask for the status of an order from their own channel; the
// team can ask about any. Converting an investigation into a bug (or a
// story) is the team's decision alone: a customer who runs it is told so,
// and nothing is sent to Prepcook.

import { KitchenError, type Kitchen } from '../kitchen/client.js';
import type { Orders } from '../kitchen/orders.js';
import { errorMessage, type Logger } from '../log.js';
import type { SlackApi } from './api.js';
import { stageInWords } from './conversation.js';
import { link } from './format.js';
import type { Team } from './people.js';

export interface CommandDeps {
  kitchen: Kitchen;
  orders: Orders;
  team: Team;
  log: Logger;
}

export interface CommandInput {
  text: string;
  userId: string;
  channelId: string;
}

export const HELP = [
  '*Tammy*',
  '`/tammy status PC-42` — where an order is',
  '`/tammy convert PC-42` — the team only: turn an investigation into a bug (`/tammy convert PC-42 story` for a story)',
].join('\n');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function kitchenTrouble(error: unknown, key: string): string {
  if (error instanceof KitchenError) {
    if (error.status === 404) return `The kitchen has no card ${key}.`;
    if (error.status === 409) {
      return `The kitchen refused: ${error.message.replace(/^.*?:\s*/, '')}`;
    }
    if (error.status === 401) {
      return "The kitchen didn't accept my token; check PREPCOOK_API_TOKEN on both sides.";
    }
    if (error.status === 0) return "I can't reach the kitchen right now.";
  }
  return `That didn't work: ${errorMessage(error)}`;
}

/** Runs a command and returns the (ephemeral) answer. */
export async function runCommand(
  input: CommandInput,
  deps: CommandDeps,
  slack: SlackApi
): Promise<string> {
  const [verb = '', key = '', target = 'bug'] = input.text.trim().split(/\s+/);
  const internal = await deps.team.isInternal(input.userId, slack);

  if (verb === 'status') {
    if (!key) return 'Which order? `/tammy status PC-42`';
    const order = deps.orders.find(key);
    if (!order && !(internal && UUID.test(key))) {
      return `I don't have an order ${key}.`;
    }
    if (
      order &&
      !internal &&
      order.channel !== input.channelId &&
      order.reporterId !== input.userId
    ) {
      return 'I can only tell you about problems reported in this channel.';
    }
    try {
      const card = await deps.kitchen.getCard(order?.cardId ?? key);
      if (!internal) return `*${card.key}*: ${stageInWords(card.status)}.`;
      const bits = [
        `*${link(card.url, card.key)}* ${card.title}`,
        `${card.column} (${card.status}) · ${card.work_class}`,
      ];
      if (card.confidence) bits.push(`confidence ${card.confidence}`);
      if (card.harness) bits.push(`harness ${card.harness.outcome}`);
      if (order) bits.push(link(order.permalink, 'customer thread'));
      return bits.join(' · ');
    } catch (error) {
      return kitchenTrouble(error, key);
    }
  }

  if (verb === 'convert') {
    if (!internal) {
      return "Only the team can do that. I've made sure they have everything from your report.";
    }
    if (!key) return 'Which order? `/tammy convert PC-42`';
    if (target !== 'bug' && target !== 'story') {
      return 'Convert to `bug` or `story`.';
    }
    const order = deps.orders.find(key);
    const id = order?.cardId ?? (UUID.test(key) ? key : null);
    if (!id) return `I don't have an order ${key}.`;
    const by = await slack.userName(input.userId);
    try {
      const converted = await deps.kitchen.convert(id, target, by);
      if (order) deps.orders.markConverted(order.cardId);
      deps.log.info(`${key} converted to ${target} by ${by}`);
      return `${order?.cardKey ?? key} is now a ${converted.to} and went to *${converted.column}*${converted.plan_carried_over ? ' — the investigation is its plan' : ' to be planned'}.`;
    } catch (error) {
      return kitchenTrouble(error, key);
    }
  }

  return HELP;
}

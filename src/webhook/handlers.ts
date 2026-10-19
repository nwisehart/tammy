// What Tammy does with a Prepcook event: an investigation's report goes to
// the customer's thread in plain English (and a short summary to the team);
// a conversion is announced in the thread. Events about cards Tammy did not
// file, and every other kind, are ignored.

import { cardIdFromUrl } from '../kitchen/client.js';
import type { Order, Orders } from '../kitchen/orders.js';
import type { Logger } from '../log.js';
import { whoseSide, type TriageReport } from '../plain-english/report.js';
import type { TranslateContext } from '../plain-english/translate.js';
import type { SlackApi } from '../slack/api.js';
import { escapeText, link } from '../slack/format.js';
import type {
  CardConverted,
  Envelope,
  InvestigationCompleted,
  IssueRef,
} from './events.js';

export interface EventDeps {
  orders: Orders;
  slack: SlackApi;
  translate: (
    report: TriageReport,
    context: TranslateContext
  ) => Promise<string>;
  product: string;
  notifyChannel: string | null;
  log: Logger;
}

function findOrder(
  orders: Orders,
  issue: IssueRef | undefined,
  source?: InvestigationCompleted['source']
): Order | undefined {
  const id = cardIdFromUrl(issue?.card_url);
  return (
    (id ? orders.byCardId(id) : undefined) ??
    (issue?.key ? orders.byKey(issue.key) : undefined) ??
    (source?.kind === 'tammy' ? orders.byPermalink(source.ref) : undefined)
  );
}

function firstSentence(text: string): string {
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim());
  return (match?.[0] ?? text).replace(/\s+/g, ' ').trim();
}

export function internalSummary(
  order: Order,
  data: InvestigationCompleted
): string {
  const side = whoseSide(data.report.scope);
  const facts = [
    `confidence ${data.confidence ?? 'unknown'}`,
    `harness ${data.harness.outcome}`,
    side === 'ours'
      ? 'a defect'
      : side === 'setup'
        ? 'configuration'
        : 'side unclear',
  ];
  const lines = [
    `Report in on ${link(data.issue.card_url ?? order.cardUrl, order.cardKey)}: ${escapeText(order.title)}`,
    facts.join(' · '),
    `> ${escapeText(firstSentence(data.report.what_happens))}`,
  ];
  if (data.report.workaround && !/^none/i.test(data.report.workaround.trim())) {
    lines.push(
      `Workaround: ${escapeText(firstSentence(data.report.workaround))}`
    );
  }
  lines.push(
    `I've explained it to the customer in ${link(order.permalink, 'their thread')}. To have it fixed: \`/tammy convert ${order.cardKey}\``
  );
  return lines.join('\n');
}

export function createEventHandler(deps: EventDeps) {
  return async (event: Envelope): Promise<void> => {
    if (event.type === 'investigation_completed') {
      const data = event.data as InvestigationCompleted;
      const order = findOrder(deps.orders, data.issue, data.source);
      if (!order) {
        deps.log.debug(
          `investigation_completed for ${data.issue?.key}: not one of mine`
        );
        return;
      }
      if (order.reportedAt) {
        deps.log.debug(`${order.cardKey}: report already posted`);
        return;
      }
      const message = await deps.translate(data.report, {
        title: order.title,
        product: deps.product,
        reproduced:
          data.harness.outcome === 'reproduced'
            ? true
            : data.harness.outcome === 'not_reproduced'
              ? false
              : null,
      });
      const greeting = order.reporterId
        ? `<@${order.reporterId}> the kitchen is back on ${order.cardKey}.`
        : `The kitchen is back on ${order.cardKey}.`;
      await deps.slack.post(
        order.channel,
        `${greeting}\n\n${message}`,
        order.threadTs
      );
      deps.orders.markReported(order.cardId);
      deps.log.info(`${order.cardKey}: report explained in the thread`);
      if (deps.notifyChannel) {
        await deps.slack.post(deps.notifyChannel, internalSummary(order, data));
      }
      return;
    }

    if (event.type === 'card_converted') {
      const data = event.data as CardConverted;
      const order = findOrder(deps.orders, data.issue);
      if (!order) {
        deps.log.debug(
          `card_converted for ${data.issue?.key}: not one of mine`
        );
        return;
      }
      const what = data.to === 'story' ? 'a piece of planned work' : 'a bug';
      await deps.slack.post(
        order.channel,
        `An update on ${order.cardKey}: the kitchen has taken this on as ${what}, so it's with the engineers now. They decide when it gets done, so I can't give you a date.`,
        order.threadTs
      );
      deps.orders.markConverted(order.cardId);
      deps.log.info(`${order.cardKey}: conversion to ${data.to} announced`);
      return;
    }

    deps.log.debug(`ignored a ${event.type} event`);
  };
}

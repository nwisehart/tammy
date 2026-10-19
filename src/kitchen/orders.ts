// Orders: the investigation cards Tammy filed, each tied to the Slack thread
// it came from, so a webhook about a card finds its way back to the customer.

import { now, type Db } from '../db.js';

export interface Order {
  cardId: string;
  cardKey: string;
  cardUrl: string;
  title: string;
  channel: string;
  threadTs: string;
  permalink: string;
  reporter: string | null;
  reporterId: string | null;
  customer: string | null;
  status: 'filed' | 'reported' | 'converted';
  filedAt: string;
  reportedAt: string | null;
  convertedAt: string | null;
}

interface Row {
  card_id: string;
  card_key: string;
  card_url: string;
  title: string;
  channel: string;
  thread_ts: string;
  permalink: string;
  reporter: string | null;
  reporter_id: string | null;
  customer: string | null;
  status: Order['status'];
  filed_at: string;
  reported_at: string | null;
  converted_at: string | null;
}

function fromRow(r: Row): Order {
  return {
    cardId: r.card_id,
    cardKey: r.card_key,
    cardUrl: r.card_url,
    title: r.title,
    channel: r.channel,
    threadTs: r.thread_ts,
    permalink: r.permalink,
    reporter: r.reporter,
    reporterId: r.reporter_id,
    customer: r.customer,
    status: r.status,
    filedAt: r.filed_at,
    reportedAt: r.reported_at,
    convertedAt: r.converted_at,
  };
}

export type NewOrder = Omit<
  Order,
  'status' | 'filedAt' | 'reportedAt' | 'convertedAt'
>;

export class Orders {
  constructor(private readonly db: Db) {}

  add(order: NewOrder): Order {
    this.db
      .prepare(
        `INSERT INTO orders (card_id, card_key, card_url, title, channel, thread_ts,
           permalink, reporter, reporter_id, customer, filed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        order.cardId,
        order.cardKey,
        order.cardUrl,
        order.title,
        order.channel,
        order.threadTs,
        order.permalink,
        order.reporter,
        order.reporterId,
        order.customer,
        now()
      );
    return this.byCardId(order.cardId)!;
  }

  byCardId(id: string): Order | undefined {
    const row = this.db
      .prepare('SELECT * FROM orders WHERE card_id = ?')
      .get(id) as Row | undefined;
    return row && fromRow(row);
  }

  byKey(key: string): Order | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM orders WHERE card_key = ? COLLATE NOCASE ORDER BY filed_at DESC LIMIT 1'
      )
      .get(key) as Row | undefined;
    return row && fromRow(row);
  }

  byPermalink(permalink: string): Order | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM orders WHERE permalink = ? ORDER BY filed_at DESC LIMIT 1'
      )
      .get(permalink) as Row | undefined;
    return row && fromRow(row);
  }

  forThread(channel: string, threadTs: string): Order[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM orders WHERE channel = ? AND thread_ts = ? ORDER BY filed_at'
        )
        .all(channel, threadTs) as Row[]
    ).map(fromRow);
  }

  /** The order a key or card id names, as typed in `/tammy status`. */
  find(keyOrId: string): Order | undefined {
    return this.byCardId(keyOrId) ?? this.byKey(keyOrId);
  }

  markReported(cardId: string): void {
    this.db
      .prepare(
        "UPDATE orders SET status = 'reported', reported_at = ? WHERE card_id = ? AND status = 'filed'"
      )
      .run(now(), cardId);
  }

  markConverted(cardId: string): void {
    this.db
      .prepare(
        "UPDATE orders SET status = 'converted', converted_at = ? WHERE card_id = ?"
      )
      .run(now(), cardId);
  }
}

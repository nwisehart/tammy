// Who is on the team, and which conversations Tammy is part of.
//
// The team ("internal users") is everyone in `slack.internal_users`, plus
// everyone who is a member of an internal channel. Membership is read from
// Slack and kept for ten minutes. Everyone else is a customer.

import type { SlackConfig } from '../config.js';
import { now, type Db } from '../db.js';
import type { SlackApi } from './api.js';

const MEMBERSHIP_TTL_MS = 10 * 60 * 1000;

export class Team {
  private cache: { at: number; members: Set<string> } | null = null;

  constructor(
    private readonly config: SlackConfig,
    private readonly clock: () => number = Date.now
  ) {}

  async isInternal(userId: string, slack: SlackApi): Promise<boolean> {
    if (this.config.internalUsers.includes(userId)) return true;
    if (!this.config.internalChannels.length) return false;
    if (!this.cache || this.clock() - this.cache.at > MEMBERSHIP_TTL_MS) {
      const members = new Set<string>();
      for (const channel of this.config.internalChannels) {
        try {
          for (const m of await slack.members(channel)) members.add(m);
        } catch {
          // A channel Tammy is not in cannot vouch for anyone.
        }
      }
      this.cache = { at: this.clock(), members };
    }
    return this.cache.members.has(userId);
  }

  isCustomerChannel(channel: string): boolean {
    return this.config.customerChannels.includes(channel);
  }

  isInternalChannel(channel: string): boolean {
    return this.config.internalChannels.includes(channel);
  }

  /** Channels where an @-mention gets an answer. */
  answersIn(channel: string): boolean {
    return this.isCustomerChannel(channel) || this.isInternalChannel(channel);
  }
}

export interface Conversation {
  channel: string;
  threadTs: string;
  startedBy: string | null;
  handedOverAt: string | null;
}

/**
 * The threads Tammy is in. Once she is in a thread she answers every reply
 * there without being mentioned again — until someone on the team writes in
 * it without mentioning her, which hands the thread to them.
 */
export class Conversations {
  constructor(private readonly db: Db) {}

  get(channel: string, threadTs: string): Conversation | undefined {
    const row = this.db
      .prepare(
        'SELECT channel, thread_ts, started_by, handed_over_at FROM conversations WHERE channel = ? AND thread_ts = ?'
      )
      .get(channel, threadTs) as
      | {
          channel: string;
          thread_ts: string;
          started_by: string | null;
          handed_over_at: string | null;
        }
      | undefined;
    return (
      row && {
        channel: row.channel,
        threadTs: row.thread_ts,
        startedBy: row.started_by,
        handedOverAt: row.handed_over_at,
      }
    );
  }

  start(channel: string, threadTs: string, user: string | null): void {
    this.db
      .prepare(
        `INSERT INTO conversations (channel, thread_ts, started_by, started_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(channel, thread_ts) DO UPDATE SET handed_over_at = NULL`
      )
      .run(channel, threadTs, user, now());
  }

  handOver(channel: string, threadTs: string): void {
    this.db
      .prepare(
        'UPDATE conversations SET handed_over_at = ? WHERE channel = ? AND thread_ts = ? AND handed_over_at IS NULL'
      )
      .run(now(), channel, threadTs);
  }
}

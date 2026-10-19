// The one SQLite file Tammy keeps (`<data_dir>/tammy.db`): the menu index,
// the orders she has taken to the kitchen, the conversations she is in, and
// the webhook deliveries already handled. This file is what to back up; the
// data directory's `models/` folder can always be downloaded again.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    root TEXT NOT NULL,
    source TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    url TEXT,
    title TEXT NOT NULL,
    hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    heading TEXT NOT NULL,
    trail TEXT NOT NULL,
    anchor TEXT,
    line INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX chunks_document ON chunks(document_id);
  CREATE TABLE orders (
    card_id TEXT PRIMARY KEY,
    card_key TEXT NOT NULL,
    card_url TEXT NOT NULL,
    title TEXT NOT NULL,
    channel TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    permalink TEXT NOT NULL,
    reporter TEXT,
    reporter_id TEXT,
    customer TEXT,
    status TEXT NOT NULL DEFAULT 'filed',
    filed_at TEXT NOT NULL,
    reported_at TEXT,
    converted_at TEXT
  );
  CREATE INDEX orders_key ON orders(card_key);
  CREATE INDEX orders_thread ON orders(channel, thread_ts);
  CREATE TABLE conversations (
    channel TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    started_by TEXT,
    started_at TEXT NOT NULL,
    handed_over_at TEXT,
    PRIMARY KEY (channel, thread_ts)
  );
  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
  `,
];

/** Opens (creating when needed) the database, with sqlite-vec loaded. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  sqliteVec.load(db);
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function now(): string {
  return new Date().toISOString();
}

#!/usr/bin/env node
// `tammy index`, `tammy ask`, `tammy start`.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { Brain } from './brain/brain.js';
import { connect } from './brain/connect.js';
import type { ToolHost } from './brain/tools.js';
import { loadConfig, type SourceSpec, type TammyConfig } from './config.js';
import { openDb } from './db.js';
import { createLogger, errorMessage } from './log.js';
import { indexMenu, watchMenu } from './menu/indexer.js';
import { openMenu } from './menu/open.js';
import { describeCitation } from './menu/retrieve.js';

const USAGE = `Usage:
  tammy index [<path or url>…] [--full] [--watch]
      Index the menu: the sources given, or [[menu.sources]] in tammy.toml.
      Only changed documents are re-embedded unless --full; --watch re-indexes
      local sources when their files change. The first run downloads the
      embedding model into <data_dir>/models.
  tammy ask "<question>" [--k <n>]
      Show the passages Tammy would read for a question, and her answer when
      Claude is set up (ANTHROPIC_API_KEY, or [brain] provider = "seat").
      Offline otherwise; nothing goes to Slack or Prepcook.
  tammy start
      Run Tammy: Slack (Socket Mode) and the Prepcook webhook.

Options:
  --config <file>   tammy.toml to read (default: ./tammy.toml, or $TAMMY_CONFIG)
`;

function sourcesFromArgs(args: string[], cwd: string): SourceSpec[] {
  return args.map((arg) =>
    /^https?:\/\//.test(arg)
      ? { kind: 'url', url: arg, depth: 1, include: [] }
      : { kind: 'path', path: resolve(cwd, arg), include: [] }
  );
}

async function runIndex(
  config: TammyConfig,
  positionals: string[],
  flags: { full: boolean; watch: boolean }
): Promise<number> {
  const log = createLogger(config.logLevel, 'index');
  const sources = positionals.length
    ? sourcesFromArgs(positionals, process.cwd())
    : config.menu.sources;
  if (!sources.length) {
    log.error(
      'nothing to index: name a path or URL, or add [[menu.sources]] to tammy.toml'
    );
    return 2;
  }
  const db = openDb(config.dbPath);
  const menu = openMenu(config, db, { allowDownload: true });
  const once = async (full: boolean) => {
    const started = Date.now();
    const s = await indexMenu(menu.store, menu.embedder, sources, {
      chunkTokens: config.menu.chunkTokens,
      overlapTokens: config.menu.overlapTokens,
      full,
      log,
    });
    const counts = menu.store.counts();
    log.info(
      `${s.added} added, ${s.updated} updated, ${s.unchanged} unchanged, ${s.removed} removed; ` +
        `${counts.documents} document(s), ${counts.chunks} chunk(s) in ${config.dbPath} (${((Date.now() - started) / 1000).toFixed(1)}s)`
    );
    return s;
  };
  const summary = await once(flags.full);
  if (!flags.watch) {
    db.close();
    return summary.failedRoots.length ? 1 : 0;
  }
  const stop = watchMenu(sources, async () => void (await once(false)), log);
  await new Promise<void>((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  stop();
  db.close();
  return 0;
}

async function runAsk(
  config: TammyConfig,
  question: string,
  k: number | undefined
): Promise<number> {
  const log = createLogger(config.logLevel, 'ask');
  const db = openDb(config.dbPath);
  const menu = openMenu(config, db, { allowDownload: false });
  if (!menu.retriever.status().model) {
    log.error('the menu is empty: run `tammy index` first');
    db.close();
    return 2;
  }
  const result = await menu.retriever.search(question, k);
  const out = process.stdout;
  out.write(`Question: ${question}\n`);
  out.write(
    `Best score ${result.best.toFixed(3)} (min_score ${config.menu.minScore})${result.thin ? ' — thin: Tammy would say she does not know' : ''}\n\n`
  );
  result.passages.forEach((p, i) => {
    const preview = p.text.replace(/\s+/g, ' ').slice(0, 280);
    out.write(
      `[${i + 1}] ${p.score.toFixed(3)}  ${p.trail.join(' › ') || p.heading}\n    ${describeCitation(p.citation)}\n    ${preview}${p.text.length > 280 ? '…' : ''}\n\n`
    );
  });

  const provider = connect(config, log, { requireKey: false });
  if (!provider) {
    out.write(
      'No ANTHROPIC_API_KEY set: not asking the model. These are the passages Tammy would read.\n'
    );
    db.close();
    return 0;
  }
  const brain = new Brain({
    provider,
    model: config.brain.model,
    classifierModel: config.brain.classifierModel,
    product: config.brain.product,
    maxTokens: config.brain.maxTokens,
    maxToolRounds: config.brain.maxToolRounds,
    log,
  });
  const offline: ToolHost = {
    searchMenu: (query) => menu.retriever.search(query),
    fileInvestigation: async () => ({
      refused:
        'Filing is not available from the command line. Tell the user you would take this to the kitchen.',
    }),
    checkOrder: async () => ({ error: 'No orders from the command line.' }),
    canCheckOrders: () => false,
  };
  const reply = await brain.respond({
    turns: [{ role: 'customer', text: question }],
    host: offline,
    audience: 'customer',
  });
  out.write(`Tammy (${reply.kind}):\n${reply.text}\n`);
  reply.citations.forEach((c, i) =>
    out.write(`  [${i + 1}] ${describeCitation(c)}\n`)
  );
  db.close();
  return 0;
}

export async function cli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      full: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      k: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    process.stdout.write(USAGE);
    return command || values.help ? 0 : 2;
  }
  const config = loadConfig({ path: values.config });
  if (command === 'index') {
    return runIndex(config, rest, { full: values.full, watch: values.watch });
  }
  if (command === 'ask') {
    const question = rest.join(' ').trim();
    if (!question) {
      process.stderr.write('tammy ask "<question>"\n');
      return 2;
    }
    const k = values.k ? Number(values.k) : undefined;
    return runAsk(config, question, k && k > 0 ? k : undefined);
  }
  if (command === 'start') {
    const { start } = await import('./index.js');
    const log = createLogger(config.logLevel);
    const stop = await start(config, log);
    await new Promise<void>((done) => {
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
    await stop();
    return 0;
  }
  process.stderr.write(`unknown command ${command}\n\n${USAGE}`);
  return 2;
}

cli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`tammy: ${errorMessage(error)}\n`);
    process.exit(1);
  });

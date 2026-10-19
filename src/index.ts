#!/usr/bin/env node
// Boot: load the config, open the menu, and start the Slack app (Socket
// Mode) and the webhook server Prepcook delivers to.

import { pathToFileURL } from 'node:url';

import { Brain } from './brain/brain.js';
import { connect } from './brain/connect.js';
import { ConfigError, loadConfig, type TammyConfig } from './config.js';
import { openDb } from './db.js';
import { KitchenClient } from './kitchen/client.js';
import { Orders } from './kitchen/orders.js';
import { createLogger, errorMessage, type Logger } from './log.js';
import { openMenu } from './menu/open.js';
import { translateReport } from './plain-english/translate.js';
import { fromWebClient } from './slack/api.js';
import { createSlackApp } from './slack/app.js';
import { Conversations, Team } from './slack/people.js';
import { createEventHandler } from './webhook/handlers.js';
import { createWebhookServer, DbDeliveries } from './webhook/server.js';

export async function start(
  config: TammyConfig,
  log: Logger
): Promise<() => Promise<void>> {
  const s = config.secrets;
  const botToken = s.require(
    'TAMMY_SLACK_BOT_TOKEN',
    'Slack bot token, xoxb-…'
  );
  const appToken = s.require(
    'TAMMY_SLACK_APP_TOKEN',
    'Slack app-level token for Socket Mode, xapp-…'
  );
  const llm = connect(config, log, { requireKey: true })!;
  const prepcookToken = s.require('PREPCOOK_API_TOKEN', "Prepcook's card API");
  const webhookSecret = s.require(
    'TAMMY_WEBHOOK_SECRET',
    "the Prepcook webhook target's secret"
  );

  const db = openDb(config.dbPath);
  const menu = openMenu(config, db, { allowDownload: false });
  const status = menu.retriever.status();
  if (!status.model) {
    log.warn(
      'the menu is empty: run `pnpm tammy index` before customers ask anything'
    );
  } else {
    log.info(
      `menu: ${status.documents} document(s), ${status.chunks} chunk(s), ${status.model}`
    );
  }

  // Where the team hears that Claude is unavailable; bound once Slack is up.
  const teamChannel =
    config.slack.notifyChannel ?? config.slack.internalChannels[0] ?? null;
  let tellTeam: (text: string) => Promise<void> = async () => {};
  const brain = new Brain({
    provider: llm,
    model: config.brain.model,
    classifierModel: config.brain.classifierModel,
    product: config.brain.product,
    maxTokens: config.brain.maxTokens,
    maxToolRounds: config.brain.maxToolRounds,
    log: log.child('brain'),
    onUnavailable: (text) => tellTeam(text),
  });
  const kitchen = new KitchenClient({
    baseUrl: config.kitchen.url,
    token: prepcookToken,
    board: config.kitchen.board,
    retries: config.kitchen.retries,
    timeoutMs: config.kitchen.timeoutMs,
  });
  const orders = new Orders(db);
  const team = new Team(config.slack);

  const app = createSlackApp({
    botToken,
    appToken,
    signingSecret: s.get('TAMMY_SLACK_SIGNING_SECRET'),
    logLevel: config.logLevel,
    log: log.child('slack'),
    deps: {
      brain,
      search: (query) => menu.retriever.search(query),
      kitchen,
      orders,
      conversations: new Conversations(db),
      team,
      product: config.brain.product,
      notifyChannel: config.slack.notifyChannel,
      answerDms: config.slack.answerDms,
      log: log.child('slack'),
    },
  });

  const webhook = createWebhookServer({
    path: config.webhook.path,
    secret: webhookSecret,
    deliveries: new DbDeliveries(db),
    log: log.child('webhook'),
    onEvent: createEventHandler({
      orders,
      slack: fromWebClient(app.client),
      translate: (report, context) =>
        translateReport(report, context, {
          provider: llm,
          model: config.brain.model,
          log: log.child('plain-english'),
        }),
      product: config.brain.product,
      notifyChannel: config.slack.notifyChannel,
      log: log.child('webhook'),
    }),
  });

  if (teamChannel) {
    const slack = fromWebClient(app.client);
    tellTeam = async (text) => {
      await slack.post(teamChannel, text);
    };
  }

  await app.start();
  log.info('connected to Slack (Socket Mode)');
  await new Promise<void>((resolve, reject) => {
    webhook.server.once('error', reject);
    webhook.server.listen(config.webhook.port, config.webhook.host, () =>
      resolve()
    );
  });
  log.info(
    `webhook listening on http://${config.webhook.host}:${config.webhook.port}${config.webhook.path}`
  );

  return async () => {
    await new Promise<void>((resolve) => webhook.server.close(() => resolve()));
    await webhook.idle();
    await app.stop();
    db.close();
  };
}

export async function main(): Promise<void> {
  const configArg = process.argv.indexOf('--config');
  let config: TammyConfig;
  try {
    config = loadConfig({
      path: configArg > 0 ? process.argv[configArg + 1] : undefined,
    });
  } catch (error) {
    process.stderr.write(`tammy: ${errorMessage(error)}\n`);
    process.exit(2);
  }
  const log = createLogger(config.logLevel);
  if (!config.configPath) log.warn('no tammy.toml found; running on defaults');
  let stop: () => Promise<void>;
  try {
    stop = await start(config, log);
  } catch (error) {
    log.error(errorMessage(error));
    process.exit(error instanceof ConfigError ? 2 : 1);
  }
  const shutdown = (signal: string) => {
    log.info(`${signal}: stopping`);
    stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log.error(errorMessage(error));
        process.exit(1);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}

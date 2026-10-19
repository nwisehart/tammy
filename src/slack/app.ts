// The Bolt app, in Socket Mode: no public URL is needed for Slack. Tammy
// answers @-mentions in the configured channels, direct messages, and
// replies in threads she is already in; `/tammy` runs the commands.

import { App, LogLevel, type webApi } from '@slack/bolt';

import type { Logger } from '../log.js';
import { fromWebClient, type SlackApi } from './api.js';
import { runCommand, type CommandDeps } from './commands.js';
import {
  handleMessage,
  shouldAnswer,
  type ConversationDeps,
  type IncomingMessage,
} from './conversation.js';

export type SlackDeps = ConversationDeps & CommandDeps;

/** The slice of a Bolt App the handlers register on; tests pass a fake. */
export interface HandlerRegistry {
  event(
    name: 'app_mention',
    handler: (args: MentionArgs) => Promise<void>
  ): unknown;
  message(handler: (args: MessageArgs) => Promise<void>): unknown;
  command(name: string, handler: (args: CommandArgs) => Promise<void>): unknown;
}

interface Ctx {
  botUserId?: string;
}

export interface MentionArgs {
  event: {
    channel: string;
    user?: string;
    text: string;
    ts: string;
    thread_ts?: string;
    bot_id?: string;
  };
  client: webApi.WebClient;
  context: Ctx;
}

export interface MessageArgs {
  message: {
    channel: string;
    channel_type?: string;
    subtype?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts: string;
    thread_ts?: string;
  };
  client: webApi.WebClient;
  context: Ctx;
}

export interface CommandArgs {
  command: { text: string; user_id: string; channel_id: string };
  ack: (response?: string) => Promise<void>;
  respond: (message: {
    text: string;
    response_type: 'ephemeral';
  }) => Promise<unknown>;
  client: webApi.WebClient;
}

export function registerHandlers(
  app: HandlerRegistry,
  deps: SlackDeps,
  slackFor: (client: webApi.WebClient) => SlackApi = fromWebClient
): void {
  const run = async (msg: IncomingMessage, slack: SlackApi) => {
    if (!(await shouldAnswer(msg, deps, slack))) {
      deps.log.debug(`not answering ${msg.channel}/${msg.ts}`);
      return;
    }
    await handleMessage(msg, deps, slack);
  };

  app.event('app_mention', async ({ event, client, context }) => {
    if (!event.user || event.bot_id || !context.botUserId) return;
    await run(
      {
        channel: event.channel,
        user: event.user,
        text: event.text,
        ts: event.ts,
        threadTs: event.thread_ts,
        mentioned: true,
        botUserId: context.botUserId,
      },
      slackFor(client)
    );
  });

  app.message(async ({ message, client, context }) => {
    if (message.subtype || message.bot_id || !message.user) return;
    const botUserId = context.botUserId;
    if (!botUserId || message.user === botUserId) return;
    const text = message.text ?? '';
    const mentioned = text.includes(`<@${botUserId}`);
    // In channels a mention arrives as app_mention too; answer it once.
    if (mentioned && message.channel_type !== 'im') return;
    await run(
      {
        channel: message.channel,
        channelType: message.channel_type,
        user: message.user,
        text,
        ts: message.ts,
        threadTs: message.thread_ts,
        mentioned,
        botUserId,
      },
      slackFor(client)
    );
  });

  app.command('/tammy', async ({ command, ack, respond, client }) => {
    await ack();
    const text = await runCommand(
      {
        text: command.text,
        userId: command.user_id,
        channelId: command.channel_id,
      },
      deps,
      slackFor(client)
    );
    await respond({ text, response_type: 'ephemeral' });
  });
}

const BOLT_LEVELS: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};

export function createSlackApp(options: {
  botToken: string;
  appToken: string;
  signingSecret?: string;
  logLevel: string;
  deps: SlackDeps;
  log: Logger;
}): App {
  const app = new App({
    token: options.botToken,
    appToken: options.appToken,
    socketMode: true,
    ...(options.signingSecret ? { signingSecret: options.signingSecret } : {}),
    logLevel: BOLT_LEVELS[options.logLevel] ?? LogLevel.INFO,
  });
  registerHandlers(app as unknown as HandlerRegistry, options.deps);
  app.error(async (error) => {
    options.log.error(`slack: ${error.message}`);
  });
  return app;
}

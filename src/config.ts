// Tammy's configuration: `tammy.toml` for everything that is not a secret,
// and the six secrets from the environment or a KEY=VALUE secrets file.
// The environment always wins over the file, so a service manager can
// override one value without rewriting the file.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

import { probeSeat, type SeatProbeResult } from './brain/claude-cli.js';
import type { ProviderName } from './brain/provider.js';
import type { LogLevel } from './log.js';

export const SECRET_NAMES = [
  'TAMMY_SLACK_BOT_TOKEN',
  'TAMMY_SLACK_APP_TOKEN',
  'TAMMY_SLACK_SIGNING_SECRET',
  'ANTHROPIC_API_KEY',
  'PREPCOOK_API_TOKEN',
  'TAMMY_WEBHOOK_SECRET',
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export const DEFAULT_SECRETS_FILE = '~/.config/tammy/secrets.env';
export const DEFAULT_MODEL = 'claude-sonnet-4-5';
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type SourceSpec =
  | { kind: 'path'; path: string; include: string[] }
  | { kind: 'url'; url: string; depth: number; include: string[] };

export interface SlackConfig {
  /** Channels where customers talk to Tammy. */
  customerChannels: string[];
  /** Channels whose members are the team; Tammy answers there too. */
  internalChannels: string[];
  /** Slack user ids treated as the team wherever they write. */
  internalUsers: string[];
  /** Where new orders and finished reports are announced to the team. */
  notifyChannel: string | null;
  /** Whether Tammy answers direct messages. */
  answerDms: boolean;
}

export interface SeatConfig {
  /** The `claude` CLI: a name looked up on PATH, or a path. */
  claudeBinary: string;
  /** The seat's login directory (CLAUDE_CONFIG_DIR), or the CLI's default. */
  claudeConfigDir: string | null;
  /** The most model turns one message may take. */
  maxTurns: number;
  /** An empty directory the CLI runs in, so it loads no project files. */
  cwd: string;
  /** Variables set on the CLI's environment on top of Tammy's own. */
  env: Record<string, string>;
}

export interface BrainConfig {
  /** The product Tammy supports, as customers call it. */
  product: string;
  /**
   * How Tammy reaches Claude: an API key, or the Claude subscription
   * signed in on this host. Null when tammy.toml does not say; then
   * `chooseProvider` decides.
   */
  provider: ProviderName | null;
  model: string;
  classifierModel: string;
  maxTokens: number;
  maxToolRounds: number;
  seat: SeatConfig;
}

export interface EmbeddingsConfig {
  model: string;
  quantized: boolean;
  /** A directory already holding the model's files, for offline machines. */
  localDir: string | null;
  /** Where downloaded model files are kept: `<data_dir>/models`. */
  cacheDir: string;
}

export interface MenuConfig {
  sources: SourceSpec[];
  chunkTokens: number;
  overlapTokens: number;
  topK: number;
  minScore: number;
  embeddings: EmbeddingsConfig;
}

export interface KitchenConfig {
  url: string;
  board: string | null;
  retries: number;
  timeoutMs: number;
}

export interface WebhookConfig {
  host: string;
  port: number;
  path: string;
}

export interface TammyConfig {
  /** The file read, or null when Tammy runs on defaults. */
  configPath: string | null;
  /** Relative paths in the config resolve against this directory. */
  baseDir: string;
  dataDir: string;
  dbPath: string;
  logLevel: LogLevel;
  slack: SlackConfig;
  brain: BrainConfig;
  menu: MenuConfig;
  kitchen: KitchenConfig;
  webhook: WebhookConfig;
  secrets: Secrets;
}

/**
 * The secrets, looked up by name: the environment first, then the secrets
 * file. Values never appear in an error message or a log line.
 */
export class Secrets {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly file: Map<string, string>,
    readonly filePath: string | null
  ) {}

  get(name: SecretName): string | undefined {
    const fromEnv = this.env[name]?.trim();
    if (fromEnv) return fromEnv;
    const fromFile = this.file.get(name)?.trim();
    return fromFile || undefined;
  }

  has(name: SecretName): boolean {
    return this.get(name) !== undefined;
  }

  /** The value, or a ConfigError naming the secret and where to put it. */
  require(name: SecretName, purpose: string): string {
    const value = this.get(name);
    if (value !== undefined) return value;
    const where = this.filePath
      ? `the environment or ${this.filePath}`
      : 'the environment or a secrets_file';
    throw new ConfigError(
      `${name} is not set (${purpose}): put it in ${where}`
    );
  }

  /** Which secrets are set and where each came from; never the values. */
  describe(): Record<SecretName, 'env' | 'file' | 'missing'> {
    const out = {} as Record<SecretName, 'env' | 'file' | 'missing'>;
    for (const name of SECRET_NAMES) {
      out[name] = this.env[name]?.trim()
        ? 'env'
        : this.file.get(name)?.trim()
          ? 'file'
          : 'missing';
    }
    return out;
  }
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function resolveFrom(baseDir: string, path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

/**
 * Reads a KEY=VALUE secrets file. Blank lines and `#` comments are skipped,
 * `export ` prefixes and matching quotes around a value are dropped. The file
 * must be readable by its owner only (mode 0600 or tighter).
 */
export function readSecretsFile(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  const stat = statSync(path);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
    throw new ConfigError(
      `${path} is mode ${mode}; secrets must be readable by you alone: chmod 600 ${path}`
    );
  }
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) {
      throw new ConfigError(`${path}:${i + 1} is not KEY=VALUE`);
    }
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value.endsWith(value[0])
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  });
  return out;
}

type Table = Record<string, unknown>;

function table(value: unknown, key: string): Table {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${key} must be a table`);
  }
  return value as Table;
}

function str(t: Table, key: string, path: string, fallback: string): string;
function str(
  t: Table,
  key: string,
  path: string,
  fallback: null
): string | null;
function str(
  t: Table,
  key: string,
  path: string,
  fallback: string | null
): string | null {
  const v = t[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'string') throw new ConfigError(`${path}${key} is a string`);
  return v.trim() === '' ? fallback : v.trim();
}

function num(
  t: Table,
  key: string,
  path: string,
  fallback: number,
  min: number,
  max: number
): number {
  const v = t[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || Number.isNaN(v) || v < min || v > max) {
    throw new ConfigError(`${path}${key} is a number from ${min} to ${max}`);
  }
  return v;
}

function bool(t: Table, key: string, path: string, fallback: boolean) {
  const v = t[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean')
    throw new ConfigError(`${path}${key} is true or false`);
  return v;
}

function strings(t: Table, key: string, path: string): string[] {
  const v = t[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ConfigError(`${path}${key} is a list of strings`);
  }
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
}

function parseSources(value: unknown, baseDir: string): SourceSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError('menu.sources is a list of [[menu.sources]] tables');
  }
  return value.map((raw, i) => {
    const t = table(raw, `menu.sources[${i}]`);
    const at = `menu.sources[${i}].`;
    const include = strings(t, 'include', at);
    const path = str(t, 'path', at, null);
    const url = str(t, 'url', at, null);
    if (path && url) throw new ConfigError(`${at} has both path and url`);
    if (path)
      return { kind: 'path', path: resolveFrom(baseDir, path), include };
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ConfigError(`${at}url is not a URL`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ConfigError(`${at}url must be http(s)`);
      }
      return {
        kind: 'url',
        url: parsed.toString(),
        depth: num(t, 'depth', at, 1, 0, 10),
        include,
      };
    }
    throw new ConfigError(`${at} needs a path or a url`);
  });
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface LoadOptions {
  /** An explicit config path (`--config`, else `TAMMY_CONFIG`). */
  path?: string;
  env?: NodeJS.ProcessEnv;
  /** Where to look for `tammy.toml` when no path is given. */
  cwd?: string;
}

/**
 * Loads the config. An explicit path must exist; without one, `tammy.toml`
 * in the working directory is read when it is there, and defaults apply
 * otherwise (enough for `tammy index` and `tammy ask`).
 */
export function loadConfig(options: LoadOptions = {}): TammyConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.path ?? env.TAMMY_CONFIG;
  let configPath: string | null = null;
  let doc: Table = {};
  if (explicit) {
    configPath = resolveFrom(cwd, explicit);
    if (!existsSync(configPath)) {
      throw new ConfigError(`no config at ${configPath}`);
    }
  } else if (existsSync(join(cwd, 'tammy.toml'))) {
    configPath = join(cwd, 'tammy.toml');
  }
  if (configPath) {
    try {
      doc = parseToml(readFileSync(configPath, 'utf8')) as Table;
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(
        `${configPath}: ${error instanceof Error ? error.message : error}`
      );
    }
  }
  const baseDir = configPath ? dirname(configPath) : cwd;

  const dataDir = resolveFrom(baseDir, str(doc, 'data_dir', '', 'data'));
  const level = str(doc, 'log_level', '', env.TAMMY_LOG_LEVEL ?? 'info');
  if (!LOG_LEVELS.includes(level as LogLevel)) {
    throw new ConfigError(`log_level is one of ${LOG_LEVELS.join(', ')}`);
  }

  const secretsSetting =
    env.TAMMY_SECRETS_FILE ?? str(doc, 'secrets_file', '', null);
  const secretsPath = resolveFrom(
    baseDir,
    secretsSetting ?? DEFAULT_SECRETS_FILE
  );
  const secrets = new Secrets(env, readSecretsFile(secretsPath), secretsPath);

  const slack = table(doc.slack, 'slack');
  const brain = table(doc.brain, 'brain');
  const menu = table(doc.menu, 'menu');
  const embeddings = table(menu.embeddings, 'menu.embeddings');
  const kitchen = table(doc.kitchen, 'kitchen');
  const webhook = table(doc.webhook, 'webhook');

  const model = str(brain, 'model', 'brain.', DEFAULT_MODEL);
  const provider = str(brain, 'provider', 'brain.', null);
  if (provider !== null && provider !== 'api' && provider !== 'seat') {
    throw new ConfigError('brain.provider is "api" or "seat"');
  }
  const maxToolRounds = num(brain, 'max_tool_rounds', 'brain.', 6, 1, 20);
  const binarySetting = str(brain, 'claude_binary', 'brain.', 'claude');
  const claudeBinary =
    binarySetting.includes('/') || binarySetting.startsWith('~')
      ? resolveFrom(baseDir, binarySetting)
      : binarySetting;
  const configDirSetting = str(brain, 'claude_config_dir', 'brain.', null);
  const claudeConfigDir = configDirSetting
    ? resolveFrom(baseDir, configDirSetting)
    : null;
  const localDir = str(embeddings, 'local_dir', 'menu.embeddings.', null);
  const webhookPath = str(webhook, 'path', 'webhook.', '/prepcook/webhook');
  if (!webhookPath.startsWith('/')) {
    throw new ConfigError('webhook.path starts with /');
  }
  const kitchenUrl = str(kitchen, 'url', 'kitchen.', 'http://localhost:4100');
  try {
    new URL(kitchenUrl);
  } catch {
    throw new ConfigError('kitchen.url is not a URL');
  }

  const chunkTokens = num(menu, 'chunk_tokens', 'menu.', 500, 50, 4000);
  const overlapTokens = num(menu, 'overlap_tokens', 'menu.', 60, 0, 1000);
  if (overlapTokens >= chunkTokens) {
    throw new ConfigError('menu.overlap_tokens must be below chunk_tokens');
  }

  return {
    configPath,
    baseDir,
    dataDir,
    dbPath: join(dataDir, 'tammy.db'),
    logLevel: level as LogLevel,
    slack: {
      customerChannels: strings(slack, 'customer_channels', 'slack.'),
      internalChannels: strings(slack, 'internal_channels', 'slack.'),
      internalUsers: strings(slack, 'internal_users', 'slack.'),
      notifyChannel: str(slack, 'notify_channel', 'slack.', null),
      answerDms: bool(slack, 'answer_dms', 'slack.', true),
    },
    brain: {
      product: str(brain, 'product', 'brain.', 'the product'),
      provider,
      model,
      classifierModel: str(brain, 'classifier_model', 'brain.', model),
      maxTokens: num(brain, 'max_tokens', 'brain.', 1024, 64, 8192),
      maxToolRounds,
      seat: {
        claudeBinary,
        claudeConfigDir,
        maxTurns: num(brain, 'max_turns', 'brain.', maxToolRounds + 2, 1, 50),
        cwd: join(dataDir, 'seat-cwd'),
        env: claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {},
      },
    },
    menu: {
      sources: parseSources(menu.sources, baseDir),
      chunkTokens,
      overlapTokens,
      topK: num(menu, 'top_k', 'menu.', 5, 1, 50),
      minScore: num(menu, 'min_score', 'menu.', 0.35, 0, 1),
      embeddings: {
        model: str(
          embeddings,
          'model',
          'menu.embeddings.',
          DEFAULT_EMBEDDING_MODEL
        ),
        quantized: bool(embeddings, 'quantized', 'menu.embeddings.', true),
        localDir: localDir ? resolveFrom(baseDir, localDir) : null,
        cacheDir: join(dataDir, 'models'),
      },
    },
    kitchen: {
      url: kitchenUrl.replace(/\/+$/, ''),
      board: str(kitchen, 'board', 'kitchen.', null),
      retries: num(kitchen, 'retries', 'kitchen.', 3, 0, 10),
      timeoutMs: num(kitchen, 'timeout_secs', 'kitchen.', 20, 1, 300) * 1000,
    },
    webhook: {
      host: str(webhook, 'host', 'webhook.', '127.0.0.1'),
      port: num(webhook, 'port', 'webhook.', 3978, 0, 65535),
      path: webhookPath,
    },
    secrets,
  };
}

/**
 * The environment the `claude` CLI runs with: Tammy's own, without any of
 * her secrets (the CLI needs none of them, and an ANTHROPIC_API_KEY or
 * ANTHROPIC_AUTH_TOKEN would make it bill the API instead of the seat),
 * plus the seat's own settings such as CLAUDE_CONFIG_DIR.
 */
export function seatEnv(
  seat: Pick<SeatConfig, 'env'>,
  base: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const drop = new Set<string>([...SECRET_NAMES, 'ANTHROPIC_AUTH_TOKEN']);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !drop.has(key)) out[key] = value;
  }
  return { ...out, ...seat.env };
}

export interface ProviderChoice {
  provider: ProviderName;
  /** One line to log when the choice was made for the operator. */
  note: string | null;
}

/**
 * Which way Tammy reaches Claude. `[brain] provider` decides when it is
 * set (recommended). Without it: the API when ANTHROPIC_API_KEY is set;
 * else the seat when the `claude` CLI is installed and signed in; else the
 * API (which then reports the missing key).
 */
export function chooseProvider(
  config: Pick<TammyConfig, 'brain' | 'secrets'>,
  options: {
    env?: NodeJS.ProcessEnv;
    probe?: (binary: string, env: NodeJS.ProcessEnv) => SeatProbeResult;
  } = {}
): ProviderChoice {
  if (config.brain.provider) {
    return { provider: config.brain.provider, note: null };
  }
  if (config.secrets.has('ANTHROPIC_API_KEY')) {
    return { provider: 'api', note: null };
  }
  const probe = options.probe ?? probeSeat;
  const seat = config.brain.seat;
  const found = probe(seat.claudeBinary, seatEnv(seat, options.env));
  if (!found.signedIn) return { provider: 'api', note: null };
  return {
    provider: 'seat',
    note: `no ANTHROPIC_API_KEY, and ${found.binary ?? seat.claudeBinary} is signed in: using the Claude seat on this host (set [brain] provider to choose explicitly)`,
  };
}

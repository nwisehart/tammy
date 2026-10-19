import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connect } from '../src/brain/connect.js';
import {
  chooseProvider,
  ConfigError,
  DEFAULT_MODEL,
  loadConfig,
  readSecretsFile,
  seatEnv,
} from '../src/config.js';
import { silentLogger } from '../src/log.js';
import { tempDir } from './helpers.js';

const dirs: { cleanup: () => void }[] = [];
function dir() {
  const d = tempDir();
  dirs.push(d);
  return d.path;
}
afterEach(() => dirs.splice(0).forEach((d) => d.cleanup()));

const EXAMPLE = join(import.meta.dirname, '..', 'tammy.example.toml');

describe('loadConfig', () => {
  it('runs on defaults when there is no tammy.toml', () => {
    const cwd = dir();
    const config = loadConfig({
      cwd,
      env: { TAMMY_SECRETS_FILE: join(cwd, 'none.env') },
    });
    expect(config.configPath).toBeNull();
    expect(config.dataDir).toBe(join(cwd, 'data'));
    expect(config.dbPath).toBe(join(cwd, 'data', 'tammy.db'));
    expect(config.brain.model).toBe(DEFAULT_MODEL);
    expect(config.brain.classifierModel).toBe(DEFAULT_MODEL);
    expect(config.menu.embeddings.model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(config.menu.embeddings.cacheDir).toBe(join(cwd, 'data', 'models'));
    expect(config.webhook).toEqual({
      host: '127.0.0.1',
      port: 3978,
      path: '/prepcook/webhook',
    });
    expect(config.kitchen.url).toBe('http://localhost:4100');
  });

  it('reads tammy.toml and resolves paths against its directory', () => {
    const cwd = dir();
    writeFileSync(
      join(cwd, 'tammy.toml'),
      `
data_dir = "state"
secrets_file = "secrets.env"
[slack]
customer_channels = ["C1"]
internal_channels = ["C2"]
internal_users = ["U9"]
notify_channel = "C2"
[brain]
product = "Pantry"
model = "claude-test-model"
classifier_model = "claude-test-small"
[menu]
top_k = 3
[[menu.sources]]
path = "../docs"
[[menu.sources]]
url = "https://docs.example.com/guide/"
depth = 2
[kitchen]
url = "http://prepcook.local:4100/"
board = "7d0c6a0e-0000-4000-8000-000000000001"
`
    );
    const config = loadConfig({ cwd, env: {} });
    expect(config.configPath).toBe(join(cwd, 'tammy.toml'));
    expect(config.dataDir).toBe(join(cwd, 'state'));
    expect(config.slack.customerChannels).toEqual(['C1']);
    expect(config.slack.notifyChannel).toBe('C2');
    expect(config.brain).toMatchObject({
      product: 'Pantry',
      model: 'claude-test-model',
      classifierModel: 'claude-test-small',
    });
    expect(config.menu.topK).toBe(3);
    expect(config.menu.sources).toEqual([
      { kind: 'path', path: join(cwd, '..', 'docs'), include: [] },
      {
        kind: 'url',
        url: 'https://docs.example.com/guide/',
        depth: 2,
        include: [],
      },
    ]);
    expect(config.kitchen.url).toBe('http://prepcook.local:4100');
    expect(config.kitchen.board).toBe('7d0c6a0e-0000-4000-8000-000000000001');
    expect(config.secrets.filePath).toBe(join(cwd, 'secrets.env'));
  });

  it('refuses a value of the wrong type, naming the key', () => {
    const cwd = dir();
    writeFileSync(join(cwd, 'tammy.toml'), '[menu]\ntop_k = "five"\n');
    expect(() => loadConfig({ cwd, env: {} })).toThrow(/menu\.top_k/);
  });

  it('refuses an explicit config path that does not exist', () => {
    expect(() => loadConfig({ path: '/nowhere/tammy.toml', env: {} })).toThrow(
      ConfigError
    );
  });

  it('parses the shipped example, every key in it', () => {
    const config = loadConfig({
      path: EXAMPLE,
      env: { TAMMY_SECRETS_FILE: '/nonexistent' },
    });
    expect(config.brain.model).toBe(DEFAULT_MODEL);
    expect(config.brain.provider).toBe('api');
    expect(config.menu.sources.length).toBeGreaterThan(0);
  });
});

describe('the provider', () => {
  const noSecrets = (cwd: string) => ({
    TAMMY_SECRETS_FILE: join(cwd, 'none.env'),
  });
  const never = () => {
    throw new Error('the seat should not be probed');
  };

  it('is left to auto-detection by default, with seat defaults', () => {
    const cwd = dir();
    const config = loadConfig({ cwd, env: noSecrets(cwd) });
    expect(config.brain.provider).toBeNull();
    expect(config.brain.seat).toEqual({
      claudeBinary: 'claude',
      claudeConfigDir: null,
      maxTurns: 8,
      cwd: join(cwd, 'data', 'seat-cwd'),
      env: {},
    });
  });

  it('reads the seat settings, and claude_config_dir becomes CLAUDE_CONFIG_DIR', () => {
    const cwd = dir();
    writeFileSync(
      join(cwd, 'tammy.toml'),
      `
[brain]
provider = "seat"
max_tool_rounds = 3
claude_binary = "bin/claude"
claude_config_dir = "claude-login"
`
    );
    const config = loadConfig({ cwd, env: noSecrets(cwd) });
    expect(config.brain.provider).toBe('seat');
    expect(config.brain.seat).toMatchObject({
      claudeBinary: join(cwd, 'bin', 'claude'),
      claudeConfigDir: join(cwd, 'claude-login'),
      maxTurns: 5,
      env: { CLAUDE_CONFIG_DIR: join(cwd, 'claude-login') },
    });
    const env = seatEnv(config.brain.seat, {
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/home/operator/.claude',
      ANTHROPIC_API_KEY: 'sk-test-not-real',
      ANTHROPIC_AUTH_TOKEN: 'test-not-real',
      TAMMY_WEBHOOK_SECRET: 'test-not-real',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: join(cwd, 'claude-login'),
    });
  });

  it('takes an explicit max_turns and a claude on PATH by name', () => {
    const cwd = dir();
    writeFileSync(
      join(cwd, 'tammy.toml'),
      '[brain]\nprovider = "api"\nmax_turns = 12\nclaude_binary = "claude-2"\n'
    );
    const config = loadConfig({ cwd, env: noSecrets(cwd) });
    expect(config.brain.provider).toBe('api');
    expect(config.brain.seat.maxTurns).toBe(12);
    expect(config.brain.seat.claudeBinary).toBe('claude-2');
  });

  it('refuses an unknown provider', () => {
    const cwd = dir();
    writeFileSync(join(cwd, 'tammy.toml'), '[brain]\nprovider = "bedrock"\n');
    expect(() => loadConfig({ cwd, env: noSecrets(cwd) })).toThrow(
      /brain\.provider is "api" or "seat"/
    );
  });

  it('is the one tammy.toml names, without probing', () => {
    const cwd = dir();
    writeFileSync(join(cwd, 'tammy.toml'), '[brain]\nprovider = "seat"\n');
    const config = loadConfig({
      cwd,
      env: { ...noSecrets(cwd), ANTHROPIC_API_KEY: 'sk-test-not-real' },
    });
    expect(chooseProvider(config, { probe: never })).toEqual({
      provider: 'seat',
      note: null,
    });
  });

  it('is the API when ANTHROPIC_API_KEY is set and no provider is named', () => {
    const cwd = dir();
    const config = loadConfig({
      cwd,
      env: { ...noSecrets(cwd), ANTHROPIC_API_KEY: 'sk-test-not-real' },
    });
    expect(chooseProvider(config, { probe: never })).toEqual({
      provider: 'api',
      note: null,
    });
  });

  it('is the seat, with one line to log, when there is no key and claude is signed in', () => {
    const cwd = dir();
    writeFileSync(
      join(cwd, 'tammy.toml'),
      '[brain]\nclaude_config_dir = "/srv/tammy/claude"\n'
    );
    const config = loadConfig({ cwd, env: noSecrets(cwd) });
    const probed: { binary: string; env: NodeJS.ProcessEnv }[] = [];
    const choice = chooseProvider(config, {
      env: { PATH: '/usr/bin' },
      probe: (binary, env) => {
        probed.push({ binary, env });
        return { binary: '/usr/local/bin/claude', signedIn: true };
      },
    });
    expect(choice.provider).toBe('seat');
    expect(choice.note).toMatch(
      /^no ANTHROPIC_API_KEY, and \/usr\/local\/bin\/claude is signed in: using the Claude seat on this host \(set \[brain\] provider to choose explicitly\)$/
    );
    expect(probed).toEqual([
      {
        binary: 'claude',
        env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/srv/tammy/claude' },
      },
    ]);
  });

  it('stays the API when claude is missing or signed out', () => {
    const cwd = dir();
    const config = loadConfig({ cwd, env: noSecrets(cwd) });
    for (const probe of [
      () => ({ binary: null, signedIn: false }),
      () => ({ binary: '/usr/local/bin/claude', signedIn: false }),
    ]) {
      expect(chooseProvider(config, { probe })).toEqual({
        provider: 'api',
        note: null,
      });
    }
  });

  it('leaves `tammy ask` offline with no key and no seat', () => {
    const cwd = dir();
    const config = loadConfig({ cwd, env: noSecrets(cwd) });
    const probe = () => ({ binary: null, signedIn: false });
    expect(
      connect(config, silentLogger, { requireKey: false, probe })
    ).toBeNull();
    expect(() =>
      connect(config, silentLogger, { requireKey: true, probe })
    ).toThrow(/ANTHROPIC_API_KEY is not set/);
  });
});

describe('secrets', () => {
  it('lets the environment win over the secrets file', () => {
    const cwd = dir();
    const file = join(cwd, 'secrets.env');
    writeFileSync(
      file,
      '# Tammy\nexport ANTHROPIC_API_KEY="from-file"\nPREPCOOK_API_TOKEN=file-token\n'
    );
    chmodSync(file, 0o600);
    const config = loadConfig({
      cwd,
      env: { TAMMY_SECRETS_FILE: file, ANTHROPIC_API_KEY: 'from-env' },
    });
    expect(config.secrets.get('ANTHROPIC_API_KEY')).toBe('from-env');
    expect(config.secrets.get('PREPCOOK_API_TOKEN')).toBe('file-token');
    expect(config.secrets.describe()).toMatchObject({
      ANTHROPIC_API_KEY: 'env',
      PREPCOOK_API_TOKEN: 'file',
      TAMMY_WEBHOOK_SECRET: 'missing',
    });
  });

  it('refuses a secrets file others can read', () => {
    const cwd = dir();
    const file = join(cwd, 'secrets.env');
    writeFileSync(file, 'TAMMY_WEBHOOK_SECRET=abc\n');
    chmodSync(file, 0o644);
    expect(() => readSecretsFile(file)).toThrow(/chmod 600/);
  });

  it('names a missing secret without leaking any value', () => {
    const cwd = dir();
    const file = join(cwd, 'secrets.env');
    writeFileSync(file, 'TAMMY_SLACK_BOT_TOKEN=xoxb-very-secret-value\n');
    chmodSync(file, 0o600);
    const config = loadConfig({ cwd, env: { TAMMY_SECRETS_FILE: file } });
    let message = '';
    try {
      config.secrets.require('TAMMY_SLACK_APP_TOKEN', 'Socket Mode');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('TAMMY_SLACK_APP_TOKEN');
    expect(message).toContain(file);
    expect(message).not.toContain('xoxb-very-secret-value');
  });
});

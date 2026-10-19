// Picks how Tammy reaches Claude for this run and builds that provider.

import Anthropic from '@anthropic-ai/sdk';

import { chooseProvider, type TammyConfig } from '../config.js';
import type { Logger } from '../log.js';
import type { SeatProbeResult } from './claude-cli.js';
import { ApiProvider, type LlmProvider } from './provider.js';
import { SeatProvider } from './seat.js';

/**
 * The provider the config chooses. With the API and no ANTHROPIC_API_KEY:
 * a ConfigError when `requireKey`, else null (Tammy works offline).
 */
export function connect(
  config: TammyConfig,
  log: Logger,
  options: {
    requireKey: boolean;
    probe?: (binary: string, env: NodeJS.ProcessEnv) => SeatProbeResult;
  }
): LlmProvider | null {
  const choice = chooseProvider(config, { probe: options.probe });
  if (choice.note) log.info(choice.note);
  if (choice.provider === 'seat') {
    return new SeatProvider({
      seat: config.brain.seat,
      log: log.child('seat'),
    });
  }
  const apiKey = options.requireKey
    ? config.secrets.require('ANTHROPIC_API_KEY', 'Claude')
    : config.secrets.get('ANTHROPIC_API_KEY');
  return apiKey ? new ApiProvider(new Anthropic({ apiKey })) : null;
}

// Finding the `claude` CLI and asking it whether a seat is signed in. Used
// by the config's provider auto-detection and by the seat provider, which
// checks for the binary before every message so a missing CLI is reported
// rather than crashing the process.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * The absolute path of an executable: `binary` itself when it is a path,
 * else the first match on PATH. Null when there is none.
 */
export function findExecutable(
  binary: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const executable = (path: string) => {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(binary) || binary.includes('/')) {
    return executable(binary) ? binary : null;
  }
  const extensions =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')]
      : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, binary + ext);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

export interface SeatProbeResult {
  /** The CLI's absolute path, or null when it is not installed. */
  binary: string | null;
  signedIn: boolean;
}

/**
 * Whether the CLI is installed and signed in, from
 * `claude auth status --json`. Runs the CLI once, with `env` (so a
 * dedicated CLAUDE_CONFIG_DIR is the login checked); never prints anything.
 */
export function probeSeat(
  binary: string,
  env: NodeJS.ProcessEnv
): SeatProbeResult {
  const path = findExecutable(binary, env);
  if (!path) return { binary: null, signedIn: false };
  const run = spawnSync(path, ['auth', 'status', '--json'], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (run.status !== 0 || !run.stdout) return { binary: path, signedIn: false };
  try {
    const status = JSON.parse(run.stdout) as { loggedIn?: unknown };
    return { binary: path, signedIn: status.loggedIn === true };
  } catch {
    return { binary: path, signedIn: false };
  }
}

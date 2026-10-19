// A small levelled logger. Lines go to stderr as
// `<time> <level> <scope>: <message>`, so a service manager's journal keeps
// them as they are. Nothing that holds a secret is ever passed in here.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  child(scope: string): Logger;
}

export type LogSink = (line: string) => void;

export function createLogger(
  level: LogLevel = 'info',
  scope = 'tammy',
  sink: LogSink = (line) => process.stderr.write(`${line}\n`)
): Logger {
  const emit = (at: LogLevel, message: string) => {
    if (ORDER[at] < ORDER[level]) return;
    sink(`${new Date().toISOString()} ${at} ${scope}: ${message}`);
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    child: (child) => createLogger(level, `${scope}.${child}`, sink),
  };
}

/** A logger that drops everything, for tests and library defaults. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** The message of anything thrown, without its stack. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

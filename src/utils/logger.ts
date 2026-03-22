export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CONSOLE_LOGGER: Logger = {
  debug: (...args) => console.log('[DEBUG]', new Date().toISOString(), ...args),
  info: (...args) => console.log('[INFO]', new Date().toISOString(), ...args),
  warn: (...args) => console.warn('[WARN]', new Date().toISOString(), ...args),
  error: (...args) => console.error('[ERROR]', new Date().toISOString(), ...args),
};

let logger: Logger = NOOP_LOGGER;

export function setLogger(newLogger: Logger): void {
  logger = newLogger;
}

export function enableDebugLogging(): void {
  logger = CONSOLE_LOGGER;
}

export function disableDebugLogging(): void {
  logger = NOOP_LOGGER;
}

export function log(): Logger {
  return logger;
}
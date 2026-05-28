export type LogFields = Record<string, unknown>;

/** Minimal structured logger interface (pino-compatible subset). */
export interface Logger {
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
  child(fields: LogFields): Logger;
}

/** No-op logger (default for tests). */
export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

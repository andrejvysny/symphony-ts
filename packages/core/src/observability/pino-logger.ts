import { pino } from 'pino';
import type { Logger } from './logger.js';

/** Create a structured logger (pino). Includes issue/session context via child(). */
export function createLogger(opts: { level?: string; pretty?: boolean } = {}): Logger {
  const base = pino({
    level: opts.level ?? process.env['SYMPHONY_LOG_LEVEL'] ?? 'info',
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } }
      : {}),
  });
  return wrap(base);
}

function wrap(p: import('pino').Logger): Logger {
  return {
    info: (fields, msg) => p.info(fields, msg),
    warn: (fields, msg) => p.warn(fields, msg),
    error: (fields, msg) => p.error(fields, msg),
    child: (fields) => wrap(p.child(fields)),
  };
}

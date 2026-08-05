/**
 * Structured application logger (Pino), production-grade.
 * Emits JSON at info level. Secrets are redacted and never logged.
 */

import pino from 'pino';

let loggerInstance = null;

export function createLogger() {
  loggerInstance = pino({
    level: 'info',
    base: { service: 'keeper-google-chat' },
    redact: {
      paths: [
        'apiKey',
        'api_key',
        'keeper.apiKey',
        'credentials',
        'private_key',
        'authorization',
      ],
      remove: true,
    },
  });

  return loggerInstance;
}

export function getLogger() {
  if (!loggerInstance) {
    loggerInstance = createLogger();
  }
  return loggerInstance;
}

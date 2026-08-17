/**
 * Application logger — Slack Keeper app style (`[INFO]`, `[OK]`, `[WARN]`, `[ERROR]`).
 * Supports Pino-like calls: `logger.info(msg)` or `logger.info(obj, msg)`.
 * Also writes timestamped lines to `logs/keeper_google_chat.log`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LEVELS = {
  debug: 'DEBUG',
  info: 'INFO',
  ok: 'OK',
  warn: 'WARN',
  error: 'ERROR',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_LOG_FILE = path.join(PROJECT_ROOT, 'logs', 'keeper_google_chat.log');

/** @type {KeeperLogger|null} */
let loggerInstance = null;

/**
 * @param {unknown} value
 */
function formatErr(value) {
  if (!value) return '';
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === 'object' && value !== null) {
    const obj = /** @type {{ message?: unknown, error?: unknown }} */ (value);
    if (obj.message != null && String(obj.message)) return String(obj.message);
    // Commander submitError() shape: { success, error_code, error }
    if (obj.error != null && String(obj.error)) return String(obj.error);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Readable key=value context for Slack-style single-line logs.
 * @param {Record<string, unknown>} obj
 * @param {Set<string>} [skip]
 */
function formatContext(obj, skip = new Set()) {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    if (skip.has(key) || value === undefined) continue;
    if (value instanceof Error) {
      parts.push(`${key}=${value.message || String(value)}`);
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      try {
        parts.push(`${key}=${JSON.stringify(value)}`);
      } catch {
        parts.push(`${key}=[object]`);
      }
      continue;
    }
    parts.push(`${key}=${String(value)}`);
  }
  return parts.length ? parts.join(' ') : '';
}

/**
 * @param {unknown[]} args
 * @returns {string}
 */
function formatMessage(args) {
  if (!args.length) return '';
  if (typeof args[0] === 'string') {
    return args[0];
  }
  if (args.length >= 2 && typeof args[1] === 'string') {
    const obj =
      args[0] && typeof args[0] === 'object'
        ? /** @type {Record<string, unknown>} */ (args[0])
        : null;
    let msg = args[1];
    if (!obj) return msg;

    if (obj.err) {
      msg = `${msg}: ${formatErr(obj.err)}`;
      const rest = formatContext(obj, new Set(['err']));
      return rest ? `${msg} ${rest}` : msg;
    }
    if (typeof obj.error === 'string') {
      msg = `${msg}: ${obj.error}`;
      const rest = formatContext(obj, new Set(['error']));
      return rest ? `${msg} ${rest}` : msg;
    }

    const ctx = formatContext(obj);
    return ctx ? `${msg} ${ctx}` : msg;
  }
  if (args[0] && typeof args[0] === 'object') {
    return formatContext(/** @type {Record<string, unknown>} */ (args[0])) || JSON.stringify(args[0]);
  }
  return String(args[0]);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

class KeeperLogger {
  /**
   * @param {{ logFile?: string|null }} [options]
   */
  constructor(options = {}) {
    this.logFile = options.logFile === undefined ? DEFAULT_LOG_FILE : options.logFile;
    if (this.logFile) {
      try {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      } catch {
        this.logFile = null;
      }
    }
  }

  /**
   * @param {string} level
   * @param {unknown[]} args
   */
  _write(level, args) {
    const message = formatMessage(args);
    const line = `[${level}] ${message}`;
    if (level === 'ERROR') {
      console.error(line);
    } else if (level === 'WARN') {
      console.warn(line);
    } else {
      console.log(line);
    }
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, `${timestamp()} ${line}\n`, 'utf8');
      } catch {
 // ignore file write failures
      }
    }
  }

  debug(...args) {
    this._write(LEVELS.debug, args);
  }

  info(...args) {
    this._write(LEVELS.info, args);
  }

  /** Success / ready messages (Slack `logger.ok` parity). */
  ok(...args) {
    this._write(LEVELS.ok, args);
  }

  warn(...args) {
    this._write(LEVELS.warn, args);
  }

  error(...args) {
    this._write(LEVELS.error, args);
  }
}

/**
 * @param {{ logFile?: string|null }} [options]
 */
export function createLogger(options = {}) {
  loggerInstance = new KeeperLogger(options);
  return loggerInstance;
}

export function getLogger() {
  if (!loggerInstance) {
    loggerInstance = createLogger();
  }
  return loggerInstance;
}

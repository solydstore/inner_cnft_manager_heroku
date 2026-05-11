import pino from 'pino';
import { Request, Response, NextFunction } from 'express';
import type { SecurityEvent } from '../types';

// ============================================
// CUSTOM FORMATTER
// ============================================

/**
 * Produces clean, readable single-line logs:
 *
 *   14:22:01 INFO  [http   ] POST /api/claim/start 202 34ms
 *   14:22:01 INFO  [claim  ] INITIATE claim fb4fe603 (2 items) orderId=gid://shopify/Order/743...
 *   14:22:05 INFO  [mint   ] START SOLYD Genesis -> DYw8... tree=500/16384
 *   14:22:35 INFO  [mint   ] COMPLETE SOLYD Genesis -> ABC123... soulbound=true
 *   14:22:35 WARN  [auth   ] AUTH DENIED /save from 10.1.0.58
 *   14:22:35 ERROR [queue  ] Job failed: fb4fe603_18292411 err=Timeout
 *
 * Works in Heroku CLI, Papertrail, and local terminal.
 */

const LEVEL_LABELS: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO ',
  40: 'WARN ',
  50: 'ERROR',
  60: 'FATAL',
};

const LEVEL_COLORS: Record<number, string> = {
  10: '\x1b[90m',  // gray
  20: '\x1b[36m',  // cyan
  30: '\x1b[32m',  // green
  40: '\x1b[33m',  // yellow
  50: '\x1b[31m',  // red
  60: '\x1b[35m',  // magenta
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BRIGHT = '\x1b[1m';

// Fields already in the formatted line, skip from extras
const SKIP_FIELDS = new Set([
  'level', 'time', 'pid', 'hostname', 'service', 'msg',
  'method', 'path', 'status', 'ms', 'ip', 'reqId',
  'eventType',
]);

function formatTime(isoOrMs: string | number): string {
  const d = typeof isoOrMs === 'string' ? new Date(isoOrMs) : new Date(isoOrMs);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatExtras(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (SKIP_FIELDS.has(key)) continue;
    if (val === undefined || val === null) continue;
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    parts.push(`${key}=${str.length > 80 ? str.slice(0, 77) + '...' : str}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

// ============================================
// ROOT LOGGER
// ============================================

const isProd = process.env.NODE_ENV === 'production';

export const rootLogger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(_label, number) {
      return { level: number };
    },
  },
}, {
  write(raw: string) {
    try {
      const obj = JSON.parse(raw);
      const level = obj.level as number;
      const label = LEVEL_LABELS[level] || 'INFO ';
      const service = (obj.service as string || 'app').padEnd(7);
      const time = formatTime(obj.time);
      const msg = obj.msg || '';
      const extras = formatExtras(obj);

      if (isProd) {
        // Production: clean single-line, no ANSI colors (Heroku/Papertrail strip them)
        process.stdout.write(`${time} ${label} [${service}] ${msg}${extras}\n`);
      } else {
        // Dev: with colors
        const color = LEVEL_COLORS[level] || '';
        process.stdout.write(
          `${DIM}${time}${RESET} ${color}${BRIGHT}${label}${RESET} ${DIM}[${service}]${RESET} ${msg}${extras ? DIM + extras + RESET : ''}\n`
        );
      }
    } catch {
      process.stdout.write(raw);
    }
  },
});

// ============================================
// CHILD LOGGERS
// ============================================

export const httpLog = rootLogger.child({ service: 'http' });
export const authLog = rootLogger.child({ service: 'auth' });
export const walletLog = rootLogger.child({ service: 'wallet' });
export const claimLog = rootLogger.child({ service: 'claim' });
export const queueLog = rootLogger.child({ service: 'queue' });
export const mintLog = rootLogger.child({ service: 'mint' });
export const sseLog = rootLogger.child({ service: 'sse' });
export const shopifyLog = rootLogger.child({ service: 'shopify' });
export const serverLog = rootLogger.child({ service: 'server' });

// ============================================
// HTTP MIDDLEWARE (replaces morgan)
// ============================================

export function httpLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const method = req.method;
    const url = req.originalUrl || req.url;
    const ip = req.ip || req.socket.remoteAddress || '-';
    const reqId = (req.headers['x-request-id'] as string || '').slice(0, 8);

    const data = { method, path: url, status, ms, ip, reqId };
    const summary = `${method} ${url} ${status} ${ms}ms`;

    if (status >= 500) {
      httpLog.error(data, summary);
    } else if (status === 401 || status === 403 || status === 429) {
      httpLog.warn(data, summary);
    } else {
      httpLog.info(data, summary);
    }
  });

  next();
}

// ============================================
// SECURITY EVENT LOGGER
// ============================================

export function logSecurityEvent(event: SecurityEvent): void {
  const data = {
    eventType: event.type,
    ip: event.ip,
    path: event.path,
    reqId: event.requestId || '-',
    customerId: event.customerId || undefined,
    details: event.details || undefined,
  };

  switch (event.type) {
    case 'auth_failure':
      authLog.warn(data, `AUTH DENIED ${event.path} from ${event.ip}`);
      break;
    case 'rate_limit':
      authLog.warn(data, `RATE LIMITED ${event.path} from ${event.ip}`);
      break;
    case 'wallet_change':
      walletLog.info(data, `WALLET CHANGED ${event.customerId}`);
      break;
    case 'wallet_save':
      walletLog.info(data, `WALLET SAVED ${event.details}`);
      break;
    case 'wallet_read':
      walletLog.debug(data, `WALLET READ ${event.customerId}`);
      break;
    case 'claim_started':
      claimLog.info(data, `CLAIM STARTED ${event.details}`);
      break;
    case 'claim_success':
      claimLog.info(data, `MINT SUCCESS ${event.details}`);
      break;
    case 'claim_failed':
      claimLog.warn(data, `MINT FAILED ${event.details}`);
      break;
    default:
      authLog.info(data, `${event.type} ${event.path}`);
  }
}
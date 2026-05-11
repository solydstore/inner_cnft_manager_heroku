/**
 * Redis Configuration
 *
 * Connection options for BullMQ. Heroku-Redis-safe settings.
 */

// Get Redis connection options for BullMQ
export function getRedisConnectionOptions() {
  // Prefer REDIS_TLS_URL (Heroku paid tiers) over REDIS_URL (free tier / non-TLS)
  const redisUrl = process.env.REDIS_TLS_URL || process.env.REDIS_URL;

  if (!redisUrl) {
    return null;
  }

  const url = new URL(redisUrl);
  const useTls = url.protocol === 'rediss:' || !!process.env.REDIS_TLS_URL;

  return {
    host: url.hostname,
    port: parseInt(url.port) || 6379,
    username: url.username || undefined,
    password: url.password || undefined,

    // Heroku Redis self-signed certs
    tls: useTls ? { rejectUnauthorized: false } : undefined,

    // REQUIRED by BullMQ — without these the worker spams commands and
    // ioredis kills the connection with ECONNRESET.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,

    // Reconnect on transient network drops instead of giving up
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 200, 5000);
      return delay;
    },

    // Auto-reconnect when Redis sends READONLY (Heroku failover)
    reconnectOnError: (err: Error) => {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
      return targetErrors.some((e) => err.message.includes(e));
    },

    // Prevent Heroku from silently closing idle connections
    keepAlive: 30_000,

    // Fail fast on initial connection so Heroku can restart the dyno
    connectTimeout: 10_000,

    // Don't queue commands while disconnected — fail them immediately
    enableOfflineQueue: false,
  };
}

// Check if Redis is available
export function isRedisAvailable(): boolean {
  return !!(process.env.REDIS_TLS_URL || process.env.REDIS_URL);
}

// Queue names
export const QUEUE_NAMES = {
  MINT: 'sbt-mint',
} as const;

// Default job options
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 5000,
  },
  removeOnComplete: {
    count: 100,
    age: 24 * 60 * 60,
  },
  removeOnFail: {
    count: 500,
    age: 7 * 24 * 60 * 60,
  },
};
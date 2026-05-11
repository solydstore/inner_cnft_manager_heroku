import app from './app';
import { config, validateConfig } from './config/env';
import { serverLog, queueLog } from './config/logger';
import { initMintQueue, startMintWorker, shutdownQueue } from './services/mintQueue';
import { isRedisAvailable } from './config/redis';
import { initMintAuditDb, shutdownAuditDb } from './services/mintAudit';

validateConfig();

// Initialize audit log (Postgres)
initMintAuditDb();

if (isRedisAvailable()) {
  queueLog.info('Redis available, initializing queue');
  const queueReady = initMintQueue();

  if (queueReady) {
    const workerReady = startMintWorker(1);
    queueLog.info({ queueReady, workerReady }, 'Queue and worker initialized');
  }
} else {
  queueLog.warn('Redis not available, using in-memory fallback');
}

const server = app.listen(config.port, () => {
  serverLog.info({ port: config.port, env: config.nodeEnv }, `Server started on port ${config.port}`);
});

async function shutdown(signal: string) {
  serverLog.info({ signal }, `${signal} received, shutting down`);

  try {
    await shutdownQueue();
    await shutdownAuditDb();
    queueLog.info('Queue and audit DB shut down');
  } catch (err) {
    queueLog.error({ err: err instanceof Error ? err.message : err }, 'Queue shutdown error');
  }

  server.close(() => {
    serverLog.info('Server closed');
    process.exit(0);
  });

  setTimeout(() => {
    serverLog.warn('Forced shutdown after 10s timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT')); 
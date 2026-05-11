/**
 * Mint Queue Service
 *
 * BullMQ queue + worker for reliable background minting.
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { getRedisConnectionOptions, isRedisAvailable, QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from '../config/redis';
import { mintSoulboundCNFT } from './minting';
import { updateLineItemSbtStatus } from './shopify';
import { logSecurityEvent } from '../config/logger';
import { queueLog } from '../config/logger';
import { emitMintEvent } from './mintEvents';
import { logMintAudit } from './mintAudit';
import { onMintSuccess } from './mailerlite';

// ============================================
// TYPES
// ============================================

export interface MintJobData {
  claimId: string;
  customerId: string;
  orderId: string;
  lineItemId: string;
  sku: string;
  productName?: string;
  walletAddress: string;
}

export interface MintJobResult {
  success: boolean;
  assetId?: string;
  txnHash?: string;
  soulbound?: boolean;
  error?: string;
}

// ============================================
// QUEUE SETUP
// ============================================

let mintQueue: Queue | null = null;
let mintWorker: Worker | null = null;
let queueEvents: QueueEvents | null = null;

export function initMintQueue(): boolean {
  const connection = getRedisConnectionOptions();

  if (!connection) {
    queueLog.warn('Redis not available, queue not initialized');
    return false;
  }

  try {
    mintQueue = new Queue(QUEUE_NAMES.MINT, {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });

    queueEvents = new QueueEvents(QUEUE_NAMES.MINT, { connection });

    queueEvents.on('completed', ({ jobId }) => {
      queueLog.info({ jobId }, `Job completed: ${jobId}`);
    });

    queueEvents.on('failed', ({ jobId, failedReason }) => {
      queueLog.error({ jobId, err: failedReason }, `Job failed: ${jobId}`);
    });

    queueLog.info('Queue initialized');
    return true;
  } catch (err) {
    queueLog.error({ err: err instanceof Error ? err.message : err }, 'Queue init failed');
    return false;
  }
}

export function startMintWorker(concurrency: number = 1): boolean {
  const connection = getRedisConnectionOptions();

  if (!connection) {
    queueLog.warn('Redis not available, worker not started');
    return false;
  }

  try {
    mintWorker = new Worker(
      QUEUE_NAMES.MINT,
      async (job: Job<MintJobData>) => {
        return processMintJob(job);
      },
      {
        connection,
        concurrency,
        limiter: {
          max: 5,
          duration: 60000,
        },
      }
    );

    mintWorker.on('completed', (job) => {
      queueLog.info({ jobId: job.id, lineItemId: job.data.lineItemId }, `Worker completed: ${job.id}`);
    });

    mintWorker.on('failed', (job, err) => {
      queueLog.error({ jobId: job?.id, err: err.message }, `Worker failed: ${job?.id}`);
    });

    mintWorker.on('error', (err) => {
      queueLog.error({ err: err.message }, 'Worker error');
    });

    queueLog.info({ concurrency }, `Worker started (concurrency: ${concurrency})`);
    return true;
  } catch (err) {
    queueLog.error({ err: err instanceof Error ? err.message : err }, 'Worker start failed');
    return false;
  }
}

async function processMintJob(job: Job<MintJobData>): Promise<MintJobResult> {
  const { claimId, customerId, orderId, lineItemId, sku, productName, walletAddress } = job.data;
  const attempt = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts || 3;
  const ctx = { jobId: job.id, claimId, orderId, lineItemId, sku, attempt, maxAttempts };

  queueLog.info(ctx, `PROCESSING ${sku} attempt ${attempt}/${maxAttempts}`);

  try {
    await updateLineItemSbtStatus(orderId, lineItemId, {
      mint_status: 'in_progress',
      attempts: attempt,
      last_error: null,
    });

    emitMintEvent({
      type: 'mint_progress',
      claimId,
      orderId,
      lineItemId,
      sku,
      data: { mint_status: 'in_progress', attempts: attempt },
    });

    const result = await mintSoulboundCNFT(walletAddress, sku, productName);

    if (result.success && result.assetId) {
      await updateLineItemSbtStatus(orderId, lineItemId, {
        mint_status: 'minted',
        asset_id: result.assetId,
        txn_hash: result.txnHash || null,
        claimed_at: new Date().toISOString(),
        last_error: result.soulbound ? null : 'Minted but soulbound flag may not be set',
      });

      logSecurityEvent({
        type: 'claim_success',
        ip: 'worker',
        path: '/queue/mint',
        customerId,
        details: `${sku} -> ${result.assetId}`,
      });

      emitMintEvent({
        type: 'mint_complete',
        claimId,
        orderId,
        lineItemId,
        sku,
        data: {
          mint_status: 'minted',
          asset_id: result.assetId,
          txn_hash: result.txnHash || null,
          wallet_address: walletAddress,
          claimed_at: new Date().toISOString(),
        },
      });

      // Audit log: successful mint. Awaited so rank sync below reads the current count.
      // logMintAudit is safe (swallows its own errors) so await is non-blocking for failure modes.
      await logMintAudit({
        customerId, orderId, lineItemId, sku, walletAddress,
        status: 'minted',
        assetId: result.assetId,
        txnHash: result.txnHash,
        soulbound: result.soulbound,
        attempt,
      });

      // Fire-and-forget: sync MailerLite rank (silver/purple/platina) based on total SBTs.
      void onMintSuccess({
        customerId,
        walletAddress,
        sku,
        assetId: result.assetId,
        txnHash: result.txnHash || null,
      });

      return {
        success: true,
        assetId: result.assetId,
        txnHash: result.txnHash,
        soulbound: result.soulbound,
      };
    }

    throw new Error(result.error || 'Minting failed');

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    const isLastAttempt = attempt >= maxAttempts;

    if (isLastAttempt) {
      await updateLineItemSbtStatus(orderId, lineItemId, {
        mint_status: 'failed',
        attempts: attempt,
        last_error: `Failed after ${attempt} attempts: ${errorMsg}`,
      });

      logSecurityEvent({
        type: 'claim_failed',
        ip: 'worker',
        path: '/queue/mint',
        customerId,
        details: `${sku}: ${errorMsg}`,
      });

      emitMintEvent({
        type: 'mint_failed',
        claimId,
        orderId,
        lineItemId,
        sku,
        data: {
          mint_status: 'failed',
          error: `Failed after ${attempt} attempts: ${errorMsg}`,
          attempts: attempt,
        },
      });

      // Audit log: final failure
      logMintAudit({
        customerId, orderId, lineItemId, sku, walletAddress,
        status: 'failed',
        attempt,
        error: `Failed after ${attempt} attempts: ${errorMsg}`,
      });
    } else {
      await updateLineItemSbtStatus(orderId, lineItemId, {
        attempts: attempt,
        last_error: `Attempt ${attempt} failed: ${errorMsg}`,
      });

      queueLog.warn({ ...ctx, err: errorMsg }, `Attempt ${attempt} failed, will retry`);
    }

    throw err;
  }
}

// ============================================
// PUBLIC API
// ============================================

export async function addMintJob(data: MintJobData): Promise<string> {
  if (!mintQueue) {
    throw new Error('Mint queue not initialized');
  }

  const lineItemNumericId = data.lineItemId.split('/').pop() || data.lineItemId;
  const jobId = `${data.claimId}_${lineItemNumericId}`;

  const job = await mintQueue.add(
    `mint-${lineItemNumericId}`,
    data,
    { jobId }
  );

  queueLog.info({ jobId: job.id, lineItemId: data.lineItemId, claimId: data.claimId }, `Job queued: ${job.id}`);
  return job.id || '';
}

export async function getQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
} | null> {
  if (!mintQueue) return null;

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    mintQueue.getWaitingCount(),
    mintQueue.getActiveCount(),
    mintQueue.getCompletedCount(),
    mintQueue.getFailedCount(),
    mintQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

export function isQueueAvailable(): boolean {
  return mintQueue !== null;
}

export async function shutdownQueue(): Promise<void> {
  if (mintWorker) {
    await mintWorker.close();
    queueLog.info('Worker shut down');
  }
  if (queueEvents) {
    await queueEvents.close();
  }
  if (mintQueue) {
    await mintQueue.close();
    queueLog.info('Queue shut down');
  }
}
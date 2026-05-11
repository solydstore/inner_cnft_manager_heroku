/**
 * SBT Claim Service
 *
 * Handles claim validation and job queuing.
 * Optimized: reuses order data from validation, caches admin order ID.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  getOrderWithSbtMetadata,
  getOrderSbtMetadata,
  writeOrderSbtMetadata,
  updateLineItemSbtStatus,
  getCustomerMetafield,
} from './shopify';
import { isMintingConfigured, mintSoulboundCNFT } from './minting';
import { addMintJob, isQueueAvailable, getQueueStats } from './mintQueue';
import { emitMintEvent } from './mintEvents';
import { logMintAudit } from './mintAudit';
import { onMintSuccess } from './mailerlite';
import { logSecurityEvent } from '../config/logger';
import { claimLog } from '../config/logger';
import type {
  ClaimSbtPayload,
  ClaimSbtResponse,
  OrderSbtMetadata,
  MintStatus,
} from '../types';

// ============================================
// IN-MEMORY LOCKS
// ============================================

const processingLocks: Set<string> = new Set();
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

function acquireLock(key: string): boolean {
  if (processingLocks.has(key)) return false;
  processingLocks.add(key);
  setTimeout(() => processingLocks.delete(key), LOCK_TIMEOUT_MS);
  return true;
}

function releaseLock(key: string): void {
  processingLocks.delete(key);
}

// ============================================
// CLAIM VALIDATION (returns reusable data)
// ============================================

interface ValidationResult {
  valid: boolean;
  error?: string;
  order?: { id: string; name: string; customerId: string };
  lineItems?: Array<{ id: string; sku: string; productName: string; currentStatus: MintStatus }>;
  // Carry forward to avoid re-fetching
  adminOrderId?: string;
  sbtMetadata?: OrderSbtMetadata;
}

async function validateClaimRequest(payload: ClaimSbtPayload): Promise<ValidationResult> {
  const { customerId, orderId, lineItemIds, walletAddress } = payload;

  if (!isMintingConfigured()) {
    return { valid: false, error: 'Minting service not configured' };
  }

  // Fetch order AND verify wallet in parallel (independent calls)
  const [orderResult, customerWallet] = await Promise.all([
    getOrderWithSbtMetadata(orderId),
    getCustomerMetafield(customerId, 'custom', 'wallet_address'),
  ]);

  if (orderResult.errors?.length) {
    return { valid: false, error: `Shopify error: ${orderResult.errors.map(e => e.message).join(', ')}` };
  }

  const order = orderResult.data?.order;
  if (!order) return { valid: false, error: 'Order not found' };

  if (order.customer?.id !== customerId) {
    return { valid: false, error: 'Order does not belong to this customer' };
  }

  if (!customerWallet || customerWallet !== walletAddress) {
    return { valid: false, error: 'Wallet address does not match customer account' };
  }

  // Parse metadata from the ALREADY FETCHED order (no extra call)
  let sbtMetadata: OrderSbtMetadata = {};
  if (order.metafield?.value) {
    try {
      sbtMetadata = JSON.parse(order.metafield.value) as OrderSbtMetadata;
    } catch {
      // Invalid JSON, treat as empty
    }
  }

  const validatedLineItems: ValidationResult['lineItems'] = [];

  for (const lineItemId of lineItemIds) {
    const orderLineItem = order.lineItems.nodes.find(li => li.id === lineItemId);
    if (!orderLineItem) {
      return { valid: false, error: `Line item ${lineItemId} not found in order` };
    }

    const sku = orderLineItem.variant?.sku || orderLineItem.sku || orderLineItem.name;
    if (!sku) {
      return { valid: false, error: `Line item ${lineItemId} has no SKU` };
    }
    // Full product name (e.g. "BORN SOLYD Phone Case - iPhone 16 Pro Max") drives metadata selection.
    const productName = orderLineItem.name || sku;

    const currentStatus = sbtMetadata[lineItemId]?.mint_status || 'unclaimed';

    if (currentStatus === 'minted') {
      return { valid: false, error: `Line item ${lineItemId} already claimed on ${sbtMetadata[lineItemId]?.claimed_at}` };
    }

    if (currentStatus === 'in_progress') {
      return { valid: false, error: `Line item ${lineItemId} is already being processed. Please wait.` };
    }

    validatedLineItems.push({ id: lineItemId, sku, productName, currentStatus: currentStatus as MintStatus });
  }

  return {
    valid: true,
    order: { id: order.id, name: order.name, customerId: order.customer!.id },
    lineItems: validatedLineItems,
    // Pass these forward so initiateClaim doesn't re-fetch
    adminOrderId: order.id,
    sbtMetadata,
  };
}

// ============================================
// CLAIM INITIATION
// ============================================

export async function initiateClaim(payload: ClaimSbtPayload): Promise<ClaimSbtResponse> {
  const { customerId, orderId, lineItemIds, walletAddress } = payload;
  const claimId = uuidv4();
  const ctx = { claimId, orderId, customerId, items: lineItemIds.length };

  claimLog.info(ctx, `INITIATE claim ${claimId} (${lineItemIds.length} items)`);

  const validation = await validateClaimRequest(payload);

  if (!validation.valid) {
    claimLog.warn({ ...ctx, err: validation.error }, `VALIDATION FAILED: ${validation.error}`);
    logSecurityEvent({
      type: 'claim_failed',
      ip: 'server',
      path: '/api/claim/start',
      customerId,
      details: validation.error,
    });
    return { success: false, error: validation.error };
  }

  for (const li of validation.lineItems!) {
    const lockKey = `${orderId}:${li.id}`;
    if (!acquireLock(lockKey)) {
      return { success: false, error: `Line item ${li.id} is currently being processed. Please wait.` };
    }
  }

  // Use the metadata + admin ID from validation (no re-fetch)
  const adminOrderId = validation.adminOrderId!;
  const currentMetadata = validation.sbtMetadata || {};

  try {
    for (const li of validation.lineItems!) {
      if (!currentMetadata[li.id]) {
        currentMetadata[li.id] = {
          sku: li.sku,
          mint_status: 'unclaimed',
          wallet_address: null,
          txn_hash: null,
          asset_id: null,
          claimed_at: null,
          attempts: 0,
          last_error: null,
        };
      }
      currentMetadata[li.id].mint_status = 'in_progress';
      currentMetadata[li.id].wallet_address = walletAddress;
      currentMetadata[li.id].attempts = 0;
      currentMetadata[li.id].last_error = null;
    }

    // Write directly with cached admin ID (1 Shopify write, no read)
    await writeOrderSbtMetadata(adminOrderId, currentMetadata);
  } catch (err) {
    for (const li of validation.lineItems!) releaseLock(`${orderId}:${li.id}`);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: `Failed to initiate claim: ${message}` };
  }

  const useQueue = isQueueAvailable();

  try {
    for (const li of validation.lineItems!) {
      if (useQueue) {
        await addMintJob({ claimId, customerId, orderId, lineItemId: li.id, sku: li.sku, productName: li.productName, walletAddress });
      } else {
        claimLog.warn(ctx, 'Redis unavailable, processing in background');
        processInBackground(claimId, customerId, orderId, li.id, li.sku, li.productName, walletAddress);
      }
    }

    logSecurityEvent({
      type: 'claim_started',
      ip: 'server',
      path: '/api/claim/start',
      customerId,
      details: `${claimId} queued ${validation.lineItems!.length} items (queue: ${useQueue})`,
    });
  } catch (err) {
    for (const li of validation.lineItems!) releaseLock(`${orderId}:${li.id}`);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: `Failed to queue mint jobs: ${message}` };
  }

  for (const li of validation.lineItems!) releaseLock(`${orderId}:${li.id}`);

  claimLog.info(ctx, `QUEUED ${validation.lineItems!.length} items`);

  return {
    success: true,
    message: 'Claim initiated. Your collectibles are being minted. This may take a few minutes.',
    claimId,
    lineItems: validation.lineItems!.map(li => ({ lineItemId: li.id, status: 'in_progress' as MintStatus })),
  };
}

// ============================================
// FALLBACK: IN-MEMORY PROCESSING
// ============================================

async function processInBackground(
  claimId: string,
  customerId: string,
  orderId: string,
  lineItemId: string,
  sku: string,
  productName: string,
  walletAddress: string
): Promise<void> {
  (async () => {
    const ctx = { claimId, orderId, lineItemId, sku };

    emitMintEvent({
      type: 'mint_progress',
      claimId, orderId, lineItemId, sku,
      data: { mint_status: 'in_progress', attempts: 1 },
    });

    try {
      claimLog.info(ctx, `BG PROCESSING ${sku}`);
      const result = await mintSoulboundCNFT(walletAddress, sku, productName);

      if (result.success && result.assetId) {
        await updateLineItemSbtStatus(orderId, lineItemId, {
          mint_status: 'minted',
          asset_id: result.assetId,
          txn_hash: result.txnHash || null,
          claimed_at: new Date().toISOString(),
        });

        logSecurityEvent({
          type: 'claim_success',
          ip: 'server',
          path: '/api/claim/background',
          customerId,
          details: `${sku} -> ${result.assetId}`,
        });

        emitMintEvent({
          type: 'mint_complete',
          claimId, orderId, lineItemId, sku,
          data: {
            mint_status: 'minted',
            asset_id: result.assetId,
            txn_hash: result.txnHash || null,
            wallet_address: walletAddress,
            claimed_at: new Date().toISOString(),
          },
        });

        // Audit + MailerLite rank sync (parity with the queue worker path).
        await logMintAudit({
          customerId, orderId, lineItemId, sku, walletAddress,
          status: 'minted',
          assetId: result.assetId,
          txnHash: result.txnHash,
          soulbound: result.soulbound,
          attempt: 1,
        });

        void onMintSuccess({
          customerId,
          walletAddress,
          sku,
          assetId: result.assetId,
          txnHash: result.txnHash || null,
        });
      } else {
        throw new Error(result.error || 'Minting failed');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      claimLog.error({ ...ctx, err: errorMsg }, `BG FAILED ${sku}`);

      await updateLineItemSbtStatus(orderId, lineItemId, {
        mint_status: 'failed',
        last_error: errorMsg,
      });

      logSecurityEvent({
        type: 'claim_failed',
        ip: 'server',
        path: '/api/claim/background',
        customerId,
        details: `${sku}: ${errorMsg}`,
      });

      emitMintEvent({
        type: 'mint_failed',
        claimId, orderId, lineItemId, sku,
        data: { mint_status: 'failed', error: errorMsg, attempts: 1 },
      });

      await logMintAudit({
        customerId, orderId, lineItemId, sku, walletAddress,
        status: 'failed',
        attempt: 1,
        error: errorMsg,
      });
    }
  })();
}

// ============================================
// STATUS CHECK
// ============================================

export async function getClaimStatus(
  orderId: string,
  lineItemIds?: string[]
): Promise<{
  success: boolean;
  metadata?: OrderSbtMetadata;
  queue?: { waiting: number; active: number; completed: number; failed: number };
  error?: string;
}> {
  try {
    const metadata = await getOrderSbtMetadata(orderId);
    const queueStats = await getQueueStats();

    if (lineItemIds?.length && metadata) {
      const filtered: OrderSbtMetadata = {};
      for (const id of lineItemIds) {
        if (metadata[id]) filtered[id] = metadata[id];
      }
      return { success: true, metadata: filtered, queue: queueStats || undefined };
    }

    return { success: true, metadata: metadata || {}, queue: queueStats || undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}

// ============================================
// RETRY
// ============================================

export async function retryFailedClaim(
  customerId: string,
  orderId: string,
  lineItemId: string,
  walletAddress: string
): Promise<ClaimSbtResponse> {
  const metadata = await getOrderSbtMetadata(orderId);

  if (!metadata?.[lineItemId]) {
    return { success: false, error: 'Line item not found in claim history' };
  }

  if (metadata[lineItemId].mint_status !== 'failed') {
    return { success: false, error: `Cannot retry: current status is ${metadata[lineItemId].mint_status}` };
  }

  claimLog.info({ orderId, lineItemId }, `RETRY ${lineItemId}`);

  return initiateClaim({ customerId, orderId, lineItemIds: [lineItemId], walletAddress });
}
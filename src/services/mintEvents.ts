/**
 * Mint Event Bus
 *
 * In-process EventEmitter that bridges the mint worker (or background processor)
 * to SSE connections. When a line item finishes minting (success or failure),
 * the worker emits an event here. Any active SSE connection listening for that
 * claimId or orderId picks it up and pushes it to the client.
 *
 * FILE: src/services/mintEvents.ts
 */

import { EventEmitter } from 'events';

// Raise the default listener limit since each SSE connection adds a listener
const bus = new EventEmitter();
bus.setMaxListeners(200);

export interface MintEvent {
  type: 'mint_progress' | 'mint_complete' | 'mint_failed';
  claimId: string;
  orderId: string;
  lineItemId: string;
  sku: string;
  data: {
    mint_status: 'in_progress' | 'minted' | 'failed';
    asset_id?: string | null;
    txn_hash?: string | null;
    wallet_address?: string | null;
    claimed_at?: string | null;
    error?: string | null;
    attempts?: number;
  };
}

/**
 * Emit a mint event. Called by the worker/background processor.
 */
export function emitMintEvent(event: MintEvent): void {
  // Emit on the claimId channel (primary)
  bus.emit(`claim:${event.claimId}`, event);
  // Also emit on the orderId channel (for order-level listeners)
  bus.emit(`order:${event.orderId}`, event);
}

/**
 * Subscribe to events for a specific claimId.
 * Returns an unsubscribe function.
 */
export function onClaimEvent(
  claimId: string,
  handler: (event: MintEvent) => void
): () => void {
  const channel = `claim:${claimId}`;
  bus.on(channel, handler);
  return () => bus.off(channel, handler);
}

/**
 * Subscribe to events for a specific orderId.
 * Returns an unsubscribe function.
 */
export function onOrderEvent(
  orderId: string,
  handler: (event: MintEvent) => void
): () => void {
  const channel = `order:${orderId}`;
  bus.on(channel, handler);
  return () => bus.off(channel, handler);
}

export default bus;
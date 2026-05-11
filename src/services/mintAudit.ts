/**
 * Mint Audit Log - Postgres
 *
 * Lightweight audit trail for all mint outcomes (success + final failure).
 * Independent from Shopify metafields. Survives API outages.
 *
 * Install: npm install pg @types/pg
 * Heroku:  heroku addons:create heroku-postgresql:essential-0
 */

import { Pool } from 'pg';
import { queueLog } from '../config/logger';

let pool: Pool | null = null;

export function initMintAuditDb(): boolean {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    queueLog.warn('DATABASE_URL not set, mint audit log disabled');
    return false;
  }

  pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30000,
  });

  pool.on('error', (err) => {
    queueLog.error({ err: err.message }, 'Postgres pool error');
  });

  // Create table if it doesn't exist
  pool.query(`
    CREATE TABLE IF NOT EXISTS mint_audit_log (
      id            SERIAL PRIMARY KEY,
      customer_id   TEXT NOT NULL,
      order_id      TEXT NOT NULL,
      line_item_id  TEXT NOT NULL,
      sku           TEXT,
      wallet_address TEXT,
      status        TEXT NOT NULL,
      asset_id      TEXT,
      txn_hash      TEXT,
      soulbound     BOOLEAN,
      attempt       INTEGER,
      error         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mint_audit_customer ON mint_audit_log(customer_id);
    CREATE INDEX IF NOT EXISTS idx_mint_audit_order ON mint_audit_log(order_id);
    CREATE INDEX IF NOT EXISTS idx_mint_audit_status ON mint_audit_log(status);
  `).then(() => {
    queueLog.info('Mint audit log table ready');
  }).catch((err) => {
    queueLog.error({ err: err.message }, 'Failed to create mint_audit_log table');
  });

  return true;
}

export interface MintAuditEntry {
  customerId: string;
  orderId: string;
  lineItemId: string;
  sku: string;
  walletAddress: string;
  status: 'minted' | 'failed';
  assetId?: string | null;
  txnHash?: string | null;
  soulbound?: boolean | null;
  attempt: number;
  error?: string | null;
}

/**
 * Log a mint outcome. Fire-and-forget: never throws, never blocks the mint flow.
 */
export async function logMintAudit(entry: MintAuditEntry): Promise<void> {
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO mint_audit_log
        (customer_id, order_id, line_item_id, sku, wallet_address, status, asset_id, txn_hash, soulbound, attempt, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.customerId,
        entry.orderId,
        entry.lineItemId,
        entry.sku,
        entry.walletAddress,
        entry.status,
        entry.assetId || null,
        entry.txnHash || null,
        entry.soulbound ?? null,
        entry.attempt,
        entry.error || null,
      ]
    );
  } catch (err) {
    // Never let audit logging break the mint flow
    queueLog.error({ err: err instanceof Error ? err.message : err }, 'Failed to write mint audit log');
  }
}

/**
 * Count successfully minted SBTs for a customer. Returns null if DB is unavailable
 * so callers can tell "0" (no mints) apart from "unknown".
 */
export async function getMintedCountForCustomer(customerId: string): Promise<number | null> {
  if (!pool) return null;

  try {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM mint_audit_log WHERE customer_id = $1 AND status = 'minted'`,
      [customerId]
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  } catch (err) {
    queueLog.error({ err: err instanceof Error ? err.message : err }, 'Failed to count minted SBTs');
    return null;
  }
}

export function isMintAuditEnabled(): boolean {
  return pool !== null;
}

export async function shutdownAuditDb(): Promise<void> {
  if (pool) {
    await pool.end();
    queueLog.info('Audit DB pool closed');
  }
}
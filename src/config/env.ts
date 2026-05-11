import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  apiSecret: process.env.SOLYD_API_SECRET || '',

  // HMAC enforcement: defaults to true in production, false in development.
  // Set REQUIRE_HMAC=false to temporarily disable during migration.
  requireHmac:
    process.env.REQUIRE_HMAC !== undefined
      ? process.env.REQUIRE_HMAC === 'true'
      : process.env.NODE_ENV === 'production',

  // Shopify Admin API
  // Minimum required scopes: write_customers, read_customers
  // Do NOT grant broader scopes than necessary
  shopify: {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN || '',
    clientId: process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
    apiVersion: '2025-10',
  },

  helius: {
    apiKey: process.env.HELIUS_API_KEY || '',
    rpcUrl: process.env.HELIUS_RPC_URL || '',
  },

  // Minting configuration
  minting: {
    // Wallet secret for minting authority (base64 encoded)
    walletSecretBase64: process.env.WALLET_SECRET_BASE64 || '',
    // Core collection address for cNFTs
    coreCollectionAddress: process.env.CORE_COLLECTION_ADDRESS || '',
    // Merkle tree address for compressed NFTs
    merkleTreeAddress: process.env.MERKLE_TREE_ADDRESS || '',
    // RPC endpoint (defaults to Helius if available)
    rpcEndpoint: process.env.RPC_ENDPOINT || process.env.HELIUS_RPC_URL || 'https://api.devnet.solana.com',
    // Retry configuration
    maxRetries: parseInt(process.env.MINT_MAX_RETRIES || '3', 10),
    retryDelayMs: parseInt(process.env.MINT_RETRY_DELAY_MS || '5000', 10),
    // DAS indexer delay (time to wait for indexer after minting)
    dasIndexerDelayMs: parseInt(process.env.DAS_INDEXER_DELAY_MS || '3000', 10),
  },

  // MailerLite transactional / membership triggers
  // API key and group IDs are read from env so they can be rotated without a deploy.
  // Rank thresholds are >= (minimum SBT count to enter the rank).
  mailerlite: {
    apiKey: process.env.MAILERLITE_API_KEY || '',
    apiUrl: process.env.MAILERLITE_API_URL || 'https://connect.mailerlite.com/api',
    timeoutMs: parseInt(process.env.MAILERLITE_TIMEOUT_MS || '5000', 10),
    groups: {
      vipMembers: process.env.MAILERLITE_GROUP_VIP_MEMBERS || '',
      silver: process.env.MAILERLITE_GROUP_SILVER || '',
      purple: process.env.MAILERLITE_GROUP_PURPLE || '',
      platina: process.env.MAILERLITE_GROUP_PLATINA || '',
    },
    thresholds: {
      silver: parseInt(process.env.MAILERLITE_THRESHOLD_SILVER || '1', 10),
      purple: parseInt(process.env.MAILERLITE_THRESHOLD_PURPLE || '5', 10),
      platina: parseInt(process.env.MAILERLITE_THRESHOLD_PLATINA || '15', 10),
    },
  },
} as const;

export function isMailerLiteEnabled(): boolean {
  const ml = config.mailerlite;
  return !!(ml.apiKey && ml.groups.vipMembers);
}

export function validateConfig(): void {
  const required = [
    { key: 'SOLYD_API_SECRET', value: config.apiSecret },
    { key: 'SHOPIFY_STORE_DOMAIN', value: config.shopify.storeDomain },
    { key: 'SHOPIFY_CLIENT_ID', value: config.shopify.clientId },
    { key: 'SHOPIFY_CLIENT_SECRET', value: config.shopify.clientSecret },
  ];

  const missing = required.filter((r) => !r.value);
  if (missing.length > 0) {
    console.error(`Missing env vars: ${missing.map((m) => m.key).join(', ')}`);
    process.exit(1);
  }

  // FATAL in production: CORS must be configured
  if (config.isProduction && config.allowedOrigins.length === 0) {
    console.error('[FATAL] ALLOWED_ORIGINS is empty in production. Server will reject all browser requests.');
    process.exit(1);
  }

  // FATAL: API secret must be strong
  if (config.apiSecret.length < 32) {
    console.error('[FATAL] SOLYD_API_SECRET must be at least 32 characters.');
    process.exit(1);
  }

  // Log HMAC mode
  console.log(`[config] HMAC enforcement: ${config.requireHmac ? 'ENABLED' : 'DISABLED (dev mode)'}`);

  // MailerLite: optional, warn if partially configured, validate threshold ordering
  const ml = config.mailerlite;
  const mlEnabled = isMailerLiteEnabled();
  if (mlEnabled) {
    const missingGroups = Object.entries(ml.groups).filter(([, v]) => !v).map(([k]) => k);
    if (missingGroups.length > 0) {
      console.warn(`[config] MailerLite: missing group IDs: ${missingGroups.join(', ')} (rank sync for those will be skipped)`);
    }
    const { silver, purple, platina } = ml.thresholds;
    if (!(silver >= 1 && purple > silver && platina > purple)) {
      console.error(`[FATAL] MailerLite thresholds must satisfy: silver >= 1 < purple < platina. Got silver=${silver} purple=${purple} platina=${platina}`);
      process.exit(1);
    }
    console.log(`[config] MailerLite: ENABLED (silver>=${silver}, purple>=${purple}, platina>=${platina})`);
  } else if (ml.apiKey || ml.groups.vipMembers) {
    console.warn('[config] MailerLite: partially configured (need both MAILERLITE_API_KEY and MAILERLITE_GROUP_VIP_MEMBERS) — DISABLED');
  } else {
    console.log('[config] MailerLite: DISABLED (no API key set)');
  }
}
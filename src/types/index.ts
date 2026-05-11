export interface SaveWalletPayload {
  customerId: string;
  walletAddress: string;
  walletSource: 'privy' | 'external';
  signature?: string;
  message?: string;
}

export interface SaveWalletResponse {
  success: boolean;
  walletAddress: string;
  customerId: string;
}

export interface MetafieldInput {
  namespace: string;
  key: string;
  value: string;
  type: string;
  ownerId: string;
}

export interface ShopifyMetafieldResponse {
  data?: {
    metafieldsSet?: {
      metafields: Array<{
        id: string;
        namespace: string;
        key: string;
        value: string;
      }>;
      userErrors: Array<{
        field: string[];
        message: string;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export interface MintNftPayload {
  walletAddress: string;
  orderId: string;
  metadata: {
    name: string;
    symbol: string;
    uri: string;
  };
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SecurityEvent {
  type: 'auth_failure' | 'auth_success' | 'validation_failure' | 'rate_limit' | 'wallet_save' | 'wallet_read' | 'wallet_change' | 'sbt_claim_start' | 'sbt_claim_validation_failed' | 'claim_started' | 'claim_failed' | 'claim_success';
  ip: string;
  path: string;
  customerId?: string;
  details?: string;
  requestId?: string;
}

// Claim types
export type MintStatus = 'unclaimed' | 'in_progress' | 'minted' | 'failed';

export interface LineItemMintData {
  sku: string;
  mint_status: MintStatus;
  wallet_address: string | null;
  txn_hash: string | null;
  asset_id: string | null;
  claimed_at: string | null;
  attempts: number;
  last_error: string | null;
}

export type OrderSbtMetadata = Record<string, LineItemMintData>;

export interface ClaimSbtPayload {
  customerId: string;
  orderId: string;
  lineItemIds: string[];
  walletAddress: string;
}

export interface ClaimSbtResponse {
  success: boolean;
  message?: string;
  claimId?: string;
  lineItems?: Array<{
    lineItemId: string;
    status: MintStatus;
  }>;
  error?: string;
}

export interface MintJobData {
  claimId: string;
  customerId: string;
  orderId: string;
  lineItemId: string;
  sku: string;
  productName?: string;
  walletAddress: string;
  attempt: number;
}
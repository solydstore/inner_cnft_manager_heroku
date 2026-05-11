import { config } from '../config/env';
import { shopifyLog } from '../config/logger';
import { getShopifyToken } from './shopifyToken';
import type { MetafieldInput, ShopifyMetafieldResponse } from '../types';
import type { OrderSbtMetadata, LineItemMintData } from '../types';

const GRAPHQL_URL = `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;

export async function shopifyGraphQL<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const token = await getShopifyToken();

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

const METAFIELDS_SET = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function setMetafields(
  metafields: MetafieldInput[]
): Promise<ShopifyMetafieldResponse> {
  return shopifyGraphQL<ShopifyMetafieldResponse>(METAFIELDS_SET, { metafields });
}

export async function setCustomerMetafield(
  customerId: string,
  namespace: string,
  key: string,
  value: string,
  type = 'single_line_text_field'
): Promise<ShopifyMetafieldResponse> {
  return setMetafields([{ ownerId: customerId, namespace, key, value, type }]);
}

const GET_METAFIELD = `
  query GetCustomerMetafield($customerId: ID!, $namespace: String!, $key: String!) {
    customer(id: $customerId) {
      id
      metafield(namespace: $namespace, key: $key) {
        id
        value
      }
    }
  }
`;

export async function getCustomerMetafield(
  customerId: string,
  namespace: string,
  key: string
): Promise<string | null> {
  const result = await shopifyGraphQL<{
    data?: { customer?: { metafield?: { value: string } | null } };
  }>(GET_METAFIELD, { customerId, namespace, key });

  return result.data?.customer?.metafield?.value ?? null;
}

export async function setOrderMetafield(
  orderId: string,
  namespace: string,
  key: string,
  value: string,
  type = 'single_line_text_field'
): Promise<ShopifyMetafieldResponse> {
  return setMetafields([{ ownerId: orderId, namespace, key, value, type }]);
}

// ============================================
// ORDER ID CACHE
// ============================================
// The Admin API order ID (gid://shopify/Order/xxx) is resolved once
// via getOrderWithSbtMetadata and never changes. Cache it so we don't
// re-fetch the full order just to get the same ID on every write.

const orderIdCache = new Map<string, { adminId: string; expiresAt: number }>();
const ORDER_ID_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cacheOrderId(inputId: string, adminId: string): void {
  orderIdCache.set(inputId, {
    adminId,
    expiresAt: Date.now() + ORDER_ID_CACHE_TTL_MS,
  });
  // Also cache the admin ID pointing to itself
  if (inputId !== adminId) {
    orderIdCache.set(adminId, {
      adminId,
      expiresAt: Date.now() + ORDER_ID_CACHE_TTL_MS,
    });
  }
}

function getCachedOrderId(inputId: string): string | null {
  const cached = orderIdCache.get(inputId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.adminId;
  }
  orderIdCache.delete(inputId);
  return null;
}

// ============================================
// ORDER QUERIES FOR SBT CLAIMS
// ============================================

interface ShopifyOrder {
  id: string;
  name: string;
  customer: { id: string } | null;
  displayFulfillmentStatus: string;
  displayFinancialStatus: string;
  lineItems: {
    nodes: Array<{
      id: string;
      name: string;
      sku: string | null;
      variantTitle: string | null;
      quantity: number;
    }>;
  };
  metafield: { value: string } | null;
}

type OrderMintMetadata = Record<string, {
  sku: string;
  mint_status: string;
  wallet_address: string | null;
  txn_hash: string | null;
  asset_id?: string | null;
  claimed_at: string | null;
  attempts?: number;
  last_error?: string | null;
}>;

const GET_ORDER_FOR_CLAIM = `
  query GetOrderForClaim($orderId: ID!) {
    order(id: $orderId) {
      id
      name
      customer {
        id
      }
      displayFulfillmentStatus
      displayFinancialStatus
      lineItems(first: 50) {
        nodes {
          id
          name
          sku
          variantTitle
          quantity
        }
      }
      metafield(namespace: "sbt", key: "mint_data") {
        value
      }
    }
  }
`;

export async function getOrderForClaim(orderId: string): Promise<ShopifyOrder | null> {
  const result = await shopifyGraphQL<{
    data?: { order?: ShopifyOrder };
    errors?: Array<{ message: string }>;
  }>(GET_ORDER_FOR_CLAIM, { orderId });

  if (result.errors?.length) {
    shopifyLog.error({ orderId, errors: result.errors }, 'GraphQL errors on getOrderForClaim');
    throw new Error(result.errors[0].message);
  }

  return result.data?.order ?? null;
}

export async function getOrderMintMetadata(orderId: string): Promise<OrderMintMetadata | null> {
  const order = await getOrderForClaim(orderId);
  if (!order?.metafield?.value) return null;

  try {
    return JSON.parse(order.metafield.value) as OrderMintMetadata;
  } catch {
    shopifyLog.error({ orderId }, 'Failed to parse mint metadata');
    return null;
  }
}

export async function updateOrderMintMetadata(
  orderId: string,
  metadata: OrderMintMetadata
): Promise<ShopifyMetafieldResponse> {
  return setOrderMetafield(
    orderId,
    'sbt',
    'mint_data',
    JSON.stringify(metadata),
    'json'
  );
}

// ============================================
// ADDITIONAL ORDER QUERIES FOR CLAIM SERVICE
// ============================================

const GET_ORDER_WITH_SBT_METADATA = `
  query GetOrderWithSbtMetadata($orderId: ID!) {
    order(id: $orderId) {
      id
      name
      customer {
        id
      }
      displayFulfillmentStatus
      displayFinancialStatus
      lineItems(first: 50) {
        nodes {
          id
          name
          sku
          variantTitle
          quantity
          variant {
            sku
          }
        }
      }
      metafield(namespace: "sbt", key: "mint_data") {
        value
      }
    }
  }
`;

const GET_ORDER_BY_ID_NUMBER = `
  query GetOrderByIdNumber($query: String!) {
    orders(first: 1, query: $query) {
      nodes {
        id
        name
        customer {
          id
        }
        displayFulfillmentStatus
        displayFinancialStatus
        lineItems(first: 50) {
          nodes {
            id
            name
            sku
            variantTitle
            quantity
            variant {
              sku
            }
          }
        }
        metafield(namespace: "sbt", key: "mint_data") {
          value
        }
      }
    }
  }
`;

interface OrderData {
  id: string;
  name: string;
  customer: { id: string } | null;
  displayFulfillmentStatus: string;
  displayFinancialStatus: string;
  lineItems: {
    nodes: Array<{
      id: string;
      name: string;
      sku: string | null;
      variantTitle: string | null;
      quantity: number;
      variant?: { sku: string | null };
    }>;
  };
  metafield: { value: string } | null;
}

interface OrderWithSbtMetadataResult {
  data?: {
    order?: OrderData;
  };
  errors?: Array<{ message: string }>;
}

interface OrderSearchResult {
  data?: {
    orders?: {
      nodes: OrderData[];
    };
  };
  errors?: Array<{ message: string }>;
}

export async function getOrderWithSbtMetadata(orderId: string): Promise<OrderWithSbtMetadataResult> {
  shopifyLog.debug({ orderId }, 'Fetching order');

  let result = await shopifyGraphQL<OrderWithSbtMetadataResult>(GET_ORDER_WITH_SBT_METADATA, { orderId });

  if (!result.data?.order) {
    const numericId = orderId.split('/').pop();

    if (numericId) {
      shopifyLog.debug({ orderId, numericId }, 'Direct lookup failed, searching by numeric ID');

      const searchResult = await shopifyGraphQL<OrderSearchResult>(GET_ORDER_BY_ID_NUMBER, {
        query: `id:${numericId}`,
      });

      if (searchResult.data?.orders?.nodes?.[0]) {
        result = {
          data: { order: searchResult.data.orders.nodes[0] },
          errors: searchResult.errors,
        };
      }
    }
  }

  // Cache the resolved admin order ID
  if (result.data?.order?.id) {
    cacheOrderId(orderId, result.data.order.id);
  }

  shopifyLog.debug({ orderId, found: !!result.data?.order }, 'Order lookup result');

  return result;
}

/**
 * Get SBT metadata from an order.
 * Returns both the metadata AND the resolved admin order ID to avoid re-fetching.
 */
export async function getOrderSbtMetadataWithAdminId(orderId: string): Promise<{
  metadata: OrderSbtMetadata | null;
  adminOrderId: string;
}> {
  const result = await getOrderWithSbtMetadata(orderId);

  if (result.errors?.length) {
    throw new Error(result.errors[0].message);
  }

  const adminOrderId = result.data?.order?.id || orderId;
  const metafieldValue = result.data?.order?.metafield?.value;

  if (!metafieldValue) {
    return { metadata: null, adminOrderId };
  }

  try {
    return {
      metadata: JSON.parse(metafieldValue) as OrderSbtMetadata,
      adminOrderId,
    };
  } catch {
    shopifyLog.error({ orderId }, 'Failed to parse SBT metadata');
    return { metadata: null, adminOrderId };
  }
}

/**
 * Original getOrderSbtMetadata - kept for backward compatibility (status checks, retries).
 */
export async function getOrderSbtMetadata(orderId: string): Promise<OrderSbtMetadata | null> {
  const { metadata } = await getOrderSbtMetadataWithAdminId(orderId);
  return metadata;
}

/**
 * Write SBT metadata directly using a known admin order ID.
 * Skips the order lookup entirely.
 */
export async function writeOrderSbtMetadata(
  adminOrderId: string,
  metadata: OrderSbtMetadata
): Promise<ShopifyMetafieldResponse> {
  return setOrderMetafield(
    adminOrderId,
    'sbt',
    'mint_data',
    JSON.stringify(metadata),
    'json'
  );
}

/**
 * Original setOrderSbtMetadata - resolves admin ID via cache or fetch.
 * Used when the caller doesn't have the admin ID handy.
 */
export async function setOrderSbtMetadata(
  orderId: string,
  metadata: OrderSbtMetadata
): Promise<ShopifyMetafieldResponse> {
  // Check cache first
  const cachedId = getCachedOrderId(orderId);
  if (cachedId) {
    shopifyLog.debug({ orderId, cachedId }, 'Using cached admin order ID');
    return writeOrderSbtMetadata(cachedId, metadata);
  }

  // Cache miss: fetch to resolve
  let adminOrderId = orderId;
  if (orderId.startsWith('gid://shopify/Order/')) {
    const result = await getOrderWithSbtMetadata(orderId);
    if (result.data?.order?.id) {
      adminOrderId = result.data.order.id;
    }
  }

  return writeOrderSbtMetadata(adminOrderId, metadata);
}

/**
 * Update a single line item's SBT status.
 * Optimized: uses cached admin ID when available.
 */
export async function updateLineItemSbtStatus(
  orderId: string,
  lineItemId: string,
  updates: Partial<LineItemMintData>
): Promise<void> {
  // Get current metadata + admin ID in one call
  const { metadata: existingMetadata, adminOrderId } = await getOrderSbtMetadataWithAdminId(orderId);
  const metadata = existingMetadata || {};

  if (!metadata[lineItemId]) {
    metadata[lineItemId] = {
      sku: '',
      mint_status: 'unclaimed',
      wallet_address: null,
      txn_hash: null,
      asset_id: null,
      claimed_at: null,
      attempts: 0,
      last_error: null,
    };
  }

  metadata[lineItemId] = {
    ...metadata[lineItemId],
    ...updates,
  };

  // Write directly with the admin ID (no re-fetch)
  await writeOrderSbtMetadata(adminOrderId, metadata);
}

// ============================================
// CUSTOMER TAGGING
// ============================================

export interface CustomerProfile {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
}

const GET_CUSTOMER_PROFILE = `
  query GetCustomerProfile($id: ID!) {
    customer(id: $id) {
      id
      email
      firstName
      lastName
      displayName
    }
  }
`;

export async function getCustomerProfile(customerId: string): Promise<CustomerProfile | null> {
  const result = await shopifyGraphQL<{
    data?: { customer?: CustomerProfile | null };
    errors?: Array<{ message: string }>;
  }>(GET_CUSTOMER_PROFILE, { id: customerId });

  if (result.errors?.length) {
    shopifyLog.warn({ customerId, errors: result.errors }, 'getCustomerProfile errors');
    return null;
  }

  return result.data?.customer ?? null;
}

export async function getCustomerTags(customerId: string): Promise<string[]> {
  const result = await shopifyGraphQL<{
    data?: { customer?: { tags: string[] } };
  }>(
    `query GetCustomerTags($id: ID!) {
      customer(id: $id) { tags }
    }`,
    { id: customerId }
  );

  return result.data?.customer?.tags ?? [];
}

export async function addCustomerTag(customerId: string, tag: string): Promise<void> {
  const result = await shopifyGraphQL<{
    data?: { tagsAdd?: { userErrors: Array<{ field: string; message: string }> } };
  }>(
    `mutation AddCustomerTag($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }`,
    { id: customerId, tags: [tag] }
  );

  const errors = result.data?.tagsAdd?.userErrors;
  if (errors?.length) {
    throw new Error(`Tag error: ${errors.map((e) => e.message).join('; ')}`);
  }
}
import { config } from '../config/env';
import { shopifyLog } from '../config/logger';

// ============================================
// SHOPIFY CLIENT-CREDENTIALS TOKEN MANAGER
// ============================================
// Fetches a short-lived access_token via POST to the OAuth endpoint,
// caches it in memory, and proactively refreshes before expiry.
// A safety buffer (default 10 min) ensures we never serve an expired token.

const REFRESH_BUFFER_S = 10 * 60; // refresh 10 min before actual expiry

let cachedToken: string | null = null;
let expiresAt = 0; // unix epoch seconds
let refreshPromise: Promise<string> | null = null; // dedup concurrent calls

async function fetchNewToken(): Promise<{ access_token: string; expires_in: number }> {
  const url = `https://${config.shopify.storeDomain}/admin/oauth/access_token`;

  shopifyLog.info('Requesting new Shopify client-credentials token');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: config.shopify.clientId,
      client_secret: config.shopify.clientSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify token request failed ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    scope: string;
    expires_in: number;
  };

  shopifyLog.info(
    { scope: data.scope, expires_in: data.expires_in },
    'Shopify token acquired'
  );

  return data;
}

/**
 * Returns a valid Shopify Admin API access token.
 * - Serves from cache when still fresh.
 * - Proactively fetches a new one when within the safety buffer.
 * - Deduplicates concurrent refresh calls so only one HTTP request fires.
 */
export async function getShopifyToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Token still valid and outside the refresh buffer
  if (cachedToken && now < expiresAt - REFRESH_BUFFER_S) {
    return cachedToken;
  }

  // Need a refresh. Deduplicate so parallel requests share one fetch.
  if (!refreshPromise) {
    refreshPromise = fetchNewToken()
      .then(({ access_token, expires_in }) => {
        cachedToken = access_token;
        expiresAt = Math.floor(Date.now() / 1000) + expires_in;
        return access_token;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}
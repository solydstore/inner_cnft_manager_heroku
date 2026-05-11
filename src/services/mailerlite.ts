/**
 * MailerLite membership trigger service.
 *
 * Responsibilities:
 *   - On first wallet save  -> subscribe customer to the VIP MEMBERS group.
 *   - On each mint success  -> recompute rank (silver/purple/platina) from total
 *                              minted count, add to target rank group, and remove
 *                              from other rank groups so the subscriber is in
 *                              exactly one rank at a time (plus VIP MEMBERS).
 *
 * Safety:
 *   - All calls are fire-and-forget from the caller's perspective: failures here
 *     MUST NOT break wallet save, minting, or claim flows. Every public function
 *     catches its own errors and logs them.
 *   - API key and group IDs come from env (see config.mailerlite).
 *   - AbortController timeout on every HTTP call so a hung MailerLite does not
 *     stall the server.
 *   - No PII beyond what's needed for templating (email, name, wallet, counts).
 */

import { rootLogger } from '../config/logger';
import { config, isMailerLiteEnabled } from '../config/env';
import { getCustomerProfile, type CustomerProfile } from './shopify';
import { getMintedCountForCustomer, isMintAuditEnabled } from './mintAudit';

const mlLog = rootLogger.child({ service: 'mailer ' });

export type VipRank = 'silver' | 'purple' | 'platina';

interface MailerLiteSubscriber {
  id: string;
  email: string;
  status: string;
  fields?: Record<string, unknown>;
  groups?: Array<{ id: string; name: string }>;
}

interface UpsertParams {
  email: string;
  fields: Record<string, string | number | null>;
  groupIds: string[];
}

// ============================================
// PUBLIC TRIGGERS
// ============================================

/**
 * Called after a customer saves their wallet for the first time.
 * Adds them to the VIP MEMBERS group with personalization fields.
 * Never throws.
 */
export async function onWalletActivated(params: {
  customerId: string;
  walletAddress: string;
}): Promise<void> {
  const walletShort =
    params.walletAddress.slice(0, 4) + '…' + params.walletAddress.slice(-4);
  const baseCtx = { customerId: params.customerId, wallet: walletShort };

  mlLog.info(baseCtx, `TRIGGER onWalletActivated customer=${params.customerId} wallet=${walletShort}`);

  if (!isMailerLiteEnabled()) {
    mlLog.warn(
      { ...baseCtx, apiKeySet: !!config.mailerlite.apiKey, vipGroupSet: !!config.mailerlite.groups.vipMembers },
      'MailerLite DISABLED (check MAILERLITE_API_KEY and MAILERLITE_GROUP_VIP_MEMBERS) — skipping'
    );
    return;
  }

  try {
    mlLog.info(baseCtx, 'Fetching Shopify customer profile');
    const profile = await getCustomerProfile(params.customerId);

    if (!profile) {
      mlLog.warn(baseCtx, 'Shopify returned no customer profile (customer not found?), skipping');
      return;
    }

    if (!profile.email) {
      mlLog.warn(baseCtx, 'Shopify profile has no email, skipping MailerLite subscribe');
      return;
    }

    const vipGroup = config.mailerlite.groups.vipMembers;
    if (!vipGroup) {
      mlLog.warn(baseCtx, 'MAILERLITE_GROUP_VIP_MEMBERS is empty, skipping wallet-activated trigger');
      return;
    }

    const email = profile.email;
    const masked = maskEmail(email);
    mlLog.info(
      { ...baseCtx, email: masked, firstName: profile.firstName, lastName: profile.lastName, vipGroup },
      `Calling MailerLite upsert email=${masked} firstName=${profile.firstName || ''} group=${vipGroup}`
    );

    const subscriber = await upsertSubscriber({
      email,
      groupIds: [vipGroup],
      fields: buildPersonalFields({
        profile,
        walletAddress: params.walletAddress,
        rank: null,
        sbtCount: 0,
        lastSbt: null,
      }),
    });

    if (!subscriber) {
      mlLog.error({ ...baseCtx, email: masked }, `SUBSCRIBE FAILED ${masked} (see previous HTTP error log)`);
      return;
    }

    mlLog.info(
      { ...baseCtx, email: masked, subscriberId: subscriber.id, vipGroup },
      `SUBSCRIBED ${masked} -> VIP MEMBERS (subscriberId=${subscriber.id} group=${vipGroup})`
    );
  } catch (err) {
    mlLog.error(
      { ...baseCtx, err: err instanceof Error ? err.message : err, stack: err instanceof Error ? err.stack : undefined },
      'onWalletActivated failed (non-fatal)'
    );
  }
}

/**
 * Called after a mint succeeds. Recomputes the subscriber's VIP rank based on
 * total minted SBTs for this customer, assigns them to the matching rank group,
 * and removes them from the other rank groups.
 * Never throws.
 */
export async function onMintSuccess(params: {
  customerId: string;
  walletAddress: string;
  sku: string;
  assetId: string | null;
  txnHash: string | null;
}): Promise<void> {
  const baseCtx = { customerId: params.customerId, sku: params.sku };

  mlLog.info(baseCtx, `TRIGGER onMintSuccess customer=${params.customerId} sku=${params.sku}`);

  if (!isMailerLiteEnabled()) {
    mlLog.warn(baseCtx, 'MailerLite DISABLED, skipping rank sync');
    return;
  }

  try {
    if (!isMintAuditEnabled()) {
      mlLog.warn(baseCtx, 'Audit DB disabled, skipping rank sync (set DATABASE_URL to enable)');
      return;
    }

    const [profile, sbtCount] = await Promise.all([
      getCustomerProfile(params.customerId),
      getMintedCountForCustomer(params.customerId),
    ]);

    if (!profile?.email) {
      mlLog.warn(baseCtx, 'No email on Shopify profile, skipping rank sync');
      return;
    }

    if (sbtCount === null) {
      mlLog.warn(baseCtx, 'Audit count returned null, skipping rank sync');
      return;
    }

    const rank = rankFromSbtCount(sbtCount);
    const targetGroupId = rank ? config.mailerlite.groups[rank] : null;
    const vipGroup = config.mailerlite.groups.vipMembers;
    const masked = maskEmail(profile.email);

    const groupIds: string[] = [];
    if (vipGroup) groupIds.push(vipGroup);
    if (targetGroupId) groupIds.push(targetGroupId);

    mlLog.info(
      { ...baseCtx, email: masked, sbtCount, rank: rank || 'none', groupIds },
      `RANK RESOLVE sbtCount=${sbtCount} rank=${rank || 'member'} groups=[${groupIds.join(',')}]`
    );

    const subscriber = await upsertSubscriber({
      email: profile.email,
      groupIds,
      fields: buildPersonalFields({
        profile,
        walletAddress: params.walletAddress,
        rank,
        sbtCount,
        lastSbt: {
          sku: params.sku,
          assetId: params.assetId,
          txnHash: params.txnHash,
          claimedAt: new Date().toISOString(),
        },
      }),
    });

    if (!subscriber) {
      mlLog.error({ ...baseCtx, email: masked }, 'RANK UPSERT FAILED (see previous HTTP error log)');
      return;
    }

    // Remove from other rank groups so subscriber is in exactly one rank at a time.
    await enforceSingleRank(subscriber.id, targetGroupId);

    mlLog.info(
      {
        customerId: params.customerId,
        email: maskEmail(profile.email),
        sbtCount,
        rank: rank || 'none',
      },
      `RANK SYNCED ${maskEmail(profile.email)} -> ${rank || 'member'} (${sbtCount} SBTs)`
    );
  } catch (err) {
    mlLog.error(
      { customerId: params.customerId, err: err instanceof Error ? err.message : err },
      'onMintSuccess failed (non-fatal)'
    );
  }
}

// ============================================
// RANK RESOLUTION
// ============================================

export function rankFromSbtCount(count: number): VipRank | null {
  const { silver, purple, platina } = config.mailerlite.thresholds;
  if (count >= platina) return 'platina';
  if (count >= purple) return 'purple';
  if (count >= silver) return 'silver';
  return null;
}

function rankGroupIds(): string[] {
  const { silver, purple, platina } = config.mailerlite.groups;
  return [silver, purple, platina].filter((v): v is string => !!v);
}

async function enforceSingleRank(subscriberId: string, keepGroupId: string | null): Promise<void> {
  const toRemove = rankGroupIds().filter((id) => id !== keepGroupId);
  await Promise.all(toRemove.map((id) => removeFromGroup(subscriberId, id)));
}

// ============================================
// FIELD BUILDING
// ============================================

interface PersonalFieldsInput {
  profile: CustomerProfile;
  walletAddress: string;
  rank: VipRank | null;
  sbtCount: number;
  lastSbt: {
    sku: string;
    assetId: string | null;
    txnHash: string | null;
    claimedAt: string;
  } | null;
}

/**
 * Build MailerLite custom-field payload used for email templating.
 * Field keys must exist on the MailerLite account (create them in the dashboard
 * under Subscribers -> Fields). Missing fields are simply ignored by MailerLite.
 */
function buildPersonalFields(input: PersonalFieldsInput): Record<string, string | number | null> {
  const { profile, walletAddress, rank, sbtCount, lastSbt } = input;
  const wallet = walletAddress || '';
  const walletShort = wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : '';

  const fields: Record<string, string | number | null> = {
    name: profile.firstName || profile.displayName || '',
    last_name: profile.lastName || '',
    vip_rank: rank || 'member',
    sbt_count: sbtCount,
    wallet_address: wallet,
    wallet_short: walletShort,
    shopify_customer_id: numericShopifyId(profile.id),
  };

  if (lastSbt) {
    fields.last_sbt_sku = lastSbt.sku;
    fields.last_sbt_asset_id = lastSbt.assetId || '';
    fields.last_sbt_txn_hash = lastSbt.txnHash || '';
    fields.last_sbt_claimed_at = lastSbt.claimedAt;
  }

  return fields;
}

function numericShopifyId(gid: string): string {
  return gid.split('/').pop() || gid;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(0, local.length - 2))}@${domain}`;
}

// ============================================
// HTTP CLIENT (MailerLite Classic/Connect API v3)
// ============================================

async function mlFetch<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: T | null; errorText?: string }> {
  const url = `${config.mailerlite.apiUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.mailerlite.timeoutMs);
  const start = Date.now();

  mlLog.info({ method, path }, `HTTP ${method} ${path}`);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${config.mailerlite.apiKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const ms = Date.now() - start;

    // 204 No Content (common for DELETE) has no body
    if (res.status === 204) {
      mlLog.info({ method, path, status: 204, ms }, `HTTP ${method} ${path} -> 204 ${ms}ms`);
      return { ok: true, status: 204, data: null };
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // non-JSON body
      }
    }

    if (!res.ok) {
      mlLog.error(
        { method, path, status: res.status, ms, body: text.slice(0, 500) },
        `HTTP ${method} ${path} -> ${res.status} ${ms}ms FAILED`
      );
      return { ok: false, status: res.status, data: null, errorText: text.slice(0, 500) };
    }

    mlLog.info({ method, path, status: res.status, ms }, `HTTP ${method} ${path} -> ${res.status} ${ms}ms`);
    return { ok: true, status: res.status, data: parsed as T };
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    mlLog.error({ method, path, ms, err: message }, `HTTP ${method} ${path} -> NETWORK ERROR ${ms}ms (${message})`);
    return { ok: false, status: 0, data: null, errorText: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create or update a subscriber. Returns the subscriber record on success.
 * MailerLite treats POST /subscribers as upsert-by-email.
 */
/**
 * Create or update a subscriber, then explicitly assign to each group.
 *
 * The MailerLite Connect API silently ignores the `groups` array on
 * POST /subscribers — a subscriber is created but not added to any group.
 * The canonical way to assign groups is the dedicated endpoint
 * POST /subscribers/{subscriber_id}/groups/{group_id}.
 */
async function upsertSubscriber(params: UpsertParams): Promise<MailerLiteSubscriber | null> {
  const body = {
    email: params.email,
    fields: params.fields,
    status: 'active',
    resubscribe: false,
  };

  const result = await mlFetch<{ data: MailerLiteSubscriber }>('POST', '/subscribers', body);

  if (!result.ok) {
    mlLog.error(
      { email: maskEmail(params.email), status: result.status, err: result.errorText },
      `MailerLite upsert failed (${result.status})`
    );
    return null;
  }

  const subscriber = result.data?.data ?? null;
  if (!subscriber?.id) {
    mlLog.error({ email: maskEmail(params.email) }, 'MailerLite upsert returned no subscriber id');
    return null;
  }

  // Explicitly assign to each group. Run in parallel since they're independent.
  await Promise.all(params.groupIds.map((gid) => assignToGroup(subscriber.id, gid)));

  return subscriber;
}

async function assignToGroup(subscriberId: string, groupId: string): Promise<void> {
  const result = await mlFetch<unknown>(
    'POST',
    `/subscribers/${encodeURIComponent(subscriberId)}/groups/${encodeURIComponent(groupId)}`
  );

  if (!result.ok) {
    mlLog.error(
      { subscriberId, groupId, status: result.status, err: result.errorText },
      `ASSIGN TO GROUP FAILED subscriber=${subscriberId} group=${groupId} status=${result.status}`
    );
    return;
  }

  mlLog.info(
    { subscriberId, groupId, status: result.status },
    `ASSIGNED subscriber=${subscriberId} -> group=${groupId}`
  );
}

async function removeFromGroup(subscriberId: string, groupId: string): Promise<void> {
  const result = await mlFetch<unknown>(
    'DELETE',
    `/subscribers/${encodeURIComponent(subscriberId)}/groups/${encodeURIComponent(groupId)}`
  );

  // 404 is fine — subscriber wasn't in that group
  if (!result.ok && result.status !== 404) {
    mlLog.warn(
      { subscriberId, groupId, status: result.status, err: result.errorText },
      `MailerLite removeFromGroup failed (${result.status})`
    );
  }
}

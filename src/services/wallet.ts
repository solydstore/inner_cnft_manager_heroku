//services/wallet.ts

import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import { setCustomerMetafield, getCustomerMetafield, getCustomerTags, addCustomerTag } from './shopify';
import { logSecurityEvent } from '../config/logger';
import { walletLog } from '../config/logger';
import { onWalletActivated } from './mailerlite';
import type { SaveWalletPayload, SaveWalletResponse } from '../types';

const NAMESPACE = 'custom';
const KEY = 'wallet_address';

function verifyWalletOwnership(
  walletAddress: string,
  signature?: string,
  message?: string
): boolean {
  if (!signature || !message) {
    return true;
  }

  try {
    const publicKey = new PublicKey(walletAddress);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = Buffer.from(signature, 'base64');

    return nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKey.toBytes()
    );
  } catch {
    return false;
  }
}

export async function saveWallet(
  payload: SaveWalletPayload
): Promise<SaveWalletResponse> {
  const { customerId, walletAddress, walletSource, signature, message } = payload;
  const walletShort = walletAddress.slice(0, 4) + '...' + walletAddress.slice(-4);
  const ctx = { customerId, wallet: walletShort, source: walletSource };

  walletLog.info(ctx, `SAVE ${walletShort} (${walletSource}) -> ${customerId}`);

  if (signature && message) {
    const isOwner = verifyWalletOwnership(walletAddress, signature, message);
    if (!isOwner) {
      walletLog.warn(ctx, 'Ownership verification FAILED');
      throw new Error('Wallet ownership verification failed. Invalid signature.');
    }
    walletLog.info(ctx, 'Ownership verified via signature');
  }

  const existingWallet = await getCustomerMetafield(customerId, NAMESPACE, KEY);
  if (existingWallet && existingWallet !== walletAddress) {
    logSecurityEvent({
      type: 'wallet_change',
      ip: 'server',
      path: '/api/wallet/save',
      customerId,
      details: `${existingWallet.slice(0, 4)}...${existingWallet.slice(-4)} -> ${walletShort}`,
    });
  }

  const result = await setCustomerMetafield(customerId, NAMESPACE, KEY, walletAddress);

  if (result.errors?.length) {
    throw new Error(`GraphQL errors: ${result.errors.map((e) => e.message).join('; ')}`);
  }

  const userErrors = result.data?.metafieldsSet?.userErrors;
  if (userErrors?.length) {
    throw new Error(`Metafield errors: ${userErrors.map((e) => e.message).join('; ')}`);
  }

  const VIP_TAG = 'vip-activated';
  // Always check tag state (independent of existingWallet) so we recover if a
  // previous save wrote the metafield but the tag add failed. The MailerLite
  // trigger is fired exactly when we add the tag — the two events are coupled.
  try {
    const tags = await getCustomerTags(customerId);
    if (!tags.includes(VIP_TAG)) {
      await addCustomerTag(customerId, VIP_TAG);
      walletLog.info(ctx, `TAGGED ${VIP_TAG} -> firing MailerLite VIP MEMBERS trigger`);

      // Fire-and-forget: subscribe to MailerLite VIP MEMBERS group when the
      // vip-activated tag is added. onWalletActivated swallows its own errors.
      void onWalletActivated({ customerId, walletAddress });
    } else {
      walletLog.info(ctx, `${VIP_TAG} tag already present, skipping MailerLite trigger`);
    }
  } catch (tagErr) {
    walletLog.error(
      { ...ctx, err: tagErr instanceof Error ? tagErr.message : tagErr },
      'Failed to add vip-activated tag (MailerLite trigger skipped)'
    );
  }

  walletLog.info(ctx, 'SAVED');
  return { success: true, walletAddress, customerId };
}

export async function getWallet(customerId: string): Promise<string | null> {
  return getCustomerMetafield(customerId, NAMESPACE, KEY);
}
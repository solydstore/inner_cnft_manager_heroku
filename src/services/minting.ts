/**
 * SBT Minting Service
 *
 * Handles compressed NFT minting with soulbound (non-transferable) flag.
 * Uses Metaplex Bubblegum V2.
 */

import { Buffer } from 'buffer';
import {
  keypairIdentity,
  publicKey,
  createSignerFromKeypair,
  some,
  type Umi,
  type PublicKey,
  type Signer,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  mintV2,
  mplBubblegum,
  parseLeafFromMintV2Transaction,
  setNonTransferableV2,
  fetchTreeConfigFromSeeds,
} from '@metaplex-foundation/mpl-bubblegum';
import { mplCore } from '@metaplex-foundation/mpl-core';
import { dasApi } from '@metaplex-foundation/digital-asset-standard-api';
import { config } from '../config/env';
import { mintLog } from '../config/logger';

// ============================================
// TYPES
// ============================================

export interface MintResult {
  success: boolean;
  assetId?: string;
  txnHash?: string;
  soulbound?: boolean;
  error?: string;
}

export interface ProductMetadata {
  name: string;
  uri: string;
}

// ============================================
// UMI SINGLETON
// ============================================

import type { Keypair } from '@metaplex-foundation/umi';

let umiInstance: Umi | null = null;
let signerInstance: Signer | null = null;
let keypairInstance: Keypair | null = null;

function getUmi(): { umi: Umi; signer: Signer; keypair: Keypair } {
  if (umiInstance && signerInstance && keypairInstance) {
    return { umi: umiInstance, signer: signerInstance, keypair: keypairInstance };
  }

  const { walletSecretBase64, rpcEndpoint, merkleTreeAddress, coreCollectionAddress } = config.minting;

  if (!walletSecretBase64 || !merkleTreeAddress || !coreCollectionAddress) {
    throw new Error('Minting not configured. Missing WALLET_SECRET_BASE64, MERKLE_TREE_ADDRESS, or CORE_COLLECTION_ADDRESS');
  }

  const secretKey = Uint8Array.from(
    JSON.parse(Buffer.from(walletSecretBase64, 'base64').toString('utf-8'))
  );

  umiInstance = createUmi(rpcEndpoint)
    .use(mplBubblegum())
    .use(mplCore())
    .use(dasApi());

  keypairInstance = umiInstance.eddsa.createKeypairFromSecretKey(secretKey);
  signerInstance = createSignerFromKeypair(umiInstance, keypairInstance);
  umiInstance.use(keypairIdentity(keypairInstance));

  mintLog.info({ authority: signerInstance.publicKey.toString() }, 'UMI initialized');

  return { umi: umiInstance, signer: signerInstance, keypair: keypairInstance };
}

// ============================================
// TREE STATUS CHECK
// ============================================

export async function checkTreeCapacity(): Promise<{
  minted: number;
  capacity: number;
  remaining: number;
  percentUsed: number;
  isFull: boolean;
}> {
  const { umi } = getUmi();
  const merkleTree = publicKey(config.minting.merkleTreeAddress);

  const treeConfig = await fetchTreeConfigFromSeeds(umi, { merkleTree });
  const minted = Number(treeConfig.numMinted);
  const capacity = Number(treeConfig.totalMintCapacity);
  const remaining = capacity - minted;
  const percentUsed = (minted / capacity) * 100;

  return {
    minted,
    capacity,
    remaining,
    percentUsed,
    isFull: minted >= capacity,
  };
}

// ============================================
// PRODUCT METADATA MAPPING
// ============================================

// Products are split into two device groups based on the product name:
//   - "iphone"  -> contains "iPhone" (e.g. "Vanta iPhone Case")
//   - "seeker"  -> contains "Seeker" (e.g. "Vanta Seeker Case")
// Within each group, the brand prefix (the words before "iPhone Case" /
// "Seeker Case") selects the metadata URI. The same brand can map to
// different URIs in each group (e.g. iPhone Vanta vs Seeker Vanta).
//
// The on-chain NFT name comes from the matched rule's displayName (the brand
// name as it appears in the off-chain JSON, e.g. "Vanta" or "Pudgy Penguins:
// Pengu Edition"). Fallback when no rule matches: the product's brand portion
// (everything before "iPhone"/"Seeker"/"Case") — e.g. "The Fifth Cause iPhone
// Case" -> "The Fifth Cause".
//
// URIs/names can be overridden via env vars (URI_IPHONE_<BRAND>,
// URI_SEEKER_<BRAND>, NAME_IPHONE_<BRAND>, NAME_SEEKER_<BRAND>).
// Prefixes are checked longest-first so e.g. "MONKE CONSOLE" wins over "MONKE".

type DeviceGroup = 'iphone' | 'seeker';

interface BrandRule {
  envKey: string;        // env var holding the URI override
  nameEnvKey: string;    // env var holding the display name override
  group: DeviceGroup;    // device family this rule applies to
  prefix: string;        // case-insensitive prefix matched against the brand portion
  displayName: string;   // on-chain NFT name (matches the off-chain metadata "name")
  defaultUri?: string;   // fallback URI if env var is not set
}

const BRAND_RULES: BrandRule[] = ([
  // ---------- iPhone ----------
  { envKey: 'URI_IPHONE_VANTA',           nameEnvKey: 'NAME_IPHONE_VANTA',           group: 'iphone', prefix: 'VANTA',           displayName: 'Vanta',           defaultUri: 'https://gateway.irys.xyz/GJFu8GmWvjoym6dp6XxMEbQCLfVa6Eav4VWjZ3Gka26S' },
  { envKey: 'URI_IPHONE_OBSIDIAN',        nameEnvKey: 'NAME_IPHONE_OBSIDIAN',        group: 'iphone', prefix: 'OBSIDIAN',        displayName: 'Obsidian',        defaultUri: 'https://gateway.irys.xyz/9hXx3bxE5R1sb4rK8EsxPHDb55waGP2HyzGsHmhbTkUr' },
  { envKey: 'URI_IPHONE_SPIRIT',          nameEnvKey: 'NAME_IPHONE_SPIRIT',          group: 'iphone', prefix: 'SPIRIT',          displayName: 'Spirit',          defaultUri: 'https://gateway.irys.xyz/6dczhzGT2RHKx7k2mFyLNneGn593iDx1a4WqpKpbNnwr' },
  { envKey: 'URI_IPHONE_THE_FIFTH_CAUSE', nameEnvKey: 'NAME_IPHONE_THE_FIFTH_CAUSE', group: 'iphone', prefix: 'THE FIFTH CAUSE', displayName: 'The Fifth Cause', defaultUri: 'https://gateway.irys.xyz/8PsYoQdA3w2d42kL2nU4vmE6rRdEv5admAqApWwAaDFp' },
  { envKey: 'URI_IPHONE_GENESIS',         nameEnvKey: 'NAME_IPHONE_GENESIS',         group: 'iphone', prefix: 'GENESIS',         displayName: 'Genesis',         defaultUri: 'https://gateway.irys.xyz/ApdadMkg296MLsU1aJftiqA9Yf7e57xLsS39d45vJgeB' },
  { envKey: 'URI_IPHONE_ETERNAL_CYCLE',   nameEnvKey: 'NAME_IPHONE_ETERNAL_CYCLE',   group: 'iphone', prefix: 'ETERNAL CYCLE',   displayName: 'Eternal Cycle',   defaultUri: 'https://gateway.irys.xyz/CsWhfnm2Rb9w7bmgEtsoS1ttEnQPxkCXScmsqu2TQoDL' },
  { envKey: 'URI_IPHONE_BORN_SOLYD',      nameEnvKey: 'NAME_IPHONE_BORN_SOLYD',      group: 'iphone', prefix: 'BORN SOLYD',      displayName: 'BORN SOLYD',      defaultUri: 'https://gateway.irys.xyz/4zurXQsdJ64NRCinWbWGZuCB3b43QpiFK97BzREFnqyh' },
  { envKey: 'URI_IPHONE_ZERO',            nameEnvKey: 'NAME_IPHONE_ZERO',            group: 'iphone', prefix: 'ZERO',            displayName: 'Zero',            defaultUri: 'https://gateway.irys.xyz/GoMzWfgpUGpXfFrEtpagqx4BkNb7zARx4X3HTHHmoZ9r' },
  // "KNG BONK" is the actual iPhone metadata title; matches both "KING BONK" and "KNG BONK" product naming.
  { envKey: 'URI_IPHONE_KNG_BONK',        nameEnvKey: 'NAME_IPHONE_KNG_BONK',        group: 'iphone', prefix: 'KING BONK',       displayName: 'KNG BONK',        defaultUri: 'https://gateway.irys.xyz/Eo4stG8xXTDnGqc8LCaWVLUmctTufR96wSgh28Vnvbn8' },
  { envKey: 'URI_IPHONE_KNG_BONK',        nameEnvKey: 'NAME_IPHONE_KNG_BONK',        group: 'iphone', prefix: 'KNG BONK',        displayName: 'KNG BONK',        defaultUri: 'https://gateway.irys.xyz/Eo4stG8xXTDnGqc8LCaWVLUmctTufR96wSgh28Vnvbn8' },

  // ---------- Seeker ----------
  { envKey: 'URI_SEEKER_BIBI',                  nameEnvKey: 'NAME_SEEKER_BIBI',                  group: 'seeker', prefix: 'BIBI THE BAGUETTE',         displayName: 'Bibi The Baguette',         defaultUri: 'https://gateway.irys.xyz/n623PNwBxGtiGwHzJxIHc3frncVQ2gcUKWDjEZKhse0' },
  { envKey: 'URI_SEEKER_BIBI',                  nameEnvKey: 'NAME_SEEKER_BIBI',                  group: 'seeker', prefix: 'BIBI',                      displayName: 'Bibi The Baguette',         defaultUri: 'https://gateway.irys.xyz/n623PNwBxGtiGwHzJxIHc3frncVQ2gcUKWDjEZKhse0' },
  { envKey: 'URI_SEEKER_BORN_SOLYD',            nameEnvKey: 'NAME_SEEKER_BORN_SOLYD',            group: 'seeker', prefix: 'BORN SOLYD',                displayName: 'Born SOLYD',                defaultUri: 'https://arweave.net/zUiNeOO1rsp9XK8gLpWsSdONjgmTgldcVRCMvr61m8s' },
  { envKey: 'URI_SEEKER_BLOOD',                 nameEnvKey: 'NAME_SEEKER_BLOOD',                 group: 'seeker', prefix: 'BLOOD ON THE STREETS',      displayName: 'Blood On The Streets',      defaultUri: 'https://arweave.net/wfAmZiRPAvW7B6j1V7Y_dJNiE11rTgdBIeQ-zikCuFw' },
  { envKey: 'URI_SEEKER_BLOOD',                 nameEnvKey: 'NAME_SEEKER_BLOOD',                 group: 'seeker', prefix: 'BLOOD',                     displayName: 'Blood On The Streets',      defaultUri: 'https://arweave.net/wfAmZiRPAvW7B6j1V7Y_dJNiE11rTgdBIeQ-zikCuFw' },
  { envKey: 'URI_SEEKER_CLAYNOSAURZ',           nameEnvKey: 'NAME_SEEKER_CLAYNOSAURZ',           group: 'seeker', prefix: 'CLAYNOSAURZ',               displayName: 'Claynosaurz',               defaultUri: 'https://gateway.irys.xyz/7KOM7EsD7aF5VyKPvLxLmGmbOcUXdJp_jOozU7QxHW8' },
  { envKey: 'URI_SEEKER_CLAYNOSAURZ',           nameEnvKey: 'NAME_SEEKER_CLAYNOSAURZ',           group: 'seeker', prefix: 'CLAYNO',                    displayName: 'Claynosaurz',               defaultUri: 'https://gateway.irys.xyz/7KOM7EsD7aF5VyKPvLxLmGmbOcUXdJp_jOozU7QxHW8' },
  { envKey: 'URI_SEEKER_GENESIS',               nameEnvKey: 'NAME_SEEKER_GENESIS',               group: 'seeker', prefix: 'GENESIS',                   displayName: 'Genesis',                   defaultUri: 'https://arweave.net/HVDI-NDSRGYbudtxW-mU02CQK4oFms-tIaQeL3H9YZA' },
  { envKey: 'URI_SEEKER_KING_BONK',             nameEnvKey: 'NAME_SEEKER_KING_BONK',             group: 'seeker', prefix: 'KING BONK',                 displayName: 'King BONK',                 defaultUri: 'https://arweave.net/7tEa85smMdweJeB1NKzI6oPK5NvhT0JwsvbXbpgKxtU' },
  { envKey: 'URI_SEEKER_LINCE',                 nameEnvKey: 'NAME_SEEKER_LINCE',                 group: 'seeker', prefix: 'LINCE PREDATOR',            displayName: 'Lince Predator',            defaultUri: 'https://gateway.irys.xyz/j520QK2xi0I4UCNeBHzjLfUNYwd0G8C7rrDY3CmCZeY' },
  { envKey: 'URI_SEEKER_LINCE',                 nameEnvKey: 'NAME_SEEKER_LINCE',                 group: 'seeker', prefix: 'LINCE',                     displayName: 'Lince Predator',            defaultUri: 'https://gateway.irys.xyz/j520QK2xi0I4UCNeBHzjLfUNYwd0G8C7rrDY3CmCZeY' },
  { envKey: 'URI_SEEKER_KUMEKA',                nameEnvKey: 'NAME_SEEKER_KUMEKA',                group: 'seeker', prefix: 'KUMEKA TEAM',               displayName: 'Kumeka Team',               defaultUri: 'https://gateway.irys.xyz/ehEpw6uUQhuyNRjH3yLONoLVQvke0aqBey6lkjCcTDk' },
  { envKey: 'URI_SEEKER_KUMEKA',                nameEnvKey: 'NAME_SEEKER_KUMEKA',                group: 'seeker', prefix: 'KUMEKA',                    displayName: 'Kumeka Team',               defaultUri: 'https://gateway.irys.xyz/ehEpw6uUQhuyNRjH3yLONoLVQvke0aqBey6lkjCcTDk' },
  { envKey: 'URI_SEEKER_MECHA_MONKE',           nameEnvKey: 'NAME_SEEKER_MECHA_MONKE',           group: 'seeker', prefix: 'MECHA MONKE',               displayName: 'Mecha Monke',               defaultUri: 'https://arweave.net/J2wZdRkXevCsAEigiR3HB9eoXl7iDZDunzEUvaQL7BA' },
  { envKey: 'URI_SEEKER_MONKE_CONSOLE',         nameEnvKey: 'NAME_SEEKER_MONKE_CONSOLE',         group: 'seeker', prefix: 'MONKE CONSOLE',             displayName: 'Monke Console',             defaultUri: 'https://arweave.net/N5hBqW574O9QHtD7kWK_nW7cZZ_yIJzED9M9CXlMG5s' },
  { envKey: 'URI_SEEKER_PUDGY',                 nameEnvKey: 'NAME_SEEKER_PUDGY',                 group: 'seeker', prefix: 'PUDGY PENGUINS PENGU EDITION', displayName: 'Pudgy Penguins: Pengu',  defaultUri: 'https://gateway.irys.xyz/1oLQMDeiWYdY2wqnNNQaS83M_4kJhrcn3X-arO5JjXs' },
  { envKey: 'URI_SEEKER_PUDGY',                 nameEnvKey: 'NAME_SEEKER_PUDGY',                 group: 'seeker', prefix: 'PUDGY PENGUINS',            displayName: 'Pudgy Penguins: Pengu',     defaultUri: 'https://gateway.irys.xyz/1oLQMDeiWYdY2wqnNNQaS83M_4kJhrcn3X-arO5JjXs' },
  { envKey: 'URI_SEEKER_PUDGY',                 nameEnvKey: 'NAME_SEEKER_PUDGY',                 group: 'seeker', prefix: 'PUDGY',                     displayName: 'Pudgy Penguins: Pengu',     defaultUri: 'https://gateway.irys.xyz/1oLQMDeiWYdY2wqnNNQaS83M_4kJhrcn3X-arO5JjXs' },
  { envKey: 'URI_SEEKER_SOLFLARE',              nameEnvKey: 'NAME_SEEKER_SOLFLARE',              group: 'seeker', prefix: 'SOLFLARE ENDLESS QUEST',    displayName: 'Solflare Endless Quest',    defaultUri: 'https://gateway.irys.xyz/0Opeow5mMIw9WqpsRtuyYK1tuiw4cs8zyeqe7z_Pkak' },
  { envKey: 'URI_SEEKER_SOLFLARE',              nameEnvKey: 'NAME_SEEKER_SOLFLARE',              group: 'seeker', prefix: 'SOLFLARE',                  displayName: 'Solflare Endless Quest',    defaultUri: 'https://gateway.irys.xyz/0Opeow5mMIw9WqpsRtuyYK1tuiw4cs8zyeqe7z_Pkak' },
  { envKey: 'URI_SEEKER_THE_BONK',              nameEnvKey: 'NAME_SEEKER_THE_BONK',              group: 'seeker', prefix: 'THE BONK',                  displayName: 'The BONK',                  defaultUri: 'https://arweave.net/VrXwho429YAT8R-2WsNTJ5PnJBtMBAWkF173_jjk9sQ' },
  { envKey: 'URI_SEEKER_VANTA',                 nameEnvKey: 'NAME_SEEKER_VANTA',                 group: 'seeker', prefix: 'VANTA',                     displayName: 'Vanta',                     defaultUri: 'https://arweave.net/3i61laSALCHUjiqulvQT9UvaJ-c-3Pw-LSKf0ZLnP4U' },
  { envKey: 'URI_SEEKER_X_RAY',                 nameEnvKey: 'NAME_SEEKER_X_RAY',                 group: 'seeker', prefix: 'X RAY',                     displayName: 'X-Ray',                     defaultUri: 'https://arweave.net/t6z3mT_OczKuAQZtD3AcDesB2H7oLotwfyqVCMH80eM' },
  { envKey: 'URI_SEEKER_ZERO',                  nameEnvKey: 'NAME_SEEKER_ZERO',                  group: 'seeker', prefix: 'ZERO',                      displayName: 'Zero',                      defaultUri: 'https://arweave.net/pEIi9VZW5wkwNvhbqEpEviSsSWoE77TBCTi87fF9q6Y' },
  { envKey: 'URI_SEEKER_ZUPAFORGE',             nameEnvKey: 'NAME_SEEKER_ZUPAFORGE',             group: 'seeker', prefix: 'ZUPAFORGE',                 displayName: 'Zupaforge',                 defaultUri: 'https://gateway.irys.xyz/ZHHnGpSbuqUoNSZYEddPvmcSiQ4CV8N9PznjvsqqQkU' },
] as BrandRule[]).sort((a, b) => b.prefix.length - a.prefix.length);

function normalize(s: string): string {
  // Uppercase, replace separators (`_`, `-`, `:`, `,`) with spaces, drop other
  // punctuation, collapse whitespace. Lets us match e.g. "X-Ray" against "X RAY"
  // and "Pudgy Penguins: Pengu Edition" against "PUDGY PENGUINS PENGU EDITION".
  return s
    .trim()
    .toUpperCase()
    .replace(/[_\-:,]+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Detect device group from the product name. Returns null if neither marker
// is found — caller will fall through to the brand-portion fallback.
function detectGroup(productName: string): DeviceGroup | null {
  const upper = normalize(productName);
  // Order matters: a Seeker product won't say "iPhone", but be explicit anyway.
  if (/\bSEEKER\b/.test(upper)) return 'seeker';
  if (/\bIPHONE\b/.test(upper)) return 'iphone';
  return null;
}

// Strip trailing case/device suffix to get the brand portion of the product name.
// "The Fifth Cause iPhone Case"           -> "The Fifth Cause"
// "Vanta Seeker Case - Solana Seeker"     -> "Vanta"
// "Pudgy Penguins: Pengu Edition Seeker Case" -> "Pudgy Penguins: Pengu Edition"
function extractBrandPortion(productName: string): string {
  return productName
    .replace(/\s+(?:iPhone|Seeker|Phone)\s+Case\b.*$/i, '')
    .replace(/\s+Case\b.*$/i, '')
    .replace(/\s*[-–—].*$/, '')
    .trim();
}

// Token Metadata caps name at 32 bytes. Truncate on UTF-8 byte boundary.
const MAX_NAME_BYTES = 32;
function truncateName(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length <= MAX_NAME_BYTES) return name;
  let end = MAX_NAME_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

export function getProductMetadata(productName: string, sku?: string): ProductMetadata {
  const group = detectGroup(productName) ?? (sku ? detectGroup(sku) : null);

  // Match against the brand portion (product name with case/device suffix
  // stripped) so prefixes anchor to the start cleanly. Also include the raw
  // normalized strings so SKUs / unusual product names still get a chance.
  const brandPortion = extractBrandPortion(productName);
  const candidates = [brandPortion, productName, sku]
    .filter((v): v is string => !!v && v.length > 0)
    .map(normalize);

  if (group) {
    const groupRules = BRAND_RULES.filter((r) => r.group === group);
    for (const rule of groupRules) {
      const prefix = normalize(rule.prefix);
      if (candidates.some((c) => c === prefix || c.startsWith(prefix + ' '))) {
        const uri = process.env[rule.envKey] || rule.defaultUri;
        if (!uri) {
          throw new Error(`Matched ${group} brand "${rule.prefix}" but ${rule.envKey} is not set and no default URI is configured.`);
        }
        const name = process.env[rule.nameEnvKey] || rule.displayName;
        return { name: truncateName(name), uri };
      }
    }
  }

  // Fallback: use the brand portion of the product name (everything before
  // "iPhone Case" / "Seeker Case" / variant tail) as the display name.
  const fallbackName = brandPortion || productName;
  const fallbackUri = process.env.URI_DEFAULT;
  if (!fallbackUri) {
    throw new Error(`No brand rule matched product "${productName}" (group=${group ?? 'unknown'}) and URI_DEFAULT is not set.`);
  }
  return { name: truncateName(fallbackName), uri: fallbackUri };
}

// ============================================
// MANUAL PROOF FETCHING (workaround for SDK bug)
// ============================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAssetWithProofManually(
  rpcEndpoint: string,
  assetIdString: string
): Promise<any> {
  // Fetch asset and proof in parallel (they're independent)
  const [assetResponse, proofResponse] = await Promise.all([
    fetch(rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'getAsset',
        method: 'getAsset',
        params: { id: assetIdString },
      }),
    }),
    fetch(rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'getAssetProof',
        method: 'getAssetProof',
        params: { id: assetIdString },
      }),
    }),
  ]);

  const [assetData, proofData] = await Promise.all([
    assetResponse.json() as Promise<{ result?: Record<string, unknown>; error?: unknown }>,
    proofResponse.json() as Promise<{ result?: Record<string, unknown>; error?: unknown }>,
  ]);

  if (assetData.error) {
    throw new Error(`Asset not found: ${JSON.stringify(assetData.error)}`);
  }
  if (proofData.error) {
    throw new Error(`Proof not found: ${JSON.stringify(proofData.error)}`);
  }

  const asset = assetData.result as {
    ownership: { owner: string; delegate?: string };
    compression: {
      data_hash: string;
      creator_hash: string;
      leaf_id: number;
      collection_hash: string;
      asset_data_hash: string;
      flags: number;
    };
  };

  const proof = proofData.result as { tree_id: string; root: string; proof: string[] };

  return {
    leafOwner: publicKey(asset.ownership.owner),
    leafDelegate: asset.ownership.delegate
      ? publicKey(asset.ownership.delegate)
      : publicKey(asset.ownership.owner),
    merkleTree: publicKey(proof.tree_id),
    root: Array.from(decodeBase58(proof.root)),
    dataHash: Array.from(decodeBase58(asset.compression.data_hash)),
    creatorHash: Array.from(decodeBase58(asset.compression.creator_hash)),
    nonce: BigInt(asset.compression.leaf_id),
    index: asset.compression.leaf_id,
    proof: proof.proof.map((p: string) => publicKey(p)),
    collectionHash: Array.from(decodeBase58(asset.compression.collection_hash)),
    assetDataHash: Array.from(decodeBase58(asset.compression.asset_data_hash)),
    flags: asset.compression.flags,
  };
}

function decodeBase58(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET[i]] = i;

  const bytes: number[] = [0];
  for (let i = 0; i < str.length; i++) {
    const value = ALPHABET_MAP[str[i]];
    if (value === undefined) throw new Error(`Invalid base58: ${str[i]}`);
    for (let j = 0; j < bytes.length; j++) bytes[j] *= 58;
    bytes[0] += value;
    let carry = 0;
    for (let j = 0; j < bytes.length; j++) {
      bytes[j] += carry;
      carry = bytes[j] >> 8;
      bytes[j] &= 0xff;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

// ============================================
// MAIN MINTING FUNCTION
// ============================================

export async function mintSoulboundCNFT(
  recipientWallet: string,
  sku: string,
  productName?: string
): Promise<MintResult> {
  const { umi, signer } = getUmi();

  // Prefer the full product name (e.g. "BORN SOLYD Phone Case - iPhone 16 Pro Max")
  // for both metadata lookup and the on-chain NFT name. Fall back to sku if no name.
  const nameForLookup = productName || sku;
  const { name, uri } = getProductMetadata(nameForLookup, sku);
  const merkleTree = publicKey(config.minting.merkleTreeAddress);
  const coreCollection = publicKey(config.minting.coreCollectionAddress);
  const recipient = publicKey(recipientWallet);

  const ctx = { sku, productName, name, uri, wallet: recipientWallet.slice(0, 8) + '...' };

  mintLog.info(ctx, `START ${name} -> ${recipientWallet.slice(0, 8)}...`);

  // Check tree capacity
  try {
    const tree = await checkTreeCapacity();
    if (tree.isFull) {
      mintLog.error(ctx, 'TREE FULL, cannot mint');
      return { success: false, error: 'Merkle tree is full. Cannot mint more NFTs.' };
    }
    mintLog.info({ ...ctx, minted: tree.minted, capacity: tree.capacity, pct: tree.percentUsed.toFixed(1) }, `Tree ${tree.minted}/${tree.capacity}`);
  } catch (e) {
    mintLog.warn({ ...ctx, err: e instanceof Error ? e.message : e }, 'Could not check tree capacity');
  }

  // STEP 1: Mint cNFT
  mintLog.info(ctx, 'Step 1/2: Minting cNFT');

  let signature: Uint8Array;
  try {
    const result = await mintV2(umi, {
      leafOwner: recipient,
      merkleTree,
      collectionAuthority: signer,
      coreCollection,
      metadata: {
        name,
        uri,
        sellerFeeBasisPoints: 0,
        collection: some(coreCollection),
        creators: [
          {
            address: signer.publicKey,
            verified: true,
            share: 100,
          },
        ],
      },
    }).sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });

    signature = result.signature;
    mintLog.info(ctx, 'cNFT minted (confirmed)');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown minting error';
    mintLog.error({ ...ctx, err: message }, 'MINT FAILED');
    return { success: false, error: message };
  }

  // Wait for transaction to finalize (confirmed -> finalized takes ~6-8s)
  // parseLeafFromMintV2Transaction requires finalized commitment internally.
  // We use 'confirmed' for fast sendAndConfirm, then wait here for finalization.
  const FINALIZATION_WAIT_MS = 6000;
  mintLog.info(ctx, `cNFT confirmed, waiting ${FINALIZATION_WAIT_MS}ms for finalization`);
  await new Promise((r) => setTimeout(r, FINALIZATION_WAIT_MS));

  // Parse leaf to get asset ID
  let assetId: string;
  try {
    let leaf;
    for (let i = 0; i < 5; i++) {
      try {
        leaf = await parseLeafFromMintV2Transaction(umi, signature);
        break;
      } catch {
        if (i < 4) {
          mintLog.debug({ ...ctx, attempt: i + 1 }, 'Retry parsing leaf (waiting for finalization)');
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          throw new Error('Failed to parse leaf from mint transaction after 5 attempts');
        }
      }
    }
    assetId = leaf!.id.toString();
    mintLog.info({ ...ctx, assetId }, `Asset ID resolved: ${assetId.slice(0, 12)}...`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to get asset ID';
    mintLog.error({ ...ctx, err: message }, 'ASSET ID FAILED (NFT minted but ID unknown)');
    return {
      success: true,
      txnHash: Buffer.from(signature).toString('base64').substring(0, 40),
      soulbound: false,
      error: 'Minted but failed to retrieve asset ID. May need manual soulbound.',
    };
  }

  // STEP 2: Set non-transferable (soulbound)
  mintLog.info({ ...ctx, assetId }, 'Step 2/2: Setting soulbound');

  let soulboundSuccess = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      // Only sleep before retries, not the first attempt
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, config.minting.dasIndexerDelayMs));
      }

      const assetWithProof = await fetchAssetWithProofManually(
        config.minting.rpcEndpoint,
        assetId
      );

      await setNonTransferableV2(umi, {
        ...assetWithProof,
        authority: signer,
        coreCollection,
      }).sendAndConfirm(umi);

      soulboundSuccess = true;
      mintLog.info({ ...ctx, assetId, attempt }, 'SOULBOUND SET');
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === 5) {
        mintLog.warn({ ...ctx, assetId, attempt, err: msg }, 'SOULBOUND FAILED after 5 attempts');
      } else if (!msg.includes('Asset not found')) {
        mintLog.debug({ ...ctx, assetId, attempt, err: msg }, 'Soulbound retry');
      }
    }
  }

  const txnHash = Buffer.from(signature).toString('base64').substring(0, 40);

  mintLog.info(
    { ...ctx, assetId, txnHash, soulbound: soulboundSuccess },
    `COMPLETE ${name} -> ${assetId.slice(0, 12)}... (soulbound: ${soulboundSuccess})`
  );

  return {
    success: true,
    assetId,
    txnHash,
    soulbound: soulboundSuccess,
  };
}

// ============================================
// HEALTH CHECK
// ============================================

export function isMintingConfigured(): boolean {
  return !!(
    config.minting.walletSecretBase64 &&
    config.minting.merkleTreeAddress &&
    config.minting.coreCollectionAddress
  );
}

/**
 * Pre-initialize UMI on server start so the first mint doesn't pay the ~500ms setup cost.
 * Call this from index.ts after the server starts.
 */
export function warmUpUmi(): void {
  if (!isMintingConfigured()) {
    mintLog.warn('Minting not configured, skipping UMI warm-up');
    return;
  }
  try {
    getUmi();
    mintLog.info('UMI warm-up complete');
  } catch (err) {
    mintLog.error({ err: err instanceof Error ? err.message : err }, 'UMI warm-up failed');
  }
}
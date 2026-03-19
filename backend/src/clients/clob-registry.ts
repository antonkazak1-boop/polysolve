/**
 * Per-user CLOB client registry.
 * Creates and caches ClobClient instances keyed by userId.
 * Falls back to the global .env-based client for the admin / legacy path.
 */

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { getDecryptedPolyKeys } from '../services/auth';
import { isRegionAllowedForTrading, getCurrentCountry } from '../utils/region-guard';

type TickSize = '0.1' | '0.01' | '0.001' | '0.0001';
const VALID_TICK_SIZES: TickSize[] = ['0.1', '0.01', '0.001', '0.0001'];
function toTickSize(raw: string): TickSize {
  if (VALID_TICK_SIZES.includes(raw as TickSize)) return raw as TickSize;
  return '0.01';
}

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const TTL_MS = 30 * 60 * 1000; // 30 min
const CLOB_MIN_SHARES = 5;

interface CachedClient {
  client: ClobClient;
  signerAddress: string;
  funderAddress: string | undefined;
  sigType: number;
  createdAt: number;
}

const cache = new Map<string, CachedClient>();

async function getRegionBlockError(): Promise<string | null> {
  const ok = await isRegionAllowedForTrading();
  if (ok) return null;
  const country = await getCurrentCountry();
  return `Region blocked (IP: ${country || 'unknown'}). Use VPN.`;
}

export async function getClobClientForUser(userId: string): Promise<CachedClient | null> {
  const existing = cache.get(userId);
  if (existing && Date.now() - existing.createdAt < TTL_MS) return existing;

  const keys = await getDecryptedPolyKeys(userId);
  if (!keys) return null;

  try {
    const wallet = new Wallet(keys.privateKey);
    const sigType = keys.signatureType ?? 0;
    const funder = sigType === 0 ? undefined : keys.funderAddress;
    const creds = { key: keys.apiKey, secret: keys.apiSecret, passphrase: keys.apiPassphrase };
    const client = new ClobClient(HOST, CHAIN_ID, wallet, creds, sigType, funder);

    const entry: CachedClient = {
      client,
      signerAddress: wallet.address,
      funderAddress: funder,
      sigType,
      createdAt: Date.now(),
    };
    cache.set(userId, entry);
    return entry;
  } catch (e: any) {
    console.error(`[clob-registry] Failed to create client for user ${userId.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

export function evictUser(userId: string) {
  cache.delete(userId);
}

export function getUserTradingAddress(cached: CachedClient): string {
  return cached.funderAddress || cached.signerAddress;
}

export function getUserTradingAddresses(cached: CachedClient): { funder: string | null; signer: string | null } {
  return { funder: cached.funderAddress || null, signer: cached.signerAddress || null };
}

export async function userPlaceBuyOrder(
  cached: CachedClient,
  tokenId: string,
  price: number,
  usdcAmount: number,
  minSharesFloor: number = CLOB_MIN_SHARES,
): Promise<import('./polymarket-clob').OrderResult> {
  const regionError = await getRegionBlockError();
  if (regionError) return { success: false, error: regionError };

  try {
    const book = await cached.client.getOrderBook(tokenId);
    const tickSize = toTickSize((book as any).tick_size || '0.01');
    const negRisk = (book as any).neg_risk || false;
    const tick = parseFloat(tickSize);
    const roundedPrice = Math.round(price / tick) * tick;
    if (roundedPrice <= 0 || roundedPrice >= 1) return { success: false, error: `invalid price (${roundedPrice})` };

    const floor = Math.max(CLOB_MIN_SHARES, Math.floor(minSharesFloor) || CLOB_MIN_SHARES);
    let size = Math.max(Math.floor(usdcAmount / roundedPrice), floor);
    if (size * roundedPrice < 1) size = Math.max(Math.ceil(1.01 / roundedPrice), floor);
    const actualCost = size * roundedPrice;

    const res = await cached.client.createAndPostOrder(
      { tokenID: tokenId, price: roundedPrice, size, side: Side.BUY },
      { tickSize, negRisk },
      OrderType.GTC,
    );

    const ok = !!(res as any)?.success || !!(res as any)?.orderID;
    return {
      success: ok,
      orderID: (res as any)?.orderID,
      status: (res as any)?.status,
      error: ok ? undefined : ((res as any)?.error || (res as any)?.errorMsg || undefined),
      actualSize: size,
      actualUsdcAmount: actualCost,
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function userPlaceSellOrder(
  cached: CachedClient,
  tokenId: string,
  price: number,
  size: number,
): Promise<import('./polymarket-clob').OrderResult> {
  const regionError = await getRegionBlockError();
  if (regionError) return { success: false, error: regionError };

  try {
    const book = await cached.client.getOrderBook(tokenId);
    const tickSize = toTickSize((book as any).tick_size || '0.01');
    const negRisk = (book as any).neg_risk || false;
    const tick = parseFloat(tickSize);
    const roundedPrice = Math.round(price / tick) * tick;
    if (roundedPrice <= 0 || roundedPrice >= 1) return { success: false, error: `invalid price (${roundedPrice})` };

    if (size < CLOB_MIN_SHARES) size = CLOB_MIN_SHARES;
    if (size * roundedPrice < 1) size = Math.ceil(1.01 / roundedPrice);

    const res = await cached.client.createAndPostOrder(
      { tokenID: tokenId, price: roundedPrice, size, side: Side.SELL },
      { tickSize, negRisk },
      OrderType.GTC,
    );

    const ok = !!(res as any)?.success || !!(res as any)?.orderID;
    return {
      success: ok,
      orderID: (res as any)?.orderID,
      status: (res as any)?.status,
      error: ok ? undefined : ((res as any)?.error || (res as any)?.errorMsg || undefined),
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function userGetOrderStatus(cached: CachedClient, orderId: string): Promise<string | null> {
  try {
    const order = await cached.client.getOrder(orderId);
    return (order as any)?.status || null;
  } catch {
    return null;
  }
}

export async function userCancelOrder(cached: CachedClient, orderId: string): Promise<boolean> {
  try {
    await cached.client.cancelOrder({ orderID: orderId });
    return true;
  } catch {
    return false;
  }
}

export async function userCancelAllOrders(cached: CachedClient): Promise<boolean> {
  try {
    await cached.client.cancelAll();
    return true;
  } catch {
    return false;
  }
}

export async function userGetOpenSellOrders(cached: CachedClient, tokenId: string): Promise<{ side: string; size_remaining: number; asset_id: string }[]> {
  try {
    const orders = await cached.client.getOpenOrders({ asset_id: tokenId });
    return (orders || [])
      .filter((o: any) => o.side === 'SELL')
      .map((o: any) => ({
        side: o.side,
        size_remaining: parseFloat(o.original_size || '0') - parseFloat(o.size_matched || '0'),
        asset_id: o.asset_id,
      }));
  } catch {
    return [];
  }
}

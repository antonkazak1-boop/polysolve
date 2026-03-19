/**
 * Polymarket CLOB trading client.
 * Uses @polymarket/clob-client SDK for real order placement.
 * signatureType=2 (GNOSIS_SAFE) with proxy funder address.
 */

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { isRegionAllowedForTrading, getCurrentCountry } from '../utils/region-guard';

type TickSize = '0.1' | '0.01' | '0.001' | '0.0001';
const VALID_TICK_SIZES: TickSize[] = ['0.1', '0.01', '0.001', '0.0001'];

function toTickSize(raw: string): TickSize {
  if (VALID_TICK_SIZES.includes(raw as TickSize)) return raw as TickSize;
  return '0.01';
}

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon

let _client: ClobClient | null = null;
let _ready = false;
let _initError: string | null = null;
let _funderAddress: string | undefined;
let _signerAddress: string | undefined;
let _sigType: number = 0;

async function getRegionBlockError(): Promise<string | null> {
  const regionOk = await isRegionAllowedForTrading();
  if (regionOk) return null;
  const country = await getCurrentCountry();
  return `Region blocked (IP: ${country || 'unknown'}). Use VPN.`;
}

export interface OrderResult {
  success: boolean;
  orderID?: string;
  status?: string; // 'matched' | 'live' | 'delayed'
  error?: string;
  /** Actual size (shares) placed — may be higher than requested to meet CLOB minimum */
  actualSize?: number;
  /** Actual USDC cost (actualSize * roundedPrice) */
  actualUsdcAmount?: number;
}

export interface MarketParams {
  tickSize: TickSize;
  negRisk: boolean;
}


export async function initClobClient(): Promise<boolean> {
  const pk = process.env.POLY_PRIVATE_KEY;
  const funder = process.env.POLY_FUNDER_ADDRESS;

  if (!pk) {
    _initError = 'POLY_PRIVATE_KEY not set';
    console.warn('[clob] ' + _initError);
    return false;
  }

  if (!funder) {
    console.log('[clob] POLY_FUNDER_ADDRESS not set — trading from EOA directly');
  }

  const regionOk = await isRegionAllowedForTrading();
  if (!regionOk) {
    const country = await getCurrentCountry();
    _initError = `Region blocked (IP: ${country || 'unknown'}). Use VPN.`;
    console.warn('[clob] ' + _initError);
    return false;
  }

  try {
    const wallet = new Wallet(pk);
    _sigType = parseInt(process.env.POLY_SIGNATURE_TYPE || '0');
    _signerAddress = wallet.address;
    _funderAddress = funder;

    const apiKey = process.env.POLY_API_KEY;
    const apiSecret = process.env.POLY_API_SECRET;
    const apiPassphrase = process.env.POLY_API_PASSPHRASE;

    if (!apiKey || !apiSecret || !apiPassphrase) {
      _initError = 'POLY_API_KEY / SECRET / PASSPHRASE not set';
      console.warn('[clob] ' + _initError);
      return false;
    }

    const creds = { key: apiKey, secret: apiSecret, passphrase: apiPassphrase };

    const effectiveFunder = _sigType === 0 ? undefined : funder;
    _client = new ClobClient(HOST, CHAIN_ID, wallet, creds, _sigType, effectiveFunder);

    _ready = true;
    _initError = null;
    console.log('[clob] client initialized, signer:', wallet.address, 'funder:', effectiveFunder ?? '(self)', 'sigType:', _sigType);
    return true;
  } catch (e: any) {
    _initError = e.message;
    console.error('[clob] init failed:', e.message);
    return false;
  }
}

export function isClobReady(): boolean {
  return _ready && _client !== null;
}

export function getClobStatus(): { ready: boolean; error: string | null } {
  return { ready: _ready, error: _initError };
}

export function getTradingUserAddress(): string | null {
  return _funderAddress || _signerAddress || null;
}

/** Both addresses to try when fetching positions — API may key by proxy or by signer. */
export function getTradingAddresses(): { funder: string | null; signer: string | null } {
  return { funder: _funderAddress || null, signer: _signerAddress || null };
}

export async function getMarketParams(tokenId: string): Promise<MarketParams> {
  if (!_client) throw new Error('CLOB client not initialized');
  try {
    const book = await _client.getOrderBook(tokenId);
    return {
      tickSize: toTickSize((book as any).tick_size || '0.01'),
      negRisk: (book as any).neg_risk || false,
    };
  } catch {
    return { tickSize: '0.01' as TickSize, negRisk: false };
  }
}

/** Polymarket CLOB minimum; callers may pass higher floor via minSharesFloor */
const CLOB_MIN_SHARES = 5;

export async function placeBuyOrder(
  tokenId: string,
  price: number,
  usdcAmount: number,
  minSharesFloor: number = CLOB_MIN_SHARES,
): Promise<OrderResult> {
  if (!_client) return { success: false, error: 'CLOB client not initialized' };
  const regionError = await getRegionBlockError();
  if (regionError) return { success: false, error: regionError };

  try {
    const params = await getMarketParams(tokenId);
    const tick = parseFloat(params.tickSize);
    const roundedPrice = Math.round(price / tick) * tick;
    if (roundedPrice <= 0 || roundedPrice >= 1) return { success: false, error: `invalid price (${roundedPrice}), must be between 0 and 1 exclusive` };

    const floor = Math.max(CLOB_MIN_SHARES, Math.floor(minSharesFloor) || CLOB_MIN_SHARES);
    let size = Math.max(Math.floor(usdcAmount / roundedPrice), floor);
    const totalCost = size * roundedPrice;
    if (totalCost < 1) {
      size = Math.max(Math.ceil(1.01 / roundedPrice), floor);
    }

    const actualCost = size * roundedPrice;
    console.log(`[clob] placing BUY: token=${tokenId.slice(0, 20)}... price=${roundedPrice} size=${size} cost=$${actualCost.toFixed(2)} tick=${params.tickSize} negRisk=${params.negRisk}`);

    const res = await _client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: roundedPrice,
        size,
        side: Side.BUY,
      },
      { tickSize: params.tickSize, negRisk: params.negRisk },
      OrderType.GTC,
    );

    console.log('[clob] BUY result:', JSON.stringify(res));
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
    console.error('[clob] BUY order failed:', e.message);
    return { success: false, error: e.message };
  }
}

export async function placeSellOrder(
  tokenId: string,
  price: number,
  size: number,
): Promise<OrderResult> {
  if (!_client) return { success: false, error: 'CLOB client not initialized' };
  const regionError = await getRegionBlockError();
  if (regionError) return { success: false, error: regionError };

  try {
    const params = await getMarketParams(tokenId);
    const tick = parseFloat(params.tickSize);
    const roundedPrice = Math.round(price / tick) * tick;
    if (roundedPrice <= 0 || roundedPrice >= 1) return { success: false, error: `invalid price (${roundedPrice}), must be between 0 and 1 exclusive` };

    if (size < CLOB_MIN_SHARES) size = CLOB_MIN_SHARES;
    let totalCost = size * roundedPrice;
    if (totalCost < 1) {
      size = Math.ceil(1.01 / roundedPrice);
    }

    console.log(`[clob] placing SELL: token=${tokenId.slice(0, 20)}... price=${roundedPrice} size=${size} cost=$${(size * roundedPrice).toFixed(2)}`);

    const res = await _client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: roundedPrice,
        size,
        side: Side.SELL,
      },
      { tickSize: params.tickSize, negRisk: params.negRisk },
      OrderType.GTC,
    );

    console.log('[clob] SELL result:', JSON.stringify(res));
    const ok = !!(res as any)?.success || !!(res as any)?.orderID;
    return {
      success: ok,
      orderID: (res as any)?.orderID,
      status: (res as any)?.status,
      error: ok ? undefined : ((res as any)?.error || (res as any)?.errorMsg || undefined),
    };
  } catch (e: any) {
    console.error('[clob] SELL order failed:', e.message);
    return { success: false, error: e.message };
  }
}

export async function getOrderStatus(orderId: string): Promise<string | null> {
  if (!_client) return null;
  const regionError = await getRegionBlockError();
  if (regionError) {
    console.warn(`[clob] getOrderStatus blocked: ${regionError}`);
    return null;
  }
  try {
    const order = await _client.getOrder(orderId);
    return (order as any)?.status || null;
  } catch {
    return null;
  }
}

export async function cancelOrder(orderId: string): Promise<boolean> {
  if (!_client) return false;
  const regionError = await getRegionBlockError();
  if (regionError) {
    console.warn(`[clob] cancelOrder blocked: ${regionError}`);
    return false;
  }
  try {
    const res = await _client.cancelOrder({ orderID: orderId });
    console.log(`[clob] cancelOrder ${orderId.slice(0, 16)}... result:`, JSON.stringify(res));
    return true;
  } catch (e: any) {
    console.error(`[clob] cancelOrder ${orderId.slice(0, 16)}... failed:`, e.message);
    return false;
  }
}

export async function cancelAllOrders(): Promise<boolean> {
  if (!_client) return false;
  const regionError = await getRegionBlockError();
  if (regionError) {
    console.warn(`[clob] cancelAll blocked: ${regionError}`);
    return false;
  }
  try {
    const res = await _client.cancelAll();
    console.log('[clob] cancelAll result:', JSON.stringify(res));
    return true;
  } catch (e: any) {
    console.error('[clob] cancelAll failed:', e.message);
    return false;
  }
}

export async function getOpenSellOrders(tokenId: string): Promise<{ side: string; size_remaining: number; asset_id: string }[]> {
  if (!_client) return [];
  try {
    const orders = await _client.getOpenOrders({ asset_id: tokenId });
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

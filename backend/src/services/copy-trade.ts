/**
 * Copy-trade service.
 * Supports multiple wallets; copies both BUY (open) and SELL (close).
 * Uses source trader's actual USD volume (usdcSize) for proportional sizing,
 * clamped to the per-wallet amountPerTrade maximum.
 */

import { gammaClient } from '../clients/gamma-client';
import prisma from '../config/database';
import { getDemoBalance, setDemoBalance } from './cron-scheduler';
import { isClobReady, placeBuyOrder, placeSellOrder, getOrderStatus, cancelOrder, getTradingUserAddress, getOpenSellOrders } from '../clients/polymarket-clob';
import { isRegionAllowedForTrading, getCurrentCountry } from '../utils/region-guard';
import axios from 'axios';

/** Poll source wallets this often. Lower = less lag, more API load. Was 60s. */
const POLL_INTERVAL_MS = 30_000;
const MAX_SEEN_KEYS = 5000;
/** Only copy BUYs that happened within this window (prices may change if older). */
const MAX_BUY_AGE_MS = 30 * 60 * 1000; // 30 min
/** SELLs we process up to this old — so we close positions even after app was off for hours. */
const MAX_SELL_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Allowed drift between the trader's entry price and the current CLOB ask.
 * Uses an absolute cent-based threshold that shrinks as the signal ages —
 * fresh signals (< 2 min) get more slack, stale ones (> 20 min) almost none.
 *
 * Max allowed drift = BASE_DRIFT_CENTS − age_penalty, floored at MIN_DRIFT_CENTS.
 *   age 0 min  → 5¢ slack  (signal is live, small spread is fine)
 *   age 5 min  → 4¢ slack
 *   age 10 min → 3¢ slack
 *   age 20 min → 2¢ slack  (minimum — always allow a tiny spread)
 *   age 30 min → 2¢ (capped; beyond MAX_BUY_AGE_MS the trade is skipped anyway)
 *
 * Absolute-cent approach avoids the asymmetry of %-based guards:
 *   %-guard: $0.11 entry + 20% = $0.132 (2¢), $0.80 entry + 20% = $0.96 (16¢ — way too loose)
 *   cent-guard: same 3¢ regardless of entry price → consistent execution quality
 */
const BASE_DRIFT_CENTS  = 0.05; // 5¢ for a fresh signal
const MIN_DRIFT_CENTS   = 0.02; // 2¢ floor — always allow a tiny spread
const DRIFT_DECAY_PER_MIN = 0.001; // lose 0.1¢ per minute of signal age

function maxAllowedDrift(tradeAgeMs: number): number {
  const ageMin = tradeAgeMs / 60_000;
  return Math.max(MIN_DRIFT_CENTS, BASE_DRIFT_CENTS - ageMin * DRIFT_DECAY_PER_MIN);
}
/** Fallback price filters if DB settings not loaded yet */
const DEFAULT_MIN_COPY_PRICE = 0.004;
const DEFAULT_MAX_COPY_PRICE = 0.95;

/** Load per-user or global copy-trading price filters from DB */
async function getUserPriceFilters(userId: string | null): Promise<{ minPrice: number; maxPrice: number }> {
  try {
    if (userId) {
      const s = await (prisma as any).userCopySettings.findUnique({ where: { userId } });
      if (s) return { minPrice: s.minCopyPrice ?? DEFAULT_MIN_COPY_PRICE, maxPrice: s.maxCopyPrice ?? DEFAULT_MAX_COPY_PRICE };
    }
    const s = await (prisma as any).copyTradingSettings.upsert({
      where: { id: 'global' },
      update: {},
      create: { id: 'global', minCopyPrice: DEFAULT_MIN_COPY_PRICE, maxCopyPrice: DEFAULT_MAX_COPY_PRICE },
    });
    return { minPrice: s.minCopyPrice ?? DEFAULT_MIN_COPY_PRICE, maxPrice: s.maxCopyPrice ?? DEFAULT_MAX_COPY_PRICE };
  } catch {
    return { minPrice: DEFAULT_MIN_COPY_PRICE, maxPrice: DEFAULT_MAX_COPY_PRICE };
  }
}

/** @deprecated use getUserPriceFilters */
async function getGlobalPriceFilters(): Promise<{ minPrice: number; maxPrice: number }> {
  return getUserPriceFilters(null);
}

const CLOB_ABS_MIN_SHARES = 5;
/** Per-wallet floor; never below Polymarket CLOB minimum (5). */
function walletMinShares(w: any): number {
  const n = Math.floor(Number(w?.minOrderShares));
  if (!Number.isFinite(n) || n < CLOB_ABS_MIN_SHARES) return CLOB_ABS_MIN_SHARES;
  return Math.min(n, 10_000);
}

const seenTradeIds = new Set<string>();
let isPolling = false;

const clobHttp = axios.create({
  baseURL: 'https://clob.polymarket.com',
  timeout: 10_000,
});

export async function getClobPrice(tokenId: string): Promise<number | null> {
  try {
    const res = await clobHttp.get('/price', { params: { token_id: tokenId, side: 'buy' } });
    const p = parseFloat(res.data?.price);
    return isNaN(p) ? null : p;
  } catch {
    return null;
  }
}

/** Ask price (sell side) — the price at which sellers are listing. */
async function getClobAskPrice(tokenId: string): Promise<number | null> {
  try {
    const res = await clobHttp.get('/price', { params: { token_id: tokenId, side: 'sell' } });
    const p = parseFloat(res.data?.price);
    return isNaN(p) ? null : p;
  } catch {
    return null;
  }
}

/**
 * Determine how much USDC to spend on the copy trade.
 * Uses the source trader's actual usdcSize, clamped to amountPerTrade max.
 * If usdcSize not available, falls back to amountPerTrade.
 */
function computeCopyAmount(raw: any, amountPerTrade: number, copyScale: number): number {
  const sourceUsd = parseFloat(raw.usdcSize);
  if (!isNaN(sourceUsd) && sourceUsd > 0) {
    const scaled = sourceUsd * copyScale;
    return Math.min(scaled, amountPerTrade);
  }
  return amountPerTrade;
}

function parseTradeTimestamp(raw: any): Date {
  if (!raw.timestamp) return new Date(0);
  const ts = Number(raw.timestamp);
  return new Date(ts < 1e12 ? ts * 1000 : ts);
}

function parseOutcome(raw: any): string {
  if (raw.outcome) return raw.outcome.toUpperCase();
  if (raw.outcomeIndex !== undefined) return raw.outcomeIndex === 0 ? 'YES' : 'NO';
  return 'YES';
}

function parseSide(raw: any): 'BUY' | 'SELL' {
  const side = (raw.side || raw.type || 'BUY').toUpperCase();
  return side === 'SELL' ? 'SELL' : 'BUY';
}

function makeTradeKey(walletAddress: string, raw: any): string {
  const ts = parseTradeTimestamp(raw).getTime();
  const size = raw.size ?? raw.shares ?? '0';
  const price = raw.price ?? raw.averagePrice ?? '0';
  const market = raw.conditionId || raw.marketId || '';
  const out = parseOutcome(raw);
  // Include outcome so YES and NO legs are never deduped into one key (and vice versa).
  return `${walletAddress.toLowerCase()}-${market}-${ts}-${size}-${price}-${out}`;
}

/**
 * If we already copied an open position on the *other* outcome of the same binary market,
 * skip copying this BUY — otherwise we mirror a hedge / both-sides punt (e.g. cricket)
 * and pay ~2× with no edge.
 */
async function hasOpenOppositeOutcome(
  ownerUserId: string | null,
  sourceWallet: string,
  conditionId: string,
  incomingOutcome: string,
  isLive: boolean
): Promise<boolean> {
  const inc = incomingOutcome.toUpperCase();
  const userClause = ownerUserId ? { userId: ownerUserId } : { userId: null };

  if (isLive) {
    const row = await (prisma as any).liveTrade.findFirst({
      where: {
        ...userClause,
        sourceWalletAddress: sourceWallet,
        conditionId,
        side: 'BUY',
        isTakeProfit: false,
        status: { in: ['LIVE', 'FILLED', 'PENDING'] },
        size: { gt: 0 },
        outcome: { not: inc },
      },
    });
    return !!row;
  }

  const demo = await (prisma as any).demoTrade.findFirst({
    where: {
      ...userClause,
      sourceWalletAddress: sourceWallet,
      marketId: conditionId,
      status: 'OPEN',
      outcome: { not: inc },
    },
  });
  return !!demo;
}

const TP_FALLBACK_PRICE = 0.80; // if ROI target exceeds $1, cap at this price

function getTakeProfitTargetPrice(entryPrice: number, roiPercent: number): number {
  const target = entryPrice * (1 + roiPercent / 100);
  // If target >= 1.0 (impossible on Polymarket), cap at fallback — still locks in good profit
  return target >= 1.0 ? TP_FALLBACK_PRICE : target;
}

function getTakeProfitSize(positionSize: number, closePercent: number): number {
  return Math.round(positionSize * (closePercent / 100));
}

/**
 * Exported alias for use in cron-scheduler.
 */
export async function getOwnFreePositionSize(tokenId: string): Promise<number | null> {
  return getOwnLivePositionSize(tokenId);
}

/**
 * Returns how many shares of tokenId we actually hold and are FREE to sell.
 * Subtracts any shares currently locked in pending SELL orders (open orders from CLOB)
 * to avoid "not enough balance / allowance" errors when TP limiter already holds the shares.
 */
async function getOwnLivePositionSize(tokenId: string): Promise<number | null> {
  const tradingUser = getTradingUserAddress();
  if (!tradingUser) return null;
  try {
    const [posResp, sellOrders] = await Promise.all([
      axios.get('https://data-api.polymarket.com/positions', {
        params: { user: tradingUser, sizeThreshold: 0 },
        timeout: 10_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
      }),
      getOpenSellOrders(tokenId),
    ]);
    const position = (posResp.data || []).find((p: any) => p.asset === tokenId);
    if (!position) return 0;
    const totalSize = Math.max(Math.round(position.size || 0), 0);

    const lockedInSells = sellOrders.reduce((sum, o) => sum + o.size_remaining, 0);

    return Math.max(totalSize - Math.round(lockedInSells), 0);
  } catch {
    return null;
  }
}

async function cancelPendingTakeProfitOrders(parentTradeId: string): Promise<void> {
  const pendingOrders = await (prisma as any).liveTrade.findMany({
    where: {
      parentTradeId,
      isTakeProfit: true,
      status: 'LIVE',
      orderId: { not: null },
    },
  });

  for (const order of pendingOrders) {
    if (order.orderId) await cancelOrder(order.orderId);
    await (prisma as any).liveTrade.update({
      where: { id: order.id },
      data: { status: 'CANCELLED' },
    });
  }
}

async function applyTakeProfitFill(parentTradeId: string, filledSize: number): Promise<void> {
  const parentTrade = await (prisma as any).liveTrade.findUnique({
    where: { id: parentTradeId },
  });
  if (!parentTrade) return;

  const remainingSize = Math.max((parentTrade.size || 0) - filledSize, 0);
  await (prisma as any).liveTrade.update({
    where: { id: parentTradeId },
    data: {
      size: remainingSize,
      usdcAmount: remainingSize * parentTrade.price,
      status: remainingSize <= 0 ? 'CLOSED' : parentTrade.status,
    },
  });
}

async function ensureTakeProfitOrder(buyTrade: any): Promise<void> {
  if (!buyTrade || buyTrade.side !== 'BUY' || buyTrade.isTakeProfit || buyTrade.status !== 'FILLED') return;

  // Case-insensitive wallet lookup; if sourceWallet missing, use first live wallet with TP enabled
  const liveTpWallets = await (prisma as any).copyWallet.findMany({
    where: { mode: 'live', takeProfitEnabled: true },
    select: {
      walletAddress: true,
      mode: true,
      takeProfitEnabled: true,
      takeProfitRoiPercent: true,
      takeProfitClosePercent: true,
      takeProfitFallbackPrice: true,
      minOrderShares: true,
    },
  });
  const wallet = buyTrade.sourceWalletAddress
    ? liveTpWallets.find((w: any) => w.walletAddress.toLowerCase() === (buyTrade.sourceWalletAddress || '').toLowerCase())
    : liveTpWallets[0];
  if (!wallet) return;

  const existingTp = await (prisma as any).liveTrade.findFirst({
    where: {
      parentTradeId: buyTrade.id,
      isTakeProfit: true,
      status: { in: ['LIVE', 'FILLED'] },
    },
  });
  if (existingTp) return;

  const fallbackPrice = wallet.takeProfitFallbackPrice ?? TP_FALLBACK_PRICE;
  const rawTarget = buyTrade.price * (1 + (wallet.takeProfitRoiPercent || 150) / 100);
  const tpPrice = rawTarget >= 1.0 ? fallbackPrice : rawTarget;
  if (tpPrice <= 0 || tpPrice >= 1) {
    console.log(`[copy-trade] TP skipped (price out of range): ${buyTrade.marketTitle.slice(0, 45)} target=${tpPrice.toFixed(3)}`);
    return;
  }
  if (rawTarget >= 1.0) {
    console.log(`[copy-trade] TP fallback: entry=${buyTrade.price.toFixed(3)} raw=${rawTarget.toFixed(3)} → using fallback ${fallbackPrice} (${buyTrade.marketTitle.slice(0, 40)})`);
  }

  const minS = walletMinShares(wallet);
  // Start with percentage-based size, bump up to meet CLOB + wallet minimums
  let tpSize = getTakeProfitSize(buyTrade.size, wallet.takeProfitClosePercent || 40);
  if (tpSize < minS) tpSize = Math.min(buyTrade.size, minS);
  if (tpPrice * tpSize < 1) {
    const minSharesUsd = Math.ceil(1.01 / tpPrice);
    tpSize = Math.min(buyTrade.size, Math.max(minS, minSharesUsd));
  }

  if (tpSize < minS || tpSize > buyTrade.size || tpPrice * tpSize < 1) {
    console.log(`[copy-trade] TP skipped (can't meet min ${minS}sh / \$1): ${buyTrade.marketTitle.slice(0, 45)} target=${tpPrice.toFixed(3)} size=${tpSize}/${buyTrade.size} val=$${(tpPrice * tpSize).toFixed(2)}`);
    return;
  }

  // Check free shares before placing — avoid "not enough balance" when shares are already locked in SELL orders on CLOB
  const freeShares = await getOwnLivePositionSize(buyTrade.tokenId);
  if (freeShares !== null && freeShares < tpSize) {
    if (freeShares <= 0) {
      console.log(`[copy-trade] TP skipped (all shares locked in existing SELL orders): ${buyTrade.marketTitle.slice(0, 45)}`);
      return;
    }
    tpSize = freeShares;
    if (tpSize < minS || tpPrice * tpSize < 1) {
      console.log(`[copy-trade] TP skipped (free=${freeShares} too small): ${buyTrade.marketTitle.slice(0, 45)}`);
      return;
    }
  }

  const orderResult = await placeSellOrder(buyTrade.tokenId, tpPrice, tpSize);
  const tpStatus = orderResult.success
    ? ((orderResult.status || '') === 'matched' ? 'FILLED' : 'LIVE')
    : 'FAILED';

  const tpTrade = await (prisma as any).liveTrade.create({
    data: {
      userId: buyTrade.userId || null,
      sourceWalletAddress: buyTrade.sourceWalletAddress,
      conditionId: buyTrade.conditionId,
      tokenId: buyTrade.tokenId,
      marketTitle: buyTrade.marketTitle,
      outcome: buyTrade.outcome,
      side: 'SELL',
      price: tpPrice,
      size: tpSize,
      usdcAmount: tpPrice * tpSize,
      orderId: orderResult.orderID || null,
      status: tpStatus,
      parentTradeId: buyTrade.id,
      isTakeProfit: true,
      errorMessage: orderResult.error || null,
    },
  });

  if (tpTrade.status === 'FILLED') {
    await applyTakeProfitFill(buyTrade.id, tpSize);
  }

  if (orderResult.success) {
    console.log(`[copy-trade] TP SELL placed: ${buyTrade.marketTitle.slice(0, 45)} ${tpSize}sh @ ${tpPrice.toFixed(3)} (+${wallet.takeProfitRoiPercent}% ROI)`);
  } else {
    console.warn(`[copy-trade] TP SELL failed: ${buyTrade.marketTitle.slice(0, 45)} — ${orderResult.error}`);
  }
}

export async function poll(): Promise<{ copied: number; skipped: number; errors: number }> {
  if (isPolling) return { copied: 0, skipped: 0, errors: 0 };
  isPolling = true;

  let copied = 0;
  let skipped = 0;
  let errors = 0;

  const { minPrice: MIN_COPY_PRICE, maxPrice: MAX_COPY_PRICE } = await getGlobalPriceFilters();

  try {
    const wallets = await (prisma as any).copyWallet.findMany({
      where: { enabled: true },
    });
    if (!wallets.length) return { copied, skipped, errors };

    for (const w of wallets) {
      const walletAddress = (w.walletAddress || '').trim().toLowerCase();
      if (!walletAddress) continue;
      const ownerUserId: string | null = w.userId || null;

      const lastChecked: Date = w.lastCheckedAt ? new Date(w.lastCheckedAt) : new Date(0);

      let walletTrades: any[];
      try {
        walletTrades = await gammaClient.getWalletTrades(walletAddress, 80);
        console.log(`[copy-trade] ${walletAddress.slice(0, 10)}: fetched ${walletTrades.length} trades, lastChecked=${lastChecked.toISOString()}`);
      } catch (e: any) {
        console.warn('[copy-trade] fetch trades failed for', walletAddress.slice(0, 10), e.message);
        continue;
      }

      // Pre-compute trader's total BUY shares per conditionId+outcome for proportional SELL
      const traderBuyTotals = new Map<string, number>();
      for (const t of walletTrades) {
        if ((t.side || t.type || '').toUpperCase() !== 'BUY') continue;
        const mId = t.conditionId || t.marketId || '';
        const out = (t.outcome || (t.outcomeIndex === 0 ? 'YES' : 'NO')).toUpperCase();
        const shares = parseInt(t.size || t.shares || '0') || 0;
        if (mId && shares > 0) {
          const key = `${mId}|${out}`;
          traderBuyTotals.set(key, (traderBuyTotals.get(key) || 0) + shares);
        }
      }

      let latestTradeTs = lastChecked;

      for (const raw of walletTrades) {
        const tradeKey = makeTradeKey(walletAddress, raw);
        if (seenTradeIds.has(tradeKey)) continue;
        seenTradeIds.add(tradeKey);

        const tradeTs = parseTradeTimestamp(raw);
        if (tradeTs <= lastChecked) continue;

        const tradeAgeMs = Date.now() - tradeTs.getTime();
        const side = parseSide(raw);
        const price = parseFloat(raw.price ?? raw.averagePrice ?? '0') || 0;
        const marketId = raw.conditionId || raw.marketId;
        if (!marketId) { skipped++; continue; }

        if (tradeTs > latestTradeTs) latestTradeTs = tradeTs;

        const outcome = parseOutcome(raw);
        const marketTitle = raw.title || raw.market || '';
        const tokenId = raw.asset || '';
        const isLive = (w.mode || 'demo') === 'live';

        if (side === 'BUY') {
          if (tradeAgeMs > MAX_BUY_AGE_MS) {
            skipped++;
            continue;
          }
          if (price <= 0) { skipped++; continue; }
          if (price < MIN_COPY_PRICE) {
            skipped++;
            continue; // no liquidity at <0.4¢, skip junk outcomes
          }
          // Skip near-resolved markets above configured max price
          if (price > MAX_COPY_PRICE) {
            console.log(`[copy-trade] BUY skipped (price=${price.toFixed(3)} > max=${MAX_COPY_PRICE}): ${marketTitle.slice(0, 45)}`);
            skipped++;
            continue;
          }

          const alreadyCopied = await (prisma as any).copyTradeLog.findFirst({
            where: {
              walletAddress,
              marketId,
              outcome,
              action: 'BUY',
              status: 'COPIED',
              copiedAt: { gte: new Date(Date.now() - 7 * 86400000) },
            },
          });
          if (alreadyCopied) { skipped++; continue; }

          if (await hasOpenOppositeOutcome(ownerUserId, walletAddress, marketId, outcome, isLive)) {
            console.log(
              `[copy-trade] BUY skipped (open opposite leg on same market): ${marketTitle.slice(0, 55)} → ${outcome} (${walletAddress.slice(0, 8)})`
            );
            skipped++;
            continue;
          }

          try {
            // ── Stale-signal guard + limit order at trader's price ─────────────────
            // trader's `price` is their historical entry (could be minutes or days old).
            // We fetch the current ask to detect drift, but we ALWAYS place our
            // limit order at the trader's original price — never paying more.
            // Allowed drift shrinks with signal age (see maxAllowedDrift).
            if (tokenId && isLive && price > 0) {
              const currentAsk = await getClobAskPrice(tokenId);
              if (currentAsk !== null) {
                const drift = currentAsk - price;
                const allowed = maxAllowedDrift(tradeAgeMs);
                if (drift > allowed) {
                  console.log(
                    `[copy-trade] BUY skipped (drift=${(drift * 100).toFixed(1)}¢ > ${(allowed * 100).toFixed(1)}¢ allowed for ${Math.round(tradeAgeMs / 60_000)}min-old signal | ask=${currentAsk.toFixed(3)} entry=${price.toFixed(3)}): ${marketTitle.slice(0, 50)}`
                  );
                  skipped++;
                  continue;
                }
              }
            }

            // Always use trader's original entry price as our limit — we never overpay.
            const copyPrice = price;
            const maxAmount = Number(w.amountPerTrade) || 1;
            const scale = Number(w.copyScale) || 1;
            let amount = computeCopyAmount(raw, maxAmount, scale);
            const minS = walletMinShares(w);
            const minUsdForShares = minS * copyPrice;
            // minOrderShares can push amount above amountPerTrade — cap it hard.
            // If even the CLOB minimum (5 shares) exceeds amountPerTrade, skip the trade.
            if (minUsdForShares > maxAmount) {
              console.log(
                `[copy-trade] BUY skipped (minShares=${minS} @ ${copyPrice.toFixed(3)} = $${minUsdForShares.toFixed(2)} exceeds amountPerTrade $${maxAmount.toFixed(2)}): ${marketTitle.slice(0, 50)}`
              );
              skipped++;
              continue;
            }
            if (amount < minUsdForShares) amount = minUsdForShares;
            amount = Math.min(amount, maxAmount); // hard cap — never exceed per-trade limit
            const sourceUsd = parseFloat(raw.usdcSize) || 0;

            if (isLive) {
              if (!isClobReady()) {
                console.warn('[copy-trade] LIVE BUY skipped — CLOB client not ready');
                skipped++;
                continue;
              }
              if (!tokenId) {
                console.warn('[copy-trade] LIVE BUY skipped — no tokenId (asset)');
                skipped++;
                continue;
              }
              const regionOk = await isRegionAllowedForTrading();
              if (!regionOk) {
                const country = await getCurrentCountry();
                console.warn(`[copy-trade] LIVE BUY skipped — region blocked (IP: ${country || 'unknown'}). Use VPN.`);
                skipped++;
                continue;
              }

              const orderResult = await placeBuyOrder(tokenId, copyPrice, amount, minS);

              let liveStatus = 'FAILED';
              if (orderResult.success) {
                const clobStatus = (orderResult as any).status || '';
                liveStatus = clobStatus === 'matched' ? 'FILLED' : 'LIVE';
              }

              // Use actual size/cost from CLOB when present (CLOB may round up to meet $1 / 5-share minimum)
              const actualSize = orderResult.actualSize ?? Math.floor(amount / copyPrice);
              const actualUsdc = orderResult.actualUsdcAmount ?? amount;

              // Fetch market endDate from Gamma for pre-close exit logic
              let marketEndDate: Date | null = null;
              try {
                const mkt = await gammaClient.getMarketById(marketId).catch(() => null);
                if (mkt?.endDate) marketEndDate = new Date(mkt.endDate);
              } catch {}

              const liveTrade = await (prisma as any).liveTrade.create({
                data: {
                  userId: ownerUserId,
                  sourceWalletAddress: walletAddress,
                  conditionId: marketId,
                  tokenId,
                  marketTitle,
                  outcome,
                  side: 'BUY',
                  price: copyPrice,
                  size: actualSize,
                  usdcAmount: actualUsdc,
                  orderId: orderResult.orderID || null,
                  status: liveStatus,
                  marketEndDate,
                  errorMessage: orderResult.error || null,
                },
              });

              await (prisma as any).copyTradeLog.create({
                data: {
                  userId: ownerUserId,
                  walletAddress,
                  action: 'BUY',
                  marketId,
                  marketTitle,
                  outcome,
                  sourcePrice: price,
                  copyPrice,
                  amount: actualUsdc,
                  demoTradeId: liveTrade.id,
                  status: orderResult.success ? 'COPIED' : 'FAILED',
                  skipReason: orderResult.error || null,
                },
              });

              if (orderResult.success) {
                copied++;
                if (liveStatus === 'FILLED') {
                  await ensureTakeProfitOrder(liveTrade);
                }
                const amtNote = actualUsdc > amount ? `$${amount.toFixed(2)}→$${actualUsdc.toFixed(2)} (min)` : `$${actualUsdc.toFixed(2)}`;
                console.log(`[copy-trade] LIVE BUY ${walletAddress.slice(0, 8)}: ${marketTitle.slice(0, 50)} ${outcome} @ ${copyPrice.toFixed(3)} ${amtNote} (src: $${sourceUsd.toFixed(2)}) orderId=${orderResult.orderID}`);
              } else {
                errors++;
                console.error(`[copy-trade] LIVE BUY FAILED ${walletAddress.slice(0, 8)}: ${orderResult.error}`);
              }
            } else {
              const balance = await getDemoBalance();
              if (amount > balance) {
                console.warn('[copy-trade] insufficient balance, skipping BUY');
                skipped++;
                continue;
              }

              const trade = await (prisma as any).demoTrade.create({
                data: {
                  userId: ownerUserId,
                  eventId: marketId,
                  eventTitle: marketTitle,
                  marketId,
                  marketQuestion: marketTitle,
                  outcome,
                  amount,
                  entryPrice: copyPrice,
                  currentPrice: copyPrice,
                  pnl: 0,
                  roi: 0,
                  status: 'OPEN',
                  tags: JSON.stringify(['copy-trade', `src:${walletAddress.slice(0, 8)}`, `tokenId:${tokenId}`]),
                  sourceWalletAddress: walletAddress,
                },
              });

              await setDemoBalance(balance - amount);

              await (prisma as any).copyTradeLog.create({
                data: {
                  userId: ownerUserId,
                  walletAddress,
                  action: 'BUY',
                  marketId,
                  marketTitle,
                  outcome,
                  sourcePrice: price,
                  copyPrice,
                  amount,
                  demoTradeId: trade.id,
                  status: 'COPIED',
                },
              });

              copied++;
              console.log(`[copy-trade] DEMO BUY ${walletAddress.slice(0, 8)}: ${marketTitle.slice(0, 50)} ${outcome} @ ${copyPrice.toFixed(3)} $${amount.toFixed(2)} (src: $${sourceUsd.toFixed(2)})`);
            }
          } catch (e: any) {
            console.error('[copy-trade] BUY failed:', e.message);
            errors++;
          }
        } else {
          // SELL — close our position; allow up to 7 days so we close even after app was off
          if (tradeAgeMs > MAX_SELL_AGE_MS) {
            skipped++;
            continue;
          }
          try {
            if (isLive) {
              // ---- LIVE MODE: place real sell order ----
              if (!isClobReady() || !tokenId) {
                skipped++;
                continue;
              }

              // --- Phase 1: cancel BUY limit orders & discover filled ones (works even without VPN) ---
              let liveBuy = await (prisma as any).liveTrade.findFirst({
                where: {
                  sourceWalletAddress: walletAddress,
                  conditionId: marketId,
                  outcome,
                  side: 'BUY',
                  status: 'FILLED',
                  isTakeProfit: false,
                },
                orderBy: { createdAt: 'desc' },
              });

              const pendingBuys = await (prisma as any).liveTrade.findMany({
                where: {
                  sourceWalletAddress: walletAddress,
                  conditionId: marketId,
                  outcome,
                  side: 'BUY',
                  status: 'LIVE',
                  orderId: { not: null },
                },
              });
              for (const pb of pendingBuys) {
                const pbStatus = await getOrderStatus(pb.orderId);
                if (pbStatus === 'matched') {
                  await (prisma as any).liveTrade.update({ where: { id: pb.id }, data: { status: 'FILLED' } });
                  if (!liveBuy) liveBuy = { ...pb, status: 'FILLED' };
                  console.log(`[copy-trade] LIVE BUY filled (discovered during SELL): ${marketTitle.slice(0, 45)}`);
                } else {
                  await cancelOrder(pb.orderId);
                  await (prisma as any).liveTrade.update({ where: { id: pb.id }, data: { status: 'CANCELLED' } });
                  console.log(`[copy-trade] Cancelled pending BUY limit (source sold): ${marketTitle.slice(0, 45)} @${pb.price}`);
                }
              }

              // Check if a partially/fully filled limit exists that we haven't marked FILLED yet
              if (!liveBuy) {
                const liveOrder = await (prisma as any).liveTrade.findFirst({
                  where: {
                    sourceWalletAddress: walletAddress,
                    conditionId: marketId,
                    outcome,
                    side: 'BUY',
                    status: 'LIVE',
                    orderId: { not: null },
                  },
                  orderBy: { createdAt: 'desc' },
                });
                if (liveOrder && liveOrder.orderId) {
                  const clobStatus = await getOrderStatus(liveOrder.orderId);
                  if (clobStatus === 'matched') {
                    await (prisma as any).liveTrade.update({
                      where: { id: liveOrder.id },
                      data: { status: 'FILLED' },
                    });
                    liveBuy = { ...liveOrder, status: 'FILLED' };
                    console.log(`[copy-trade] LIVE order ${liveOrder.orderId.slice(0, 16)}... matched → FILLED before SELL`);
                  } else if (clobStatus === 'live') {
                    const cancelled = await cancelOrder(liveOrder.orderId);
                    const statusAfterCancel = await getOrderStatus(liveOrder.orderId);
                    if (statusAfterCancel === 'matched') {
                      await (prisma as any).liveTrade.update({ where: { id: liveOrder.id }, data: { status: 'FILLED' } });
                      liveBuy = { ...liveOrder, status: 'FILLED' };
                      console.log(`[copy-trade] LIVE BUY filled just before cancel — treating as FILLED, will SELL: ${marketTitle.slice(0, 45)}`);
                    } else {
                      await (prisma as any).liveTrade.update({
                        where: { id: liveOrder.id },
                        data: { status: 'CANCELLED' },
                      });
                      console.log(`[copy-trade] LIVE BUY cancelled (source sold before fill): ${marketTitle.slice(0, 45)} orderId=${liveOrder.orderId.slice(0, 16)}... cancelled=${cancelled}`);
                      await (prisma as any).copyTradeLog.create({
                        data: {
                          userId: ownerUserId,
                          walletAddress,
                          action: 'SELL',
                          marketId,
                          marketTitle,
                          outcome,
                          sourcePrice: price,
                          copyPrice: price,
                          amount: liveOrder.usdcAmount || 0,
                          demoTradeId: liveOrder.id,
                          status: 'COPIED',
                          skipReason: 'BUY was unfilled — cancelled pending order instead of selling',
                        },
                      });
                      copied++;
                      continue;
                    }
                  }
                }
              }

              // Even with no DB match, check actual on-chain balance — limit may have partially filled
              if (!liveBuy) {
                const realShares = await getOwnLivePositionSize(tokenId);
                if (realShares && realShares > 0) {
                  console.log(`[copy-trade] Discovered ${realShares} real shares for ${marketTitle.slice(0, 45)} — creating synthetic FILLED record`);
                  liveBuy = await (prisma as any).liveTrade.create({
                    data: {
                      userId: ownerUserId,
                      sourceWalletAddress: walletAddress,
                      conditionId: marketId,
                      tokenId,
                      marketTitle,
                      outcome,
                      side: 'BUY',
                      price,
                      size: realShares,
                      usdcAmount: price * realShares,
                      status: 'FILLED',
                    },
                  });
                }
              }

              if (!liveBuy) {
                console.log(`[copy-trade] LIVE SELL skipped — no open BUY: ${marketTitle.slice(0, 45)} ${outcome} (${walletAddress.slice(0, 8)})`);
                skipped++;
                continue;
              }

              // --- Phase 2: sell real shares (requires VPN) ---
              const regionOk = await isRegionAllowedForTrading();
              if (!regionOk) {
                // Can't sell right now, but record a FAILED SELL so retry picks it up later
                const country = await getCurrentCountry();
                const actualSize = await getOwnLivePositionSize(tokenId);
                const currentSize = actualSize ?? liveBuy.size;
                if (currentSize > 0) {
                  await (prisma as any).liveTrade.create({
                    data: {
                      userId: ownerUserId,
                      sourceWalletAddress: walletAddress,
                      conditionId: marketId,
                      tokenId,
                      marketTitle,
                      outcome,
                      side: 'SELL',
                      price,
                      size: currentSize,
                      usdcAmount: price * currentSize,
                      status: 'FAILED',
                      parentTradeId: liveBuy.id,
                      errorMessage: `Region blocked (IP: ${country || 'unknown'}). Use VPN. Will retry.`,
                    },
                  });
                  console.warn(`[copy-trade] LIVE SELL deferred (region blocked, ${currentSize}sh): ${marketTitle.slice(0, 45)} — will retry when VPN is up`);
                } else {
                  console.warn(`[copy-trade] LIVE SELL skipped (region blocked, 0 shares): ${marketTitle.slice(0, 45)}`);
                }
                errors++;
                continue;
              }

              await cancelPendingTakeProfitOrders(liveBuy.id);

              const actualHeldSize = await getOwnLivePositionSize(tokenId);
              const currentSize = actualHeldSize ?? liveBuy.size;
              if (currentSize <= 0) {
                await (prisma as any).liveTrade.update({
                  where: { id: liveBuy.id },
                  data: { status: 'CLOSED', size: 0, usdcAmount: 0 },
                });
                console.log(`[copy-trade] LIVE SELL skipped — no shares left after TP/manual exit: ${marketTitle.slice(0, 45)}`);
                skipped++;
                continue;
              }

              // Proportional sell: fraction = traderSellShares / traderTotalBuyShares
              const sourceSellShares = parseInt(raw.size || raw.shares || '0') || 0;
              const traderBuyKey = `${marketId}|${outcome}`;
              const traderTotalBuy = traderBuyTotals.get(traderBuyKey) || 0;
              const minS = walletMinShares(w);
              let sellSize = currentSize;
              if (sourceSellShares > 0 && traderTotalBuy > 0) {
                const fraction = sourceSellShares / traderTotalBuy;
                sellSize = Math.round(currentSize * fraction);
                if (sellSize < minS) {
                  if (currentSize >= minS) sellSize = minS;
                  else if (currentSize >= CLOB_ABS_MIN_SHARES) sellSize = currentSize;
                  else {
                    skipped++;
                    continue;
                  }
                }
                if (sellSize > currentSize) sellSize = currentSize;
              }

              const orderResult = await placeSellOrder(tokenId, price, sellSize);

              // If market orderbook is gone (resolved) — close position silently, not as FAILED
              const isMarketGone = !orderResult.success && orderResult.error &&
                (orderResult.error.toLowerCase().includes('does not exist') ||
                 orderResult.error.toLowerCase().includes('no orderbook'));
              // If balance error but we already checked actualHeldSize > 0 — still FAILED, will retry
              const sellStatus = orderResult.success ? 'FILLED' : (isMarketGone ? 'CLOSED' : 'FAILED');

              if (isMarketGone) {
                // Market resolved — just close our record
                await (prisma as any).liveTrade.update({
                  where: { id: liveBuy.id },
                  data: { status: 'CLOSED', size: 0, usdcAmount: 0 },
                });
                console.log(`[copy-trade] LIVE SELL skipped (market resolved): ${marketTitle.slice(0, 45)}`);
                skipped++;
                continue;
              }

              await (prisma as any).liveTrade.create({
                data: {
                  userId: ownerUserId,
                  sourceWalletAddress: walletAddress,
                  conditionId: marketId,
                  tokenId,
                  marketTitle,
                  outcome,
                  side: 'SELL',
                  price,
                  size: sellSize,
                  usdcAmount: price * sellSize,
                  orderId: orderResult.orderID || null,
                  status: sellStatus,
                  errorMessage: orderResult.error || null,
                },
              });

              if (orderResult.success) {
                const remaining = currentSize - sellSize;
                if (remaining <= 0) {
                  // Full close
                  await (prisma as any).liveTrade.update({
                    where: { id: liveBuy.id },
                    data: { status: 'CLOSED', size: 0, usdcAmount: 0 },
                  });
                } else {
                  // Partial close — reduce our position size
                  await (prisma as any).liveTrade.update({
                    where: { id: liveBuy.id },
                    data: {
                      size: remaining,
                      usdcAmount: remaining * liveBuy.price,
                    },
                  });
                }
              }

              await (prisma as any).copyTradeLog.create({
                data: {
                  userId: ownerUserId,
                  walletAddress,
                  action: 'SELL',
                  marketId,
                  marketTitle,
                  outcome,
                  sourcePrice: price,
                  copyPrice: price,
                  amount: price * sellSize,
                  demoTradeId: liveBuy.id,
                  status: orderResult.success ? 'COPIED' : 'FAILED',
                  skipReason: orderResult.error || null,
                },
              });

              if (orderResult.success) {
                copied++;
                const pct = traderTotalBuy > 0 ? `${(sourceSellShares / traderTotalBuy * 100).toFixed(0)}%` : '100%';
                const partial = sellSize < currentSize ? ` (partial: ${sellSize}/${currentSize} shares, trader sold ${pct})` : '';
                console.log(`[copy-trade] LIVE SELL ${walletAddress.slice(0, 8)}: ${marketTitle.slice(0, 50)} @ ${price.toFixed(3)}${partial} orderId=${orderResult.orderID}`);
              } else {
                errors++;
                console.error(`[copy-trade] LIVE SELL FAILED: ${orderResult.error}`);
              }
            } else {
              // ---- DEMO MODE: close paper position ----
              const openTrade = await (prisma as any).demoTrade.findFirst({
                where: {
                  marketId,
                  outcome,
                  status: 'OPEN',
                  sourceWalletAddress: walletAddress,
                },
                orderBy: { openedAt: 'desc' },
              });

              if (!openTrade) {
                console.log(`[copy-trade] DEMO SELL skipped — no open position: ${marketTitle.slice(0, 45)} ${outcome} (${walletAddress.slice(0, 8)})`);
                skipped++;
                continue;
              }

              const exitPrice = price > 0 ? price : (openTrade.currentPrice ?? openTrade.entryPrice);

              // Proportional sell: fraction = traderSellShares / traderTotalBuyShares
              const sourceSellShares = parseInt(raw.size || raw.shares || '0') || 0;
              const traderBuyKey = `${marketId}|${outcome}`;
              const traderTotalBuy = traderBuyTotals.get(traderBuyKey) || 0;
              let sellFraction = 1;
              if (sourceSellShares > 0 && traderTotalBuy > 0) {
                sellFraction = sourceSellShares / traderTotalBuy;
                if (sellFraction > 1) sellFraction = 1;
              }

              const sellAmount = openTrade.amount * sellFraction;
              const pnl = (exitPrice - openTrade.entryPrice) * (sellAmount / openTrade.entryPrice);
              const roi = ((exitPrice - openTrade.entryPrice) / openTrade.entryPrice) * 100;

              if (sellFraction >= 0.95) {
                // Full close (≥95% = treat as complete exit)
                await (prisma as any).demoTrade.update({
                  where: { id: openTrade.id },
                  data: {
                    exitPrice,
                    currentPrice: exitPrice,
                    pnl,
                    roi,
                    status: 'CLOSED_MANUAL',
                    closedAt: new Date(),
                  },
                });

                const balance = await getDemoBalance();
                await setDemoBalance(balance + openTrade.amount + pnl);
              } else {
                // Partial close — reduce position size
                const remainAmount = openTrade.amount - sellAmount;
                const partialPnl = (exitPrice - openTrade.entryPrice) * (remainAmount / openTrade.entryPrice);

                await (prisma as any).demoTrade.update({
                  where: { id: openTrade.id },
                  data: {
                    amount: remainAmount,
                    currentPrice: exitPrice,
                    pnl: partialPnl,
                    roi,
                  },
                });

                const balance = await getDemoBalance();
                await setDemoBalance(balance + sellAmount + pnl);
              }

              await (prisma as any).copyTradeLog.create({
                data: {
                  userId: ownerUserId,
                  walletAddress,
                  action: 'SELL',
                  marketId,
                  marketTitle: openTrade.marketQuestion || marketTitle,
                  outcome,
                  sourcePrice: price,
                  copyPrice: exitPrice,
                  amount: sellAmount,
                  demoTradeId: openTrade.id,
                  status: 'COPIED',
                },
              });

              copied++;
              const partial = sellFraction < 0.9 ? ` (partial: ${(sellFraction * 100).toFixed(0)}%)` : '';
              console.log(`[copy-trade] DEMO SELL ${walletAddress.slice(0, 8)}: closed ${(openTrade.marketQuestion || '').slice(0, 50)} PnL=${pnl.toFixed(2)}${partial}`);
            }
          } catch (e: any) {
            console.error('[copy-trade] SELL failed:', e.message);
            errors++;
          }
        }
      }

      await (prisma as any).copyWallet.update({
        where: { id: w.id },
        data: { lastCheckedAt: latestTradeTs > lastChecked ? latestTradeTs : new Date() },
      });
    }

    // Prevent unbounded memory growth
    if (seenTradeIds.size > MAX_SEEN_KEYS) {
      const excess = seenTradeIds.size - MAX_SEEN_KEYS;
      const iter = seenTradeIds.values();
      for (let i = 0; i < excess; i++) iter.next();
      // rebuild keeping only latest entries
      const keep = [...seenTradeIds].slice(excess);
      seenTradeIds.clear();
      keep.forEach(k => seenTradeIds.add(k));
    }

    console.log(`[copy-trade] poll done — copied:${copied} skipped:${skipped} errors:${errors} (seen keys: ${seenTradeIds.size})`);
  } catch (e: any) {
    console.error('[copy-trade] poll error:', e.message);
    errors++;
  } finally {
    isPolling = false;
  }

  return { copied, skipped, errors };
}

export async function retryFailedLiveTrades(): Promise<void> {
  if (!isClobReady()) return;
  const regionOk = await isRegionAllowedForTrading();
  if (!regionOk) {
    const country = await getCurrentCountry();
    console.warn(`[copy-trade] retry failed trades skipped — region blocked (IP: ${country || 'unknown'}). Use VPN.`);
    return;
  }

  // Only retry SELL orders — BUY retries are too risky (price may have moved)
  const failedTrades = await (prisma as any).liveTrade.findMany({
    where: {
      status: 'FAILED',
      side: 'SELL',
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: 'desc' },
    take: 15,
  });

  if (!failedTrades.length) return;
  console.log(`[copy-trade] retrying ${failedTrades.length} failed SELL trades...`);

  for (const trade of failedTrades) {
    try {
      if (!trade.tokenId) {
        await (prisma as any).liveTrade.update({
          where: { id: trade.id },
          data: { status: 'CLOSED', errorMessage: 'no tokenId' },
        });
        continue;
      }

      // Check actual free shares before attempting
      let retrySize = trade.size;
      const freeShares = await getOwnLivePositionSize(trade.tokenId);
      if (freeShares === 0) {
        await (prisma as any).liveTrade.update({
          where: { id: trade.id },
          data: { status: 'CLOSED', errorMessage: 'auto-closed: no free shares (sold by TP or manual)' },
        });
        if (trade.parentTradeId) {
          await (prisma as any).liveTrade.update({
            where: { id: trade.parentTradeId },
            data: { status: 'CLOSED', size: 0, usdcAmount: 0 },
          });
        }
        console.log(`[copy-trade] RETRY SELL skipped (no free shares, closed): ${trade.marketTitle?.slice(0, 40)}`);
        continue;
      }
      if (freeShares !== null) retrySize = freeShares;

      // Use current ask price (sell-side of the book) so our limit sits at the ask, not the bid
      const currentPrice = await getClobAskPrice(trade.tokenId);
      const sellPrice = (currentPrice !== null && currentPrice > 0) ? currentPrice : trade.price;

      const orderResult = await placeSellOrder(trade.tokenId, sellPrice, retrySize);

      let retryStatus = 'FAILED';
      if (orderResult.success) {
        retryStatus = orderResult.status === 'matched' ? 'FILLED' : 'LIVE';
      }

      // Permanently cancel if orderbook no longer exists, market resolved, or price invalid (market settled)
      const permanentErrors = ['does not exist', 'not found', 'no orderbook', 'invalid price'];
      const isPermanent = !orderResult.success && orderResult.error &&
        permanentErrors.some(e => (orderResult.error || '').toLowerCase().includes(e));

      // Market gone (resolved) — just close, don't keep retrying
      const isMarketGone = !orderResult.success && orderResult.error &&
        permanentErrors.some(e => (orderResult.error || '').toLowerCase().includes(e));

      await (prisma as any).liveTrade.update({
        where: { id: trade.id },
        data: {
          status: isMarketGone ? 'CLOSED' : retryStatus,
          orderId: orderResult.orderID || null,
          errorMessage: orderResult.error || null,
        },
      });

      if (orderResult.success) {
        console.log(`[copy-trade] RETRY SELL OK: ${trade.marketTitle.slice(0, 40)} orderId=${orderResult.orderID}`);
        if (trade.parentTradeId) {
          await (prisma as any).liveTrade.update({
            where: { id: trade.parentTradeId },
            data: { status: 'CLOSED', size: 0, usdcAmount: 0 },
          });
        }
      } else if (isMarketGone) {
        if (trade.parentTradeId) {
          await (prisma as any).liveTrade.update({
            where: { id: trade.parentTradeId },
            data: { status: 'CLOSED', size: 0, usdcAmount: 0 },
          });
        }
        console.log(`[copy-trade] RETRY SELL closed (market gone): ${trade.marketTitle.slice(0, 40)}`);
      } else {
        console.warn(`[copy-trade] RETRY SELL failed: ${trade.marketTitle.slice(0, 40)} — ${orderResult.error}`);
      }
    } catch (e: any) {
      console.error(`[copy-trade] retry error: ${e.message}`);
    }
  }
}

async function syncLiveOrderStatuses(): Promise<void> {
  if (!isClobReady()) return;
  const regionOk = await isRegionAllowedForTrading();
  if (!regionOk) return; // no log every 2 min; region already logged in poll/retry

  const liveOrders = await (prisma as any).liveTrade.findMany({
    where: { status: 'LIVE', orderId: { not: null } },
  });

  if (!liveOrders.length) return;

  for (const order of liveOrders) {
    const clobStatus = await getOrderStatus(order.orderId);
    // null = order not found (CLOB deletes old orders when filled or expired)
    if (!clobStatus) {
      // Recover: if we have real shares for this BUY, treat as FILLED and place TP
      if (order.side === 'BUY' && !order.isTakeProfit && order.tokenId) {
        const realSize = await getOwnLivePositionSize(order.tokenId);
        if (realSize !== null && realSize > 0) {
          await (prisma as any).liveTrade.update({
            where: { id: order.id },
            data: { status: 'FILLED', size: realSize },
          });
          await ensureTakeProfitOrder({ ...order, status: 'FILLED', size: realSize });
          console.log(`[copy-trade] order ${(order.orderId || '').slice(0, 16)}... not on CLOB but we have ${realSize}sh → FILLED + TP (${(order.marketTitle || '').slice(0, 40)})`);
        }
      }
      continue;
    }

    if (clobStatus === 'matched') {
      await (prisma as any).liveTrade.update({
        where: { id: order.id },
        data: { status: 'FILLED' },
      });
      if (order.side === 'BUY' && !order.isTakeProfit) {
        await ensureTakeProfitOrder({ ...order, status: 'FILLED' });
      }
      if (order.side === 'SELL' && order.isTakeProfit && order.parentTradeId) {
        await applyTakeProfitFill(order.parentTradeId, order.size);
      }
      console.log(`[copy-trade] order ${order.orderId.slice(0, 16)}... matched → FILLED (${order.marketTitle.slice(0, 40)})`);
    } else if (clobStatus === 'canceled') {
      await (prisma as any).liveTrade.update({
        where: { id: order.id },
        data: { status: 'CANCELLED' },
      });
      console.log(`[copy-trade] order ${order.orderId.slice(0, 16)}... canceled → CANCELLED`);
    }
  }

  // Backfill: place TP for FILLED BUYs that still have no LIVE/FILLED take-profit order
  const filledBuysForTp = await (prisma as any).liveTrade.findMany({
    where: { side: 'BUY', status: 'FILLED', isTakeProfit: false },
    take: 10,
  });
  for (const buy of filledBuysForTp) {
    if (!buy.tokenId) continue;
    const hasTp = await (prisma as any).liveTrade.findFirst({
      where: { parentTradeId: buy.id, isTakeProfit: true, status: { in: ['LIVE', 'FILLED'] } },
    });
    if (hasTp) continue;
    // Skip if there was a recent FAILED TP attempt (avoid spamming CLOB)
    const recentFail = await (prisma as any).liveTrade.findFirst({
      where: {
        parentTradeId: buy.id,
        isTakeProfit: true,
        status: 'FAILED',
        createdAt: { gt: new Date(Date.now() - 10 * 60_000) },
      },
    });
    if (recentFail) continue;
    await ensureTakeProfitOrder(buy);
  }
}

/**
 * Check if source traders have exited positions we still hold.
 * Handles both FILLED buys (sell shares) and LIVE buys (cancel limit + sell any partially filled shares).
 * Runs every 70s, so even if VPN is down now, it will retry on the next cycle.
 */
export async function syncTraderExits(): Promise<number> {
  const openBuys = await (prisma as any).liveTrade.findMany({
    where: { side: 'BUY', status: { in: ['FILLED', 'LIVE'] }, isTakeProfit: false },
  });
  if (openBuys.length === 0) return 0;

  let closed = 0;
  for (const trade of openBuys) {
    try {
      if (!trade.sourceWalletAddress || !trade.conditionId) continue;

      const resp = await axios.get('https://data-api.polymarket.com/positions', {
        params: { user: trade.sourceWalletAddress, sizeThreshold: 0, market: trade.conditionId },
        timeout: 10_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
      });
      const positions = resp.data || [];
      if (positions.length === 0) continue;
      const matching = positions.find((p: any) =>
        (p.outcome || '').toUpperCase() === (trade.outcome || '').toUpperCase(),
      );
      const traderSize = matching ? (matching.size || 0) : 0;
      if (traderSize > 0.5) continue; // trader still holds

      // --- Trader exited this position ---

      // For LIVE (unfilled) buys: cancel the limit order, then check for partial fills
      if (trade.status === 'LIVE') {
        if (trade.orderId) {
          // Check if it actually filled before cancelling
          const clobStatus = await getOrderStatus(trade.orderId);
          if (clobStatus === 'matched') {
            await (prisma as any).liveTrade.update({ where: { id: trade.id }, data: { status: 'FILLED' } });
            trade.status = 'FILLED';
            console.log(`[sync-exits] LIVE BUY actually filled: ${trade.marketTitle?.slice(0, 45)}`);
            // Fall through to FILLED handling below
          } else {
            await cancelOrder(trade.orderId);
            // Check real balance — limit may have partially filled
            const realShares = trade.tokenId ? await getOwnLivePositionSize(trade.tokenId) : 0;
            if (realShares && realShares > 0) {
              // Partial fill — update record and fall through to sell
              await (prisma as any).liveTrade.update({
                where: { id: trade.id },
                data: { status: 'FILLED', size: realShares, usdcAmount: trade.price * realShares },
              });
              trade.status = 'FILLED';
              trade.size = realShares;
              console.log(`[sync-exits] LIVE BUY cancelled but ${realShares}sh partially filled — will sell: ${trade.marketTitle?.slice(0, 45)}`);
            } else {
              await (prisma as any).liveTrade.update({
                where: { id: trade.id },
                data: { status: 'CANCELLED' },
              });
              closed++;
              console.log(`[sync-exits] LIVE BUY cancelled (trader exited, unfilled): ${trade.marketTitle?.slice(0, 45)}`);
              continue;
            }
          }
        } else {
          // No orderId — stale record
          await (prisma as any).liveTrade.update({ where: { id: trade.id }, data: { status: 'CANCELLED' } });
          closed++;
          continue;
        }
      }

      // --- FILLED buy: sell our shares ---
      if (!trade.tokenId) {
        await (prisma as any).liveTrade.update({ where: { id: trade.id }, data: { status: 'CLOSED' } });
        closed++;
        console.log(`[sync-exits] Closed (no tokenId): ${trade.marketTitle?.slice(0, 45)}`);
        continue;
      }

      await cancelPendingTakeProfitOrders(trade.id);
      await new Promise(r => setTimeout(r, 1500));

      const freeShares = await getOwnLivePositionSize(trade.tokenId);
      const currentSize = freeShares ?? trade.size;
      if (currentSize <= 0) {
        await (prisma as any).liveTrade.update({
          where: { id: trade.id },
          data: { status: 'CLOSED', size: 0, usdcAmount: 0 },
        });
        closed++;
        console.log(`[sync-exits] Closed (already exited): ${trade.marketTitle?.slice(0, 45)}`);
        continue;
      }

      // Use ask price so our SELL limit sits at the ask, not dumps into the bid
      const clobPrice = await getClobAskPrice(trade.tokenId);
      if (clobPrice === null) {
        await (prisma as any).liveTrade.update({ where: { id: trade.id }, data: { status: 'CLOSED' } });
        closed++;
        console.log(`[sync-exits] Closed (market dead): ${trade.marketTitle?.slice(0, 45)}`);
        continue;
      }

      if (!isClobReady()) continue;
      const regionOk = await isRegionAllowedForTrading();
      if (!regionOk) {
        // Record a FAILED SELL so retryFailedLiveTrades picks it up when VPN is back
        const existingFailedSell = await (prisma as any).liveTrade.findFirst({
          where: { parentTradeId: trade.id, side: 'SELL', status: 'FAILED', isTakeProfit: false },
        });
        if (!existingFailedSell) {
          await (prisma as any).liveTrade.create({
            data: {
              userId: trade.userId || null,
              sourceWalletAddress: trade.sourceWalletAddress,
              conditionId: trade.conditionId,
              tokenId: trade.tokenId,
              marketTitle: trade.marketTitle,
              outcome: trade.outcome,
              side: 'SELL',
              price: clobPrice,
              size: currentSize,
              usdcAmount: clobPrice * currentSize,
              status: 'FAILED',
              parentTradeId: trade.id,
              errorMessage: 'Region blocked — will retry when VPN is up',
            },
          });
          console.warn(`[sync-exits] SELL deferred (region blocked, ${currentSize}sh): ${trade.marketTitle?.slice(0, 40)} — retry scheduled`);
        }
        continue;
      }

      if (currentSize < 5 || clobPrice * currentSize < 1) {
        console.log(`[sync-exits] Skipped (below CLOB min): ${trade.marketTitle?.slice(0, 40)} ${currentSize}sh@${clobPrice.toFixed(3)} val=$${(clobPrice * currentSize).toFixed(2)}`);
        continue;
      }

      const orderResult = await placeSellOrder(trade.tokenId, clobPrice, currentSize);

      const isMarketGone = !orderResult.success && orderResult.error &&
        (orderResult.error.toLowerCase().includes('does not exist') ||
         orderResult.error.toLowerCase().includes('no orderbook'));

      if (isMarketGone) {
        await (prisma as any).liveTrade.update({ where: { id: trade.id }, data: { status: 'CLOSED' } });
        closed++;
        console.log(`[sync-exits] Closed (orderbook gone at sell): ${trade.marketTitle?.slice(0, 45)}`);
      } else if (orderResult.success) {
        await (prisma as any).liveTrade.create({
          data: {
            userId: trade.userId || null,
            sourceWalletAddress: trade.sourceWalletAddress,
            conditionId: trade.conditionId,
            tokenId: trade.tokenId,
            marketTitle: trade.marketTitle,
            outcome: trade.outcome,
            side: 'SELL',
            price: clobPrice,
            size: currentSize,
            usdcAmount: clobPrice * currentSize,
            orderId: orderResult.orderID || null,
            status: 'FILLED',
          },
        });
        await (prisma as any).liveTrade.update({
          where: { id: trade.id },
          data: { status: 'CLOSED', size: 0, usdcAmount: 0 },
        });
        closed++;
        const pnl = ((clobPrice - trade.price) * currentSize).toFixed(2);
        console.log(`[sync-exits] SOLD (trader exited): ${trade.marketTitle?.slice(0, 40)} ${currentSize}sh @ ${clobPrice.toFixed(3)} PnL=$${pnl}`);
      } else {
        console.warn(`[sync-exits] SELL failed: ${trade.marketTitle?.slice(0, 40)} — ${orderResult.error}`);
      }
    } catch {
      // skip per-trade errors
    }
  }
  return closed;
}

/**
 * Find real on-chain positions that have no matching open BUY in our DB (orphans).
 * These happen when a BUY was marked CLOSED but the SELL never actually went through on CLOB.
 * Attempts to sell them at current market price.
 */
export async function sweepOrphanPositions(): Promise<number> {
  if (!isClobReady()) return 0;
  const regionOk = await isRegionAllowedForTrading();
  if (!regionOk) return 0;

  const tradingUser = getTradingUserAddress();
  if (!tradingUser) return 0;

  let allPositions: any[];
  try {
    const resp = await axios.get('https://data-api.polymarket.com/positions', {
      params: { user: tradingUser, sizeThreshold: 0 },
      timeout: 15_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
    });
    allPositions = (resp.data || []).filter((p: any) => Math.round(p.size || 0) >= 5);
  } catch {
    return 0;
  }

  if (!allPositions.length) return 0;

  let sold = 0;
  for (const pos of allPositions) {
    try {
      const tokenId = pos.asset;
      const realSize = Math.round(pos.size || 0);
      if (!tokenId || realSize < 5) continue;

      // Check if we have an active BUY record for this token
      const activeBuy = await (prisma as any).liveTrade.findFirst({
        where: {
          tokenId,
          side: 'BUY',
          status: { in: ['FILLED', 'LIVE'] },
          isTakeProfit: false,
        },
      });
      if (activeBuy) continue; // tracked — syncTraderExits handles this

      // Check if there's already a pending SELL (TP or otherwise) for this token
      const pendingSell = await (prisma as any).liveTrade.findFirst({
        where: {
          tokenId,
          side: 'SELL',
          status: { in: ['LIVE', 'PENDING'] },
        },
      });
      if (pendingSell) continue; // already have a sell order out

      // Check if there's a recent FAILED SELL we're already retrying
      const recentFailedSell = await (prisma as any).liveTrade.findFirst({
        where: {
          tokenId,
          side: 'SELL',
          status: 'FAILED',
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });
      if (recentFailedSell) continue; // retry will handle it

      // This is an orphan — real shares with no active DB record
      // Find the original CLOSED BUY for context
      const closedBuy = await (prisma as any).liveTrade.findFirst({
        where: { tokenId, side: 'BUY', status: 'CLOSED' },
        orderBy: { createdAt: 'desc' },
      });

      const sellOrders = await getOpenSellOrders(tokenId);
      const lockedInSells = sellOrders.reduce((sum, o) => sum + o.size_remaining, 0);
      const freeShares = Math.max(realSize - Math.round(lockedInSells), 0);
      if (freeShares < 5) continue;

      // Use ask price so our SELL limit sits at the ask, not dumps into the bid
      const clobPrice = await getClobAskPrice(tokenId);
      if (clobPrice === null || clobPrice <= 0) continue;
      if (clobPrice * freeShares < 1) continue; // below CLOB minimum

      const title = closedBuy?.marketTitle || pos.title || tokenId.slice(0, 20);
      console.log(`[orphan-sweep] Found ${freeShares}sh orphan: ${title.slice(0, 50)} @ ${clobPrice.toFixed(3)} (ask) — selling`);

      const orderResult = await placeSellOrder(tokenId, clobPrice, freeShares);
      if (orderResult.success) {
        await (prisma as any).liveTrade.create({
          data: {
            userId: closedBuy?.userId || null,
            sourceWalletAddress: closedBuy?.sourceWalletAddress || '',
            conditionId: closedBuy?.conditionId || '',
            tokenId,
            marketTitle: title,
            outcome: closedBuy?.outcome || pos.outcome || '',
            side: 'SELL',
            price: clobPrice,
            size: freeShares,
            usdcAmount: clobPrice * freeShares,
            orderId: orderResult.orderID || null,
            status: orderResult.status === 'matched' ? 'FILLED' : 'LIVE',
          },
        });
        sold++;
        console.log(`[orphan-sweep] SOLD: ${title.slice(0, 45)} ${freeShares}sh @ ${clobPrice.toFixed(3)} orderId=${orderResult.orderID}`);
      } else {
        console.warn(`[orphan-sweep] SELL failed: ${title.slice(0, 45)} — ${orderResult.error}`);
      }
    } catch {
      // skip per-position errors
    }
  }
  if (sold > 0) console.log(`[orphan-sweep] sold ${sold} orphan positions`);
  return sold;
}

export function startCopyTradePoller() {
  setTimeout(() => retryFailedLiveTrades(), 5000);
  setTimeout(() => syncTraderExits(), 15_000);
  // Sweep orphan positions on startup (delayed) and every 3 minutes
  setTimeout(() => sweepOrphanPositions(), 30_000);
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
  setInterval(() => syncLiveOrderStatuses(), 45_000);
  setInterval(() => retryFailedLiveTrades(), 5 * 60 * 1000);
  setInterval(() => syncTraderExits(), 70_000);
  setInterval(() => sweepOrphanPositions(), 3 * 60 * 1000);
  console.log(`[copy-trade] poller started (interval: ${POLL_INTERVAL_MS / 1000}s, order sync: 45s, retry: 300s, exit sync: 70s, orphan sweep: 180s)`);
}

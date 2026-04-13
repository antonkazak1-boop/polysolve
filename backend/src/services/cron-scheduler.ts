import cron from 'node-cron';
import axios from 'axios';
import { scanAnomalies } from '../clients/anomaly-detector';
import { generateRecommendations, invalidateRecommendationsCache } from './recommendation-engine';
import { generateSignals, invalidateSignalsCache } from './signal-engine';
import { resolvePendingSignals } from './signal-tracker';
import { scanWhaleActivity } from './whale-scanner';
import { snapshotPendingSignalPrices } from './signal-price-snapshot';
import prisma from '../config/database';
import { gammaClient, parseOutcomePrices } from '../clients/gamma-client';
import { getClobPrice, getOwnFreePositionSize } from './copy-trade';
import { isClobReady, placeSellOrder, getTradingUserAddress } from '../clients/polymarket-clob';
import { isRegionAllowedForTrading } from '../utils/region-guard';
import { syncOracleElixir2026FromDrive } from './oracle-elixir-sync';

let started = false;

export function startCron() {
  if (started) return;
  started = true;

  console.log('⏰ Cron scheduler started');

  // Scan anomalies every 15 min (was 5) — less VPN/API load
  cron.schedule('*/15 * * * *', async () => {
    try {
      console.log('[cron] Scanning anomalies...');
      await scanAnomalies({ limit: 60 });
      console.log('[cron] Anomaly scan done');
    } catch (err: any) {
      console.error('[cron] Anomaly scan failed:', err.message);
    }
  });

  // Signals + Recommendations every 25 min — signals first, recommendations reuses Perplexity cache
  cron.schedule('*/25 * * * *', async () => {
    try {
      console.log('[cron] Refreshing signals (with Perplexity)...');
      invalidateSignalsCache();
      await generateSignals(false);
      console.log('[cron] Signals refreshed');

      console.log('[cron] Refreshing recommendations (cache reuse)...');
      invalidateRecommendationsCache();
      await generateRecommendations(10, false); // Perplexity cache hit for overlapping markets
      console.log('[cron] Recommendations refreshed');
    } catch (err: any) {
      console.error('[cron] Signals/Recommendations refresh failed:', err.message);
    }
  });

  // Scan for whale trades every 5 min
  cron.schedule('*/5 * * * *', async () => {
    try {
      const result = await scanWhaleActivity();
      if (result.saved > 0) {
        console.log(`[cron] Whale scan: found ${result.found} large trades, saved ${result.saved} new`);
      }
    } catch (err: any) {
      console.error('[cron] Whale scan failed:', err.message);
    }
  });

  // Snapshot prices for pending signals every 15 min (for CLV)
  cron.schedule('*/15 * * * *', async () => {
    try {
      const count = await snapshotPendingSignalPrices();
      if (count > 0) console.log(`[cron] CLV snapshots: ${count} recorded`);
    } catch (err: any) {
      console.error('[cron] CLV snapshot failed:', err.message);
    }
  });

  // Resolve pending signals every 30 min (check if markets have settled)
  cron.schedule('*/30 * * * *', async () => {
    try {
      const result = await resolvePendingSignals();
      if (result.resolved > 0) {
        console.log(`[cron] Resolved ${result.resolved} signals: ${result.wins} wins, ${result.losses} losses`);
      }
    } catch (err: any) {
      console.error('[cron] Signal resolution failed:', err.message);
    }
  });

  // Update demo trade prices + resolve live copy-trade positions when market settles (every 10 min)
  cron.schedule('*/10 * * * *', async () => {
    try {
      await updateDemoTradePrices();
      await syncLiveResolutions();
    } catch (err: any) {
      console.error('[cron] Demo price / live resolution update failed:', err.message);
    }
  });

  // Exit stale positions: held too long at bad price, or market about to close (every 30 min)
  cron.schedule('*/30 * * * *', async () => {
    try {
      const exited = await syncStalePositions();
      if (exited > 0) console.log(`[cron] Stale exit: closed ${exited} positions`);
    } catch (err: any) {
      console.error('[cron] Stale exit failed:', err.message);
    }
  });

  // Take demo portfolio snapshot every hour
  cron.schedule('0 * * * *', async () => {
    try {
      await takeDemoSnapshot();
    } catch (err: any) {
      console.error('[cron] Demo snapshot failed:', err.message);
    }
  });

  // Oracle's Elixir 2026 CSV: публичный Drive + импорт (4×/сутки). Включить: ORACLE_ELIXIR_SYNC_ENABLED=1 (API не обязателен)
  cron.schedule('0 */6 * * *', async () => {
    if (process.env.ORACLE_ELIXIR_SYNC_ENABLED !== '1') return;
    try {
      console.log('[cron] Oracle Elixir 2026 Drive sync…');
      const r = await syncOracleElixir2026FromDrive();
      if (r.error) console.error('[cron] OE sync failed:', r.error);
      else if (r.importResult) {
        console.log(
          `[cron] OE sync OK: +${r.importResult.imported} games, skipped ${r.importResult.skipped}, errors ${r.importResult.errors} → ${r.destPath}`,
        );
      }
    } catch (err: any) {
      console.error('[cron] OE sync exception:', err?.message);
    }
  });
}

/**
 * Extract tokenId from the tags JSON array. Format: "tokenId:<id>"
 */
function extractTokenIdFromTags(tags: string): string | null {
  try {
    const arr = JSON.parse(tags || '[]');
    for (const t of arr) {
      if (typeof t === 'string' && t.startsWith('tokenId:')) return t.slice(8);
    }
  } catch {}
  return null;
}

export async function updateDemoTradePrices() {
  const openTrades = await (prisma as any).demoTrade.findMany({
    where: { status: 'OPEN' },
  });

  if (openTrades.length === 0) return;

  for (const trade of openTrades) {
    try {
      const isCopyTrade = !!trade.sourceWalletAddress;
      let currentPrice: number | null = null;
      let resolved = false;
      let resolvedWon = false;

      if (isCopyTrade) {
        const tokenId = extractTokenIdFromTags(trade.tags || '[]');
        if (tokenId) {
          const clobP = await getClobPrice(tokenId);
          if (clobP !== null) {
            currentPrice = clobP;
            if (clobP >= 0.995 || clobP <= 0.005) {
              resolved = true;
              resolvedWon = clobP >= 0.995;
            }
          } else {
            // null = orderbook removed → market settled; mark as resolved loss
            // (we can't determine win/loss without resolution data, but position is dead)
            resolved = true;
            resolvedWon = false;
            currentPrice = 0;
          }
        }
      }

      if (currentPrice === null) {
        const market = await gammaClient.getMarketById(trade.marketId).catch(() => null);
        if (market) {
          const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
          if (prices.length > 0) {
            const yesPrice = prices[0];
            const noPrice = prices[1] ?? (1 - yesPrice);
            currentPrice = trade.outcome === 'YES' ? yesPrice : noPrice;

            if (prices.some((p: number) => p >= 0.995)) {
              resolved = true;
              const wonOutcome = yesPrice >= 0.995 ? 'YES' : 'NO';
              resolvedWon = trade.outcome === wonOutcome;
            }
          }
        }
      }

      if (currentPrice === null) continue;

      if (resolved) {
        const finalPnl = resolvedWon ? trade.amount * (1 / trade.entryPrice - 1) : -trade.amount;
        const finalRoi = resolvedWon ? (1 / trade.entryPrice - 1) * 100 : -100;

        await (prisma as any).demoTrade.update({
          where: { id: trade.id },
          data: {
            currentPrice,
            exitPrice: currentPrice,
            pnl: finalPnl,
            roi: finalRoi,
            status: resolvedWon ? 'CLOSED_WIN' : 'CLOSED_LOSS',
            closedAt: new Date(),
          },
        });

        const balance = await getDemoBalance();
        await setDemoBalance(balance + trade.amount + finalPnl);
      } else {
        const pnl = (currentPrice - trade.entryPrice) * (trade.amount / trade.entryPrice);
        const roi = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

        await (prisma as any).demoTrade.update({
          where: { id: trade.id },
          data: { currentPrice, pnl, roi },
        });
      }
    } catch {
      // skip individual failures
    }
  }
}

/**
 * When a market resolves, Polymarket settles positions automatically — no SELL from source.
 * Mark open LiveTrade BUYs as CLOSED when CLOB price shows resolution (≥0.995 or ≤0.005).
 */
export async function syncLiveResolutions(): Promise<number> {
  const openBuys = await (prisma as any).liveTrade.findMany({
    where: { side: 'BUY', status: 'FILLED' },
  });
  if (openBuys.length === 0) return 0;

  let closed = 0;
  for (const trade of openBuys) {
    try {
      if (!trade.tokenId) continue;

      const price = await getClobPrice(trade.tokenId);

      // Close only when market is resolved (orderbook gone or price at 0/1). Do NOT auto-close "ghost"
      // when market is still tradeable — positions API can lag and we'd wrongly close real positions.
      const marketResolved = price === null || price >= 0.995 || price <= 0.005;
      if (marketResolved) {
        await (prisma as any).liveTrade.update({
          where: { id: trade.id },
          data: { status: 'CLOSED' },
        });
        closed++;
        const reason = price === null ? 'orderbook gone' : `price=${price?.toFixed(3)}`;
        console.log(`[cron] Live position resolved: ${trade.marketTitle?.slice(0, 45)} → CLOSED (${reason})`);
        continue;
      }

    } catch {
      // skip per-trade errors
    }
  }
  return closed;
}

async function takeDemoSnapshot() {
  const trades = await (prisma as any).demoTrade.findMany();
  const balance = await getDemoBalance();
  const openTrades = trades.filter((t: any) => t.status === 'OPEN');
  const invested = openTrades.reduce((s: number, t: any) => s + t.amount, 0);
  const unrealizedPnl = openTrades.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0);
  const realizedPnl = trades
    .filter((t: any) => t.status !== 'OPEN')
    .reduce((s: number, t: any) => s + (t.pnl ?? 0), 0);

  console.log(`[cron] Snapshot: balance=$${balance.toFixed(0)} open=${openTrades.length} pnl=$${(unrealizedPnl + realizedPnl).toFixed(0)}`);
}

export async function getDemoBalance(): Promise<number> {
  const row = await (prisma as any).demoBalance.findUnique({ where: { id: 'demo' } });
  return row?.balance ?? 10000;
}

export async function setDemoBalance(balance: number): Promise<void> {
  await (prisma as any).demoBalance.upsert({
    where: { id: 'demo' },
    update: { balance },
    create: { id: 'demo', balance },
  });
}

/**
 * Exit positions that are "stale" — held too long at a bad price, or market closing soon.
 *
 * Two triggers (per wallet settings):
 * 1. TIME+LOSS: position held > staleExitDays days AND current price < entry * (1 - staleExitLossPct/100)
 * 2. PRE-CLOSE: market endDate is within preCloseExitHours hours AND current price < entry price
 *
 * Both are configurable per-wallet and can be disabled (staleExitEnabled = false).
 */
export async function syncStalePositions(): Promise<number> {
  if (!isClobReady()) return 0;
  const regionOk = await isRegionAllowedForTrading();
  if (!regionOk) return 0;

  const openBuys = await (prisma as any).liveTrade.findMany({
    where: { side: 'BUY', status: 'FILLED', isTakeProfit: false },
  });
  if (!openBuys.length) return 0;

  // Load wallet settings keyed by walletAddress
  const wallets = await (prisma as any).copyWallet.findMany({
    where: { enabled: true, mode: 'live' },
  });
  const walletSettings: Record<string, any> = {};
  for (const w of wallets) walletSettings[w.walletAddress.toLowerCase()] = w;

  let exited = 0;
  const now = Date.now();

  for (const trade of openBuys) {
    try {
      const settings = walletSettings[(trade.sourceWalletAddress || '').toLowerCase()];
      if (!settings || !settings.staleExitEnabled) continue;

      const ageMs = now - new Date(trade.createdAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const endDate: Date | null = trade.marketEndDate ? new Date(trade.marketEndDate) : null;
      const hoursToClose = endDate ? (endDate.getTime() - now) / (1000 * 60 * 60) : Infinity;

      // Get current market price
      const currentPrice = await getClobPrice(trade.tokenId);
      if (currentPrice === null) continue; // market gone → syncLiveResolutions handles it

      const pricePct = currentPrice / trade.price; // e.g. 0.3 = price dropped 70%
      const lossThreshold = 1 - (settings.staleExitLossPct / 100); // e.g. 0.3 if lossPct=70

      const isTimeLoss = ageDays >= settings.staleExitDays && pricePct <= lossThreshold;
      const isPreClose = hoursToClose <= settings.preCloseExitHours && currentPrice < trade.price;

      if (!isTimeLoss && !isPreClose) continue;

      const reason = isPreClose
        ? `market closes in ${hoursToClose.toFixed(1)}h, price ${currentPrice.toFixed(3)} < entry ${trade.price.toFixed(3)}`
        : `held ${ageDays.toFixed(1)}d, price dropped ${((1 - pricePct) * 100).toFixed(0)}% (entry=${trade.price.toFixed(3)} now=${currentPrice.toFixed(3)})`;

      // Check free shares (not locked in pending sells)
      let sellSize = trade.size;
      const free = await getOwnFreePositionSize(trade.tokenId);
      if (free === 0) {
        await (prisma as any).liveTrade.update({ where: { id: trade.id }, data: { status: 'CLOSED', size: 0, usdcAmount: 0 } });
        exited++;
        console.log(`[stale-exit] Closed (no free shares): ${trade.marketTitle?.slice(0, 45)}`);
        continue;
      }
      if (free !== null) sellSize = free;

      if (sellSize < 5) {
        // Too small to sell — just close in DB
        await (prisma as any).liveTrade.update({ where: { id: trade.id }, data: { status: 'CLOSED', size: 0, usdcAmount: 0 } });
        exited++;
        console.log(`[stale-exit] Closed (tiny position, ${sellSize}sh): ${trade.marketTitle?.slice(0, 45)}`);
        continue;
      }

      console.log(`[stale-exit] SELLING: ${trade.marketTitle?.slice(0, 45)} — ${reason}`);
      const orderResult = await placeSellOrder(trade.tokenId, currentPrice, sellSize);

      const isMarketGone = !orderResult.success && orderResult.error &&
        (orderResult.error.toLowerCase().includes('does not exist') || orderResult.error.toLowerCase().includes('no orderbook'));

      if (orderResult.success || isMarketGone) {
        await (prisma as any).liveTrade.create({
          data: {
            sourceWalletAddress: trade.sourceWalletAddress,
            conditionId: trade.conditionId,
            tokenId: trade.tokenId,
            marketTitle: trade.marketTitle,
            outcome: trade.outcome,
            side: 'SELL',
            price: currentPrice,
            size: sellSize,
            usdcAmount: currentPrice * sellSize,
            orderId: orderResult.orderID || null,
            status: orderResult.success ? 'FILLED' : 'CLOSED',
            errorMessage: isMarketGone ? 'market resolved' : null,
          },
        });
        await (prisma as any).liveTrade.update({
          where: { id: trade.id },
          data: { status: 'CLOSED', size: 0, usdcAmount: 0 },
        });
        exited++;
        const pnl = ((currentPrice - trade.price) * sellSize).toFixed(2);
        console.log(`[stale-exit] SOLD: ${trade.marketTitle?.slice(0, 40)} ${sellSize}sh @ ${currentPrice.toFixed(3)} PnL=$${pnl} | reason: ${reason}`);
      } else {
        console.warn(`[stale-exit] SELL failed: ${trade.marketTitle?.slice(0, 40)} — ${orderResult.error}`);
      }
    } catch (e: any) {
      console.error(`[stale-exit] error for trade ${trade.id}: ${e.message}`);
    }
  }
  return exited;
}

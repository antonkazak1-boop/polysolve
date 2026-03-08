import cron from 'node-cron';
import { scanAnomalies } from '../clients/anomaly-detector';
import { generateRecommendations, invalidateRecommendationsCache } from './recommendation-engine';
import { generateSignals, invalidateSignalsCache } from './signal-engine';
import { resolvePendingSignals } from './signal-tracker';
import { scanWhaleActivity } from './whale-scanner';
import { snapshotPendingSignalPrices } from './signal-price-snapshot';
import prisma from '../config/database';
import { gammaClient, parseOutcomePrices } from '../clients/gamma-client';

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

  // Update demo trade prices every 10 min (was 3) — user can use "Refresh" on portfolio for instant update
  cron.schedule('*/10 * * * *', async () => {
    try {
      await updateDemoTradePrices();
    } catch (err: any) {
      console.error('[cron] Demo price update failed:', err.message);
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
}

export async function updateDemoTradePrices() {
  const openTrades = await (prisma as any).demoTrade.findMany({
    where: { status: 'OPEN' },
  });

  if (openTrades.length === 0) return;

  for (const trade of openTrades) {
    try {
      const market = await gammaClient.getMarketById(trade.marketId).catch(() => null);
      if (!market) continue;

      const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
      if (prices.length === 0) continue;

      // Use correct price for outcome: YES = prices[0], NO = prices[1] or (1 - YES)
      const yesPrice = prices[0];
      const noPrice = prices[1] ?? (1 - yesPrice);
      const currentPrice = trade.outcome === 'YES' ? yesPrice : noPrice;
      const pnl = (currentPrice - trade.entryPrice) * (trade.amount / trade.entryPrice);
      const roi = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

      // Check if market resolved (any side at 99.5%+)
      if (prices.some((p: number) => p >= 0.995)) {
        const wonOutcome = yesPrice >= 0.995 ? 'YES' : 'NO';
        const won = trade.outcome === wonOutcome;
        const finalPnl = won ? trade.amount * (1 / trade.entryPrice - 1) : -trade.amount;
        const finalRoi = won ? (1 / trade.entryPrice - 1) * 100 : -100;
        const exitPrice = trade.outcome === 'YES' ? yesPrice : noPrice;

        await (prisma as any).demoTrade.update({
          where: { id: trade.id },
          data: {
            currentPrice,
            exitPrice,
            pnl: finalPnl,
            roi: finalRoi,
            status: won ? 'CLOSED_WIN' : 'CLOSED_LOSS',
            closedAt: new Date(),
          },
        });

        // Adjust demo balance
        const balance = await getDemoBalance();
        await setDemoBalance(balance + trade.amount + finalPnl);
      } else {
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

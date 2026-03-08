import prisma from '../config/database';
import { gammaClient, parseOutcomePrices } from '../clients/gamma-client';

/**
 * Snapshots current market prices for all PENDING signals.
 * Called by cron every 15 min. Used later for CLV calculation on resolve.
 */
export async function snapshotPendingSignalPrices(): Promise<number> {
  const pending = await (prisma as any).signalRecord.findMany({
    where: { outcome: 'PENDING' },
    select: { id: true, marketId: true, side: true },
    take: 100,
  });

  if (pending.length === 0) return 0;

  // Dedupe market IDs to minimize API calls
  const marketIds: string[] = [...new Set<string>(pending.map((r: any) => r.marketId as string))];
  const priceMap = new Map<string, number[]>();

  for (const mid of marketIds) {
    try {
      const market = await gammaClient.getMarketById(mid).catch(() => null);
      if (!market) continue;
      const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
      if (prices.length > 0) priceMap.set(mid, prices);
    } catch { /* skip */ }
  }

  let saved = 0;
  const now = new Date();

  for (const record of pending) {
    const prices = priceMap.get(record.marketId);
    if (!prices) continue;

    const yesPrice = prices[0];
    const noPrice = prices[1] ?? (1 - yesPrice);
    const ourSidePrice = record.side === 'YES' ? yesPrice : noPrice;

    try {
      await (prisma as any).signalPriceSnapshot.create({
        data: {
          signalRecordId: record.id,
          ourSidePrice,
          snapshotAt: now,
        },
      });
      saved++;
    } catch { /* skip */ }
  }

  return saved;
}

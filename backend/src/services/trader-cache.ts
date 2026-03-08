import prisma from '../config/database';

const STALE_HOURS = 6; // re-fetch if cache is older than this

export interface CachedTraderStats {
  address: string;
  userName?: string;
  positionsCount: number;
  tradesCount: number;
  avgTradeSize: number;
  positions: any[];
  recentTrades: any[];
  fetchedAt: Date;
  isStale: boolean;
}

function isStale(updatedAt: Date): boolean {
  return (Date.now() - updatedAt.getTime()) > STALE_HOURS * 3600 * 1000;
}

/** Read from cache. Returns null if not cached at all. */
export async function readCache(address: string): Promise<CachedTraderStats | null> {
  const addr = address.toLowerCase();
  try {
    const row = await (prisma as any).traderCache.findUnique({ where: { address: addr } });
    if (!row) return null;
    return {
      address: row.address,
      userName: row.userName ?? undefined,
      positionsCount: row.positionsCount,
      tradesCount: row.tradesCount,
      avgTradeSize: row.avgTradeSize,
      positions: JSON.parse(row.positions || '[]'),
      recentTrades: JSON.parse(row.recentTrades || '[]'),
      fetchedAt: row.fetchedAt,
      isStale: isStale(row.updatedAt),
    };
  } catch {
    return null;
  }
}

/** Read stats-only fields for many addresses at once (for leaderboard enrichment). */
export async function readCacheBulk(addresses: string[]): Promise<Map<string, CachedTraderStats>> {
  const result = new Map<string, CachedTraderStats>();
  if (!addresses.length) return result;
  try {
    const rows = await (prisma as any).traderCache.findMany({
      where: { address: { in: addresses.map(a => a.toLowerCase()) } },
    });
    for (const row of rows) {
      result.set(row.address, {
        address: row.address,
        userName: row.userName ?? undefined,
        positionsCount: row.positionsCount,
        tradesCount: row.tradesCount,
        avgTradeSize: row.avgTradeSize,
        positions: [],        // skip heavy JSON for bulk reads
        recentTrades: [],
        fetchedAt: row.fetchedAt,
        isStale: isStale(row.updatedAt),
      });
    }
  } catch { /* ignore */ }
  return result;
}

/** Write (upsert) profile data to cache. Called after a full wallet profile is fetched. */
export async function writeCache(
  address: string,
  data: {
    userName?: string;
    positions: any[];
    recentTrades: any[];
    vol?: number;
  }
): Promise<void> {
  const addr = address.toLowerCase();
  try {
    const positionsCount = data.positions.filter(
      (p: any) => (parseFloat(p.size ?? '0') || 0) > 0.001 || (p.value ?? 0) > 0.01
    ).length;
    const tradesCount = data.recentTrades.length;
    const vol = data.vol ?? 0;
    const avgTradeSize = tradesCount > 0 && vol > 0 ? vol / tradesCount : 0;

    await (prisma as any).traderCache.upsert({
      where: { address: addr },
      update: {
        userName: data.userName ?? null,
        positionsCount,
        tradesCount,
        avgTradeSize,
        positions: JSON.stringify(data.positions.slice(0, 100)),
        recentTrades: JSON.stringify(data.recentTrades.slice(0, 100)),
        fetchedAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        address: addr,
        userName: data.userName ?? null,
        positionsCount,
        tradesCount,
        avgTradeSize,
        positions: JSON.stringify(data.positions.slice(0, 100)),
        recentTrades: JSON.stringify(data.recentTrades.slice(0, 100)),
        fetchedAt: new Date(),
      },
    });
  } catch (e: any) {
    console.error('[trader-cache] write error:', e.message);
  }
}

/** Update only stats fields from lightweight leaderboard data (no full positions/trades). */
export async function refreshCacheStats(
  address: string,
  data: { userName?: string; positionsCount: number; tradesCount: number; avgTradeSize: number }
): Promise<void> {
  const addr = address.toLowerCase();
  try {
    const existing = await (prisma as any).traderCache.findUnique({ where: { address: addr } });
    if (existing) {
      await (prisma as any).traderCache.update({
        where: { address: addr },
        data: {
          userName: data.userName ?? existing.userName,
          positionsCount: data.positionsCount,
          tradesCount: data.tradesCount,
          avgTradeSize: data.avgTradeSize,
          updatedAt: new Date(),
        },
      });
    }
    // If no existing record, skip — we only update, not create from stats alone
  } catch { /* ignore */ }
}

import { Router, Request, Response } from 'express';
import { gammaClient } from '../../clients/gamma-client';
import { readCacheBulk, writeCache } from '../../services/trader-cache';

export const leaderboardRouter = Router();

const ENRICH_N = 12; // enrich top-N traders from cache

// GET /api/leaderboard - trader leaderboard
// ?enrich=1 → attach positionsCount, tradesCount, avgTradeSize from local cache
// For top-ENRICH_N, also triggers background refresh if cache is stale / missing
leaderboardRouter.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 50);
    const offset = parseInt(req.query.offset as string) || 0;
    const startDate = req.query.startDate as string;
    const timePeriod = (req.query.timePeriod as any) || undefined;
    const orderBy = (req.query.orderBy as any) || 'PNL';
    const category = req.query.category as string | undefined;
    const enrich = req.query.enrich === '1' || req.query.enrich === 'true';

    let traders: any[] = await gammaClient.getTraderLeaderboard({ limit, offset, startDate, timePeriod, orderBy, category });

    if (enrich && traders.length > 0) {
      const getAddr = (t: any) => (t.proxyWallet || t.proxy_wallet_address || '').toLowerCase();
      const addresses = traders.slice(0, ENRICH_N).map(getAddr).filter(Boolean);

      // Read what we already have in cache (instant)
      const cached = await readCacheBulk(addresses);

      traders = traders.map((t: any, i: number) => {
        const a = getAddr(t);
        const c = a ? cached.get(a) : undefined;
        if (!c) return t;
        return {
          ...t,
          positionsCount: c.positionsCount,
          tradesCount: c.tradesCount,
          avgTradeSize: c.avgTradeSize,
          cacheStale: c.isStale,
        };
      });

      // Background: for top-ENRICH_N, refresh stale/missing cache entries (no await)
      setImmediate(async () => {
        const toRefresh = traders.slice(0, ENRICH_N).filter((t: any) => {
          const a = getAddr(t);
          const c = a ? cached.get(a) : undefined;
          return !c || c.isStale;
        });
        for (const t of toRefresh) {
          const a = getAddr(t);
          if (!a) continue;
          try {
            const [positions, trades] = await Promise.all([
              gammaClient.getWalletPositions(a).catch(() => []),
              gammaClient.getWalletTrades(a, 200).catch(() => []),
            ]);
            await writeCache(a, {
              userName: t.userName || undefined,
              positions,
              recentTrades: trades,
              vol: typeof t.vol === 'number' ? t.vol : 0,
            });
          } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 400)); // throttle
        }
      });
    }

    res.json({ traders, total: traders.length });
  } catch (error: any) {
    console.error('Error fetching leaderboard:', error.message);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// GET /api/leaderboard/:address/positions - wallet positions
leaderboardRouter.get('/:address/positions', async (req: Request, res: Response) => {
  try {
    const positions = await gammaClient.getWalletPositions(req.params.address);
    res.json({ positions });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

// GET /api/leaderboard/:address/trades - wallet trade history
leaderboardRouter.get('/:address/trades', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const trades = await gammaClient.getWalletTrades(req.params.address, limit);
    res.json({ trades });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
});

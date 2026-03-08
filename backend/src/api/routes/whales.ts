import { Router, Request, Response } from 'express';
import {
  scanWhaleActivity,
  getWhaleFeed,
  getWhaleStats,
  getWalletWhaleActivity,
  scanWalletActivity,
} from '../../services/whale-scanner';

export const whalesRouter = Router();

// GET /api/whales/feed — recent large trades
whalesRouter.get('/feed', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const minAmount = parseFloat(req.query.minAmount as string) || 10000;
    const pattern = req.query.pattern as string | undefined;
    const onlyTopTraders = req.query.topTraders === 'true';
    const walletAddress = req.query.wallet as string | undefined;

    const alerts = await getWhaleFeed({ limit, minAmount, pattern, onlyTopTraders, walletAddress });

    // Build unique trader list from the returned alerts
    const traderMap = new Map<string, { address: string; name: string | null; count: number; totalVolume: number }>();
    for (const a of alerts) {
      const key = a.walletAddress;
      if (!traderMap.has(key)) {
        traderMap.set(key, { address: key, name: a.walletName ?? null, count: 0, totalVolume: 0 });
      }
      const entry = traderMap.get(key)!;
      entry.count++;
      entry.totalVolume += a.amount;
    }
    const traders = [...traderMap.values()].sort((a, b) => b.totalVolume - a.totalVolume);

    // Enrich with hoursToResolution
    const enriched = alerts.map((a: any) => {
      if (a.tradedAt) {
        const tradedMs = new Date(a.tradedAt).getTime();
        const now = Date.now();
        // hoursToResolution: how many hours before "now" whale entered
        // Positive = whale entered X hours ago; more useful as "hours left" once we have endDate
        return { ...a, hoursAgo: Math.round((now - tradedMs) / 3600000 * 10) / 10 };
      }
      return a;
    });

    res.json({ alerts: enriched, total: enriched.length, traders });
  } catch (error: any) {
    console.error('Error fetching whale feed:', error.message);
    res.status(500).json({ error: 'Failed to fetch whale feed' });
  }
});

// GET /api/whales/stats — summary stats
whalesRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await getWhaleStats();
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch whale stats' });
  }
});

// POST /api/whales/scan — manually trigger global scan
whalesRouter.post('/scan', async (_req: Request, res: Response) => {
  try {
    const result = await scanWhaleActivity();
    res.json({ ok: true, ...result });
  } catch (error: any) {
    console.error('Error scanning whale activity:', error.message);
    res.status(500).json({ error: 'Failed to scan whale activity' });
  }
});

// GET /api/whales/wallet/:address — whale activity for a specific wallet
whalesRouter.get('/wallet/:address', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
    const result = await getWalletWhaleActivity(req.params.address, limit);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch wallet whale activity' });
  }
});

// POST /api/whales/wallet/:address/scan — scan a specific wallet for large trades
whalesRouter.post('/wallet/:address/scan', async (req: Request, res: Response) => {
  try {
    const alerts = await scanWalletActivity(req.params.address);
    res.json({ ok: true, found: alerts.length, alerts });
  } catch (error: any) {
    console.error('Error scanning wallet:', error.message);
    res.status(500).json({ error: 'Failed to scan wallet' });
  }
});

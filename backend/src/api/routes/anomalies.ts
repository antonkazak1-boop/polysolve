import { Router, Request, Response } from 'express';
import { scanAnomalies, AnomalyType } from '../../clients/anomaly-detector';
import { detectInsiders, getInsiderMarketSignals } from '../../clients/insider-detector';

export const anomaliesRouter = Router();

// Simple in-memory cache: scan is expensive (fetches 100 events)
let cache: { data: any; ts: number } | null = null;
let insiderCache: { data: any; ts: number } | null = null;
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// GET /api/anomalies
// Query params:
//   type    - comma-separated AnomalyType list
//   minScore - number 0-100 (default 20)
//   minLiquidity - number (default 5000)
//   limit   - number (default 100)
anomaliesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    const minScore = parseInt(req.query.minScore as string) || 20;
    const minLiquidity = parseInt(req.query.minLiquidity as string) || 5000;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const typeParam = req.query.type as string | undefined;
    const types = typeParam
      ? (typeParam.split(',').map(s => s.trim().toUpperCase()) as AnomalyType[])
      : undefined;

    // Use cache if fresh and no custom filters
    if (!typeParam && minScore === 20 && minLiquidity === 5000 && cache && now - cache.ts < CACHE_TTL) {
      return res.json(cache.data);
    }

    const anomalies = await scanAnomalies({ types, minScore, minLiquidity, limit });

    // Group by type for summary
    const summary: Record<string, number> = {};
    for (const a of anomalies) {
      summary[a.type] = (summary[a.type] ?? 0) + 1;
    }

    const result = {
      anomalies,
      total: anomalies.length,
      summary,
      scannedAt: new Date().toISOString(),
    };

    if (!typeParam && minScore === 20 && minLiquidity === 5000) {
      cache = { data: result, ts: now };
    }

    res.json(result);
  } catch (error: any) {
    console.error('Error scanning anomalies:', error.message);
    res.status(500).json({ error: 'Failed to scan anomalies', detail: error.message });
  }
});

// GET /api/anomalies/feed
// Lightweight quick feed — returns top anomalies sorted by score
anomaliesRouter.get('/feed', async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (cache && now - cache.ts < CACHE_TTL) {
      const top = (cache.data.anomalies as any[]).slice(0, 20);
      return res.json({ anomalies: top, scannedAt: cache.data.scannedAt });
    }

    const anomalies = await scanAnomalies({ minScore: 30, limit: 20 });
    res.json({ anomalies, scannedAt: new Date().toISOString() });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch anomaly feed' });
  }
});

// GET /api/anomalies/insiders
// Full insider detection (slow — fetches positions for top 50 wallets)
anomaliesRouter.get('/insiders', async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (insiderCache && now - insiderCache.ts < CACHE_TTL * 3) {
      return res.json(insiderCache.data);
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const signals = await detectInsiders(limit);

    const result = { signals, total: signals.length, scannedAt: new Date().toISOString() };
    insiderCache = { data: result, ts: now };
    res.json(result);
  } catch (error: any) {
    console.error('Error detecting insiders:', error.message);
    res.status(500).json({ error: 'Failed to detect insiders', detail: error.message });
  }
});

// GET /api/anomalies/insider-markets
// Fast version — just returns markets with insider-like patterns, no wallet lookup
anomaliesRouter.get('/insider-markets', async (req: Request, res: Response) => {
  try {
    const markets = await getInsiderMarketSignals();
    res.json({ markets, total: markets.length, scannedAt: new Date().toISOString() });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to get insider markets' });
  }
});

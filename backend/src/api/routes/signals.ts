import { Router, Request, Response } from 'express';
import { generateSignals, getSignalsByHorizon, invalidateSignalsCache, Horizon, getWeights, getDefaultWeights, setWeights, resetWeights, ScoringWeights } from '../../services/signal-engine';
import { getAccuracyStats, getSignalHistory, resolvePendingSignals } from '../../services/signal-tracker';

export const signalsRouter = Router();

const VALID_HORIZONS = ['fast', 'medium', 'long', 'all'] as const;

// GET /api/signals — fetch ranked trading signals
// Perplexity is always ON by default. Use ?skipNews=true for fast dev/debug mode.
signalsRouter.get('/', async (req: Request, res: Response) => {
  req.setTimeout(180000); // 3min — Perplexity batch can take time
  try {
    const horizon = (req.query.horizon as string) || 'all';
    if (!VALID_HORIZONS.includes(horizon as any)) {
      return res.status(400).json({ error: `Invalid horizon. Use: ${VALID_HORIZONS.join(', ')}` });
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
    const skipNews = req.query.skipNews === 'true';

    let allSignals = await generateSignals(skipNews);
    // If no signals with Perplexity, fallback to skipNews so user still sees something
    if (allSignals.length === 0 && !skipNews) {
      try {
        allSignals = await generateSignals(true);
      } catch { /* keep [] */ }
    }
    const filtered = getSignalsByHorizon(allSignals, horizon as Horizon | 'all', limit);

    const counts = {
      fast: allSignals.filter(s => s.horizon === 'fast').length,
      medium: allSignals.filter(s => s.horizon === 'medium').length,
      long: allSignals.filter(s => s.horizon === 'long').length,
      total: allSignals.length,
    };

    res.json({ signals: filtered, counts });
  } catch (error: any) {
    console.error('Error generating signals:', error.message);
    res.status(500).json({ error: 'Failed to generate signals' });
  }
});

// POST /api/signals/refresh — bust cache and regenerate (with Perplexity)
signalsRouter.post('/refresh', async (req: Request, res: Response) => {
  req.setTimeout(180000);
  try {
    invalidateSignalsCache();
    const skipNews = req.query.skipNews === 'true';
    const signals = await generateSignals(skipNews);
    const counts = {
      fast: signals.filter(s => s.horizon === 'fast').length,
      medium: signals.filter(s => s.horizon === 'medium').length,
      long: signals.filter(s => s.horizon === 'long').length,
      total: signals.length,
    };
    res.json({ ok: true, counts });
  } catch (error: any) {
    console.error('Error refreshing signals:', error.message);
    res.status(500).json({ error: 'Failed to refresh signals' });
  }
});

// GET /api/signals/accuracy — overall + per-horizon/category/confidenceLevel accuracy stats
signalsRouter.get('/accuracy', async (_req: Request, res: Response) => {
  try {
    const stats = await getAccuracyStats();
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching accuracy stats:', error.message);
    res.status(500).json({ error: 'Failed to fetch accuracy stats' });
  }
});

// GET /api/signals/history — paginated signal log
signalsRouter.get('/history', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const horizon = req.query.horizon as string | undefined;
    const outcome = req.query.outcome as string | undefined;
    const records = await getSignalHistory(limit, horizon, outcome);
    res.json({ records, total: records.length });
  } catch (error: any) {
    console.error('Error fetching signal history:', error.message);
    res.status(500).json({ error: 'Failed to fetch signal history' });
  }
});

// POST /api/signals/resolve — manually trigger resolution check
signalsRouter.post('/resolve', async (_req: Request, res: Response) => {
  try {
    const result = await resolvePendingSignals();
    res.json({ ok: true, ...result });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to resolve signals' });
  }
});

// GET /api/signals/weights — current scoring weights
signalsRouter.get('/weights', (_req: Request, res: Response) => {
  res.json({ weights: getWeights(), defaults: getDefaultWeights() });
});

// POST /api/signals/weights — update scoring weights (partial merge)
signalsRouter.post('/weights', (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<ScoringWeights>;
    const numericFields: (keyof ScoringWeights)[] = [
      'newsRelevance', 'newsSideBonus', 'newsTotal',
      'momentum', 'anomaly', 'volume', 'consensus', 'roiPotential',
      'numbersTotalCap', 'numbersOutputWeight',
      'generalPenalty', 'sportsPenalty', 'cryptoBoost', 'politicsBoost', 'economyBoost',
    ];
    const clean: Partial<ScoringWeights> = {};
    for (const key of numericFields) {
      if (key in body && typeof body[key] === 'number') {
        (clean as any)[key] = body[key];
      }
    }
    const updated = setWeights(clean);
    res.json({ ok: true, weights: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update weights' });
  }
});

// POST /api/signals/weights/reset — restore defaults
signalsRouter.post('/weights/reset', (_req: Request, res: Response) => {
  const restored = resetWeights();
  res.json({ ok: true, weights: restored });
});

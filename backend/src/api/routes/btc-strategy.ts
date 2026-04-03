import { Router, Request, Response } from 'express';
import { getBtcKlines, extractArrays, KlineInterval } from '../../clients/binance-client';
import { computeAll } from '../../services/indicators';
import { analyzeMarket, computeDirectionalBias, enhancedBinaryFairValue } from '../../services/btc-probability-model';
import { runBacktest, BacktestConfig } from '../../services/btc-backtest';
import { gammaClient, parseOutcomePrices } from '../../clients/gamma-client';
import { getCryptoPrices, getCoinBySymbol, parseCryptoPriceMarket, ParsedCryptoMarket } from '../../clients/coingecko-client';
import { getBtcAutoTrader } from '../../services/btc-auto-trader';
import { getPredictionTracker } from '../../services/btc-prediction-tracker';
import { authMiddleware } from '../../middleware/auth';
import { getClobClientForUser, getUserTradingAddress, userPlaceBuyOrder } from '../../clients/clob-registry';

export const btcStrategyRouter = Router();

const PRICE_NOTE_5M =
  'Open = Binance BTCUSDT official 5m candle OPEN (UTC grid); close = that candle CLOSE. Polymarket often uses Chainlink or another oracle — small gaps vs Binance/CoinGecko are normal.';

// ─── GET /indicators — raw indicator snapshot ───────────────────────────────

btcStrategyRouter.get('/indicators', async (_req: Request, res: Response) => {
  try {
    const interval = (_req.query.interval as KlineInterval) || '5m';
    const klines = await getBtcKlines(interval, 200);
    const { highs, lows, closes, volumes } = extractArrays(klines);

    const candleMinutes = intervalToMinutes(interval);
    const indicators = computeAll(highs, lows, closes, volumes, candleMinutes);

    res.json({
      interval,
      candles: klines.length,
      indicators,
      generatedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /prediction — BTC 5-min prediction with history ────────────────────

btcStrategyRouter.get('/prediction', async (_req: Request, res: Response) => {
  try {
    const tracker = getPredictionTracker();

    if (!tracker.isRunning()) await tracker.start();

    const historyDesc = await tracker.getHistoryFromDb(200);
    const current = historyDesc.find(p => !p.resolved) ?? tracker.getCurrent();
    const stats = await tracker.getStatsFromDb();

    res.json({
      current,
      history: historyDesc,
      stats,
      priceNote: PRICE_NOTE_5M,
      generatedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

btcStrategyRouter.get('/trading-status', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const clob = await getClobClientForUser(userId);
    if (!clob) {
      return res.json({ ready: false, error: 'Polymarket keys not saved. Go to Settings → Polymarket Keys to add them.', tradingAddress: null });
    }
    res.json({ ready: true, error: null, tradingAddress: getUserTradingAddress(clob) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

btcStrategyRouter.post('/markets/5min-order', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const clob = await getClobClientForUser(userId);
    if (!clob) {
      return res.status(503).json({ error: 'Polymarket keys not configured. Add them in Settings → Polymarket Keys.' });
    }

    const { marketId, side, usdAmount, maxPrice } = req.body || {};
    const mId = String(marketId || '').trim();
    const sd = String(side || '').toUpperCase();
    const usd = Number(usdAmount);

    if (!mId) return res.status(400).json({ error: 'marketId required' });
    if (sd !== 'YES' && sd !== 'NO') return res.status(400).json({ error: 'side must be YES or NO' });
    if (!Number.isFinite(usd) || usd < 1 || usd > 50_000) {
      return res.status(400).json({ error: 'usdAmount must be between 1 and 50000' });
    }

    const mkt = await gammaClient.getMarketById(mId);
    if (!mkt || !mkt.active || mkt.closed) {
      return res.status(400).json({ error: 'Market not active or not found' });
    }
    if (!mkt.acceptingOrders) return res.status(400).json({ error: 'Market not accepting orders' });

    const q = (mkt.question || '');
    if (!/\bbitcoin\b|\bbtc\b/i.test(q)) return res.status(400).json({ error: 'Quick trade is only for BTC markets' });

    const endMs = mkt.endDate ? new Date(mkt.endDate).getTime() : 0;
    const hoursLeft = (endMs - Date.now()) / 3600000;
    if (hoursLeft <= 0 || hoursLeft > 0.5) {
      return res.status(400).json({ error: 'Pick a market with ≤30m left' });
    }

    let tokenIds: string[] = [];
    try { tokenIds = JSON.parse(mkt.clobTokenIds || '[]'); } catch { /* empty */ }
    if (tokenIds.length < 2) return res.status(400).json({ error: 'Market has no CLOB token ids' });

    const prices = parseOutcomePrices(mkt.outcomePrices ?? '[]');
    if (prices.length < 2) return res.status(400).json({ error: 'Could not read outcome prices' });

    const tokenIdx = sd === 'YES' ? 0 : 1;
    const tokenId = tokenIds[tokenIdx];
    const mid = prices[tokenIdx];
    if (mid < 0.01 || mid > 0.99) return res.status(400).json({ error: 'Outcome price too extreme to quote safely' });

    const mp = maxPrice !== undefined && maxPrice !== null && maxPrice !== '' ? Number(maxPrice) : NaN;
    let limit = Math.min(mid + 0.04, 0.99);
    if (Number.isFinite(mp)) limit = Math.min(Math.max(mp, mid + 0.0005), 0.99);
    if (limit <= mid) limit = Math.min(mid + 0.02, 0.99);

    const result = await userPlaceBuyOrder(clob, tokenId, limit, usd);
    res.json({
      ...result,
      marketId: mId,
      side: sd,
      limitPrice: limit,
      midPrice: mid,
      question: mkt.question,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

btcStrategyRouter.post('/prediction/generate', async (_req: Request, res: Response) => {
  try {
    const tracker = getPredictionTracker();
    if (!tracker.isRunning()) await tracker.start();
    const pred = await tracker.generatePrediction();
    res.json({ prediction: pred, stats: await tracker.getStatsFromDb() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /scan — live edge scan on Polymarket BTC markets ───────────────────

btcStrategyRouter.get('/scan', async (_req: Request, res: Response) => {
  try {
    const interval = (_req.query.interval as KlineInterval) || '5m';
    const klines = await getBtcKlines(interval, 200);
    const { highs, lows, closes, volumes } = extractArrays(klines);
    const candleMinutes = intervalToMinutes(interval);
    const indicators = computeAll(highs, lows, closes, volumes, candleMinutes);

    const [events, cryptoPrices] = await Promise.all([
      gammaClient.getEvents({ limit: 200, active: true, closed: false, archived: false, order: 'volume24hr', ascending: false }),
      getCryptoPrices(),
    ]);

    const results: any[] = [];

    for (const event of events) {
      for (const market of event.markets ?? []) {
        if (!market.active || market.closed || !market.acceptingOrders) continue;

        const question = market.question ?? event.title ?? '';
        const parsed = parseCryptoPriceMarket(question);
        if (!parsed || parsed.coin !== 'bitcoin') continue;

        const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
        if (prices.length < 2 || prices.some(p => p < 0.005 || p > 0.995)) continue;

        const yesPrice = prices[0];
        const hoursLeft = market.endDate
          ? Math.max(0, (new Date(market.endDate).getTime() - Date.now()) / 3600000)
          : 168;

        if (hoursLeft <= 0) continue;

        const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
        if (liq < 500) continue;

        const analysis = analyzeMarket({
          spot: indicators.spot,
          strike: parsed.target,
          strikeHigh: parsed.targetHigh,
          direction: parsed.direction,
          hoursLeft,
          marketYesPrice: yesPrice,
          indicators,
        });

        const clobTokenIds = safeJsonParse(market.clobTokenIds);

        results.push({
          marketId: market.id,
          eventSlug: event.slug,
          question,
          strike: parsed.target,
          strikeHigh: parsed.targetHigh,
          direction: parsed.direction,
          spot: indicators.spot,
          hoursLeft: Math.round(hoursLeft * 10) / 10,
          marketYesPrice: yesPrice,
          clobTokenIds,
          liquidity: liq,
          volume24h: market.volume24hr ?? 0,
          ...analysis,
        });
      }
    }

    results.sort((a, b) => Math.abs(b.edgePct) - Math.abs(a.edgePct));

    const withEdge = results.filter(r => r.signal !== 'FAIR');

    res.json({
      spot: indicators.spot,
      interval,
      volatility: indicators.volatility,
      totalMarketsScanned: results.length,
      marketsWithEdge: withEdge.length,
      markets: results,
      indicators: {
        rsi14: indicators.rsi14,
        macd: indicators.macd,
        bollinger: indicators.bollinger,
        volatility: indicators.volatility,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /markets — raw BTC market quotes from Polymarket ───────────────────

btcStrategyRouter.get('/markets', async (_req: Request, res: Response) => {
  try {
    const events = await gammaClient.getEvents({
      limit: 300, active: true, closed: false, archived: false, order: 'volume24hr', ascending: false,
    });

    const btcMarkets: any[] = [];

    for (const event of events) {
      const title = (event.title ?? '').toLowerCase();
      const isBtcEvent = /\bbitcoin\b|\bbtc\b/i.test(title);

      for (const market of event.markets ?? []) {
        if (!market.active || market.closed) continue;

        const question = market.question ?? event.title ?? '';
        const qLower = question.toLowerCase();
        const isBtcMarket = isBtcEvent || /\bbitcoin\b|\bbtc\b/i.test(qLower);
        if (!isBtcMarket) continue;

        const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
        if (prices.length < 2) continue;
        if (prices.some(p => p < 0.003 || p > 0.997)) continue;

        const hoursLeft = market.endDate
          ? Math.max(0, (new Date(market.endDate).getTime() - Date.now()) / 3600000)
          : null;

        if (hoursLeft !== null && hoursLeft <= 0) continue;

        const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
        const clobTokenIds = safeJsonParse(market.clobTokenIds);
        const parsed = parseCryptoPriceMarket(question);

        let timeCategory: 'short' | 'medium' | 'long' = 'long';
        if (hoursLeft !== null) {
          if (hoursLeft <= 0.5) timeCategory = 'short';      // <= 30 min
          else if (hoursLeft <= 4) timeCategory = 'medium';   // <= 4 hours
        }

        btcMarkets.push({
          marketId: market.id,
          eventSlug: event.slug,
          eventTitle: event.title,
          question,
          yesPrice: prices[0],
          noPrice: prices[1] ?? (1 - prices[0]),
          spread: market.spread ?? null,
          bestBid: market.bestBid ?? null,
          bestAsk: market.bestAsk ?? null,
          hoursLeft: hoursLeft !== null ? Math.round(hoursLeft * 100) / 100 : null,
          timeCategory,
          expiryLabel: hoursLeft !== null ? formatHoursLeft(hoursLeft) : '?',
          liquidity: liq,
          volume24h: market.volume24hr ?? 0,
          oneDayChange: market.oneDayPriceChange ?? 0,
          acceptingOrders: market.acceptingOrders,
          clobTokenIds,
          hasParsedStrike: !!parsed,
          strike: parsed?.target ?? null,
          direction: parsed?.direction ?? null,
        });
      }
    }

    btcMarkets.sort((a, b) => {
      const catOrder = { short: 0, medium: 1, long: 2 };
      const ca = catOrder[a.timeCategory as keyof typeof catOrder] ?? 2;
      const cb = catOrder[b.timeCategory as keyof typeof catOrder] ?? 2;
      if (ca !== cb) return ca - cb;
      return (a.hoursLeft ?? 999) - (b.hoursLeft ?? 999);
    });

    res.json({
      total: btcMarkets.length,
      short: btcMarkets.filter(m => m.timeCategory === 'short').length,
      medium: btcMarkets.filter(m => m.timeCategory === 'medium').length,
      long: btcMarkets.filter(m => m.timeCategory === 'long').length,
      markets: btcMarkets,
      generatedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

function formatHoursLeft(h: number): string {
  if (h <= 0) return 'Expired';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

// ─── GET /markets/5min-history — active + resolved short-term BTC markets ──

btcStrategyRouter.get('/markets/5min-history', async (_req: Request, res: Response) => {
  try {
    // Fetch klines + indicators for model signals
    const klines = await getBtcKlines('5m', 200);
    const { highs, lows, closes, volumes } = extractArrays(klines);
    const indicators = computeAll(highs, lows, closes, volumes, 5);

    // Fetch both active AND recently closed events
    const [activeEvents, closedEvents] = await Promise.all([
      gammaClient.getEvents({
        limit: 300, active: true, closed: false, archived: false,
        order: 'volume24hr', ascending: false,
      }),
      gammaClient.getEvents({
        limit: 200, active: false, closed: true, archived: false,
        order: 'volume24hr', ascending: false,
      }),
    ]);

    const allEvents = [...activeEvents, ...closedEvents];
    const seenIds = new Set<string>();
    const btcShortMarkets: any[] = [];

    for (const event of allEvents) {
      const title = (event.title ?? '').toLowerCase();
      const isBtcEvent = /\bbitcoin\b|\bbtc\b/i.test(title);

      for (const market of event.markets ?? []) {
        if (seenIds.has(market.id)) continue;
        seenIds.add(market.id);

        const question = market.question ?? event.title ?? '';
        const qLower = question.toLowerCase();
        const isBtcMarket = isBtcEvent || /\bbitcoin\b|\bbtc\b/i.test(qLower);
        if (!isBtcMarket) continue;

        const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
        if (prices.length < 2) continue;

        const endMs = market.endDate ? new Date(market.endDate).getTime() : null;
        const hoursLeft = endMs
          ? (endMs - Date.now()) / 3600000
          : null;

        // 5-min/15-min "Bitcoin Up or Down" intraday markets:
        // identified by slug pattern "btc-updown-5m-" or time-range in title like "5:50PM-5:55PM"
        const is5MinMarket = /btc-updown-5m-|btc-updown-15m-/i.test(event.slug ?? '') ||
          /\d{1,2}:\d{2}(AM|PM)-\d{1,2}:\d{2}(AM|PM)/i.test(question);

        const isShortTerm = endMs !== null && (
          is5MinMarket
            ? (!market.closed || (hoursLeft !== null && hoursLeft > -6))
            : (
              (hoursLeft !== null && hoursLeft > 0 && hoursLeft <= 0.5) ||
              (market.closed && hoursLeft !== null && hoursLeft <= 0 && hoursLeft > -6)
            )
        );
        if (!isShortTerm) continue;

        const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
        const parsed = parseCryptoPriceMarket(question);

        let clobTokenIds: string[] = [];
        try { clobTokenIds = JSON.parse(market.clobTokenIds ?? '[]'); } catch { clobTokenIds = []; }

        // Determine outcome for closed markets
        let outcome: 'yes' | 'no' | null = null;
        if (market.closed && prices.length >= 2) {
          if (prices[0] > 0.9) outcome = 'yes';
          else if (prices[0] < 0.1) outcome = 'no';
        }

        // Compute model signal for every market that has a parseable strike
        let modelSignal: any = null;
        if (parsed && parsed.coin === 'bitcoin') {
          const marketHoursLeft = hoursLeft !== null && hoursLeft > 0 ? hoursLeft : 0.083;
          const yesPrice = prices[0];
          if (yesPrice > 0.005 && yesPrice < 0.995) {
            const analysis = analyzeMarket({
              spot: indicators.spot,
              strike: parsed.target,
              strikeHigh: parsed.targetHigh,
              direction: parsed.direction,
              hoursLeft: marketHoursLeft,
              marketYesPrice: yesPrice,
              indicators,
            });
            modelSignal = {
              signal: analysis.signal,
              edge: analysis.edgePct,
              fairValue: analysis.fairValue,
              strength: analysis.signalStrength,
              kelly: analysis.kellyFraction,
            };
          }
        }

        // For closed markets: check if model signal would have been correct
        let signalResult: 'win' | 'loss' | null = null;
        if (outcome && modelSignal && modelSignal.signal !== 'FAIR') {
          const predictedYes = modelSignal.signal === 'BUY_YES';
          const yesWon = outcome === 'yes';
          signalResult = (predictedYes === yesWon) ? 'win' : 'loss';
        }

        btcShortMarkets.push({
          marketId: market.id,
          conditionId: market.conditionId,
          eventSlug: event.slug,
          eventTitle: event.title,
          question,
          yesPrice: prices[0],
          noPrice: prices[1] ?? (1 - prices[0]),
          endTime: endMs,
          hoursLeft: hoursLeft !== null ? Math.round(hoursLeft * 1000) / 1000 : null,
          isActive: !market.closed && market.active && (hoursLeft ?? 0) > 0,
          isClosed: !!market.closed,
          isExpired: hoursLeft !== null && hoursLeft <= 0 && !market.closed,
          outcome,
          liquidity: liq,
          volume24h: market.volume24hr ?? 0,
          acceptingOrders: market.acceptingOrders,
          hasParsedStrike: !!parsed,
          strike: parsed?.target ?? null,
          direction: parsed?.direction ?? null,
          clobTokenIds,
          modelSignal,
          signalResult,
        });
      }
    }

    // Also attach auto-trader trade data where available
    const trader = getBtcAutoTrader();
    const trades = await trader.getRecentTrades(200);
    const tradesByMarket = new Map<string, any>();
    for (const t of trades) {
      if (t.status === 'placed' || t.status === 'dry_run') {
        tradesByMarket.set(t.marketId, {
          signal: t.signal,
          edge: t.edgePct,
          fairValue: t.fairValue,
          price: t.price,
          size: t.size,
          resolved: t.resolved,
          outcome: t.outcome,
          pnl: t.pnl,
          spotAtEntry: t.spotAtEntry,
        });
      }
    }

    for (const m of btcShortMarkets) {
      m.trade = tradesByMarket.get(m.marketId) ?? null;
    }

    // Sort: active first (by time remaining), then closed (most recent first)
    btcShortMarkets.sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      if (a.isActive && b.isActive) return (a.hoursLeft ?? 999) - (b.hoursLeft ?? 999);
      return (b.endTime ?? 0) - (a.endTime ?? 0);
    });

    // Win rate: count from model signals on resolved markets (not just auto-trader)
    const withModelSignal = btcShortMarkets.filter(m => m.signalResult !== null);
    const wins = withModelSignal.filter(m => m.signalResult === 'win').length;
    const losses = withModelSignal.filter(m => m.signalResult === 'loss').length;
    const totalResolved = wins + losses;

    res.json({
      total: btcShortMarkets.length,
      active: btcShortMarkets.filter(m => m.isActive).length,
      closed: btcShortMarkets.filter(m => m.isClosed).length,
      expired: btcShortMarkets.filter(m => m.isExpired).length,
      withSignal: btcShortMarkets.filter(m => m.modelSignal && m.modelSignal.signal !== 'FAIR').length,
      resolved: totalResolved,
      wins,
      losses,
      winRate: totalResolved > 0 ? wins / totalResolved : null,
      totalPnl: btcShortMarkets
        .filter(m => m.trade?.resolved)
        .reduce((s, m) => s + (m.trade?.pnl ?? 0), 0),
      btcSpot: indicators.spot,
      markets: btcShortMarkets,
      generatedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /backtest — run historical backtest ────────────────────────────────

btcStrategyRouter.get('/backtest', async (req: Request, res: Response) => {
  try {
    const interval = (req.query.interval as KlineInterval) || '5m';
    const limit = Math.min(parseInt(req.query.limit as string) || 500, 1000);
    const klines = await getBtcKlines(interval, limit);
    const candleMinutes = intervalToMinutes(interval);

    const config: Partial<BacktestConfig> = {};
    if (req.query.strikeOffset) config.strikeOffsetPct = parseFloat(req.query.strikeOffset as string);
    if (req.query.direction) config.direction = req.query.direction as 'above' | 'below';
    if (req.query.horizon) config.horizonCandles = parseInt(req.query.horizon as string);
    if (req.query.edgeThreshold) config.edgeThreshold = parseFloat(req.query.edgeThreshold as string);
    if (req.query.bankroll) config.startingBankroll = parseFloat(req.query.bankroll as string);

    const result = runBacktest(klines, candleMinutes, config);

    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /auto-trade — enable/disable auto-trading ─────────────────────────

btcStrategyRouter.post('/auto-trade', async (req: Request, res: Response) => {
  try {
    const trader = getBtcAutoTrader();
    const { action, config } = req.body;

    if (action === 'start') {
      await trader.start(config);
      res.json({ status: 'started', config: trader.getConfig() });
    } else if (action === 'stop') {
      trader.stop();
      res.json({ status: 'stopped' });
    } else {
      res.json({
        status: trader.isRunning() ? 'running' : 'stopped',
        config: trader.getConfig(),
        stats: await trader.getStats(),
      });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /auto-trade/status — get auto-trader status ────────────────────────

btcStrategyRouter.get('/auto-trade/status', async (_req: Request, res: Response) => {
  try {
    const trader = getBtcAutoTrader();
    const [stats, recentTrades] = await Promise.all([
      trader.getStats(),
      trader.getRecentTrades(50),
    ]);
    res.json({
      running: trader.isRunning(),
      config: trader.getConfig(),
      stats,
      recentTrades,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /auto-trade/performance — signal quality & PnL stats ─────────────

btcStrategyRouter.get('/auto-trade/performance', async (_req: Request, res: Response) => {
  try {
    const trader = getBtcAutoTrader();
    const [perf, trades] = await Promise.all([
      trader.getPerformance(),
      trader.getRecentTrades(200),
    ]);

    // Build equity curve from resolved trades
    const resolvedTrades = trades
      .filter(t => t.resolved && (t.status === 'placed' || t.status === 'dry_run'))
      .sort((a, b) => (a.resolvedAt ?? a.timestamp) - (b.resolvedAt ?? b.timestamp));

    let equity = 0;
    const equityCurve = resolvedTrades.map(t => {
      equity += t.pnl ?? 0;
      return {
        time: t.resolvedAt ?? t.timestamp,
        equity: Math.round(equity * 100) / 100,
        pnl: Math.round((t.pnl ?? 0) * 100) / 100,
        outcome: t.outcome,
        signal: t.signal,
        edge: t.edgePct,
        question: t.question?.slice(0, 60),
      };
    });

    // Edge buckets: how do trades with different edge ranges perform?
    const edgeBuckets: Record<string, { count: number; wins: number; totalPnl: number }> = {};
    for (const t of resolvedTrades) {
      const absEdge = Math.abs(t.edgePct);
      let bucket: string;
      if (absEdge < 5) bucket = '<5%';
      else if (absEdge < 10) bucket = '5-10%';
      else if (absEdge < 20) bucket = '10-20%';
      else bucket = '20%+';
      if (!edgeBuckets[bucket]) edgeBuckets[bucket] = { count: 0, wins: 0, totalPnl: 0 };
      edgeBuckets[bucket].count++;
      if (t.outcome === 'win') edgeBuckets[bucket].wins++;
      edgeBuckets[bucket].totalPnl += t.pnl ?? 0;
    }

    // Signal type breakdown
    const signalBreakdown = {
      buyYes: { total: 0, wins: 0, pnl: 0 },
      buyNo: { total: 0, wins: 0, pnl: 0 },
    };
    for (const t of resolvedTrades) {
      const key = t.signal === 'BUY_YES' ? 'buyYes' : 'buyNo';
      signalBreakdown[key].total++;
      if (t.outcome === 'win') signalBreakdown[key].wins++;
      signalBreakdown[key].pnl += t.pnl ?? 0;
    }

    res.json({
      performance: perf,
      equityCurve,
      edgeBuckets,
      signalBreakdown,
      generatedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function intervalToMinutes(interval: KlineInterval): number {
  const map: Record<KlineInterval, number> = { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
  return map[interval] || 5;
}

function safeJsonParse(s?: string): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

import { Router, Request, Response } from 'express';
import { gammaClient, parseOutcomePrices, parseOutcomes, calcPotentialRoi, isAsymmetricReturn } from '../../clients/gamma-client';
import { getCryptoPrices, parseCryptoPriceMarket, cryptoPriceReality, getCoinBySymbol } from '../../clients/coingecko-client';

export const marketsRouter = Router();

// A market is resolved/trivial if any price rounds to 0¢ or 100¢ when displayed
// (i.e., price < 0.5% or > 99.5%) — these are effectively decided
function isResolvedMarket(prices: number[]): boolean {
  if (prices.length === 0) return true;
  return prices.some(p => p < 0.005 || p > 0.995);
}

function formatEvent(event: any) {
  const allMarkets = (event.markets || []).map((m: any) => {
    const prices = parseOutcomePrices(m.outcomePrices || '[]');
    const outcomes = parseOutcomes(m.outcomes || '[]');
    const asymmetric = isAsymmetricReturn(prices);
    return {
      id: m.id,
      conditionId: m.conditionId,
      question: m.question,
      slug: m.slug,
      outcomes,
      prices,
      volume: m.volumeNum || parseFloat(m.volume || '0'),
      liquidity: m.liquidityNum || parseFloat(m.liquidity || '0'),
      lastTradePrice: m.lastTradePrice,
      bestBid: m.bestBid,
      bestAsk: m.bestAsk,
      oneDayPriceChange: m.oneDayPriceChange,
      oneWeekPriceChange: m.oneWeekPriceChange,
      endDate: m.endDate,
      acceptingOrders: m.acceptingOrders,
      closed: m.closed,
      clobTokenIds: m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [],
      spread: m.spread,
      groupItemTitle: m.groupItemTitle,
      potentialRoi: prices[0] ? calcPotentialRoi(prices[0]) : 0,
      isAsymmetric: asymmetric.isAsymmetric,
      bestRoi: asymmetric.bestRoi,
      bestOutcomeIndex: asymmetric.bestOutcome,
    };
  });

  // Filter out resolved markets (one side at 0 or 100¢)
  const markets = allMarkets.filter((m: any) => !isResolvedMarket(m.prices));

  const tags = (event.tags || []).map((t: any) => ({ id: t.id, label: t.label, slug: t.slug }));
  const allAsymmetric = markets.some((m: any) => m.isAsymmetric);
  const maxRoi = Math.max(0, ...markets.map((m: any) => m.bestRoi));

  return {
    id: event.id,
    slug: event.slug,
    ticker: event.ticker,
    title: event.title,
    description: event.description,
    image: event.image,
    icon: event.icon,
    startDate: event.startDate,
    endDate: event.endDate,
    active: event.active,
    closed: event.closed,
    featured: event.featured,
    restricted: event.restricted,
    liquidity: event.liquidity || event.liquidityClob || 0,
    volume: event.volume || 0,
    volume24hr: event.volume24hr || 0,
    volume1wk: event.volume1wk || 0,
    volume1mo: event.volume1mo || 0,
    openInterest: event.openInterest || 0,
    competitive: event.competitive || 0,
    commentCount: event.commentCount || 0,
    negRisk: event.negRisk || false,
    enableOrderBook: event.enableOrderBook,
    markets,
    tags,
    hasAsymmetricReturn: allAsymmetric,
    maxPotentialRoi: maxRoi,
  };
}

// GET /api/markets - list events from Gamma API
marketsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const tag_slug = req.query.tag as string;
    const order = (req.query.order as string) || 'volume24hr';
    const featured = req.query.featured === 'true' ? true : undefined;
    const closed = req.query.closed === 'true' ? true : false;

    const events = await gammaClient.getEvents({
      limit,
      offset,
      active: true,
      closed,
      archived: false,
      order,
      ascending: false,
      ...(tag_slug && tag_slug !== 'all' && { tag_slug }),
      ...(featured !== undefined && { featured }),
    });

    const formatted = events.map(formatEvent);

    res.json({
      events: formatted,
      total: formatted.length,
      limit,
      offset,
      hasMore: formatted.length === limit,
    });
  } catch (error: any) {
    console.error('Error fetching markets:', error.message);
    res.status(500).json({ error: 'Failed to fetch markets', detail: error.message });
  }
});

// GET /api/markets/asymmetric - legacy alias, redirects to /opportunities
marketsRouter.get('/asymmetric', (_req: Request, res: Response) => {
  res.redirect(307, '/api/markets/opportunities');
});

/**
 * GET /api/markets/opportunities
 *
 * Strategy: buy outcomes priced 4¢–20¢ on ACTIVE, LIQUID markets.
 * These are NOT dead outcomes (0–3¢) and NOT already likely (>20¢).
 *
 * Filters out:
 *  - "dead" outcomes: price < 4¢ (crowd thinks it's impossible)
 *  - No 24h volume (market is frozen)
 *  - No price movement in past week (nobody is trading it)
 *
 * Scores by:
 *  - Price momentum (recent upward movement = crowd changing mind)
 *  - Volume relative to liquidity (hot market)
 *  - ROI potential (lower price = higher upside)
 *  - Days until close (closer = more catalyst potential)
 */
marketsRouter.get('/opportunities', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const minPrice = parseFloat(req.query.minPrice as string) || 0.04; // 4¢ minimum
    const maxPrice = parseFloat(req.query.maxPrice as string) || 0.20; // 20¢ = 4x ROI min
    const minLiquidity = parseFloat(req.query.minLiquidity as string) || 2000;
    const minVolume24h = parseFloat(req.query.minVolume24h as string) || 500;

    const events = await gammaClient.getEvents({
      limit: 150,
      active: true,
      closed: false,
      archived: false,
      order: 'volume24hr',
      ascending: false,
    });

    const results: any[] = [];

    for (const event of events) {
      const formatted = formatEvent(event);
      if (!formatted.active || formatted.closed) continue;

      for (const market of formatted.markets) {
        if (!market.acceptingOrders) continue;

        const prices: number[] = market.prices || [];
        const outcomes: string[] = market.outcomes || [];

        for (let i = 0; i < prices.length; i++) {
          const price = prices[i];
          if (!price || price < minPrice || price > maxPrice) continue;

          // Skip if zero volume (dead market)
          const vol24 = market.volume || formatted.volume24hr || 0;
          if (vol24 < minVolume24h) continue;

          const liq = market.liquidity || formatted.liquidity || 0;
          if (liq < minLiquidity) continue;

          // Must have some price activity (not frozen)
          const hasActivity = (market.oneDayPriceChange !== undefined && market.oneDayPriceChange !== 0)
            || (market.oneWeekPriceChange !== undefined && market.oneWeekPriceChange !== 0)
            || vol24 > 5000;
          if (!hasActivity) continue;

          const potentialRoi = (1 / price - 1) * 100;

          // Score: momentum + volume activity + urgency
          const momentumScore = (market.oneDayPriceChange || 0) * 100; // positive if price rising
          const volumeScore = Math.min(30, Math.log10(vol24 + 1) * 7);
          const liquidityScore = Math.min(20, Math.log10(liq + 1) * 5);
          const urgencyScore = (() => {
            if (!market.endDate) return 0;
            const days = Math.ceil((new Date(market.endDate).getTime() - Date.now()) / 86400000);
            if (days <= 3) return 15;
            if (days <= 7) return 10;
            if (days <= 30) return 5;
            return 0;
          })();
          const priceScore = Math.min(25, (1 - price / maxPrice) * 25); // lower price = higher score

          const score = priceScore + volumeScore + liquidityScore + urgencyScore + momentumScore;

          results.push({
            eventId: formatted.id,
            eventTitle: formatted.title,
            eventSlug: formatted.slug,
            eventVolume24hr: formatted.volume24hr,
            tags: formatted.tags,
            liquidity: liq,
            score,
            market: {
              ...market,
              targetOutcomeIndex: i,
              targetOutcome: outcomes[i] ?? 'Yes',
              targetPrice: price,
              targetRoi: potentialRoi,
              oneDayPriceChange: market.oneDayPriceChange,
              oneWeekPriceChange: market.oneWeekPriceChange,
              // best* fields for backward compat
              bestRoi: potentialRoi,
              bestOutcomeIndex: i,
            },
          });
        }
      }
    }

    // Sort by composite score (not just ROI — avoids 1¢ dead traps)
    results.sort((a, b) => b.score - a.score);

    res.json({ opportunities: results.slice(0, limit), total: results.length });
  } catch (error: any) {
    console.error('Error fetching opportunities:', error.message);
    res.status(500).json({ error: 'Failed to fetch opportunities' });
  }
});

/**
 * GET /api/markets/scalp
 *
 * Scalp/Flip strategy: buy cheap, sell at 2x–3x WITHOUT waiting for resolution.
 * Works because Polymarket has an active CLOB orderbook — you can sell your position
 * any time at market price.
 *
 * Target: crypto/sports/prediction markets where price can move 2–3x quickly.
 * - Price 5¢–40¢ (wider range for flipping)
 * - Strong recent momentum (24h change > +3%)
 * - High volume relative to liquidity (active trading)
 * - Short to medium time horizon
 */
marketsRouter.get('/scalp', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
    const minPrice = parseFloat(req.query.minPrice as string) || 0.05;
    const maxPrice = parseFloat(req.query.maxPrice as string) || 0.40;
    const minMomentum = parseFloat(req.query.minMomentum as string) || 0.02; // 2% daily move

    const events = await gammaClient.getEvents({
      limit: 150,
      active: true,
      closed: false,
      archived: false,
      order: 'volume24hr',
      ascending: false,
    });

    const results: any[] = [];

    for (const event of events) {
      const formatted = formatEvent(event);
      if (!formatted.active || formatted.closed) continue;

      // Crypto/sports focus (but not exclusive)
      const tags = formatted.tags.map((t: any) => t.label?.toLowerCase() ?? '');
      const isCrypto = tags.some((t: string) => ['crypto', 'bitcoin', 'ethereum', 'defi', 'nft', 'solana', 'btc', 'eth'].includes(t));
      const isSports = tags.some((t: string) => ['sports', 'nfl', 'nba', 'soccer', 'football', 'tennis'].includes(t));
      const categoryBoost = isCrypto ? 20 : isSports ? 10 : 0;

      for (const market of formatted.markets) {
        if (!market.acceptingOrders) continue;

        const prices: number[] = market.prices || [];
        const outcomes: string[] = market.outcomes || [];

        for (let i = 0; i < prices.length; i++) {
          const price = prices[i];
          if (!price || price < minPrice || price > maxPrice) continue;

          const vol24 = market.volume || formatted.volume24hr || 0;
          if (vol24 < 1000) continue;

          const liq = market.liquidity || formatted.liquidity || 0;
          if (liq < 1000) continue;

          const dayChange = market.oneDayPriceChange || 0;
          const weekChange = market.oneWeekPriceChange || 0;

          // Must have real momentum (price is moving)
          if (Math.abs(dayChange) < minMomentum && Math.abs(weekChange) < minMomentum * 2) continue;

          // Scalp targets
          const target2x = Math.min(0.99, price * 2);
          const target3x = Math.min(0.99, price * 3);
          const roi2x = (target2x / price - 1) * 100;
          const roi3x = (target3x / price - 1) * 100;

          // Volume/liquidity ratio = how active this market is
          const volLiqRatio = liq > 0 ? vol24 / liq : 0;

          // Score: momentum + activity + category
          const momentumScore = Math.abs(dayChange) * 200 + Math.abs(weekChange) * 50;
          const activityScore = Math.min(40, volLiqRatio * 10);
          const priceScore = (1 - price / maxPrice) * 20;
          const score = momentumScore + activityScore + priceScore + categoryBoost;

          results.push({
            eventId: formatted.id,
            eventTitle: formatted.title,
            eventSlug: formatted.slug,
            eventVolume24hr: formatted.volume24hr,
            tags: formatted.tags,
            liquidity: liq,
            score,
            isCrypto,
            isSports,
            market: {
              ...market,
              targetOutcomeIndex: i,
              targetOutcome: outcomes[i] ?? 'Yes',
              targetPrice: price,
              target2x,
              target3x,
              roi2x,
              roi3x,
              dayChange,
              weekChange,
              volLiqRatio,
            },
          });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);

    res.json({ scalps: results.slice(0, limit), total: results.length });
  } catch (error: any) {
    console.error('Error fetching scalp opportunities:', error.message);
    res.status(500).json({ error: 'Failed to fetch scalp opportunities' });
  }
});

// GET /api/markets/crypto-prices — live BTC/ETH/SOL from CoinGecko
marketsRouter.get('/crypto-prices', async (_req: Request, res: Response) => {
  try {
    const prices = await getCryptoPrices();
    res.json({ prices, fetchedAt: new Date().toISOString() });
  } catch (error: any) {
    console.error('Error fetching crypto prices:', error.message);
    res.status(500).json({ error: 'Failed to fetch crypto prices' });
  }
});

// GET /api/markets/tags - get available tags
marketsRouter.get('/tags', async (_req: Request, res: Response) => {
  try {
    const tags = await gammaClient.getTags();
    res.json(tags);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// GET /api/markets/trending - trending by volume change
marketsRouter.get('/trending', async (_req: Request, res: Response) => {
  try {
    const events = await gammaClient.getEvents({
      limit: 20,
      active: true,
      closed: false,
      archived: false,
      order: 'volume24hr',
      ascending: false,
    });
    res.json(events.map(formatEvent));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch trending' });
  }
});

// GET /api/markets/:id - event or market by ID (id or slug)
marketsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    let event = await gammaClient.getEvent(req.params.id);
    if (!event) event = await gammaClient.getEventBySlug(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(formatEvent(event));
  } catch (error: any) {
    console.error('Error fetching market:', error.message);
    res.status(500).json({ error: 'Failed to fetch market' });
  }
});

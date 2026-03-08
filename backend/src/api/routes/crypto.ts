import { Router, Request, Response } from 'express';
import { gammaClient, parseOutcomePrices, parseOutcomes, GammaEvent, GammaMarket } from '../../clients/gamma-client';
import {
  getCryptoPrices,
  getCoinBySymbol,
  parseCryptoPriceMarket,
  binaryOptionFairValue,
  rangeBinaryFairValue,
  DEFAULT_VOLS,
  CoinPrice,
  ParsedCryptoMarket,
} from '../../clients/coingecko-client';

export const cryptoRouter = Router();

// ─── Types ──────────────────────────────────────────────────────────────────

interface CryptoMarketAnalysis {
  marketId: string;
  eventId: string;
  eventSlug: string;
  question: string;
  coin: string;
  symbol: string;

  // Spot data
  spotPrice: number;
  strike: number;
  strikeHigh?: number;
  direction: 'above' | 'below' | 'between';

  // Distance
  distancePct: number;
  distanceAbs: number;

  // Time
  hoursLeft: number;
  expiryLabel: string;

  // Market price (what Polymarket says)
  marketYesPrice: number;
  marketNoPrice: number;
  impliedProbMarket: number;

  // Fair value (our model)
  fairValue: number;
  edge: number; // fairValue - marketPrice (positive = underpriced YES)
  edgePct: number;
  signal: 'BUY_YES' | 'BUY_NO' | 'FAIR' | 'SKIP';
  signalStrength: 'strong' | 'moderate' | 'weak';

  // Risk/reward
  kellyFraction: number;
  expectedValue: number; // EV per $1 bet on the signaled side

  // Market metadata
  volume24h: number;
  liquidity: number;
  oneDayChange: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const MONTH_MAP: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseExpiryFromQuestion(question: string, marketEndDate?: string): { hoursLeft: number; label: string } {
  // Try market endDate first
  if (marketEndDate) {
    const ms = new Date(marketEndDate).getTime() - Date.now();
    if (ms > 0) {
      const hours = ms / 3600000;
      return { hoursLeft: hours, label: formatHoursLeft(hours) };
    }
  }

  const q = question.toLowerCase();

  // "on March 3" / "by March 3"
  const byOnMatch = q.match(/(?:by|on|before)\s+(\w+)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/);
  if (byOnMatch) {
    const mi = MONTH_MAP[byOnMatch[1]];
    if (mi !== undefined) {
      const day = parseInt(byOnMatch[2]);
      const year = byOnMatch[3] ? parseInt(byOnMatch[3]) : new Date().getFullYear();
      const deadline = new Date(year, mi, day, 23, 59, 0);
      const hours = Math.max(0, (deadline.getTime() - Date.now()) / 3600000);
      return { hoursLeft: hours, label: formatHoursLeft(hours) };
    }
  }

  // "February 23-March 1"
  const rangeMatch = q.match(/(\w+)\s+\d{1,2}\s*[-–]\s*(\w+)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/);
  if (rangeMatch) {
    const mi = MONTH_MAP[rangeMatch[2]] ?? MONTH_MAP[rangeMatch[1]];
    if (mi !== undefined) {
      const day = parseInt(rangeMatch[3]);
      const year = rangeMatch[4] ? parseInt(rangeMatch[4]) : new Date().getFullYear();
      const deadline = new Date(year, mi, day, 23, 59, 0);
      const hours = Math.max(0, (deadline.getTime() - Date.now()) / 3600000);
      return { hoursLeft: hours, label: formatHoursLeft(hours) };
    }
  }

  return { hoursLeft: 168, label: '~7d' }; // fallback
}

function formatHoursLeft(h: number): string {
  if (h <= 0) return 'Expired';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${Math.round(h)}h`;
  const days = Math.round(h / 24);
  return `${days}d`;
}

function computeEdgeSignal(edge: number, fairValue: number, marketPrice: number): {
  signal: CryptoMarketAnalysis['signal'];
  strength: CryptoMarketAnalysis['signalStrength'];
} {
  const absEdge = Math.abs(edge);
  const edgePct = marketPrice > 0 ? absEdge / marketPrice : 0;

  if (absEdge < 0.03 || edgePct < 0.05) return { signal: 'FAIR', strength: 'weak' };

  const signal: CryptoMarketAnalysis['signal'] = edge > 0 ? 'BUY_YES' : 'BUY_NO';
  const strength: CryptoMarketAnalysis['signalStrength'] =
    absEdge >= 0.15 || edgePct >= 0.30 ? 'strong' :
    absEdge >= 0.07 || edgePct >= 0.15 ? 'moderate' : 'weak';

  return { signal, strength };
}

function kellyFraction(prob: number, price: number): number {
  if (price <= 0 || price >= 1 || prob <= 0 || prob >= 1) return 0;
  const b = (1 / price) - 1; // odds
  const f = (prob * b - (1 - prob)) / b;
  return Math.max(0, Math.min(0.25, f)); // cap at 25%
}

// ─── Main endpoint ──────────────────────────────────────────────────────────

// GET /api/crypto — crypto binary options analysis
cryptoRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const [events, cryptoPrices] = await Promise.all([
      gammaClient.getEvents({ limit: 200, active: true, closed: false, archived: false, order: 'volume24hr', ascending: false }),
      getCryptoPrices(),
    ]);

    const analyses: CryptoMarketAnalysis[] = [];
    const seenMarkets = new Set<string>();

    for (const event of events) {
      for (const market of event.markets ?? []) {
        if (!market.active || market.closed || !market.acceptingOrders) continue;
        if (seenMarkets.has(market.id)) continue;

        const question = market.question ?? event.title ?? '';
        const parsed = parseCryptoPriceMarket(question);
        if (!parsed) continue;

        const coin = getCoinBySymbol(cryptoPrices, parsed.symbol);
        if (!coin) continue;

        const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
        if (prices.length < 2) continue;
        if (prices.some(p => p < 0.005 || p > 0.995)) continue; // resolved

        seenMarkets.add(market.id);

        const spot = coin.current_price;
        const vol = DEFAULT_VOLS[parsed.coin] ?? 0.60;
        const { hoursLeft, label: expiryLabel } = parseExpiryFromQuestion(question, market.endDate);

        // Compute fair value
        let fairVal: number;
        let distancePct: number;
        let distanceAbs: number;

        if (parsed.direction === 'between' && parsed.targetHigh) {
          fairVal = rangeBinaryFairValue(spot, parsed.target, parsed.targetHigh, hoursLeft, vol);
          const midTarget = (parsed.target + parsed.targetHigh) / 2;
          distancePct = Math.abs(spot - midTarget) / spot * 100;
          distanceAbs = Math.abs(spot - midTarget);
        } else if (parsed.direction === 'above') {
          fairVal = binaryOptionFairValue(spot, parsed.target, hoursLeft, vol, 'above');
          distancePct = ((parsed.target - spot) / spot) * 100;
          distanceAbs = parsed.target - spot;
        } else {
          fairVal = binaryOptionFairValue(spot, parsed.target, hoursLeft, vol, 'below');
          distancePct = ((spot - parsed.target) / spot) * 100;
          distanceAbs = spot - parsed.target;
        }

        const yesPrice = prices[0];
        const noPrice = prices[1] ?? (1 - yesPrice);
        const edge = fairVal - yesPrice;
        const edgePct = yesPrice > 0 ? (edge / yesPrice) * 100 : 0;

        const { signal, strength } = computeEdgeSignal(edge, fairVal, yesPrice);

        // EV calculation: bet on the signaled side
        const betPrice = signal === 'BUY_YES' ? yesPrice : signal === 'BUY_NO' ? noPrice : yesPrice;
        const betProb = signal === 'BUY_YES' ? fairVal : signal === 'BUY_NO' ? (1 - fairVal) : fairVal;
        const ev = betProb * (1 / betPrice - 1) - (1 - betProb); // per $1

        const kelly = signal !== 'FAIR' && signal !== 'SKIP'
          ? kellyFraction(betProb, betPrice)
          : 0;

        const vol24h = market.volume24hr ?? event.volume24hr ?? 0;
        const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');

        // Skip very illiquid or expired
        if (hoursLeft <= 0 || liq < 500) continue;

        analyses.push({
          marketId: market.id,
          eventId: event.id,
          eventSlug: event.slug ?? '',
          question,
          coin: parsed.coin,
          symbol: parsed.symbol,
          spotPrice: spot,
          strike: parsed.target,
          strikeHigh: parsed.targetHigh,
          direction: parsed.direction,
          distancePct,
          distanceAbs,
          hoursLeft,
          expiryLabel,
          marketYesPrice: yesPrice,
          marketNoPrice: noPrice,
          impliedProbMarket: yesPrice,
          fairValue: Math.round(fairVal * 1000) / 1000,
          edge: Math.round(edge * 1000) / 1000,
          edgePct: Math.round(edgePct * 10) / 10,
          signal,
          signalStrength: strength,
          kellyFraction: Math.round(kelly * 1000) / 1000,
          expectedValue: Math.round(ev * 1000) / 1000,
          volume24h: vol24h,
          liquidity: liq,
          oneDayChange: market.oneDayPriceChange ?? 0,
        });
      }
    }

    // Sort: strong edges first, then by absolute edge
    analyses.sort((a, b) => {
      const strengthOrder = { strong: 3, moderate: 2, weak: 1 };
      const sa = a.signal === 'FAIR' || a.signal === 'SKIP' ? 0 : strengthOrder[a.signalStrength];
      const sb = b.signal === 'FAIR' || b.signal === 'SKIP' ? 0 : strengthOrder[b.signalStrength];
      if (sa !== sb) return sb - sa;
      return Math.abs(b.edge) - Math.abs(a.edge);
    });

    // Summary stats
    const coins = cryptoPrices.map(c => ({
      coin: c.id,
      symbol: c.symbol,
      price: c.current_price,
      change24h: c.price_change_percentage_24h,
      change7d: c.price_change_percentage_7d,
      high24h: c.high_24h,
      low24h: c.low_24h,
    }));

    const totalMarkets = analyses.length;
    const withEdge = analyses.filter(a => a.signal === 'BUY_YES' || a.signal === 'BUY_NO');
    const strongEdge = withEdge.filter(a => a.signalStrength === 'strong');

    res.json({
      coins,
      markets: analyses,
      summary: {
        totalMarkets,
        marketsWithEdge: withEdge.length,
        strongEdge: strongEdge.length,
        avgEdge: withEdge.length > 0
          ? Math.round(withEdge.reduce((s, a) => s + Math.abs(a.edgePct), 0) / withEdge.length * 10) / 10
          : 0,
      },
      model: {
        type: 'Log-normal random walk (Black-Scholes digital)',
        vols: DEFAULT_VOLS,
        note: 'Fair values are estimates. Real vol may differ. Use as directional guide, not absolute truth.',
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error in crypto analysis:', error.message);
    res.status(500).json({ error: 'Failed to analyze crypto markets' });
  }
});

// GET /api/crypto/prices — just the coin prices
cryptoRouter.get('/prices', async (_req: Request, res: Response) => {
  try {
    const prices = await getCryptoPrices();
    res.json({
      prices: prices.map(c => ({
        coin: c.id,
        symbol: c.symbol,
        price: c.current_price,
        change24h: c.price_change_percentage_24h,
        change7d: c.price_change_percentage_7d,
        high24h: c.high_24h,
        low24h: c.low_24h,
      })),
      fetchedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

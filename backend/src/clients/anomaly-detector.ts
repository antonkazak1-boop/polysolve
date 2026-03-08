import { gammaClient, parseOutcomePrices, parseOutcomes, calcPotentialRoi, GammaEvent, GammaMarket } from './gamma-client';

export type AnomalyType =
  | 'PRICE_SPIKE'
  | 'VOLUME_SURGE'
  | 'INSIDER_SIGNAL'
  | 'SMART_MONEY'
  | 'CLOSING_SPIKE'
  | 'REVERSAL';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Anomaly {
  id: string;
  type: AnomalyType;
  severity: Severity;
  score: number;
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  marketId: string;
  marketQuestion: string;
  prices: number[];
  outcomes: string[];
  oneDayChange: number;
  oneWeekChange: number;
  volume24h: number;
  liquidity: number;
  tags: string[];
  daysUntilClose?: number;
  potentialRoi?: number;
  reasoning: string;
  detectedAt: string;
}

// --- thresholds ---
const PRICE_SPIKE_THRESHOLD = 0.05;        // 5% 1-day move
const VOLUME_SURGE_RATIO = 0.8;            // volume24h / liquidity
const INSIDER_PRICE_CAP = 0.25;            // low-price side
const INSIDER_MOVE_MIN = 0.04;             // moved at least 4% in 24h
const SMART_MONEY_COMPETITIVE = 0.6;       // competitive < 0.6 = lopsided
const CLOSING_DAYS = 14;                   // closing within 14 days
const MIN_LIQUIDITY = 1_000;               // lower min for smaller markets

function severity(score: number): Severity {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

function daysUntil(dateStr: string): number | undefined {
  if (!dateStr) return undefined;
  const ms = new Date(dateStr).getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

function liqScore(liq: number): number {
  // log scale: $10k=30, $100k=50, $1M=70, $10M=90
  return Math.min(90, Math.max(0, (Math.log10(Math.max(liq, 1)) - 3) * 20 + 30));
}

// ─── detector functions, each returns Anomaly | null per market ─────────────

function detectPriceSpike(event: GammaEvent, market: GammaMarket, prices: number[]): Anomaly | null {
  const change = market.oneDayPriceChange ?? 0;
  const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
  if (Math.abs(change) < PRICE_SPIKE_THRESHOLD || liq < MIN_LIQUIDITY) return null;

  const absChange = Math.abs(change);
  // score: change magnitude * liquidity weight
  const changeScore = Math.min(60, (absChange / 0.40) * 60);
  const score = Math.round(changeScore * 0.6 + liqScore(liq) * 0.4);

  const direction = change > 0 ? 'surged' : 'dropped';
  const pct = (absChange * 100).toFixed(1);
  return {
    id: `spike-${market.id}`,
    type: 'PRICE_SPIKE',
    severity: severity(score),
    score,
    eventId: event.id,
    eventTitle: event.title,
    eventSlug: event.slug,
    marketId: market.id,
    marketQuestion: market.question,
    prices,
    outcomes: parseOutcomes(market.outcomes),
    oneDayChange: change,
    oneWeekChange: market.oneWeekPriceChange ?? 0,
    volume24h: market.volume24hr ?? (event.volume24hr || 0),
    liquidity: liq,
    tags: event.tags.map(t => t.label),
    daysUntilClose: daysUntil(market.endDate),
    potentialRoi: prices[0] > 0 && prices[0] < 1 ? calcPotentialRoi(Math.min(...prices.filter(p => p > 0))) : undefined,
    reasoning: `YES price ${direction} ${pct}% in 24h — crowd is repricing rapidly. Liquidity: $${(liq / 1000).toFixed(0)}K.`,
    detectedAt: new Date().toISOString(),
  };
}

function detectVolumeSurge(event: GammaEvent, market: GammaMarket, prices: number[]): Anomaly | null {
  const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
  const vol24 = market.volume24hr ?? event.volume24hr ?? 0;
  if (liq < MIN_LIQUIDITY || vol24 <= 0) return null;

  const ratio = vol24 / liq;
  if (ratio < VOLUME_SURGE_RATIO) return null;

  const ratioScore = Math.min(60, (ratio / 5) * 60);
  const score = Math.round(ratioScore * 0.55 + liqScore(liq) * 0.45);

  return {
    id: `vol-${market.id}`,
    type: 'VOLUME_SURGE',
    severity: severity(score),
    score,
    eventId: event.id,
    eventTitle: event.title,
    eventSlug: event.slug,
    marketId: market.id,
    marketQuestion: market.question,
    prices,
    outcomes: parseOutcomes(market.outcomes),
    oneDayChange: market.oneDayPriceChange ?? 0,
    oneWeekChange: market.oneWeekPriceChange ?? 0,
    volume24h: vol24,
    liquidity: liq,
    tags: event.tags.map(t => t.label),
    daysUntilClose: daysUntil(market.endDate),
    reasoning: `24h volume ($${(vol24 / 1000).toFixed(0)}K) is ${ratio.toFixed(1)}x the available liquidity ($${(liq / 1000).toFixed(0)}K). Unusual trading interest — possible news-driven activity.`,
    detectedAt: new Date().toISOString(),
  };
}

function detectInsiderSignal(event: GammaEvent, market: GammaMarket, prices: number[]): Anomaly | null {
  const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
  const vol24 = market.volume24hr ?? event.volume24hr ?? 0;
  const change = market.oneDayPriceChange ?? 0;
  if (liq < MIN_LIQUIDITY) return null;

  // Find if any outcome has a low price that moved significantly upward
  const hasInsiderPattern = prices.some((p, i) => {
    const prevApprox = p - change; // rough approximation of yesterday's price
    return p < INSIDER_PRICE_CAP && prevApprox < p && change > INSIDER_MOVE_MIN;
  });

  if (!hasInsiderPattern) return null;

  const moveScore = Math.min(40, (change / 0.30) * 40);
  const volScore = Math.min(30, Math.log10(Math.max(vol24, 1)) * 5);
  const score = Math.round(moveScore + volScore + liqScore(liq) * 0.3);

  const lowPriceIdx = prices.reduce((best, p, i) => (p < INSIDER_PRICE_CAP && p > 0 ? (p < prices[best] ? i : best) : best), 0);
  const lowPrice = prices[lowPriceIdx];
  const roi = calcPotentialRoi(lowPrice);

  return {
    id: `insider-${market.id}`,
    type: 'INSIDER_SIGNAL',
    severity: severity(score),
    score,
    eventId: event.id,
    eventTitle: event.title,
    eventSlug: event.slug,
    marketId: market.id,
    marketQuestion: market.question,
    prices,
    outcomes: parseOutcomes(market.outcomes),
    oneDayChange: change,
    oneWeekChange: market.oneWeekPriceChange ?? 0,
    volume24h: vol24,
    liquidity: liq,
    tags: event.tags.map(t => t.label),
    daysUntilClose: daysUntil(market.endDate),
    potentialRoi: roi,
    reasoning: `Low-probability outcome (${(lowPrice * 100).toFixed(0)}¢) rose ${(change * 100).toFixed(1)}% in 24h with high volume. Pattern consistent with informed buying before news — potential ROI if resolves: +${roi.toFixed(0)}%.`,
    detectedAt: new Date().toISOString(),
  };
}

function detectSmartMoney(event: GammaEvent, market: GammaMarket, prices: number[]): Anomaly | null {
  const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
  if (liq < MIN_LIQUIDITY) return null;

  // lopsided market (competitive < 0.5) with significant movement
  const competitive = event.competitive ?? 1;
  if (competitive >= SMART_MONEY_COMPETITIVE) return null;

  const change = market.oneDayPriceChange ?? 0;
  if (Math.abs(change) < 0.04) return null;

  // One side has > 80% probability
  const dominantPrice = Math.max(...prices);
  if (dominantPrice < 0.75) return null;

  const lopsidedScore = Math.min(40, (1 - competitive) / 0.5 * 40);
  const moveScore = Math.min(30, (Math.abs(change) / 0.20) * 30);
  const score = Math.round(lopsidedScore + moveScore + liqScore(liq) * 0.3);

  const dominantIdx = prices.indexOf(dominantPrice);
  const outcomes = parseOutcomes(market.outcomes);
  const dominantOutcome = outcomes[dominantIdx] ?? 'Yes';

  return {
    id: `smart-${market.id}`,
    type: 'SMART_MONEY',
    severity: severity(score),
    score,
    eventId: event.id,
    eventTitle: event.title,
    eventSlug: event.slug,
    marketId: market.id,
    marketQuestion: market.question,
    prices,
    outcomes,
    oneDayChange: change,
    oneWeekChange: market.oneWeekPriceChange ?? 0,
    volume24h: market.volume24hr ?? 0,
    liquidity: liq,
    tags: event.tags.map(t => t.label),
    daysUntilClose: daysUntil(market.endDate),
    reasoning: `Market is heavily lopsided: "${dominantOutcome}" at ${(dominantPrice * 100).toFixed(0)}¢ (competitive score: ${(competitive * 100).toFixed(0)}%). Smart money has clearly staked one side — moved ${(Math.abs(change) * 100).toFixed(1)}% in 24h.`,
    detectedAt: new Date().toISOString(),
  };
}

function detectClosingSpike(event: GammaEvent, market: GammaMarket, prices: number[]): Anomaly | null {
  const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
  if (liq < MIN_LIQUIDITY) return null;

  const days = daysUntil(market.endDate);
  if (days === undefined || days > CLOSING_DAYS || days < 0) return null;

  const change = market.oneDayPriceChange ?? 0;
  const vol24 = market.volume24hr ?? event.volume24hr ?? 0;
  // Trigger if: closing soon with ANY price move, OR closing very soon (≤3 days) with volume
  const hasMove = Math.abs(change) >= 0.03;
  const isUrgent = days <= 3 && vol24 > liq * 0.5;
  if (!hasMove && !isUrgent) return null;

  const urgencyScore = Math.min(40, ((CLOSING_DAYS - days) / CLOSING_DAYS) * 40);
  const moveScore = Math.min(40, (Math.abs(change) / 0.20) * 40);
  const volScore = isUrgent ? Math.min(20, (vol24 / liq) * 5) : 0;
  const score = Math.round(urgencyScore * 0.5 + moveScore * 0.3 + liqScore(liq) * 0.1 + volScore * 0.1);

  const direction = change > 0 ? 'rising' : change < 0 ? 'falling' : 'flat';

  return {
    id: `closing-${market.id}`,
    type: 'CLOSING_SPIKE',
    severity: severity(score),
    score,
    eventId: event.id,
    eventTitle: event.title,
    eventSlug: event.slug,
    marketId: market.id,
    marketQuestion: market.question,
    prices,
    outcomes: parseOutcomes(market.outcomes),
    oneDayChange: change,
    oneWeekChange: market.oneWeekPriceChange ?? 0,
    volume24h: market.volume24hr ?? 0,
    liquidity: liq,
    tags: event.tags.map(t => t.label),
    daysUntilClose: days,
    reasoning: `Closes in ${days} day${days === 1 ? '' : 's'} — price ${direction === 'flat' ? 'stable' : `${direction} ${(Math.abs(change) * 100).toFixed(1)}%`} in 24h${isUrgent ? ' with high volume' : ''}. Late-stage — final pricing window.`,
    detectedAt: new Date().toISOString(),
  };
}

function detectReversal(event: GammaEvent, market: GammaMarket, prices: number[]): Anomaly | null {
  const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
  if (liq < MIN_LIQUIDITY) return null;

  const day = market.oneDayPriceChange ?? 0;
  const week = market.oneWeekPriceChange ?? 0;

  // Opposite directions AND both significant
  if (Math.abs(day) < 0.03 || Math.abs(week) < 0.04) return null;
  if (Math.sign(day) === Math.sign(week) || day === 0 || week === 0) return null;

  const dayScore = Math.min(35, (Math.abs(day) / 0.25) * 35);
  const weekScore = Math.min(35, (Math.abs(week) / 0.25) * 35);
  const score = Math.round(dayScore + weekScore + liqScore(liq) * 0.3);

  const weekDir = week > 0 ? 'up' : 'down';
  const dayDir = day > 0 ? 'up' : 'down';

  return {
    id: `reversal-${market.id}`,
    type: 'REVERSAL',
    severity: severity(score),
    score,
    eventId: event.id,
    eventTitle: event.title,
    eventSlug: event.slug,
    marketId: market.id,
    marketQuestion: market.question,
    prices,
    outcomes: parseOutcomes(market.outcomes),
    oneDayChange: day,
    oneWeekChange: week,
    volume24h: market.volume24hr ?? 0,
    liquidity: liq,
    tags: event.tags.map(t => t.label),
    daysUntilClose: daysUntil(market.endDate),
    reasoning: `Trend reversal: market was ${weekDir} ${(Math.abs(week) * 100).toFixed(1)}% this week but flipped ${dayDir} ${(Math.abs(day) * 100).toFixed(1)}% today. Crowd changing its mind — high uncertainty.`,
    detectedAt: new Date().toISOString(),
  };
}

// ─── main scanner ────────────────────────────────────────────────────────────

export interface ScanOptions {
  types?: AnomalyType[];
  minScore?: number;
  minLiquidity?: number;
  limit?: number;
}

export async function scanAnomalies(opts: ScanOptions = {}): Promise<Anomaly[]> {
  const {
    types,
    minScore = 20,
    minLiquidity = MIN_LIQUIDITY,
    limit = 200,
  } = opts;

  // Fetch events from multiple sort orders + offsets to catch different anomaly types
  const [byVolume, byVolume2, byLiquidity, byStartDate] = await Promise.allSettled([
    gammaClient.getEvents({ limit: 100, active: true, closed: false, archived: false, order: 'volume24hr', ascending: false }),
    gammaClient.getEvents({ limit: 100, active: true, closed: false, archived: false, order: 'volume24hr', ascending: false, offset: 100 }),
    gammaClient.getEvents({ limit: 50, active: true, closed: false, archived: false, order: 'liquidity', ascending: false }),
    gammaClient.getEvents({ limit: 50, active: true, closed: false, archived: false, order: 'startDate', ascending: false }),
  ]);

  // Deduplicate events by id
  const eventMap = new Map<string, GammaEvent>();
  for (const result of [byVolume, byVolume2, byLiquidity, byStartDate]) {
    if (result.status === 'fulfilled') {
      for (const e of result.value) eventMap.set(e.id, e);
    }
  }
  const events = Array.from(eventMap.values());

  const anomalies: Anomaly[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    for (const market of event.markets ?? []) {
      if (!market.active || market.closed) continue;

      const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
      if (liq < minLiquidity) continue;

      const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
      if (prices.length === 0) continue;
      // Skip markets where a price rounds to 0¢ or 100¢ (effectively resolved)
      if (prices.some(p => p < 0.005 || p > 0.995)) continue;

      const detectors = [
        detectPriceSpike,
        detectVolumeSurge,
        detectInsiderSignal,
        detectSmartMoney,
        detectClosingSpike,
        detectReversal,
      ];

      for (const detect of detectors) {
        const anomaly = detect(event, market, prices);
        if (!anomaly) continue;
        if (anomaly.score < minScore) continue;
        if (types && !types.includes(anomaly.type)) continue;
        if (seen.has(anomaly.id)) continue;
        seen.add(anomaly.id);
        anomalies.push(anomaly);
      }
    }
  }

  anomalies.sort((a, b) => b.score - a.score);
  return anomalies.slice(0, limit);
}

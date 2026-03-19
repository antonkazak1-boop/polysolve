import { gammaClient, parseOutcomePrices, parseOutcomes, calcPotentialRoi, GammaEvent, GammaMarket } from '../clients/gamma-client';
import { scanAnomalies, Anomaly, AnomalyType } from '../clients/anomaly-detector';
import { analyzeMarketsBatch, MarketAnalysis, MarketCandidate } from '../clients/perplexity-client';
import { getCryptoPrices, getCoinBySymbol, parseCryptoPriceMarket, cryptoPriceReality, CoinPrice } from '../clients/coingecko-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Horizon = 'fast' | 'medium' | 'long';
export type Side = 'YES' | 'NO';
export type ConfidenceLevel = 'strong' | 'good' | 'speculative';

export interface CryptoContext {
  coin: string;
  symbol: string;
  currentPrice: number;
  target: number;
  direction: 'above' | 'below';
  distancePct: number;
  impliedMove: string;
  isRealistic: boolean;
}

export interface Signal {
  id: string;
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  marketId: string;
  marketQuestion: string;
  side: Side;
  horizon: Horizon;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  entryPrice: number;
  potentialRoi: number;
  roiMultiple: number;
  volume24h: number;
  liquidity: number;
  daysUntilClose: number | null;
  oneDayChange: number;
  oneWeekChange: number;
  prices: number[];
  outcomes: string[];
  tags: string[];
  category: string;
  reasons: string[];
  anomalyTypes: AnomalyType[];
  crypto?: CryptoContext;
  news?: { summary: string; sentiment: string; relevance: number };
  filtered?: { reason: string };
  correlationWarning?: string;
  marketEfficiency?: number;
  suggestedStakePct?: number;
  generatedAt: string;
}

// ─── Configurable Scoring Weights ────────────────────────────────────────────

export interface ScoringWeights {
  // Perplexity / news scoring
  newsRelevance: number;      // how much relevance contributes (maps 0-100 → 0-N)
  newsSideBonus: number;      // max bonus when Perplexity side matches numerical side
  newsTotal: number;          // cap for total perplexity score

  // Numerical scoring components
  momentum: number;           // max pts from |dayChange|
  anomaly: number;            // max pts from anomaly score
  volume: number;             // max pts from 24h volume
  consensus: number;          // max pts from vote consensus
  roiPotential: number;       // max pts from entry-price ROI asymmetry

  // Overall mixing
  numbersTotalCap: number;    // cap for total numbers score
  numbersOutputWeight: number; // how much numbers contribute to final confidence (out of 100)

  // Category modifiers applied to final confidence
  generalPenalty: number;     // penalty for "General" category (should be negative)
  sportsPenalty: number;      // penalty for Sports (should be negative or 0)
  cryptoBoost: number;        // boost for Crypto (should be positive or 0)
  politicsBoost: number;      // boost for Politics / Iran
  economyBoost: number;       // boost for Economy
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  newsRelevance: 50,
  newsSideBonus: 20,
  newsTotal: 80,

  momentum: 15,
  anomaly: 15,
  volume: 5,
  consensus: 10,
  roiPotential: 15,

  numbersTotalCap: 60,
  numbersOutputWeight: 25,

  generalPenalty: -20,
  sportsPenalty: -5,
  cryptoBoost: 8,
  politicsBoost: 3,
  economyBoost: 2,
};

let currentWeights: ScoringWeights = { ...DEFAULT_WEIGHTS };

export function getWeights(): ScoringWeights {
  return { ...currentWeights };
}

export function getDefaultWeights(): ScoringWeights {
  return { ...DEFAULT_WEIGHTS };
}

export function setWeights(partial: Partial<ScoringWeights>): ScoringWeights {
  currentWeights = { ...currentWeights, ...partial };
  invalidateSignalsCache();
  return { ...currentWeights };
}

export function resetWeights(): ScoringWeights {
  currentWeights = { ...DEFAULT_WEIGHTS };
  invalidateSignalsCache();
  return { ...currentWeights };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HORIZON_FAST_HOURS = 24;
const HORIZON_MEDIUM_DAYS = 7;
const HORIZON_LONG_DAYS = 60;

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'Politics': ['trump', 'biden', 'election', 'president', 'congress', 'senate', 'democrat', 'republican', 'policy', 'government', 'politics', 'political', 'nato', 'parliament'],
  'Iran / Middle East': ['iran', 'iranian', 'tehran', 'khamenei', 'irgc', 'nuclear', 'sanction', 'middle east', 'israel', 'hamas', 'hezbollah', 'persian gulf'],
  'Crypto': ['crypto', 'bitcoin', 'ethereum', 'btc', 'eth', 'solana', 'defi', 'nft', 'stablecoin', 'binance', 'coinbase'],
  'Sports': ['sports', 'nfl', 'nba', 'football', 'soccer', 'tennis', 'ufc', 'mma', 'baseball', 'mlb', 'counter-strike', 'valorant', 'esports'],
  'Economy': ['economy', 'fed', 'gdp', 'inflation', 'interest rate', 'recession', 'unemployment', 'cpi', 'tariff'],
};

function detectCategory(title: string, tags: string[]): string {
  const lower = (title + ' ' + tags.join(' ')).toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return cat;
  }
  return 'General';
}

// ─── Horizon classification ──────────────────────────────────────────────────

function classifyHorizon(endDate?: string): Horizon | null {
  if (!endDate) return 'long';
  const hoursLeft = (new Date(endDate).getTime() - Date.now()) / 3600000;
  if (hoursLeft < 0) return null;
  if (hoursLeft <= HORIZON_FAST_HOURS) return 'fast';
  if (hoursLeft <= HORIZON_MEDIUM_DAYS * 24) return 'medium';
  if (hoursLeft <= HORIZON_LONG_DAYS * 24) return 'long';
  return null; // too far out
}

// ─── Date inference from question text ──────────────────────────────────────

const MONTH_MAP: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function inferDeadlineFromQuestion(question: string): number | null {
  const q = question.toLowerCase();
  const byOnPattern = /(?:by|on|before)\s+(\w+)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/i;
  const match = q.match(byOnPattern);
  if (match) {
    const monthIdx = MONTH_MAP[match[1]];
    if (monthIdx !== undefined) {
      const day = parseInt(match[2]);
      const year = match[3] ? parseInt(match[3]) : new Date().getFullYear();
      const deadline = new Date(year, monthIdx, day, 23, 59, 0);
      const hoursLeft = (deadline.getTime() - Date.now()) / 3600000;
      if (hoursLeft > -48) return Math.max(0, hoursLeft);
    }
  }
  const rangePattern = /(\w+)\s+\d{1,2}\s*[-–]\s*(\w+)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/i;
  const rangeMatch = q.match(rangePattern);
  if (rangeMatch) {
    const monthIdx = MONTH_MAP[rangeMatch[2]] ?? MONTH_MAP[rangeMatch[1]];
    if (monthIdx !== undefined) {
      const day = parseInt(rangeMatch[3]);
      const year = rangeMatch[4] ? parseInt(rangeMatch[4]) : new Date().getFullYear();
      const deadline = new Date(year, monthIdx, day, 23, 59, 0);
      const hoursLeft = (deadline.getTime() - Date.now()) / 3600000;
      if (hoursLeft > -48) return Math.max(0, hoursLeft);
    }
  }
  return null;
}

// ─── Reality checks ─────────────────────────────────────────────────────────

interface RealityResult {
  pass: boolean;
  reason?: string;
  crypto?: CryptoContext;
  confidenceAdjust?: number;
  extraReasons?: string[];
}

function realityCheck(
  question: string,
  prices: number[],
  side: Side,
  hoursLeft: number,
  category: string,
  cryptoPrices: CoinPrice[],
): RealityResult {
  // ── 1. Crypto price-target markets ──
  const parsed = parseCryptoPriceMarket(question);
  if (parsed && parsed.direction !== 'between') {
    const coin = getCoinBySymbol(cryptoPrices, parsed.symbol);
    if (coin) {
      const reality = cryptoPriceReality(coin.current_price, parsed.target, parsed.direction, hoursLeft);
      const ctx: CryptoContext = {
        coin: parsed.coin, symbol: parsed.symbol, currentPrice: coin.current_price,
        target: parsed.target, direction: parsed.direction,
        distancePct: reality.distancePct, impliedMove: reality.impliedMove, isRealistic: reality.isRealistic,
      };

      const yesPrice = prices[0] ?? 0.5;
      if (parsed.direction === 'above' && coin.current_price >= parsed.target) {
        if (side === 'NO' && yesPrice < 0.9) return { pass: false, reason: `${parsed.coin} already above target — NO invalid`, crypto: ctx };
        return { pass: true, crypto: ctx, extraReasons: [`${parsed.symbol.toUpperCase()} already at $${coin.current_price.toFixed(0)} (above $${parsed.target})`] };
      }
      if (parsed.direction === 'below' && coin.current_price <= parsed.target) {
        if (side === 'NO' && yesPrice < 0.9) return { pass: false, reason: `${parsed.coin} already below target — NO invalid`, crypto: ctx };
        return { pass: true, crypto: ctx, extraReasons: [`${parsed.symbol.toUpperCase()} already at $${coin.current_price.toFixed(0)} (below $${parsed.target})`] };
      }
      if (!reality.isRealistic && side === 'YES') {
        return { pass: false, reason: `${parsed.coin} at $${coin.current_price.toFixed(0)}, ${reality.impliedMove} in ${Math.round(hoursLeft)}h — unrealistic`, crypto: ctx };
      }

      const extraReasons: string[] = [];
      let confidenceAdjust = 0;
      extraReasons.push(`${parsed.symbol.toUpperCase()} spot: $${coin.current_price.toFixed(0)} | ${reality.impliedMove}`);
      if (reality.distancePct > 10 && yesPrice > 0.3) {
        extraReasons.push(`Market implies ${(yesPrice * 100).toFixed(0)}% but needs ${reality.distancePct.toFixed(1)}% move — overpriced YES`);
        confidenceAdjust = side === 'NO' ? 10 : -10;
      } else if (reality.distancePct < 3 && yesPrice < 0.5) {
        extraReasons.push(`Only ${reality.distancePct.toFixed(1)}% away but market gives ${(yesPrice * 100).toFixed(0)}% — underpriced YES`);
        confidenceAdjust = side === 'YES' ? 10 : -5;
      }
      return { pass: true, crypto: ctx, extraReasons, confidenceAdjust };
    }
  }

  if (parsed && parsed.direction === 'between') {
    const coin = getCoinBySymbol(cryptoPrices, parsed.symbol);
    if (coin) {
      const midTarget = parsed.targetHigh ? (parsed.target + parsed.targetHigh) / 2 : parsed.target;
      const dist = Math.abs(coin.current_price - midTarget) / coin.current_price * 100;
      const ctx: CryptoContext = {
        coin: parsed.coin, symbol: parsed.symbol, currentPrice: coin.current_price,
        target: parsed.target, direction: 'above', distancePct: dist,
        impliedMove: `spot $${coin.current_price.toFixed(0)} vs range $${parsed.target}–$${parsed.targetHigh}`,
        isRealistic: dist < 20,
      };
      return { pass: true, crypto: ctx, extraReasons: [ctx.impliedMove] };
    }
  }

  // ── 2. Lottery ticket filter ──
  let effectiveHoursLeft = hoursLeft;
  const deadlineFromQ = inferDeadlineFromQuestion(question);
  if (deadlineFromQ !== null && deadlineFromQ < effectiveHoursLeft) effectiveHoursLeft = deadlineFromQ;

  const yesPrice = prices[0] ?? 0.5;
  const entryPrice = side === 'YES' ? yesPrice : (1 - yesPrice);

  if (entryPrice < 0.05 && effectiveHoursLeft < 48) {
    return { pass: false, reason: `Lottery ticket: ${(entryPrice * 100).toFixed(1)}¢ with ${Math.round(effectiveHoursLeft)}h left` };
  }

  // ── 3. Near-certain side with tiny ROI ──
  if (entryPrice > 0.93) {
    const roi = (1 / entryPrice - 1) * 100;
    if (roi < 10) return { pass: false, reason: `${side} at ${(entryPrice * 100).toFixed(0)}¢ — ROI ${roi.toFixed(1)}% not worth it` };
  }

  // ── 4. Individual tournament picks (golf, oscars, etc) — too many low-prob ──
  const q = question.toLowerCase();
  if (/will .+ win the .+ (tournament|championship|masters|oscar|award)/i.test(q) && entryPrice < 0.1) {
    return { pass: false, reason: `Individual tournament pick at ${(entryPrice * 100).toFixed(0)}¢ — random lottery` };
  }

  return { pass: true };
}

// ─── Numerical side selection (YES vs NO) ────────────────────────────────────

interface SideVote { side: Side; weight: number; reason: string }

function selectSideNumerical(
  prices: number[],
  outcomes: string[],
  dayChange: number,
  weekChange: number,
  anomalies: Anomaly[],
): { side: Side; reasons: string[]; consensus: number } {
  const votes: SideVote[] = [];
  const yesPrice = prices[0] ?? 0.5;
  const noPrice = prices[1] ?? (1 - yesPrice);

  if (Math.abs(dayChange) >= 0.02) {
    if (dayChange > 0) votes.push({ side: 'YES', weight: 2, reason: `YES rising +${(dayChange * 100).toFixed(1)}% today` });
    else votes.push({ side: 'NO', weight: 2, reason: `YES falling ${(dayChange * 100).toFixed(1)}% — fade to NO` });
  }

  if (Math.abs(dayChange) >= 0.03 && Math.abs(weekChange) >= 0.04 && Math.sign(dayChange) !== Math.sign(weekChange)) {
    const revSide: Side = dayChange > 0 ? 'YES' : 'NO';
    votes.push({ side: revSide, weight: 3, reason: `Trend reversal: week ${weekChange > 0 ? 'up' : 'down'}, today flipped ${dayChange > 0 ? 'up' : 'down'}` });
  }

  if (yesPrice >= 0.04 && yesPrice <= 0.15) votes.push({ side: 'YES', weight: 1, reason: `Cheap YES at ${(yesPrice * 100).toFixed(0)}¢ — asymmetric upside` });
  if (noPrice >= 0.04 && noPrice <= 0.15) votes.push({ side: 'NO', weight: 1, reason: `Cheap NO at ${(noPrice * 100).toFixed(0)}¢ — contrarian upside` });

  if (yesPrice >= 0.85 && yesPrice <= 0.96 && dayChange < -0.01) {
    votes.push({ side: 'NO', weight: 2, reason: `Favorite at ${(yesPrice * 100).toFixed(0)}¢ losing momentum — fade` });
  }

  for (const a of anomalies) {
    switch (a.type) {
      case 'INSIDER_SIGNAL': {
        const cheapIdx = a.prices.reduce((best: number, p: number, i: number) => p > 0 && p < a.prices[best] ? i : best, 0);
        votes.push({ side: cheapIdx === 0 ? 'YES' : 'NO', weight: 4, reason: `INSIDER: informed buying detected` });
        break;
      }
      case 'SMART_MONEY': {
        const dominantIdx = a.prices.indexOf(Math.max(...a.prices));
        votes.push({ side: dominantIdx === 0 ? 'YES' : 'NO', weight: 3, reason: `SMART MONEY convergence` });
        break;
      }
      case 'REVERSAL':
        votes.push({ side: a.oneDayChange > 0 ? 'YES' : 'NO', weight: 2, reason: `REVERSAL detected` });
        break;
      case 'PRICE_SPIKE':
        votes.push({ side: a.oneDayChange > 0 ? 'YES' : 'NO', weight: 2, reason: `Price spike ${(Math.abs(a.oneDayChange) * 100).toFixed(1)}%` });
        break;
      case 'CLOSING_SPIKE':
        votes.push({ side: a.oneDayChange >= 0 ? 'YES' : 'NO', weight: 2, reason: `Late closing spike` });
        break;
      // VOLUME_SURGE intentionally reduced to weight 0 — too noisy as standalone
    }
  }

  if (votes.length === 0) {
    const defaultSide: Side = yesPrice <= noPrice ? 'YES' : 'NO';
    return { side: defaultSide, reasons: ['Cheaper side selected'], consensus: 0.5 };
  }

  let yesWeight = 0, noWeight = 0;
  const yesReasons: string[] = [], noReasons: string[] = [];
  for (const v of votes) {
    if (v.side === 'YES') { yesWeight += v.weight; yesReasons.push(v.reason); }
    else { noWeight += v.weight; noReasons.push(v.reason); }
  }

  const totalWeight = yesWeight + noWeight;
  const side: Side = yesWeight >= noWeight ? 'YES' : 'NO';
  const reasons = side === 'YES' ? yesReasons : noReasons;
  const consensus = totalWeight > 0 ? Math.max(yesWeight, noWeight) / totalWeight : 0.5;
  return { side, reasons, consensus };
}

// ─── Confidence scoring (uses currentWeights) ───────────────────────────────

function computeNumbersScore(dayChange: number, anomalyScore: number, vol24h: number, consensus: number, entryPrice: number): number {
  const w = currentWeights;
  const momentum = Math.min(w.momentum, Math.abs(dayChange) * 100);
  const anomaly = Math.min(w.anomaly, anomalyScore * 0.15);
  const volume = Math.min(w.volume, Math.log10(Math.max(vol24h, 1)) * (w.volume / 4));
  const cons = consensus * w.consensus;

  // ROI asymmetry: cheap entry → bigger potential payoff
  let roiPts = 0;
  if (w.roiPotential > 0) {
    if (entryPrice < 0.10) roiPts = w.roiPotential;
    else if (entryPrice < 0.20) roiPts = w.roiPotential * 0.7;
    else if (entryPrice < 0.35) roiPts = w.roiPotential * 0.4;
    else if (entryPrice < 0.50) roiPts = w.roiPotential * 0.15;
  }

  return Math.min(w.numbersTotalCap, momentum + anomaly + volume + cons + roiPts);
}

function computePerplexityScore(analysis: MarketAnalysis, numericalSide: Side): number {
  const w = currentWeights;
  const relevancePart = (analysis.relevance / 100) * w.newsRelevance;

  let sideBonus = 0;
  if (analysis.side !== 'NEUTRAL') {
    const matchesNumerical = analysis.side === numericalSide;
    sideBonus = matchesNumerical ? Math.min(w.newsSideBonus, analysis.sideConfidence * 0.2) : 0;
  }

  return Math.min(w.newsTotal, relevancePart + sideBonus);
}

function computeFinalConfidence(perplexityScore: number, numbersScore: number, category: string): number {
  const w = currentWeights;
  const numbersNormalized = (numbersScore / w.numbersTotalCap) * w.numbersOutputWeight;
  let confidence = Math.round(Math.min(100, perplexityScore + numbersNormalized));

  // Category modifier
  const categoryMod = getCategoryModifier(category);
  confidence = Math.max(1, Math.min(100, confidence + categoryMod));

  return confidence;
}

function getCategoryModifier(category: string): number {
  const w = currentWeights;
  if (category === 'General') return w.generalPenalty;
  if (category === 'Sports') return w.sportsPenalty;
  if (category === 'Crypto') return w.cryptoBoost;
  if (category === 'Politics' || category === 'Iran / Middle East') return w.politicsBoost;
  if (category === 'Economy') return w.economyBoost;
  return 0;
}

function confidenceLevel(c: number): ConfidenceLevel {
  if (c >= 75) return 'strong';
  if (c >= 50) return 'good';
  return 'speculative';
}

// ─── Candidate pre-filter ────────────────────────────────────────────────────

interface Candidate {
  event: GammaEvent;
  market: GammaMarket;
  prices: number[];
  outcomes: string[];
  horizon: Horizon;
  dayChange: number;
  weekChange: number;
  vol24h: number;
  liq: number;
  category: string;
  tags: string[];
  anomalies: Anomaly[];
  hoursLeft: number;
  question: string;
}

function preFilterCandidates(
  events: GammaEvent[],
  anomalyIndex: Map<string, Anomaly[]>,
): Candidate[] {
  const candidates: Candidate[] = [];
  const seenMarkets = new Set<string>();

  for (const event of events) {
    const tags = (event.tags ?? []).map((t: any) => t.label ?? t.slug ?? '');
    const category = detectCategory(event.title ?? '', tags);

    for (const market of event.markets ?? []) {
      if (!market.active || market.closed || !market.acceptingOrders) continue;
      if (seenMarkets.has(market.id)) continue;

      const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
      if (prices.length === 0) continue;
      if (prices.some(p => p < 0.005 || p > 0.995)) continue;

      const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
      if (liq < 1000) continue;

      const vol24h = market.volume24hr ?? event.volume24hr ?? 0;
      if (vol24h < 300) continue;

      const horizon = classifyHorizon(market.endDate);
      if (!horizon) continue;

      const dayChange = market.oneDayPriceChange ?? 0;
      const weekChange = market.oneWeekPriceChange ?? 0;
      const marketAnomalies = anomalyIndex.get(market.id) || [];

      // Must have SOME signal beyond just volume surge
      const hasStrongAnomaly = marketAnomalies.some(a => a.type !== 'VOLUME_SURGE');
      const hasVolumeSurge = marketAnomalies.some(a => a.type === 'VOLUME_SURGE');
      const hasMomentum = Math.abs(dayChange) >= 0.02 || Math.abs(weekChange) >= 0.03;
      const hasCheapSide = prices.some(p => p >= 0.04 && p <= 0.25);
      const hasFadeOpportunity = prices.some(p => p >= 0.85 && p <= 0.96) && dayChange !== 0;

      // VOLUME_SURGE alone is NOT enough — must combine with momentum or price pattern
      if (!hasStrongAnomaly && !hasMomentum && !hasCheapSide && !hasFadeOpportunity) {
        if (hasVolumeSurge && Math.abs(dayChange) < 0.01) continue; // volume surge but flat price = noise
      }

      const hoursLeft = market.endDate
        ? (new Date(market.endDate).getTime() - Date.now()) / 3600000
        : 9999;

      const question = market.question ?? event.title ?? '';

      seenMarkets.add(market.id);
      candidates.push({
        event, market, prices, outcomes: parseOutcomes(market.outcomes),
        horizon, dayChange, weekChange, vol24h, liq, category, tags,
        anomalies: marketAnomalies, hoursLeft, question,
      });
    }
  }

  return candidates;
}

// ─── Main engine ─────────────────────────────────────────────────────────────

let cachedSignals: Signal[] | null = null;
let cacheTs = 0;
const CACHE_TTL = 10 * 60 * 1000;

export function invalidateSignalsCache() {
  cachedSignals = null;
  cacheTs = 0;
}

export async function generateSignals(skipNews = false): Promise<Signal[]> {
  // Only return cache if it has actual signals (don't cache empty results)
  if (cachedSignals && cachedSignals.length > 0 && Date.now() - cacheTs < CACHE_TTL) return cachedSignals;

  const [events1, events2, anomalies, cryptoPrices] = await Promise.all([
    gammaClient.getEvents({ limit: 100, active: true, closed: false, archived: false, order: 'volume24hr', ascending: false }),
    gammaClient.getEvents({ limit: 80, active: true, closed: false, archived: false, order: 'liquidity', ascending: false }),
    scanAnomalies({ limit: 100, minScore: 15 }).catch(() => [] as Anomaly[]),
    getCryptoPrices().catch(() => [] as CoinPrice[]),
  ]);

  // Dedupe events
  const eventMap = new Map<string, GammaEvent>();
  for (const e of [...events1, ...events2]) eventMap.set(e.id, e);
  const events = Array.from(eventMap.values());

  // Build anomaly index
  const anomalyIndex = new Map<string, Anomaly[]>();
  for (const a of anomalies) {
    const arr = anomalyIndex.get(a.marketId) || [];
    arr.push(a);
    anomalyIndex.set(a.marketId, arr);
  }

  // PHASE 1: Pre-filter candidates (numerical only)
  let candidates = preFilterCandidates(events, anomalyIndex);
  console.log(`[signals] pre-filter: ${candidates.length} candidates from ${events.length} events`);

  // Cap candidates to avoid excessive Perplexity calls
  // Rank by a quick heuristic and take top 50
  candidates.sort((a, b) => {
    const scoreA = (Math.abs(a.dayChange) * 100) + (a.anomalies.length * 10) + Math.log10(a.vol24h + 1) * 3;
    const scoreB = (Math.abs(b.dayChange) * 100) + (b.anomalies.length * 10) + Math.log10(b.vol24h + 1) * 3;
    return scoreB - scoreA;
  });
  candidates = candidates.slice(0, 50);

  // PHASE 2: Reality check (crypto prices, lottery tickets, etc.)
  const passedCandidates: Candidate[] = [];
  const cryptoContexts = new Map<string, CryptoContext>();
  const realityAdjust = new Map<string, number>();
  const realityReasons = new Map<string, string[]>();

  for (const c of candidates) {
    const numSide = selectSideNumerical(c.prices, c.outcomes, c.dayChange, c.weekChange, c.anomalies);
    const reality = realityCheck(c.question, c.prices, numSide.side, c.hoursLeft, c.category, cryptoPrices);
    if (!reality.pass) continue;
    if (reality.crypto) cryptoContexts.set(c.market.id, reality.crypto);
    if (reality.confidenceAdjust) realityAdjust.set(c.market.id, reality.confidenceAdjust);
    if (reality.extraReasons?.length) realityReasons.set(c.market.id, reality.extraReasons);
    passedCandidates.push(c);
  }

  console.log(`[signals] after reality check: ${passedCandidates.length} candidates`);

  // PHASE 3: Perplexity analysis (unless skipNews)
  let perplexityResults = new Map<string, MarketAnalysis>();

  let perplexityFailed = false;
  if (!skipNews && passedCandidates.length > 0) {
    const marketCandidates: MarketCandidate[] = passedCandidates.map(c => ({
      marketQuestion: c.question,
      eventTitle: c.event.title ?? '',
      endDate: c.market.endDate,
      yesPrice: c.prices[0] ?? 0.5,
      noPrice: c.prices[1] ?? 0.5,
    }));

    try {
      perplexityResults = await analyzeMarketsBatch(marketCandidates, 3);
      // If ALL results are empty/missing, treat as failure
      if (perplexityResults.size === 0) {
        console.warn('[signals] Perplexity returned 0 results — falling back to skipNews mode');
        perplexityFailed = true;
      }
    } catch (err: any) {
      console.error('[signals] Perplexity batch failed:', err.message, '— falling back to skipNews mode');
      perplexityFailed = true;
    }
  }

  // PHASE 4: Build signals with combined scoring
  const signals: Signal[] = [];
  const cacheKeyFn = (q: string) => (q || '').slice(0, 100).toLowerCase().replace(/\s+/g, ' ').trim();

  for (const c of passedCandidates) {
    const key = cacheKeyFn(c.question);
    const pplx = perplexityResults.get(key) ?? null;

    // If Perplexity is enabled AND succeeded → apply its filters
    const usePerplexity = !skipNews && !perplexityFailed;
    if (usePerplexity && pplx && !pplx.active) continue;
    if (usePerplexity && pplx && pplx.relevance < 25) continue;

    // Numerical side selection
    const numResult = selectSideNumerical(c.prices, c.outcomes, c.dayChange, c.weekChange, c.anomalies);
    let side = numResult.side;
    const reasons: string[] = [];

    // Perplexity side override: if strong opinion (sideConfidence >= 55 and not NEUTRAL) → use it
    if (pplx && pplx.side !== 'NEUTRAL' && pplx.sideConfidence >= 55) {
      side = pplx.side as Side;
      reasons.push(`📰 ${pplx.reason}`);
    } else if (pplx && pplx.reason) {
      reasons.push(`📰 ${pplx.reason}`);
    }

    // Add crypto/reality reasons first
    const rr = realityReasons.get(c.market.id);
    if (rr) reasons.push(...rr);

    // Add numerical reasons
    reasons.push(...numResult.reasons);

    // Compute entry price and ROI
    const sideIdx = side === 'YES' ? 0 : (c.prices.length > 1 ? 1 : 0);
    const entryPrice = c.prices[sideIdx] ?? 0.5;
    if (entryPrice <= 0.005 || entryPrice >= 0.995) continue;

    const potentialRoi = calcPotentialRoi(entryPrice);
    const roiMultiple = 1 / entryPrice;

    // Final ROI filter: skip tiny ROI
    if (potentialRoi < 5) continue;

    const maxAnomalyScore = c.anomalies.reduce((max: number, a: Anomaly) => Math.max(max, a.score), 0);
    const anomalyTypes = c.anomalies.map(a => a.type);

    const daysUntilClose = c.market.endDate
      ? Math.ceil((new Date(c.market.endDate).getTime() - Date.now()) / 86400000)
      : null;

    // Scoring
    const numbersScore = computeNumbersScore(c.dayChange, maxAnomalyScore, c.vol24h, numResult.consensus, entryPrice);
    let perplexityScore = 0;
    if (pplx) {
      perplexityScore = computePerplexityScore(pplx, numResult.side);
    }

    let confidence: number;
    if (skipNews || perplexityFailed || !pplx) {
      confidence = Math.round(numbersScore) + getCategoryModifier(c.category);
      confidence = Math.max(1, Math.min(100, confidence));
    } else {
      confidence = computeFinalConfidence(perplexityScore, numbersScore, c.category);
    }

    // Reality check adjustment
    const adj = realityAdjust.get(c.market.id);
    if (adj) confidence = Math.max(1, Math.min(100, confidence + adj));

    // Minimum threshold: with Perplexity = 35, without = 20
    const minConf = (skipNews || perplexityFailed || !pplx) ? 20 : 35;
    if (confidence < minConf) continue;

    signals.push({
      id: `sig-${c.market.id}`,
      eventId: c.event.id,
      eventTitle: c.event.title ?? '',
      eventSlug: c.event.slug ?? '',
      marketId: c.market.id,
      marketQuestion: c.question,
      side,
      horizon: c.horizon,
      confidence,
      confidenceLevel: confidenceLevel(confidence),
      entryPrice,
      potentialRoi,
      roiMultiple,
      volume24h: c.vol24h,
      liquidity: c.liq,
      daysUntilClose,
      oneDayChange: c.dayChange,
      oneWeekChange: c.weekChange,
      prices: c.prices,
      outcomes: c.outcomes,
      tags: c.tags,
      category: c.category,
      reasons: reasons.slice(0, 5),
      anomalyTypes,
      crypto: cryptoContexts.get(c.market.id),
      news: pplx ? { summary: pplx.reason, sentiment: pplx.side, relevance: pplx.relevance } : undefined,
      generatedAt: new Date().toISOString(),
    });
  }

  // Sort by confidence desc
  signals.sort((a, b) => b.confidence - a.confidence);

  // Correlation warnings
  const catCount: Record<string, number> = {};
  const eventCount: Record<string, number> = {};
  for (const s of signals) {
    catCount[s.category] = (catCount[s.category] ?? 0) + 1;
    eventCount[s.eventId] = (eventCount[s.eventId] ?? 0) + 1;
  }
  for (const s of signals) {
    const warnings: string[] = [];
    if (catCount[s.category] >= 4) {
      warnings.push(`${catCount[s.category] - 1} other ${s.category} signals — correlated risk`);
    }
    if (eventCount[s.eventId] >= 2) {
      warnings.push(`${eventCount[s.eventId] - 1} other market(s) from same event`);
    }
    if (warnings.length > 0) s.correlationWarning = warnings.join('; ');
  }

  // Market efficiency + Kelly stake (defensive: no NaN, no throw)
  for (const s of signals) {
    try {
      const eff = computeMarketEfficiency(
        Number(s.liquidity) || 0,
        Number(s.volume24h) || 0,
        Number(s.oneDayChange) ?? 0
      );
      s.marketEfficiency = Number.isFinite(eff) ? eff : undefined;
    } catch { s.marketEfficiency = undefined; }
    try {
      const kelly = computeKellyStake(s.confidence / 100, s.entryPrice);
      s.suggestedStakePct = Number.isFinite(kelly) ? kelly : 0;
    } catch { s.suggestedStakePct = 0; }
  }

  console.log(`[signals] final: ${signals.length} signals (was ${passedCandidates.length} candidates)`);

  cachedSignals = signals;
  cacheTs = Date.now();

  // Persist to DB for tracking (fire-and-forget)
  setImmediate(async () => {
    try {
      const { saveSignals } = await import('./signal-tracker');
      await saveSignals(signals.slice(0, 60));
    } catch { /* non-critical */ }
  });

  return signals;
}

export function getSignalsByHorizon(signals: Signal[], horizon: Horizon | 'all', limit = 30): Signal[] {
  const filtered = horizon === 'all' ? signals : signals.filter(s => s.horizon === horizon);
  return filtered.slice(0, limit);
}

// ─── Market efficiency score ──────────────────────────────────────────────────
// Lower = less efficient = more opportunity. 0-100.
function computeMarketEfficiency(liquidity: number, volume24h: number, dayChange: number): number {
  const liq = Math.max(Number(liquidity) || 0, 1);
  const vol = Math.max(Number(volume24h) || 0, 1);
  const change = Number(dayChange);
  const liqPart = Math.log10(liq + 1) * 6;
  const volPart = Math.log10(vol + 1) * 5;
  const volatilityPart = Math.min(20, Math.abs(Number.isFinite(change) ? change : 0) * 100) * 0.5;
  const raw = liqPart + volPart - volatilityPart;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

// ─── Kelly criterion stake ────────────────────────────────────────────────────
// p = estimated win probability, entryPrice = cost per share (0-1)
// Returns recommended stake as % of bankroll (0 - 5, capped)
function computeKellyStake(p: number, entryPrice: number): number {
  if (entryPrice <= 0 || entryPrice >= 1 || p <= 0) return 0;
  const odds = 1 / entryPrice;
  const kelly = (p * odds - 1) / (odds - 1);
  if (kelly <= 0) return 0;
  return Math.round(Math.min(kelly * 100, 5) * 100) / 100;
}

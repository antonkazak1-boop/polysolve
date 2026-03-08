import { gammaClient, parseOutcomePrices, calcPotentialRoi, isAsymmetricReturn } from '../clients/gamma-client';
import { scanAnomalies } from '../clients/anomaly-detector';
import { analyzeMarketsBatch, MarketAnalysis, MarketCandidate, NewsResult } from '../clients/perplexity-client';

export interface Recommendation {
  rank: number;
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  marketId: string;
  marketQuestion: string;
  outcome: string;       // YES or NO — now Perplexity-driven
  price: number;
  potentialRoi: number;
  volume24hr: number;
  liquidity: number;
  tags: string[];
  score: number;
  anomalyScore: number;
  roiScore: number;
  volumeScore: number;
  newsScore: number;
  liquidityScore: number;
  politicsBoost: number;
  reasoning: string;
  category: string;
  isIranCrisis: boolean;
  isPolitics: boolean;
  news?: NewsResult;
  perplexityReason?: string;
  correlationWarning?: string;
  marketEfficiency?: number;
  suggestedStakePct?: number;
  generatedAt: string;
}

// ─── Category detection ──────────────────────────────────────────────────────

const POLITICS_KEYWORDS = [
  'trump', 'biden', 'election', 'president', 'congress', 'senate', 'democrat', 'republican',
  'white house', 'vote', 'policy', 'federal', 'government', 'minister', 'parliament',
  'macron', 'nato', 'un ', 'united nations', 'politics', 'political',
];
const IRAN_KEYWORDS = [
  'iran', 'iranian', 'tehran', 'khamenei', 'irgc', 'nuclear deal', 'sanction', 'middle east',
  'israel', 'hamas', 'hezbollah', 'persian gulf', 'strait of hormuz',
];

function detectCategory(title: string, tags: string[]): { isPolitics: boolean; isIranCrisis: boolean; category: string } {
  const lower = (title + ' ' + tags.join(' ')).toLowerCase();
  const isPolitics = POLITICS_KEYWORDS.some(kw => lower.includes(kw));
  const isIranCrisis = IRAN_KEYWORDS.some(kw => lower.includes(kw));
  let category = 'General';
  if (isIranCrisis) category = 'Iran / Middle East';
  else if (isPolitics) category = 'Politics';
  else if (['sport', 'football', 'nfl', 'nba', 'soccer', 'tennis'].some(k => lower.includes(k))) category = 'Sports';
  else if (['crypto', 'bitcoin', 'ethereum', 'eth', 'btc'].some(k => lower.includes(k))) category = 'Crypto';
  else if (['economy', 'fed', 'gdp', 'inflation', 'tariff'].some(k => lower.includes(k))) category = 'Economy';
  return { isPolitics, isIranCrisis, category };
}

// ─── Scoring helpers ─────────────────────────────────────────────────────────

function scoreRoi(roi: number): number {
  if (roi >= 2000) return 25;
  if (roi >= 1000) return 22;
  if (roi >= 500) return 18;
  if (roi >= 300) return 14;
  if (roi >= 100) return 10;
  if (roi >= 50) return 5;
  return 0;
}

function scoreVolume(vol24: number): number {
  if (vol24 >= 1_000_000) return 15;
  if (vol24 >= 500_000) return 12;
  if (vol24 >= 100_000) return 8;
  if (vol24 >= 10_000) return 5;
  if (vol24 >= 1_000) return 2;
  return 0;
}

function scoreLiquidity(liq: number): number {
  if (liq >= 1_000_000) return 8;
  if (liq >= 100_000) return 6;
  if (liq >= 10_000) return 4;
  if (liq >= 1_000) return 2;
  return 0;
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${Math.round(n)}`;
}

function buildReasoning(r: Partial<Recommendation>): string {
  const parts: string[] = [];
  if (r.perplexityReason) parts.push(`📰 ${r.perplexityReason}`);
  if (r.isIranCrisis) parts.push('🚨 Iran/Middle East crisis');
  else if (r.isPolitics) parts.push('🏛️ Political event');
  if ((r.potentialRoi ?? 0) >= 100) parts.push(`💰 ${Math.round(r.potentialRoi!)}% potential ROI`);
  if ((r.anomalyScore ?? 0) > 0) parts.push(`⚡ Anomaly (${r.anomalyScore?.toFixed(1)})`);
  if ((r.volume24hr ?? 0) > 100_000) parts.push(`📊 Vol $${formatK(r.volume24hr!)}`);
  return parts.join(' | ') || 'Composite scoring recommendation';
}

// ─── Main engine ─────────────────────────────────────────────────────────────

interface RawCandidate {
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  marketId: string;
  marketQuestion: string;
  endDate?: string;
  prices: number[];
  bestOutcome: number;
  bestPrice: number;
  roi: number;
  volume24hr: number;
  liquidity: number;
  tags: string[];
  anomalyScore: number;
  isPolitics: boolean;
  isIranCrisis: boolean;
  category: string;
}

let cachedRecommendations: Recommendation[] | null = null;
let cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000;

export async function generateRecommendations(limit = 10, skipNews = false): Promise<Recommendation[]> {
  if (cachedRecommendations && Date.now() - cacheTs < CACHE_TTL) {
    return cachedRecommendations.slice(0, limit);
  }

  const [events, anomalies] = await Promise.all([
    gammaClient.getEvents({ limit: 100, active: true, closed: false, archived: false, order: 'volume24hr', ascending: false }),
    scanAnomalies({ limit: 60 }).catch(() => []),
  ]);

  const anomalyIndex = new Map<string, number>();
  for (const a of anomalies) {
    const prev = anomalyIndex.get(a.marketId) ?? 0;
    if (a.score > prev) anomalyIndex.set(a.marketId, a.score);
  }

  // PHASE 1: Build raw candidates
  const rawCandidates: RawCandidate[] = [];

  for (const event of events) {
    const tags = (event.tags ?? []).map((t: any) => t.label ?? t.slug ?? '');
    const { isPolitics, isIranCrisis, category } = detectCategory(event.title ?? '', tags);

    for (const market of event.markets ?? []) {
      const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
      if (prices.length === 0) continue;
      if (prices.some((p: number) => p < 0.005 || p > 0.995)) continue;
      if (!market.acceptingOrders) continue;

      const asym = isAsymmetricReturn(prices, 0.15);
      if (!asym.isAsymmetric) continue;

      const liq = parseFloat(market.liquidity ?? '0') || 0;
      if (liq < 2000) continue;

      const bestPrice = prices[asym.bestOutcome];
      const roi = calcPotentialRoi(bestPrice);

      // Skip tournament/individual winner picks at very low prices
      const q = (market.question ?? event.title ?? '').toLowerCase();
      if (/will .+ win the .+ (tournament|championship|masters|oscar)/i.test(q) && bestPrice < 0.08) continue;

      rawCandidates.push({
        eventId: event.id,
        eventTitle: event.title ?? '',
        eventSlug: event.slug ?? '',
        marketId: market.id,
        marketQuestion: market.question ?? event.title ?? '',
        endDate: market.endDate,
        prices,
        bestOutcome: asym.bestOutcome,
        bestPrice,
        roi,
        volume24hr: event.volume24hr ?? 0,
        liquidity: liq,
        tags,
        anomalyScore: (anomalyIndex.get(market.id) ?? 0) * 0.3,
        isPolitics,
        isIranCrisis,
        category,
      });
    }
  }

  // Pre-sort by rough score and take top 25 for Perplexity
  rawCandidates.sort((a, b) => {
    const sa = scoreRoi(a.roi) + scoreVolume(a.volume24hr) + a.anomalyScore + (a.isIranCrisis ? 15 : a.isPolitics ? 8 : 0);
    const sb = scoreRoi(b.roi) + scoreVolume(b.volume24hr) + b.anomalyScore + (b.isIranCrisis ? 15 : b.isPolitics ? 8 : 0);
    return sb - sa;
  });
  const topCandidates = rawCandidates.slice(0, 25);

  // PHASE 2: Perplexity analysis for top candidates
  let pplxMap = new Map<string, MarketAnalysis>();
  const cacheKeyFn = (q: string) => (q || '').slice(0, 100).toLowerCase().replace(/\s+/g, ' ').trim();

  if (!skipNews && topCandidates.length > 0) {
    const marketCandidates: MarketCandidate[] = topCandidates.map(c => ({
      marketQuestion: c.marketQuestion,
      eventTitle: c.eventTitle,
      endDate: c.endDate,
      yesPrice: c.prices[0] ?? 0.5,
      noPrice: c.prices[1] ?? 0.5,
    }));

    try {
      pplxMap = await analyzeMarketsBatch(marketCandidates, 3);
    } catch { /* non-critical */ }
  }

  // PHASE 3: Final scoring with Perplexity
  const recommendations: Recommendation[] = [];

  for (const c of topCandidates) {
    const key = cacheKeyFn(c.marketQuestion);
    const pplx = pplxMap.get(key);

    // If Perplexity says not active → skip
    if (pplx && !pplx.active) continue;
    // Low relevance with Perplexity → skip (can't assess)
    if (!skipNews && pplx && pplx.relevance < 20) continue;

    // Determine outcome side: Perplexity opinion or default to cheapest
    let outcome = c.bestOutcome === 0 ? 'YES' : 'NO';
    let entryPrice = c.bestPrice;
    let roi = c.roi;

    if (pplx && pplx.side !== 'NEUTRAL' && pplx.sideConfidence >= 50) {
      outcome = pplx.side;
      const sideIdx = outcome === 'YES' ? 0 : (c.prices.length > 1 ? 1 : 0);
      entryPrice = c.prices[sideIdx] ?? c.bestPrice;
      roi = calcPotentialRoi(entryPrice);
    }

    // Skip tiny ROI
    if (roi < 5) continue;

    const roiSc = scoreRoi(roi);
    const volSc = scoreVolume(c.volume24hr);
    const liqSc = scoreLiquidity(c.liquidity);
    const politicsBoost = c.isIranCrisis ? 15 : c.isPolitics ? 8 : 0;

    // Perplexity news score: relevance → up to 30 pts (major weight!)
    const newsScore = pplx ? Math.min(30, Math.round(pplx.relevance * 0.3)) : 0;

    // Side confidence bonus: Perplexity is confident → extra 0-10 pts
    const sideBonus = pplx && pplx.side !== 'NEUTRAL' ? Math.min(10, Math.round(pplx.sideConfidence * 0.1)) : 0;

    const score = roiSc + volSc + liqSc + c.anomalyScore + politicsBoost + newsScore + sideBonus;

    const rec: Recommendation = {
      rank: 0,
      eventId: c.eventId,
      eventTitle: c.eventTitle,
      eventSlug: c.eventSlug,
      marketId: c.marketId,
      marketQuestion: c.marketQuestion,
      outcome,
      price: entryPrice,
      potentialRoi: roi,
      volume24hr: c.volume24hr,
      liquidity: c.liquidity,
      tags: c.tags,
      score,
      anomalyScore: c.anomalyScore,
      roiScore: roiSc,
      volumeScore: volSc,
      newsScore: newsScore + sideBonus,
      liquidityScore: liqSc,
      politicsBoost,
      category: c.category,
      isIranCrisis: c.isIranCrisis,
      isPolitics: c.isPolitics,
      perplexityReason: pplx?.reason || undefined,
      reasoning: '',
      generatedAt: new Date().toISOString(),
    };
    rec.reasoning = buildReasoning(rec);
    recommendations.push(rec);
  }

  // Correlation warnings
  const catCount: Record<string, number> = {};
  const eventCount: Record<string, number> = {};
  for (const r of recommendations) {
    catCount[r.category] = (catCount[r.category] ?? 0) + 1;
    eventCount[r.eventId] = (eventCount[r.eventId] ?? 0) + 1;
  }
  for (const r of recommendations) {
    const warnings: string[] = [];
    if (catCount[r.category] >= 4) warnings.push(`${catCount[r.category] - 1} other ${r.category} recs — correlated risk`);
    if (eventCount[r.eventId] >= 2) warnings.push(`${eventCount[r.eventId] - 1} other market(s) from same event`);
    if (warnings.length > 0) r.correlationWarning = warnings.join('; ');

    r.marketEfficiency = computeEfficiency(r.liquidity, r.volume24hr);
    const p = Math.min(0.95, r.score / 120);
    r.suggestedStakePct = computeKelly(p, r.price);
  }

  // Sort by final score, assign ranks
  recommendations.sort((a, b) => b.score - a.score);
  recommendations.forEach((r, i) => { r.rank = i + 1; });

  cachedRecommendations = recommendations;
  cacheTs = Date.now();

  console.log(`[recommendations] generated ${recommendations.length} (from ${rawCandidates.length} candidates)`);
  return recommendations.slice(0, limit);
}

export function invalidateRecommendationsCache() {
  cachedRecommendations = null;
  cacheTs = 0;
}

function computeEfficiency(liquidity: number, volume24h: number): number {
  const liqPart = Math.log10(Math.max(liquidity, 1) + 1) * 6;
  const volPart = Math.log10(Math.max(volume24h, 1) + 1) * 5;
  return Math.max(0, Math.min(100, Math.round(liqPart + volPart)));
}

function computeKelly(p: number, entryPrice: number): number {
  if (entryPrice <= 0 || entryPrice >= 1 || p <= 0) return 0;
  const odds = 1 / entryPrice;
  const kelly = (p * odds - 1) / (odds - 1);
  if (kelly <= 0) return 0;
  return Math.round(Math.min(kelly * 100, 5) * 100) / 100;
}

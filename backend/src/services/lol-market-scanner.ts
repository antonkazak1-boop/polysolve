import { gammaClient, GammaEvent, GammaMarket, parseOutcomePrices } from '../clients/gamma-client';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MarketType =
  | 'match_winner'
  | 'series_handicap'
  | 'series_total'
  | 'season_winner'
  | 'region_winner'
  | 'prop';

export interface LoLMarket {
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  marketId: string;
  question: string;
  type: MarketType;
  teams: string[];
  format: 'BO1' | 'BO3' | 'BO5' | 'unknown';
  pMarketYes: number;
  pMarketNo: number;
  volume: number;
  liquidity: number;
  endDate: string;
  conditionId: string;
  groupItemTitle?: string;
}

// ─── Market classification ───────────────────────────────────────────────────

const VS_PATTERN = /(.+?)\s+vs\.?\s+(.+?)(?:\s*\(|$)/i;
const HANDICAP_PATTERN = /handicap|spread/i;
const TOTAL_PATTERN = /total|over.*under|o\/u|odd.*even/i;
const SEASON_PATTERN = /season|playoffs?\s+winner|split\s+winner/i;
const REGION_PATTERN = /winning\s+region|which\s+region/i;
const BO_PATTERN = /\(BO(\d)\)/i;
const PROP_KEYWORDS = /first\s+blood|dragon|baron|inhibitor|pentakill|tower|game\s+\d+:/i;

function classifyMarket(event: GammaEvent, market: GammaMarket): MarketType {
  const q = market.question || event.title || '';
  if (PROP_KEYWORDS.test(q)) return 'prop';
  if (HANDICAP_PATTERN.test(q)) return 'series_handicap';
  if (TOTAL_PATTERN.test(q)) return 'series_total';
  if (REGION_PATTERN.test(q)) return 'region_winner';
  if (SEASON_PATTERN.test(q)) return 'season_winner';
  // match_winner: only for event-level "Team vs Team" — not sub-game markets
  const title = event.title || '';
  if (VS_PATTERN.test(title) && !PROP_KEYWORDS.test(q)) return 'match_winner';
  return 'prop';
}

function extractTeams(event: GammaEvent, market: GammaMarket): string[] {
  const title = event.title || market.question || '';
  const vsMatch = title.match(VS_PATTERN);
  if (vsMatch) return [vsMatch[1].trim(), vsMatch[2].trim()];

  const willMatch = (market.question || '').match(/will\s+(.+?)\s+(?:win|beat)\s+(?:the\s+)?(.+?)(?:\?|$)/i);
  if (willMatch) return [willMatch[1].trim(), willMatch[2].trim()];

  return [];
}

function extractFormat(event: GammaEvent): 'BO1' | 'BO3' | 'BO5' | 'unknown' {
  const text = event.title || '';
  const m = text.match(BO_PATTERN);
  if (m) {
    const n = Number(m[1]);
    if (n === 1) return 'BO1';
    if (n === 3) return 'BO3';
    if (n === 5) return 'BO5';
  }
  return 'unknown';
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

export async function scanLoLMarkets(): Promise<LoLMarket[]> {
  const events = await gammaClient.getEvents({
    tag_slug: 'league-of-legends',
    active: true,
    closed: false,
    limit: 100,
    order: 'volume24hr',
    ascending: false,
  });

  const results: LoLMarket[] = [];

  for (const event of events) {
    const markets = event.markets ?? [];
    for (const market of markets) {
      if (market.closed || !market.active) continue;

      const prices = parseOutcomePrices(market.outcomePrices || '[]');
      const pYes = prices[0] ?? 0.5;
      const pNo = prices[1] ?? 1 - pYes;
      const type = classifyMarket(event, market);

      results.push({
        eventId: event.id,
        eventTitle: event.title,
        eventSlug: event.slug,
        marketId: market.id,
        question: market.question || market.groupItemTitle || event.title,
        type,
        teams: extractTeams(event, market),
        format: extractFormat(event),
        pMarketYes: Math.round(pYes * 10000) / 10000,
        pMarketNo: Math.round(pNo * 10000) / 10000,
        volume: market.volumeNum ?? (parseFloat(market.volume) || 0),
        liquidity: market.liquidityNum ?? (parseFloat(market.liquidity ?? '0') || 0),
        endDate: market.endDate || event.endDate,
        conditionId: market.conditionId,
        groupItemTitle: market.groupItemTitle,
      });
    }
  }

  return results;
}

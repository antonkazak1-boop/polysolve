import axios from 'axios';

const CG_BASE = 'https://api.coingecko.com/api/v3';

export interface CoinPrice {
  id: string;
  symbol: string;
  current_price: number;
  price_change_percentage_24h: number;
  price_change_percentage_7d: number;
  high_24h: number;
  low_24h: number;
  ath: number;
  atl: number;
}

const TRACKED_COINS = ['bitcoin', 'ethereum', 'solana'];
const SYMBOLS: Record<string, string> = { bitcoin: 'btc', ethereum: 'eth', solana: 'sol' };

let cached: CoinPrice[] | null = null;
let cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

export async function getCryptoPrices(): Promise<CoinPrice[]> {
  if (cached && Date.now() - cacheTs < CACHE_TTL) return cached;

  try {
    const res = await axios.get(`${CG_BASE}/coins/markets`, {
      params: {
        vs_currency: 'usd',
        ids: TRACKED_COINS.join(','),
        order: 'market_cap_desc',
        sparkline: false,
        price_change_percentage: '24h,7d',
      },
      timeout: 10000,
    });

    cached = (res.data || []).map((c: any) => ({
      id: c.id,
      symbol: c.symbol,
      current_price: c.current_price,
      price_change_percentage_24h: c.price_change_percentage_24h ?? 0,
      price_change_percentage_7d: c.price_change_percentage_7d_in_currency ?? c.price_change_percentage_7d ?? 0,
      high_24h: c.high_24h,
      low_24h: c.low_24h,
      ath: c.ath,
      atl: c.atl,
    }));
    cacheTs = Date.now();
    return cached!;
  } catch (e: any) {
    console.warn('[CoinGecko] fetch failed:', e.message);
    return cached ?? [];
  }
}

export function getCoinBySymbol(prices: CoinPrice[], sym: string): CoinPrice | undefined {
  const s = sym.toLowerCase();
  return prices.find(p => p.symbol === s || p.id === s);
}

/**
 * Parse a crypto price-target market question.
 * Examples:
 *   "Will Bitcoin reach $70,000 February 23-March 1?"  → { coin: 'bitcoin', target: 70000, direction: 'above' }
 *   "Will the price of Bitcoin be above $68,000 on March 3?" → { coin: 'bitcoin', target: 68000, direction: 'above' }
 *   "Will Bitcoin dip to $62,000 February 23-March 1?"  → { coin: 'bitcoin', target: 62000, direction: 'below' }
 *   "Will Ethereum reach $2,200 ..."                    → { coin: 'ethereum', target: 2200, direction: 'above' }
 */
export interface ParsedCryptoMarket {
  coin: string;
  symbol: string;
  target: number;
  targetHigh?: number; // for "between $X and $Y" markets
  direction: 'above' | 'below' | 'between';
}

export function parseCryptoPriceMarket(question: string): ParsedCryptoMarket | null {
  const q = question.toLowerCase();

  let coin: string | null = null;
  let symbol: string | null = null;
  for (const [id, sym] of Object.entries(SYMBOLS)) {
    // Use word-boundary matching to avoid "MegaETH" matching "eth"
    const idRegex = new RegExp(`\\b${id}\\b`, 'i');
    const symRegex = new RegExp(`\\b${sym}\\b`, 'i');
    if (idRegex.test(q) || symRegex.test(q)) {
      coin = id;
      symbol = sym;
      break;
    }
  }
  if (!coin || !symbol) return null;

  // "between $X and $Y" pattern
  const betweenMatch = question.match(/between\s+\$([0-9,]+(?:\.\d+)?)\s+and\s+\$([0-9,]+(?:\.\d+)?)/i);
  if (betweenMatch) {
    const lo = parseFloat(betweenMatch[1].replace(/,/g, ''));
    const hi = parseFloat(betweenMatch[2].replace(/,/g, ''));
    if (!isNaN(lo) && !isNaN(hi) && lo > 0 && hi > 0) {
      return { coin, symbol, target: Math.min(lo, hi), targetHigh: Math.max(lo, hi), direction: 'between' };
    }
  }

  // Match price with optional k/m/b suffix (e.g. $1m, $75k, $1.5B)
  const priceMatch = question.match(/\$([0-9,]+(?:\.\d+)?)\s*([kmb])?(?:illion|ill)?/i);
  if (!priceMatch) return null;
  let target = parseFloat(priceMatch[1].replace(/,/g, ''));
  if (isNaN(target) || target <= 0) return null;
  const suffix = (priceMatch[2] || '').toLowerCase();
  if (suffix === 'k') target *= 1_000;
  else if (suffix === 'm') target *= 1_000_000;
  else if (suffix === 'b') target *= 1_000_000_000;

  // Sanity: crypto price targets should be in a reasonable range for the coin
  // Skip obviously non-price targets (e.g. market cap numbers)
  if (coin === 'bitcoin' && (target < 100 || target > 10_000_000)) return null;
  if (coin === 'ethereum' && (target < 10 || target > 1_000_000)) return null;
  if (coin === 'solana' && (target < 1 || target > 100_000)) return null;

  const direction: 'above' | 'below' =
    q.includes('dip') || q.includes('below') || q.includes('drop') || q.includes('fall') || q.includes('less than')
      ? 'below'
      : 'above';

  return { coin, symbol, target, direction };
}

// ─── Simple binary-option fair value (log-normal model) ─────────────────────

/**
 * Estimate the fair probability that price reaches a target within `hoursLeft`
 * using a simple log-normal random walk (Black-Scholes digital option).
 *
 * annualVol: annualized volatility (e.g. 0.60 = 60% for BTC)
 */
export function binaryOptionFairValue(
  spot: number,
  strike: number,
  hoursLeft: number,
  annualVol: number,
  direction: 'above' | 'below',
): number {
  if (hoursLeft <= 0) {
    if (direction === 'above') return spot >= strike ? 1 : 0;
    return spot <= strike ? 1 : 0;
  }

  const T = hoursLeft / (365.25 * 24);
  const sigma = annualVol;
  const d2 = (Math.log(spot / strike) + (-0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const probAbove = normalCDF(d2);

  return direction === 'above' ? probAbove : (1 - probAbove);
}

/**
 * Fair value for "between $lo and $hi" (range binary).
 */
export function rangeBinaryFairValue(
  spot: number,
  lo: number,
  hi: number,
  hoursLeft: number,
  annualVol: number,
): number {
  const pAboveLo = binaryOptionFairValue(spot, lo, hoursLeft, annualVol, 'above');
  const pAboveHi = binaryOptionFairValue(spot, hi, hoursLeft, annualVol, 'above');
  return Math.max(0, pAboveLo - pAboveHi);
}

// Standard normal CDF (Abramowitz & Stegun approximation)
function normalCDF(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

// Default annualized vols (rough estimates, can be tuned)
export const DEFAULT_VOLS: Record<string, number> = {
  bitcoin: 0.55,
  ethereum: 0.70,
  solana: 0.90,
};

/**
 * Given a crypto price-target market, return how far the actual price is
 * from the target, and whether it's realistic to hit it.
 */
export function cryptoPriceReality(
  currentPrice: number,
  target: number,
  direction: 'above' | 'below',
  hoursLeft: number,
): {
  distancePct: number; // how far away in % (positive = needs to move that much)
  isRealistic: boolean;
  impliedMove: string;
} {
  const distancePct =
    direction === 'above'
      ? ((target - currentPrice) / currentPrice) * 100
      : ((currentPrice - target) / currentPrice) * 100;

  // Max plausible move per hour in crypto (very generous ~0.5%/hr)
  const maxMovePctPerHour = 0.5;
  const maxPlausibleMove = maxMovePctPerHour * Math.max(hoursLeft, 1);

  const isRealistic = distancePct <= maxPlausibleMove;

  const impliedMove =
    direction === 'above'
      ? `needs +${distancePct.toFixed(1)}% (${currentPrice.toFixed(0)} → ${target})`
      : `needs -${distancePct.toFixed(1)}% (${currentPrice.toFixed(0)} → ${target})`;

  return { distancePct, isRealistic, impliedMove };
}

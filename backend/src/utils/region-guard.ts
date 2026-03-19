/**
 * Region guard: block CLOB/live trading when current IP is in a blocked country.
 * Default list matches Polymarket's geographic restrictions (blocked + close-only)
 * so we never send orders from a region that could get the account banned.
 * @see https://docs.polymarket.com/polymarket-learn/FAQ/geoblocking
 * @see https://help.polymarket.com/en/articles/13364163-geographic-restrictions
 */

import axios from 'axios';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const IP_CHECK_URL = 'https://ipinfo.io/json';

let cachedCountry: string | null = null;
let cachedAt = 0;

/** Polymarket blocked + close-only: AU,BE,BY,BI,CF,CD,CU,DE,ET,FR,GB,IR,IQ,IT,KP,LB,LY,MM,NI,NL,PL,RU,SG,SO,SS,SD,SY,TH,TW,UA,UM,US,VE,YE,ZW */
const DEFAULT_BLOCKED =
  'AU,BE,BY,BI,CF,CD,CU,DE,ET,FR,GB,IR,IQ,IT,KP,LB,LY,MM,NI,NL,PL,RU,SG,SO,SS,SD,SY,TH,TW,UA,UM,US,VE,YE,ZW';

/** Comma-separated list of country codes to block. Unset or empty = use DEFAULT_BLOCKED. */
const _raw = (process.env.BLOCKED_COUNTRIES ?? DEFAULT_BLOCKED).toUpperCase().split(',').map((c) => c.trim()).filter(Boolean);
const BLOCKED_COUNTRIES = _raw.length > 0 ? _raw : DEFAULT_BLOCKED.toUpperCase().split(',').map((c) => c.trim()).filter(Boolean);

export function getBlockedCountries(): string[] {
  return [...BLOCKED_COUNTRIES];
}

export async function getCurrentCountry(): Promise<string | null> {
  if (Date.now() - cachedAt < CACHE_TTL_MS && cachedCountry !== undefined) {
    return cachedCountry;
  }
  try {
    const res = await axios.get(IP_CHECK_URL, { timeout: 5000 });
    const country = (res.data?.country as string) || null;
    cachedCountry = country ? country.toUpperCase() : null;
    cachedAt = Date.now();
    return cachedCountry;
  } catch {
    cachedCountry = null;
    cachedAt = Date.now();
    return null;
  }
}

/**
 * Returns true if the current IP is allowed for CLOB/live trading.
 * Fail closed: if country cannot be determined, block trading rather than risk
 * sending a live/authenticated request from a blocked region.
 */
export async function isRegionAllowedForTrading(): Promise<boolean> {
  const country = await getCurrentCountry();
  if (!country) {
    return false;
  }
  const blocked = BLOCKED_COUNTRIES.includes(country);
  return !blocked;
}

/**
 * Sync version for use when you already have a cached country.
 * Prefer isRegionAllowedForTrading() to ensure fresh check when cache expired.
 */
export function isCountryBlocked(countryCode: string): boolean {
  return BLOCKED_COUNTRIES.includes(countryCode.toUpperCase());
}

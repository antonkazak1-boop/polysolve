import axios from 'axios';

const BASE = 'https://api.binance.com/api/v3';

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export type KlineInterval = '5m' | '15m' | '1h' | '4h' | '1d';

interface CacheEntry {
  data: Kline[];
  ts: number;
}

const TTL: Record<KlineInterval, number> = {
  '5m': 10_000,
  '15m': 15_000,
  '1h': 60_000,
  '4h': 120_000,
  '1d': 300_000,
};

const cache = new Map<string, CacheEntry>();

function cacheKey(symbol: string, interval: KlineInterval, limit: number): string {
  return `${symbol}:${interval}:${limit}`;
}

function parseKlines(raw: any[]): Kline[] {
  return raw.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
}

export async function getKlines(
  symbol: string,
  interval: KlineInterval,
  limit: number = 200,
  bypassCache = false,
): Promise<Kline[]> {
  const key = cacheKey(symbol, interval, limit);
  const cached = cache.get(key);
  if (!bypassCache && cached && Date.now() - cached.ts < TTL[interval]) return cached.data;

  const res = await axios.get(`${BASE}/klines`, {
    params: { symbol, interval, limit },
    timeout: 10_000,
  });

  const klines = parseKlines(res.data ?? []);
  cache.set(key, { data: klines, ts: Date.now() });
  return klines;
}

export async function getBtcKlines(interval: KlineInterval, limit = 200, bypassCache = false): Promise<Kline[]> {
  return getKlines('BTCUSDT', interval, limit, bypassCache);
}

export async function getEthKlines(interval: KlineInterval, limit = 200, bypassCache = false): Promise<Kline[]> {
  return getKlines('ETHUSDT', interval, limit, bypassCache);
}

export async function getSolKlines(interval: KlineInterval, limit = 200, bypassCache = false): Promise<Kline[]> {
  return getKlines('SOLUSDT', interval, limit, bypassCache);
}

/** Returns klines for any supported coin symbol */
export async function getCoinKlines(coin: string, interval: KlineInterval, limit = 200): Promise<Kline[]> {
  const symbolMap: Record<string, string> = { bitcoin: 'BTCUSDT', ethereum: 'ETHUSDT', solana: 'SOLUSDT' };
  const symbol = symbolMap[coin];
  if (!symbol) throw new Error(`Unsupported coin: ${coin}`);
  return getKlines(symbol, interval, limit);
}

/** Official Binance 5m candle for this window start (ms UTC). */
export function findKlineByOpenTime(klines: Kline[], openTimeMs: number): Kline | undefined {
  return klines.find(k => k.openTime === openTimeMs);
}

export async function getCurrentBtcPrice(): Promise<number> {
  const klines = await getBtcKlines('5m', 1);
  return klines.length > 0 ? klines[klines.length - 1].close : 0;
}

export function extractArrays(klines: Kline[]) {
  return {
    opens: klines.map(k => k.open),
    highs: klines.map(k => k.high),
    lows: klines.map(k => k.low),
    closes: klines.map(k => k.close),
    volumes: klines.map(k => k.volume),
    times: klines.map(k => k.openTime),
  };
}

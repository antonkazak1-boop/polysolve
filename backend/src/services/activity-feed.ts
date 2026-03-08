/**
 * Smart-money live activity feed.
 *
 * Polls recent trades for top leaderboard wallets + watched wallets every 60s.
 * Stores latest N events in memory; served via GET /api/wallets/activity-feed.
 */

import { gammaClient } from '../clients/gamma-client';
import { getWatchedWallets } from './wallet-profile';
import { readCacheBulk } from './trader-cache';

export interface FeedEvent {
  id: string;           // unique key
  ts: number;           // unix ms
  address: string;
  shortAddr: string;
  userName?: string;
  outcome: string;      // YES / NO
  side: 'BUY' | 'SELL';
  price: number;        // 0-1 (fraction of $1)
  size: number;         // shares
  usdValue: number;     // approx USD
  title: string;        // market/event title
  marketId?: string;
  eventSlug?: string;
  category?: string;
  isWhale: boolean;     // usdValue >= 5000
  isWatched: boolean;
  rank?: string;
  hoursToResolution?: number;
}

// ──────────────────────────────────────────────
// In-memory store
// ──────────────────────────────────────────────

const MAX_EVENTS = 200;
let feedEvents: FeedEvent[] = [];
let lastRefreshed: number | null = null;
let isRefreshing = false;

export function getFeedEvents(limit = 50): FeedEvent[] {
  return feedEvents.slice(0, Math.min(limit, MAX_EVENTS));
}

export function getFeedMeta() {
  return { lastRefreshed, count: feedEvents.length, isRefreshing };
}

// ──────────────────────────────────────────────
// Normalise raw trade from Polymarket Data API
// ──────────────────────────────────────────────

function shortAddr(a: string) {
  if (!a || a.length < 10) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'Politics': ['trump', 'biden', 'election', 'president', 'congress', 'senate', 'democrat', 'republican', 'policy', 'government', 'politics', 'nato'],
  'Crypto': ['crypto', 'bitcoin', 'ethereum', 'btc', 'eth', 'solana', 'defi', 'nft', 'binance', 'coinbase'],
  'Sports': ['nfl', 'nba', 'football', 'soccer', 'tennis', 'ufc', 'mma', 'baseball', 'sport', 'fc', 'vs.', 'win ', 'draw', 'score', 'match', 'league'],
  'Iran/Middle East': ['iran', 'iranian', 'nuclear', 'israel', 'hamas', 'middle east', 'tehran'],
  'Economy': ['fed', 'gdp', 'inflation', 'interest rate', 'recession', 'tariff', 'economy'],
};

function detectCategory(title: string): string {
  const lower = title.toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(kw => lower.includes(kw))) return cat;
  }
  return 'General';
}

function normalizeEvent(raw: any, address: string, meta: { userName?: string; rank?: string; isWatched: boolean }): FeedEvent | null {
  try {
    const ts = raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now();
    const outcome = (raw.outcome || raw.side || '').toUpperCase();
    const side: 'BUY' | 'SELL' = (raw.type || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const price = parseFloat(raw.price ?? raw.averagePrice ?? '0') || 0;
    const size = parseFloat(raw.size ?? raw.shares ?? '0') || 0;
    const usdValue = price > 0 && size > 0 ? price * size : parseFloat(raw.usdcSize ?? raw.amount ?? '0') || 0;

    if (usdValue < 10) return null; // skip dust

    const title: string = raw.title || raw.market || raw.question || raw.eventTitle || '';
    const id = `${address}-${ts}-${size}-${price}`;
    const category = raw.category || detectCategory(title);

    return {
      id,
      ts,
      address,
      shortAddr: shortAddr(address),
      userName: meta.userName,
      outcome,
      side,
      price,
      size,
      usdValue,
      title,
      marketId: raw.conditionId || raw.marketId || undefined,
      eventSlug: raw.eventSlug || raw.slug || undefined,
      category,
      isWhale: usdValue >= 5000,
      isWatched: meta.isWatched,
      rank: meta.rank,
    };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// Core refresh
// ──────────────────────────────────────────────

async function refresh() {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
    // 1. Collect addresses: top 15 from leaderboard + all watched
    const [leaderboard, watched] = await Promise.all([
      gammaClient.getTraderLeaderboard({ limit: 15, timePeriod: 'WEEK', orderBy: 'PNL' }).catch(() => []),
      getWatchedWallets().catch(() => []),
    ]);

    const watchedSet = new Set(watched.map((w: any) => w.address.toLowerCase()));

    const leaderAddresses = leaderboard.map((t: any) =>
      (t.proxyWallet || t.proxy_wallet_address || '').toLowerCase()
    ).filter(Boolean);

    const watchedAddresses = watched.map((w: any) => w.address.toLowerCase());

    // Union, deduplicated, capped at 25
    const allAddresses = [...new Set([...leaderAddresses, ...watchedAddresses])].slice(0, 25);
    if (!allAddresses.length) return;

    // 2. Bulk read name/rank from cache
    const cacheMap = await readCacheBulk(allAddresses);
    const leaderMap = new Map<string, any>();
    for (const t of leaderboard) {
      const a = (t.proxyWallet || '').toLowerCase();
      if (a) leaderMap.set(a, t);
    }
    const watchedMap = new Map<string, any>();
    for (const w of watched) watchedMap.set(w.address.toLowerCase(), w);

    // 3. Fetch trades for each wallet with stagger
    const newEvents: FeedEvent[] = [];
    const seenIds = new Set(feedEvents.map(e => e.id));

    for (let i = 0; i < allAddresses.length; i++) {
      const addr = allAddresses[i];
      if (i > 0) await new Promise(r => setTimeout(r, 250));

      try {
        const trades = await gammaClient.getWalletTrades(addr, 20);
        const leader = leaderMap.get(addr);
        const cached = cacheMap.get(addr);
        const watchedEntry = watchedMap.get(addr);

        const meta = {
          userName: cached?.userName || leader?.userName || watchedEntry?.userName || undefined,
          rank: leader?.rank || watchedEntry?.rank || undefined,
          isWatched: watchedSet.has(addr),
        };

        for (const raw of trades) {
          const ev = normalizeEvent(raw, addr, meta);
          if (ev && !seenIds.has(ev.id)) {
            newEvents.push(ev);
            seenIds.add(ev.id);
          }
        }
      } catch { /* skip this wallet */ }
    }

    // Enrich new events with hoursToResolution (batch, best-effort)
    if (newEvents.length > 0) {
      const marketIds = [...new Set(newEvents.filter(e => e.marketId).map(e => e.marketId!))];
      const endDateMap = new Map<string, number>();
      for (const mid of marketIds.slice(0, 30)) {
        try {
          const m = await gammaClient.getMarketById(mid).catch(() => null);
          if (m?.endDate) endDateMap.set(mid, new Date(m.endDate).getTime());
        } catch { /* skip */ }
      }
      for (const ev of newEvents) {
        if (ev.marketId && endDateMap.has(ev.marketId)) {
          const endMs = endDateMap.get(ev.marketId)!;
          const hoursLeft = (endMs - ev.ts) / 3600000;
          if (hoursLeft > 0) ev.hoursToResolution = Math.round(hoursLeft * 10) / 10;
        }
      }

      // Merge new events at the front, sorted by newest first
      feedEvents = [...newEvents, ...feedEvents]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, MAX_EVENTS);
    }

    lastRefreshed = Date.now();
    console.log(`[activity-feed] refreshed — ${feedEvents.length} events total, ${newEvents.length} new`);
  } catch (err: any) {
    console.error('[activity-feed] refresh error:', err.message);
  } finally {
    isRefreshing = false;
  }
}

// ──────────────────────────────────────────────
// Start background poller
// ──────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000;

export function startActivityFeedPoller() {
  // Run immediately, then every POLL_INTERVAL_MS
  refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
  console.log('[activity-feed] poller started (interval: 60s)');
}

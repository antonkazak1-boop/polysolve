import { gammaClient, parseOutcomePrices, parseOutcomes } from '../clients/gamma-client';
import prisma from '../config/database';
import { writeCache } from './trader-cache';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WalletPosition {
  marketId: string;
  conditionId?: string;
  eventSlug?: string;  // for link to /events/[eventSlug]
  eventId?: string;
  title: string;
  outcome: string;     // YES | NO
  size: number;        // shares
  value: number;       // USD value
  price: number;       // current price per share
  initialValue?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  endDate?: string;
  category?: string;
}

export interface WalletTrade {
  id?: string;
  marketId?: string;
  eventSlug?: string;
  eventId?: string;
  title: string;
  outcome: string;
  side: string;   // BUY | SELL
  size: number;
  price: number;
  amount: number; // USD
  timestamp: string;
}

export interface WalletStats {
  totalPositions: number;
  totalValue: number;
  yesPositions: number;
  noPositions: number;
  yesPct: number;
  noPct: number;
  avgEntryPrice: number;
  avgPositionSize: number;
  categoryBreakdown: Record<string, { count: number; value: number }>;
  priceRangeBreakdown: {
    cheap: number;    // < 20¢
    medium: number;   // 20–60¢
    expensive: number; // > 60¢
  };
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

export interface WalletProfile {
  address: string;
  userName?: string;
  rank?: string;
  pnl?: number;
  vol?: number;
  isWatched: boolean;
  label?: string;
  positions: WalletPosition[];
  recentTrades: WalletTrade[];
  stats: WalletStats;
  insights: string[];
  fetchedAt: string;
}

// ─── Category detection (reuse from signal-engine style) ─────────────────────

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'Politics': ['trump', 'biden', 'election', 'president', 'congress', 'senate', 'democrat', 'republican', 'policy', 'government', 'politics', 'nato'],
  'Crypto': ['crypto', 'bitcoin', 'ethereum', 'btc', 'eth', 'solana', 'defi', 'nft', 'binance', 'coinbase'],
  'Sports': ['nfl', 'nba', 'football', 'soccer', 'tennis', 'ufc', 'mma', 'baseball', 'sport'],
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

// ─── Profile builder ─────────────────────────────────────────────────────────

function buildStats(positions: WalletPosition[]): WalletStats {
  if (positions.length === 0) {
    return {
      totalPositions: 0, totalValue: 0,
      yesPositions: 0, noPositions: 0, yesPct: 0, noPct: 0,
      avgEntryPrice: 0, avgPositionSize: 0,
      categoryBreakdown: {},
      priceRangeBreakdown: { cheap: 0, medium: 0, expensive: 0 },
      unrealizedPnl: 0, unrealizedPnlPct: 0,
    };
  }

  const totalValue = positions.reduce((s, p) => s + (p.value || 0), 0);
  const yesPos = positions.filter(p => p.outcome === 'YES');
  const noPos = positions.filter(p => p.outcome === 'NO');

  const avgEntryPrice = positions.reduce((s, p) => s + p.price, 0) / positions.length;
  const avgPositionSize = totalValue / positions.length;

  const categoryBreakdown: Record<string, { count: number; value: number }> = {};
  for (const p of positions) {
    const cat = p.category || detectCategory(p.title);
    if (!categoryBreakdown[cat]) categoryBreakdown[cat] = { count: 0, value: 0 };
    categoryBreakdown[cat].count++;
    categoryBreakdown[cat].value += p.value || 0;
  }

  const priceRangeBreakdown = {
    cheap: positions.filter(p => p.price < 0.20).length,
    medium: positions.filter(p => p.price >= 0.20 && p.price <= 0.60).length,
    expensive: positions.filter(p => p.price > 0.60).length,
  };

  const unrealizedPnl = positions.reduce((s, p) => s + (p.cashPnl || 0), 0);
  const invested = positions.reduce((s, p) => s + (p.initialValue || p.value || 0), 0);
  const unrealizedPnlPct = invested > 0 ? (unrealizedPnl / invested) * 100 : 0;

  return {
    totalPositions: positions.length,
    totalValue,
    yesPositions: yesPos.length,
    noPositions: noPos.length,
    yesPct: Math.round((yesPos.length / positions.length) * 100),
    noPct: Math.round((noPos.length / positions.length) * 100),
    avgEntryPrice,
    avgPositionSize,
    categoryBreakdown,
    priceRangeBreakdown,
    unrealizedPnl,
    unrealizedPnlPct,
  };
}

function buildInsights(stats: WalletStats, trades: WalletTrade[]): string[] {
  const insights: string[] = [];

  // YES/NO bias
  if (stats.yesPct >= 70) {
    insights.push(`Bullish bias: ${stats.yesPct}% YES positions — this wallet bets on things happening`);
  } else if (stats.noPct >= 70) {
    insights.push(`Bearish/contrarian: ${stats.noPct}% NO positions — fades consensus`);
  } else {
    insights.push(`Balanced: ${stats.yesPct}% YES / ${stats.noPct}% NO — plays both sides`);
  }

  // Price range preference
  const { cheap, medium, expensive } = stats.priceRangeBreakdown;
  const total = cheap + medium + expensive;
  if (total > 0) {
    if (cheap / total > 0.5) {
      insights.push(`Asymmetric hunter: ${Math.round(cheap/total*100)}% of positions are cheap outcomes (<20¢) — chasing big multipliers`);
    } else if (expensive / total > 0.5) {
      insights.push(`Favorite player: ${Math.round(expensive/total*100)}% of positions priced above 60¢ — bets on likely outcomes`);
    } else {
      insights.push(`Mid-range bettor: focuses on 20–60¢ outcomes — balanced risk/reward`);
    }
  }

  // Top category
  const topCat = Object.entries(stats.categoryBreakdown)
    .sort(([,a],[,b]) => b.count - a.count)[0];
  if (topCat) {
    insights.push(`Specialty: ${topCat[0]} (${topCat[1].count} positions, $${(topCat[1].value/1000).toFixed(1)}K value)`);
  }

  // Position size
  if (stats.avgPositionSize > 10000) {
    insights.push(`High conviction: avg position $${(stats.avgPositionSize/1000).toFixed(1)}K — whale-level sizing`);
  } else if (stats.avgPositionSize > 2000) {
    insights.push(`Medium sizing: avg position $${(stats.avgPositionSize/1000).toFixed(1)}K`);
  } else {
    insights.push(`Diversified: avg position $${stats.avgPositionSize.toFixed(0)} — many small bets`);
  }

  // Unrealized PnL
  if (stats.unrealizedPnl > 0) {
    insights.push(`Currently up $${(stats.unrealizedPnl/1000).toFixed(1)}K unrealized (+${stats.unrealizedPnlPct.toFixed(1)}%) on open positions`);
  } else if (stats.unrealizedPnl < -500) {
    insights.push(`Currently down $${Math.abs(stats.unrealizedPnl/1000).toFixed(1)}K unrealized on open positions`);
  }

  return insights;
}

function normalizePosition(p: any): WalletPosition {
  const rawOutcome = String(p.outcome || p.side || 'YES').trim();
  const upperOutcome = rawOutcome.toUpperCase();
  const outcome = upperOutcome === 'YES' || upperOutcome === 'NO' ? upperOutcome : rawOutcome;
  const size = parseFloat(p.size ?? p.shares ?? '0') || 0;
  const price = parseFloat(p.curPrice ?? p.price ?? p.lastTradePrice ?? '0') || 0;
  const value = parseFloat(p.curValue ?? p.value ?? '0') || size * price;
  const initialValue = parseFloat(p.initialValue ?? p.cashBalance ?? '0') || 0;
  const cashPnl = parseFloat(p.cashPnl ?? '0') || (value - initialValue);
  const percentPnl = initialValue > 0 ? ((value - initialValue) / initialValue) * 100 : 0;

  const title = p.title ?? p.market?.title ?? p.question ?? 'Unknown Market';
  const category = detectCategory(title);

  const eventSlug = p.eventSlug ?? p.event_slug ?? p.market?.slug ?? p.slug;
  const eventId = p.eventId ?? p.event_id ?? eventSlug;

  return {
    marketId: p.marketId ?? p.conditionId ?? p.asset ?? '',
    conditionId: p.conditionId,
    eventSlug,
    eventId,
    title,
    outcome,
    size,
    value,
    price,
    initialValue,
    currentValue: value,
    cashPnl,
    percentPnl,
    endDate: p.endDate ?? p.market?.endDate,
    category,
  };
}

function normalizeTrade(t: any): WalletTrade {
  const amount = parseFloat(t.usdcSize ?? t.amount ?? t.size ?? '0') || 0;
  const size = parseFloat(t.size ?? t.shares ?? '0') || 0;
  const price = size > 0 ? amount / size : parseFloat(t.price ?? '0') || 0;
  const outcome = (t.outcome ?? 'yes').toUpperCase() === 'NO' ? 'NO' : 'YES';
  const side = (t.type ?? t.tradeType ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

  const ts = t.timestamp
    ? new Date(typeof t.timestamp === 'number' ? t.timestamp * 1000 : t.timestamp).toISOString()
    : new Date().toISOString();

  const eventSlug = t.eventSlug ?? t.event_slug ?? t.market?.slug ?? t.slug;
  const eventId = t.eventId ?? t.event_id ?? eventSlug;

  return {
    id: t.id ?? t.transactionHash,
    marketId: t.marketId ?? t.conditionId,
    eventSlug,
    eventId,
    title: t.title ?? t.question ?? 'Unknown Market',
    outcome,
    side,
    size,
    price,
    amount,
    timestamp: ts,
  };
}

// ─── Main profile fetch ───────────────────────────────────────────────────────

export async function getWalletProfile(address: string): Promise<WalletProfile> {
  const addr = address.toLowerCase();

  // Run in parallel
  const [rawPositions, rawTrades, leaderboard, watched] = await Promise.all([
    gammaClient.getWalletPositions(addr).catch(() => []),
    gammaClient.getWalletTrades(addr, 50).catch(() => []),
    gammaClient.getTraderLeaderboard({ limit: 50, timePeriod: 'ALL' }).catch(() => []),
    (prisma as any).watchedWallet.findUnique({ where: { address: addr } }),
  ]);

  // Find this wallet in leaderboard
  const leaderEntry = leaderboard.find((t: any) =>
    (t.proxyWallet ?? t.proxy_wallet_address ?? '').toLowerCase() === addr
  );

  let positions = rawPositions.map(normalizePosition).filter(p => p.size > 0.001 || p.value > 0.1);
  let recentTrades = rawTrades.slice(0, 30).map(normalizeTrade);

  // Enrich eventSlug when missing: resolve conditionId -> event slug via Gamma (normalize for matching)
  const norm = (s: string) => (s || '').toLowerCase().replace(/^0x/, '');
  const missingSlug = [...positions, ...recentTrades].filter(p => !p.eventSlug && (p.marketId || (p as any).conditionId));
  if (missingSlug.length > 0) {
    try {
      const events = await gammaClient.getEvents({ limit: 250, order: 'volume24hr', ascending: false });
      const condToSlug: Record<string, string> = {};
      for (const ev of events) {
        const slug = ev.slug || ev.id;
        for (const m of ev.markets || []) {
          const cid = m.conditionId || (m as any).id || '';
          if (cid) {
            const n = norm(cid);
            if (!condToSlug[n]) condToSlug[n] = slug;
          }
        }
      }
      const setSlug = (p: { eventSlug?: string; eventId?: string; marketId?: string }) => {
        if (p.eventSlug) return;
        const cid = p.marketId || (p as any).conditionId;
        if (!cid) return;
        const slug = condToSlug[norm(cid)];
        if (slug) {
          p.eventSlug = slug;
          p.eventId = slug;
        }
      };
      positions.forEach(setSlug);
      recentTrades.forEach(setSlug);
    } catch { /* non-critical */ }
  }

  const stats = buildStats(positions);
  const insights = buildInsights(stats, recentTrades);

  const userName = leaderEntry?.userName || watched?.userName || undefined;
  const vol = leaderEntry?.vol || watched?.vol || undefined;

  // Persist to local cache in background (non-blocking)
  setImmediate(() => {
    writeCache(addr, { userName, positions, recentTrades, vol }).catch(() => {});
  });

  return {
    address: addr,
    userName,
    rank: leaderEntry?.rank || watched?.rank || undefined,
    pnl: leaderEntry?.pnl || watched?.pnl || undefined,
    vol,
    isWatched: !!watched,
    label: watched?.label || undefined,
    positions,
    recentTrades,
    stats,
    insights,
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Convergence: markets where multiple watched/top wallets hold positions ───

export interface ConvergenceWallet {
  address: string;
  userName?: string;
  rank?: string;
  outcome: string; // YES/NO or market-specific label (e.g. DET, NSH)
  value: number;       // current USD value of position
  entryPrice: number;  // estimated entry price (initialValue / size)
  currentPrice: number;
  pnl: number;
  eventSlug?: string;
}

export interface ConvergenceMarket {
  marketId: string;
  title: string;
  category: string;
  eventSlug?: string;
  eventId?: string;
  wallets: ConvergenceWallet[];
  consensus: string; // YES/NO or market-specific label, SPLIT when no strong consensus
  consensusPct: number;
  totalValue: number;
  walletCount: number;
  avgEntryPrice: number;
  endDate?: string;          // ISO date when market resolves
  hoursToResolution?: number; // hours remaining
  currentYesPrice: number;     // current market price for YES
  currentNoPrice: number;      // current market price for NO
  currentConsensusPrice?: number; // price for consensus outcome label
  potentialRoiNow?: number;   // ROI if entering now at current price toward consensus
}

// ─── Convergence Cache ─────────────────────────────────────────────────────────
const CONVERGENCE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

interface ConvergenceCacheEntry {
  data: ConvergenceMarket[];
  timestamp: number;
  topN: number;
  minValue: number;
}

let convergenceCache: ConvergenceCacheEntry | null = null;

export function invalidateConvergenceCache(): void {
  convergenceCache = null;
}

export async function detectConvergence(topN = 20, minValue = 100): Promise<ConvergenceMarket[]> {
  // Check cache first
  const cacheNow = Date.now();
  if (convergenceCache &&
      convergenceCache.topN === topN &&
      convergenceCache.minValue === minValue &&
      (cacheNow - convergenceCache.timestamp) < CONVERGENCE_CACHE_TTL) {
    console.log(`[convergence] Cache hit (${Math.round((cacheNow - convergenceCache.timestamp)/1000)}s old)`);
    return convergenceCache.data;
  }

  console.log(`[convergence] Scanning with topN=${topN}, minValue=${minValue}...`);
  // Get top wallets from leaderboard + watched wallets
  const [leaderboard, watched] = await Promise.all([
    gammaClient.getTraderLeaderboard({ limit: topN, timePeriod: 'ALL' }).catch(() => []),
    (prisma as any).watchedWallet.findMany({ take: 50 }),
  ]);

  const walletAddrs = new Set<string>();
  const walletMeta = new Map<string, { userName?: string; rank?: string }>();

  for (const t of leaderboard) {
    const addr = (t.proxyWallet ?? t.proxy_wallet_address ?? '').toLowerCase();
    if (addr) {
      walletAddrs.add(addr);
      walletMeta.set(addr, { userName: t.userName || undefined, rank: t.rank || undefined });
    }
  }
  for (const w of watched) {
    walletAddrs.add(w.address.toLowerCase());
    if (!walletMeta.has(w.address.toLowerCase())) {
      walletMeta.set(w.address.toLowerCase(), { userName: w.userName || undefined });
    }
  }

  // Fetch positions for each wallet
  const positionsByWallet = new Map<string, WalletPosition[]>();
  const addrs = Array.from(walletAddrs).slice(0, 20);

  await Promise.allSettled(
    addrs.map(async (addr, i) =>
      new Promise<void>(resolve => setTimeout(async () => {
        const raw = await gammaClient.getWalletPositions(addr).catch(() => []);
        positionsByWallet.set(addr, raw.map(normalizePosition).filter(p => p.value >= minValue));
        resolve();
      }, i * 150))
    )
  );

  // Find markets where 2+ wallets have positions
  const marketMap = new Map<string, ConvergenceMarket>();

  for (const [addr, positions] of positionsByWallet) {
    const meta = walletMeta.get(addr);
    for (const pos of positions) {
      if (!pos.marketId) continue;

      if (!marketMap.has(pos.marketId)) {
        marketMap.set(pos.marketId, {
          marketId: pos.marketId,
          title: pos.title,
          category: pos.category || 'General',
          eventSlug: pos.eventSlug,
          eventId: pos.eventId,
          wallets: [],
          consensus: 'YES',
          consensusPct: 0,
          totalValue: 0,
          walletCount: 0,
          avgEntryPrice: 0,
          currentYesPrice: 0.5,
          currentNoPrice: 0.5,
        });
      }

      const cm = marketMap.get(pos.marketId)!;
      // Estimate entry price: initialValue / size gives avg cost per share
      const entryPrice = pos.size > 0 && pos.initialValue && pos.initialValue > 0
        ? pos.initialValue / pos.size
        : pos.price;
      const pnl = pos.cashPnl ?? (pos.value - (pos.initialValue ?? pos.value));

      cm.wallets.push({
        address: addr,
        userName: meta?.userName,
        rank: meta?.rank,
        outcome: pos.outcome,
        value: pos.value,
        entryPrice: Math.max(0.001, entryPrice),
        currentPrice: pos.price,
        pnl,
        eventSlug: pos.eventSlug,
      });
      cm.totalValue += pos.value;

      // Propagate eventSlug to market if not yet set
      if (!cm.eventSlug && pos.eventSlug) {
        cm.eventSlug = pos.eventSlug;
        cm.eventId = pos.eventId;
      }
    }
  }

  // Enrich market data with endDate and current prices from first wallet's position data
  // (positions carry current market price at fetch time)
  for (const m of marketMap.values()) {
    // Try to get endDate from any position
    const firstWithDate = m.wallets.find(w => {
      // Lookup original position to get endDate - we need to re-fetch or cache it
      // For now, estimate from wallet positions we have
      return false; // placeholder - we'll fetch events data next
    });
  }

  // Fetch events data to get endDates and current prices
  const allMarketIds = Array.from(marketMap.keys());
  const marketMeta = new Map<string, { endDate?: string; outcomes: string[]; prices: number[] }>();

  if (allMarketIds.length > 0) {
    try {
      const events = await gammaClient.getEvents({ limit: 200, active: true, closed: false });
      for (const ev of events) {
        for (const mk of ev.markets || []) {
          const mid = mk.id || (mk as any).conditionId;
          if (!mid || !marketMap.has(mid)) continue;
          const prices = parseOutcomePrices(mk.outcomePrices ?? '[]');
          const outcomes = parseOutcomes((mk as any).outcomes ?? '[]');
          marketMeta.set(mid, {
            endDate: mk.endDate ?? (mk as any).resolutionDate,
            outcomes,
            prices,
          });
        }
      }
    } catch { /* ignore enrichment errors */ }
  }

  // Filter 2+ wallets, compute consensus, avg entry, time to resolution, ROI
  const scanNow = Date.now();
  const convergent = Array.from(marketMap.values())
    .filter(m => m.wallets.length >= 2)
    .map(m => {
      const total = m.wallets.length;
      const outcomeCount = new Map<string, number>();
      for (const w of m.wallets) {
        const label = String(w.outcome || '').trim();
        outcomeCount.set(label, (outcomeCount.get(label) ?? 0) + 1);
      }
      const sortedOutcomes = [...outcomeCount.entries()].sort((a, b) => b[1] - a[1]);
      const topOutcome = sortedOutcomes[0]?.[0] ?? 'SPLIT';
      const topCount = sortedOutcomes[0]?.[1] ?? 0;
      const topPct = total > 0 ? Math.round((topCount / total) * 100) : 0;

      // Strong consensus only if 70%+ wallets on same outcome
      const consensus = topPct >= 70 ? topOutcome : 'SPLIT';

      // Weighted avg entry price by position value
      const totalVal = m.wallets.reduce((s, w) => s + w.value, 0);
      const avgEntryPrice = totalVal > 0
        ? m.wallets.reduce((s, w) => s + w.entryPrice * w.value, 0) / totalVal
        : 0;

      // Market metadata
      const meta = marketMeta.get(m.marketId);
      const endDate = meta?.endDate;
      const hoursToResolution = endDate
        ? Math.max(0, Math.round((new Date(endDate).getTime() - scanNow) / 3600000))
        : undefined;
      const outcomes = meta?.outcomes ?? [];
      const prices = meta?.prices ?? [];
      const currentYesPrice = prices[0] ?? m.wallets[0]?.currentPrice ?? 0.5;
      const currentNoPrice = prices[1] ?? (1 - currentYesPrice);

      // Find current price of consensus outcome label (works for DET/NSH etc.)
      let currentConsensusPrice: number | undefined;
      if (consensus !== 'SPLIT') {
        const idx = outcomes.findIndex(o => o.toLowerCase() === String(consensus).toLowerCase());
        if (idx >= 0) currentConsensusPrice = prices[idx];
        // fallback for legacy YES/NO markets
        if (currentConsensusPrice == null && String(consensus).toUpperCase() === 'YES') currentConsensusPrice = currentYesPrice;
        if (currentConsensusPrice == null && String(consensus).toUpperCase() === 'NO') currentConsensusPrice = currentNoPrice;
      }

      // Potential ROI if entering NOW toward consensus side (label-aware)
      // Require a meaningful entry price (>= 5¢) to avoid division-near-zero nonsense
      // and skip near-resolved markets (opposite side >= 95¢)
      let potentialRoiNow = 0;
      const otherPrice = currentConsensusPrice != null ? (1 - currentConsensusPrice) : 0;
      if (
        consensus !== 'SPLIT' &&
        currentConsensusPrice != null &&
        currentConsensusPrice >= 0.05 &&     // at least 5¢ — not a near-zero lottery
        currentConsensusPrice < 0.95 &&       // not already almost resolved
        otherPrice < 0.95                     // opposite side not already at ~$1
      ) {
        const rawRoi = (1 - currentConsensusPrice) / currentConsensusPrice;
        potentialRoiNow = Math.min(rawRoi, 4); // cap at 400% ROI max — anything higher is near-resolved noise
      }

      return {
        ...m,
        walletCount: total,
        consensus,
        consensusPct: consensus === 'SPLIT' ? 50 : topPct,
        avgEntryPrice,
        endDate,
        hoursToResolution,
        currentYesPrice,
        currentNoPrice,
        currentConsensusPrice,
        potentialRoiNow: Math.round(potentialRoiNow * 100), // percent
      };
    })
    .sort((a, b) => b.walletCount - a.walletCount || b.totalValue - a.totalValue);

  const result = convergent.slice(0, 40);

  // Save to cache
  convergenceCache = {
    data: result,
    timestamp: Date.now(),
    topN,
    minValue,
  };
  console.log(`[convergence] Cached ${result.length} markets for 10 min`);

  // Save snapshots to history for win-rate tracking (async, don't block)
  setTimeout(() => saveConvergenceSnapshots(result).catch(() => {}), 0);

  return result;
}

// Save convergence snapshots to history (for later win-rate calculation)
async function saveConvergenceSnapshots(markets: ConvergenceMarket[]): Promise<void> {
  for (const m of markets) {
    try {
      // Only save if consensus is strong (YES/NO, not SPLIT) and 3+ wallets
      if (m.consensus === 'SPLIT' || m.walletCount < 3) continue;
      
      // Check if already saved recently (within 24h)
      const existing = await (prisma as any).convergenceHistory.findFirst({
        where: { marketId: m.marketId, detectedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      });
      if (existing) continue;

      await (prisma as any).convergenceHistory.create({
        data: {
          marketId: m.marketId,
          title: m.title,
          eventSlug: m.eventSlug,
          consensus: m.consensus,
          consensusPct: m.consensusPct,
          walletCount: m.walletCount,
          wallets: JSON.stringify(m.wallets.map(w => ({
            address: w.address,
            userName: w.userName,
            outcome: w.outcome,
            value: w.value,
            entryPrice: w.entryPrice,
          }))),
          totalValue: m.totalValue,
          avgEntryPrice: m.avgEntryPrice,
        },
      });
    } catch { /* skip individual failures */ }
  }
}

// Resolve convergence history when market closes
export async function resolveConvergenceHistory(marketId: string, winningOutcome: 'YES' | 'NO'): Promise<void> {
  const records = await (prisma as any).convergenceHistory.findMany({
    where: { marketId, resolved: false },
  });
  
  for (const r of records) {
    const won = r.consensus === winningOutcome;
    await (prisma as any).convergenceHistory.update({
      where: { id: r.id },
      data: {
        resolved: true,
        resolvedAt: new Date(),
        winningOutcome,
        won,
        actualYesPrice: winningOutcome === 'YES' ? 1 : 0,
      },
    });
  }
}

// Get win rate statistics for convergence signals
export async function getConvergenceWinRate(): Promise<{ 
  total: number; 
  resolved: number; 
  wins: number; 
  losses: number; 
  winRate: number;
  byConsensus: Record<string, { total: number; wins: number; winRate: number }>;
}> {
  const [total, resolved, wins] = await Promise.all([
    (prisma as any).convergenceHistory.count(),
    (prisma as any).convergenceHistory.count({ where: { resolved: true } }),
    (prisma as any).convergenceHistory.count({ where: { resolved: true, won: true } }),
  ]);
  
  const losses = resolved - wins;
  
  // By consensus type - count wins separately
  const [yesTotal, yesWins, noTotal, noWins] = await Promise.all([
    (prisma as any).convergenceHistory.count({ where: { resolved: true, consensus: 'YES' } }),
    (prisma as any).convergenceHistory.count({ where: { resolved: true, consensus: 'YES', won: true } }),
    (prisma as any).convergenceHistory.count({ where: { resolved: true, consensus: 'NO' } }),
    (prisma as any).convergenceHistory.count({ where: { resolved: true, consensus: 'NO', won: true } }),
  ]);
  
  const byConsensus: Record<string, { total: number; wins: number; winRate: number }> = {
    YES: { 
      total: yesTotal, 
      wins: yesWins, 
      winRate: yesTotal > 0 ? Math.round((yesWins / yesTotal) * 100) : 0 
    },
    NO: { 
      total: noTotal, 
      wins: noWins, 
      winRate: noTotal > 0 ? Math.round((noWins / noTotal) * 100) : 0 
    },
  };
  
  return {
    total,
    resolved,
    wins,
    losses,
    winRate: resolved > 0 ? Math.round((wins / resolved) * 100) : 0,
    byConsensus,
  };
}

// ─── Watched wallets CRUD ─────────────────────────────────────────────────────

export async function getWatchedWallets() {
  return (prisma as any).watchedWallet.findMany({ orderBy: { addedAt: 'desc' } });
}

export async function addWatchedWallet(address: string, label?: string, meta?: { userName?: string; pnl?: number; vol?: number; rank?: string }) {
  return (prisma as any).watchedWallet.upsert({
    where: { address: address.toLowerCase() },
    update: { label, ...meta, updatedAt: new Date() },
    create: { address: address.toLowerCase(), label, ...meta },
  });
}

export async function removeWatchedWallet(address: string) {
  return (prisma as any).watchedWallet.delete({ where: { address: address.toLowerCase() } });
}

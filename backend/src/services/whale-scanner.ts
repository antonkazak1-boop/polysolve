import { gammaClient, parseOutcomePrices, parseOutcomes } from '../clients/gamma-client';
import prisma from '../config/database';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WhaleAlert {
  id: string;
  tradeId: string | null;
  walletAddress: string;
  walletName: string | null;
  marketId: string;
  eventId: string | null;
  eventTitle: string;
  marketQuestion: string;
  side: string;        // BUY_YES | BUY_NO | SELL_YES | SELL_NO
  outcome: string;     // YES | NO
  tradeType: string;   // BUY | SELL
  amount: number;
  shares: number;
  price: number;
  pattern: string;
  significance: string;
  walletPnl: number | null;
  walletProfit: number | null;
  isTopTrader: boolean;
  tradedAt: string;
  detectedAt: string;
}

// Minimum trade size to qualify as whale (USD)
const MIN_WHALE_SIZE = 10_000;
const MIN_SIGNIFICANT_SIZE = 50_000; // CRITICAL tier

// ─── Pattern detection ────────────────────────────────────────────────────────

/**
 * Classify a trade pattern based on context:
 * - ACCUMULATION: repeated buys on same market from same wallet
 * - EXIT: large SELL after holding
 * - REVERSAL: buy on opposite side of previous position
 * - LARGE_BET: standalone large single bet
 */
function classifyPattern(
  trade: any,
  recentAlerts: WhaleAlert[],
): { pattern: string; significance: string } {
  const isBuy = trade.tradeType === 'BUY';
  const amount = trade.amount ?? 0;

  const significance = amount >= MIN_SIGNIFICANT_SIZE ? 'CRITICAL' : 'HIGH';

  // Check for accumulation: same wallet + same market already in recent alerts
  const sameMarketPrior = recentAlerts.filter(
    a => a.walletAddress === trade.user && a.marketId === trade.marketId && a.tradeType === 'BUY'
  );
  if (sameMarketPrior.length >= 1 && isBuy) {
    return { pattern: 'ACCUMULATION', significance };
  }

  // Exit: selling on a market where wallet previously bought
  const priorBuy = recentAlerts.find(
    a => a.walletAddress === trade.user && a.marketId === trade.marketId && a.tradeType === 'BUY'
  );
  if (!isBuy && priorBuy) {
    return { pattern: 'EXIT', significance };
  }

  // Reversal: buying opposite side to prior position
  const priorOppositeBuy = recentAlerts.find(
    a => a.walletAddress === trade.user && a.marketId === trade.marketId && a.tradeType === 'BUY' && a.outcome !== (trade.outcome === 'yes' ? 'YES' : 'NO')
  );
  if (priorOppositeBuy && isBuy) {
    return { pattern: 'REVERSAL', significance };
  }

  return { pattern: 'LARGE_BET', significance };
}

// ─── Main scanner ─────────────────────────────────────────────────────────────

let isScanning = false;
let lastScanAt = 0;

export async function scanWhaleActivity(): Promise<{ found: number; saved: number }> {
  if (isScanning) return { found: 0, saved: 0 };
  isScanning = true;

  try {
    // Fetch top traders from leaderboard
    const leaderboard = await gammaClient.getTraderLeaderboard({ limit: 50, timePeriod: 'ALL' }).catch(() => []);
    const topTraderAddresses = new Set(leaderboard.map((t: any) => (t.proxyWallet ?? '').toLowerCase()).filter(Boolean));
    const traderPnlMap = new Map<string, { pnl: number; profit: number }>();
    for (const t of leaderboard) {
      const addr = (t.proxyWallet ?? '').toLowerCase();
      if (addr) traderPnlMap.set(addr, { pnl: t.pnl ?? 0, profit: (t as any).profit ?? 0 });
    }

    // Polymarket Data API requires 'user' param — no global feed.
    // Strategy: fetch recent trades for top 25 traders in parallel (staggered).
    // Build name map from leaderboard
    const traderNameMap = new Map<string, string>();
    for (const t of leaderboard) {
      const addr = (t.proxyWallet ?? '').toLowerCase();
      if (addr && t.userName) traderNameMap.set(addr, t.userName);
    }

    const topAddresses = [...topTraderAddresses].slice(0, 25);
    const activities: any[] = [];

    const results = await Promise.allSettled(
      topAddresses.map((addr, i) =>
        new Promise<any[]>(resolve =>
          setTimeout(async () => {
            try {
              const trades = await gammaClient.getWalletTrades(addr, 50);
              // Attach wallet address to each trade for later use
              resolve(trades.map((t: any) => ({ ...t, _walletAddr: addr })));
            } catch {
              resolve([]);
            }
          }, i * 200) // 200ms stagger
        )
      )
    );

    for (const r of results) {
      if (r.status === 'fulfilled') activities.push(...r.value);
    }

    // Filter: only TRADE type above threshold (skip REDEEM, MERGE, SPLIT)
    const whales = activities.filter(a => {
      const amount = parseFloat(String(a.usdcSize ?? a.amount ?? '0'));
      const type = (a.type ?? '').toUpperCase();
      return amount >= MIN_WHALE_SIZE && type === 'TRADE';
    });

    if (whales.length === 0) return { found: 0, saved: 0 };

    // Load recent alerts from DB for pattern detection
    const recentAlerts: WhaleAlert[] = await (prisma as any).whaleAlert.findMany({
      where: { detectedAt: { gte: new Date(Date.now() - 7 * 86400000) } },
      orderBy: { detectedAt: 'desc' },
      take: 500,
    }).then((rows: any[]) => rows.map(rowToAlert));

    // Process each large trade
    let saved = 0;

    for (const trade of whales) {
      try {
        const externalId = trade.transactionHash ?? trade.id ?? null;

        // Skip if already stored
        if (externalId) {
          const existing = await (prisma as any).whaleAlert.findFirst({
            where: { tradeId: externalId },
          });
          if (existing) continue;
        }

        const amount = parseFloat(String(trade.usdcSize ?? trade.amount ?? '0'));
        const shares = parseFloat(String(trade.size ?? trade.shares ?? '0'));
        const price = parseFloat(String(trade.price ?? '0')) || (shares > 0 ? amount / shares : 0);
        // outcome comes as "Yes"/"No" from API
        const outcomeRaw = (trade.outcome ?? '').toLowerCase();
        const outcome = outcomeRaw === 'no' ? 'NO' : 'YES';
        // side field in API: "BUY" or "SELL"
        const isBuy = (trade.side ?? '').toUpperCase() !== 'SELL';
        const side = `${isBuy ? 'BUY' : 'SELL'}_${outcome}`;
        const walletAddr = (trade._walletAddr ?? trade.proxyWallet ?? trade.user ?? trade.maker ?? '').toLowerCase();
        const walletName = (trade.name as string | undefined) ?? traderNameMap.get(walletAddr) ?? null;

        if (!walletAddr) continue;

        // API fields: conditionId, title, eventSlug, outcome, side, price
        let marketId = trade.conditionId ?? trade.marketId ?? '';
        let eventTitle = trade.title ?? trade.eventTitle ?? '';
        let marketQuestion = trade.question ?? trade.marketQuestion ?? eventTitle ?? '';
        let eventId: string | null = trade.eventSlug ?? trade.eventId ?? null;

        if (marketId && !eventTitle) {
          const market = await gammaClient.getMarketById(marketId).catch(() => null);
          if (market) {
            marketQuestion = market.question ?? '';
            eventTitle = market.question ?? '';
          }
        }

        if (!eventTitle) eventTitle = marketQuestion || 'Unknown Market';
        if (!marketId) continue; // Can't store without market ID

        const { pattern, significance } = classifyPattern({ ...trade, user: walletAddr, marketId, outcome }, recentAlerts);

        const isTopTrader = topTraderAddresses.has(walletAddr);
        const traderCtx = traderPnlMap.get(walletAddr);

        const tradedAt = trade.timestamp
          ? new Date(typeof trade.timestamp === 'number' ? trade.timestamp * 1000 : trade.timestamp)
          : new Date();

        await (prisma as any).whaleAlert.create({
          data: {
            tradeId: externalId,
            walletAddress: walletAddr,
            walletName,
            marketId,
            eventId,
            eventTitle,
            marketQuestion,
            side,
            outcome,
            tradeType: isBuy ? 'BUY' : 'SELL',
            amount,
            shares,
            price,
            pattern,
            significance,
            walletPnl: traderCtx?.pnl ?? null,
            walletProfit: traderCtx?.profit ?? null,
            isTopTrader,
            tradedAt,
          },
        });

        saved++;
      } catch {
        // skip individual failures
      }
    }

    lastScanAt = Date.now();
    return { found: whales.length, saved };
  } finally {
    isScanning = false;
  }
}

// ─── Feed queries ─────────────────────────────────────────────────────────────

function rowToAlert(r: any): WhaleAlert {
  return {
    id: r.id,
    tradeId: r.tradeId,
    walletAddress: r.walletAddress,
    walletName: r.walletName ?? null,
    marketId: r.marketId,
    eventId: r.eventId,
    eventTitle: r.eventTitle,
    marketQuestion: r.marketQuestion,
    side: r.side,
    outcome: r.outcome,
    tradeType: r.tradeType,
    amount: r.amount,
    shares: r.shares,
    price: r.price,
    pattern: r.pattern,
    significance: r.significance,
    walletPnl: r.walletPnl,
    walletProfit: r.walletProfit,
    isTopTrader: r.isTopTrader,
    tradedAt: r.tradedAt?.toISOString?.() ?? r.tradedAt,
    detectedAt: r.detectedAt?.toISOString?.() ?? r.detectedAt,
  };
}

export interface WhaleFeedOptions {
  limit?: number;
  minAmount?: number;
  pattern?: string;
  onlyTopTraders?: boolean;
  walletAddress?: string;
}

export async function getWhaleFeed(opts: WhaleFeedOptions = {}): Promise<WhaleAlert[]> {
  const { limit = 50, minAmount = MIN_WHALE_SIZE, pattern, onlyTopTraders, walletAddress } = opts;

  const where: any = {
    amount: { gte: minAmount },
  };
  if (pattern && pattern !== 'all') where.pattern = pattern;
  if (onlyTopTraders) where.isTopTrader = true;
  if (walletAddress) where.walletAddress = walletAddress.toLowerCase();

  const rows = await (prisma as any).whaleAlert.findMany({
    where,
    orderBy: { tradedAt: 'desc' },
    take: Math.min(limit, 200),
  });

  return rows.map(rowToAlert);
}

export async function getWhaleStats() {
  const oneDayAgo = new Date(Date.now() - 86400000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);

  const [total, today, topTraderCount, byPattern, biggestToday] = await Promise.all([
    (prisma as any).whaleAlert.count(),
    (prisma as any).whaleAlert.count({ where: { detectedAt: { gte: oneDayAgo } } }),
    (prisma as any).whaleAlert.count({ where: { isTopTrader: true } }),
    (prisma as any).whaleAlert.groupBy({
      by: ['pattern'],
      _count: { id: true },
      where: { detectedAt: { gte: sevenDaysAgo } },
    }),
    (prisma as any).whaleAlert.findFirst({
      where: { detectedAt: { gte: oneDayAgo } },
      orderBy: { amount: 'desc' },
    }),
  ]);

  const patternCounts: Record<string, number> = {};
  for (const row of byPattern) {
    patternCounts[row.pattern] = row._count.id;
  }

  return {
    total,
    today,
    topTraderCount,
    byPattern: patternCounts,
    biggestToday: biggestToday ? rowToAlert(biggestToday) : null,
    lastScanAt: lastScanAt ? new Date(lastScanAt).toISOString() : null,
  };
}

export async function getWalletWhaleActivity(address: string, limit = 30): Promise<{
  alerts: WhaleAlert[];
  totalVolume: number;
  avgSize: number;
  patterns: Record<string, number>;
}> {
  const alerts = await getWhaleFeed({ walletAddress: address, limit });
  const totalVolume = alerts.reduce((s, a) => s + a.amount, 0);
  const avgSize = alerts.length > 0 ? totalVolume / alerts.length : 0;

  const patterns: Record<string, number> = {};
  for (const a of alerts) {
    patterns[a.pattern] = (patterns[a.pattern] ?? 0) + 1;
  }

  return { alerts, totalVolume, avgSize, patterns };
}

// Manually scan activity for a specific wallet (for "Track" feature)
export async function scanWalletActivity(address: string): Promise<WhaleAlert[]> {
  const trades = await gammaClient.getWalletTrades(address, 100).catch(() => []);
  const leaderboard = await gammaClient.getTraderLeaderboard({ limit: 100 }).catch(() => []);
  const topTraderAddresses = new Set(leaderboard.map((t: any) => (t.proxyWallet ?? '').toLowerCase()).filter(Boolean));
  const traderCtxMap = new Map<string, any>();
  const traderNameMap2 = new Map<string, string>();
  for (const t of leaderboard) {
    const addr = (t.proxyWallet ?? '').toLowerCase();
    if (addr) {
      traderCtxMap.set(addr, t);
      if (t.userName) traderNameMap2.set(addr, t.userName);
    }
  }

  const large = trades.filter((t: any) => {
    const amount = parseFloat(String(t.usdcSize ?? t.amount ?? '0'));
    return amount >= MIN_WHALE_SIZE && (t.type ?? '').toUpperCase() === 'TRADE';
  });

  const recentAlerts: WhaleAlert[] = await (prisma as any).whaleAlert.findMany({
    where: { walletAddress: address.toLowerCase() },
    orderBy: { detectedAt: 'desc' },
    take: 100,
  }).then((rows: any[]) => rows.map(rowToAlert));

  const saved: WhaleAlert[] = [];
  for (const trade of large) {
    try {
      const externalId = trade.transactionHash ?? trade.id ?? null;
      if (externalId) {
        const exists = await (prisma as any).whaleAlert.findFirst({ where: { tradeId: externalId } });
        if (exists) { saved.push(rowToAlert(exists)); continue; }
      }

      const amount = parseFloat(String(trade.usdcSize ?? trade.amount ?? '0'));
      const shares = parseFloat(String(trade.size ?? trade.shares ?? '0'));
      const price = parseFloat(String(trade.price ?? '0')) || (shares > 0 ? amount / shares : 0);
      const outcomeRaw = (trade.outcome ?? '').toLowerCase();
      const outcome = outcomeRaw === 'no' ? 'NO' : 'YES';
      const isBuy = (trade.side ?? '').toUpperCase() !== 'SELL';
      const side = `${isBuy ? 'BUY' : 'SELL'}_${outcome}`;
      const marketId = trade.conditionId ?? trade.marketId ?? '';
      if (!marketId) continue;

      let marketQuestion = trade.question ?? trade.title ?? '';
      let eventTitle = trade.title ?? trade.question ?? '';
      const tradeEventId = trade.eventSlug ?? trade.eventId ?? null;
      if (!marketQuestion) {
        const market = await gammaClient.getMarketById(marketId).catch(() => null);
        if (market) marketQuestion = market.question ?? '';
      }
      if (!eventTitle) eventTitle = marketQuestion || 'Unknown Market';

      const { pattern, significance } = classifyPattern(
        { user: address.toLowerCase(), marketId, outcome, tradeType: isBuy ? 'BUY' : 'SELL' },
        recentAlerts
      );

      const ctx = traderCtxMap.get(address.toLowerCase());
      const walletName2 = (trade.name as string | undefined) ?? traderNameMap2.get(address.toLowerCase()) ?? null;
      const tradedAt = trade.timestamp
        ? new Date(typeof trade.timestamp === 'number' ? trade.timestamp * 1000 : trade.timestamp)
        : new Date();

      const row = await (prisma as any).whaleAlert.create({
        data: {
          tradeId: externalId,
          walletAddress: address.toLowerCase(),
          walletName: walletName2,
          marketId,
          eventId: tradeEventId,
          eventTitle,
          marketQuestion,
          side, outcome,
          tradeType: isBuy ? 'BUY' : 'SELL',
          amount, shares, price, pattern, significance,
          walletPnl: ctx?.pnl ?? null,
          walletProfit: ctx?.profit ?? null,
          isTopTrader: topTraderAddresses.has(address.toLowerCase()),
          tradedAt,
        },
      });
      saved.push(rowToAlert(row));
    } catch { /* skip */ }
  }

  return saved;
}

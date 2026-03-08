import { gammaClient, parseOutcomePrices, calcPotentialRoi } from './gamma-client';

export interface InsiderWallet {
  address: string;
  name?: string;
  pnl: number;
  volume: number;
  insiderScore: number;         // 0-100 composite suspicion score
  earlyBetsCount: number;       // # bets on low-prob outcomes that moved up
  avgRoiOnLowProb: number;      // average ROI on bets made at < 20¢
  recentMarkets: InsiderMarket[];
  reasoning: string;
}

export interface InsiderMarket {
  marketId: string;
  marketQuestion: string;
  eventTitle: string;
  eventId: string;
  estimatedEntryPrice: number;  // current price (proxy for entry if recent)
  currentPrice: number;
  oneDayChange: number;
  potentialRoi: number;
  volume24h: number;
  liquidity: number;
}

export interface InsiderSignal {
  walletAddress: string;
  walletName?: string;
  walletPnl: number;
  walletVolume: number;
  insiderScore: number;
  markets: InsiderMarket[];
  reasoning: string;
  detectedAt: string;
}

// Markets where smart money may have entered early:
// - low YES price (< 22¢) that moved up > 5% today
// - high volume relative to liquidity
async function getInsiderMarkets(): Promise<InsiderMarket[]> {
  const events = await gammaClient.getEvents({
    limit: 100,
    active: true,
    closed: false,
    archived: false,
    order: 'volume24hr',
    ascending: false,
  });

  const candidates: InsiderMarket[] = [];

  for (const event of events) {
    for (const market of event.markets ?? []) {
      if (!market.active || market.closed || !market.acceptingOrders) continue;

      const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
      if (prices.length === 0) continue;
      if (prices.some(p => p < 0.005 || p > 0.995)) continue;

      const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
      const vol24 = market.volume24hr ?? 0;
      const change = market.oneDayPriceChange ?? 0;

      // Look for low-prob outcomes that moved up today with volume
      for (let i = 0; i < prices.length; i++) {
        const p = prices[i];
        if (p > 0 && p < 0.22 && change > 0.04 && liq > 5_000 && vol24 > 0) {
          candidates.push({
            marketId: market.id,
            marketQuestion: market.question,
            eventTitle: event.title,
            eventId: event.id,
            estimatedEntryPrice: Math.max(0.001, p - change), // approximate yesterday's price
            currentPrice: p,
            oneDayChange: change,
            potentialRoi: calcPotentialRoi(p),
            volume24h: vol24,
            liquidity: liq,
          });
          break; // one per market
        }
      }
    }
  }

  return candidates.sort((a, b) => b.oneDayChange - a.oneDayChange).slice(0, 50);
}

export async function detectInsiders(limit = 20): Promise<InsiderSignal[]> {
  // Fetch top traders by P&L
  const traders = await gammaClient.getTraderLeaderboard({ limit: 50 });
  if (traders.length === 0) return [];

  // Get markets with insider-like patterns
  const insiderMarkets = await getInsiderMarkets();
  if (insiderMarkets.length === 0) return [];

  const signals: InsiderSignal[] = [];

  for (const trader of traders) {
    const traderAddr = trader.proxyWallet ?? trader.proxy_wallet_address ?? '';
    if (!traderAddr) continue;

    // Fetch trader's current positions
    let positions: any[] = [];
    try {
      positions = await gammaClient.getWalletPositions(traderAddr);
    } catch {
      continue;
    }
    if (positions.length === 0) continue;

    // Cross-reference positions with insider markets
    const positionConditionIds = new Set(
      positions.map((p: any) => p.conditionId || p.market?.conditionId).filter(Boolean)
    );

    const matchedMarkets = insiderMarkets.filter(im =>
      positionConditionIds.has(im.marketId) ||
      positions.some((p: any) =>
        p.title?.toLowerCase().includes(im.eventTitle.toLowerCase().slice(0, 20))
      )
    );

    if (matchedMarkets.length === 0) continue;

    // Score the insider likelihood
    const avgChange = matchedMarkets.reduce((s, m) => s + m.oneDayChange, 0) / matchedMarkets.length;
    const avgRoi = matchedMarkets.reduce((s, m) => s + m.potentialRoi, 0) / matchedMarkets.length;

    // Factors: # of insider markets, avg price movement, overall PnL rank
    const marketScore = Math.min(40, matchedMarkets.length * 10);
    const moveScore = Math.min(30, (avgChange / 0.20) * 30);
    const pnlScore = Math.min(30, (Math.log10(Math.max(trader.pnl, 1)) - 2) * 10);
    const insiderScore = Math.round(marketScore + moveScore + pnlScore);

    const topMarkets = matchedMarkets.slice(0, 5);

    signals.push({
      walletAddress: traderAddr,
      walletName: trader.userName || trader.name,
      walletPnl: trader.pnl,
      walletVolume: (trader as any).vol ?? (trader as any).volume ?? 0,
      insiderScore,
      markets: topMarkets,
      reasoning: `Top trader (PnL $${(trader.pnl / 1000).toFixed(0)}K) holds positions in ${matchedMarkets.length} market${matchedMarkets.length > 1 ? 's' : ''} with unusual 24h activity. Avg move: +${(avgChange * 100).toFixed(1)}%. Avg potential ROI: +${avgRoi.toFixed(0)}%.`,
      detectedAt: new Date().toISOString(),
    });
  }

  signals.sort((a, b) => b.insiderScore - a.insiderScore);
  return signals.slice(0, limit);
}

// Lightweight version — no position lookup, just market patterns
// Used when full insider detection is too slow
export async function getInsiderMarketSignals(): Promise<InsiderMarket[]> {
  return getInsiderMarkets();
}

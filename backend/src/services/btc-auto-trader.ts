import { getCoinKlines, extractArrays, KlineInterval } from '../clients/binance-client';
import { computeAll } from './indicators';
import { analyzeMarket } from './btc-probability-model';
import { gammaClient, parseOutcomePrices } from '../clients/gamma-client';
import { parseCryptoPriceMarket } from '../clients/coingecko-client';
import { isClobReady, placeBuyOrder } from '../clients/polymarket-clob';
import prisma from '../config/database';
import type { BtcAutoTrade } from '@prisma/client';

export interface AutoTraderConfig {
  enabled: boolean;
  interval: KlineInterval;
  pollSeconds: number;
  minEdgePct: number;
  maxPositionUsd: number;
  maxOpenPositions: number;
  maxDailyLossPct: number;
  bankroll: number;
  kellyMultiplier: number;
  minLiquidity: number;
  minHoursLeft: number;
  dryRun: boolean;
}

export interface TradeRecord {
  dbId?: string;
  timestamp: number;
  marketId: string;
  question: string;
  signal: 'BUY_YES' | 'BUY_NO';
  tokenId: string;
  price: number;
  size: number;
  edge: number;
  edgePct: number;
  fairValue: number;
  orderId?: string;
  status: 'placed' | 'failed' | 'dry_run';
  error?: string;
  expiryTime?: number;
  resolved?: boolean;
  outcome?: 'win' | 'loss';
  pnl?: number;
  resolvedAt?: number;
  resolvedPrice?: number;
  spotAtEntry?: number;
  spotAtExpiry?: number;
}

interface DailyStats {
  date: string;
  tradesPlaced: number;
  totalUsdDeployed: number;
  estimatedPnl: number;
  realizedPnl: number;
  openPositions: number;
  resolvedTrades: number;
  wins: number;
  losses: number;
}

export interface PerformanceStats {
  totalSignals: number;
  resolvedSignals: number;
  pendingSignals: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnlPerTrade: number;
  avgEdgeAtEntry: number;
  roi: number;
  totalDeployed: number;
  bestTrade: number;
  worstTrade: number;
  streakCurrent: number;
  brierScore: number;
}

const DEFAULT_CONFIG: AutoTraderConfig = {
  enabled: false,
  interval: '5m',
  pollSeconds: 30,
  minEdgePct: 5,
  maxPositionUsd: 50,
  maxOpenPositions: 5,
  maxDailyLossPct: 2,
  bankroll: 500,
  kellyMultiplier: 0.25,
  minLiquidity: 500,
  minHoursLeft: 0.08,
  dryRun: true,
};

function rowToTrade(r: BtcAutoTrade): TradeRecord {
  return {
    dbId: r.id,
    timestamp: r.timestamp.getTime(),
    marketId: r.marketId,
    question: r.question,
    signal: r.signal as TradeRecord['signal'],
    tokenId: r.tokenId,
    price: r.price,
    size: r.size,
    edge: r.edge,
    edgePct: r.edgePct,
    fairValue: r.fairValue,
    orderId: r.orderId ?? undefined,
    status: r.status as TradeRecord['status'],
    error: r.error ?? undefined,
    expiryTime: r.expiryTime != null ? Number(r.expiryTime) : undefined,
    resolved: r.resolved,
    outcome: (r.outcome as TradeRecord['outcome']) ?? undefined,
    pnl: r.pnl ?? undefined,
    resolvedAt: r.resolvedAt?.getTime(),
    resolvedPrice: r.resolvedPrice ?? undefined,
    spotAtEntry: r.spotAtEntry ?? undefined,
    spotAtExpiry: r.spotAtExpiry ?? undefined,
  };
}

class BtcAutoTrader {
  private config: AutoTraderConfig = { ...DEFAULT_CONFIG };
  private timer: ReturnType<typeof setInterval> | null = null;
  private trades: TradeRecord[] = [];
  private dailyStats: DailyStats = {
    date: '', tradesPlaced: 0, totalUsdDeployed: 0, estimatedPnl: 0, realizedPnl: 0,
    openPositions: 0, resolvedTrades: 0, wins: 0, losses: 0,
  };
  private tradedMarkets = new Set<string>();
  private lastScanAt = 0;
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    if (this.hydratePromise) return this.hydratePromise;
    this.hydratePromise = (async () => {
      const rows = await prisma.btcAutoTrade.findMany({
        orderBy: { timestamp: 'desc' },
        take: 3000,
      });
      this.trades = rows.reverse().map(rowToTrade);
      this.recomputeDailyStats();
      this.hydrated = true;
    })();
    await this.hydratePromise;
    this.hydratePromise = null;
  }

  private recomputeDailyStats() {
    const today = new Date().toISOString().slice(0, 10);
    const d0 = new Date(`${today}T00:00:00.000Z`).getTime();
    const d1 = d0 + 86400000;

    let tradesPlaced = 0;
    let totalUsdDeployed = 0;
    let realizedPnl = 0;
    let openPositions = 0;
    let resolvedTrades = 0;
    let wins = 0;
    let losses = 0;

    this.tradedMarkets.clear();

    for (const t of this.trades) {
      if (t.timestamp < d0 || t.timestamp >= d1) continue;
      tradesPlaced++;
      totalUsdDeployed += t.size;
      this.tradedMarkets.add(t.marketId);

      if (t.status === 'placed' && !t.resolved) openPositions++;

      if (t.resolved && (t.status === 'placed' || t.status === 'dry_run')) {
        resolvedTrades++;
        realizedPnl += t.pnl ?? 0;
        if (t.outcome === 'win') wins++;
        else if (t.outcome === 'loss') losses++;
      }
    }

    this.dailyStats = {
      date: today,
      tradesPlaced,
      totalUsdDeployed,
      estimatedPnl: realizedPnl,
      realizedPnl,
      openPositions,
      resolvedTrades,
      wins,
      losses,
    };
  }

  async start(overrides?: Partial<AutoTraderConfig>): Promise<void> {
    await this.ensureHydrated();
    if (this.timer) this.stop();
    if (overrides) this.config = { ...this.config, ...overrides };
    this.config.enabled = true;
    this.resetDailyIfNeeded();
    console.log('[btc-auto] started, config:', JSON.stringify(this.config));

    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.pollSeconds * 1000);
  }

  stop() {
    this.config.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[btc-auto] stopped');
  }

  isRunning(): boolean { return this.config.enabled && this.timer !== null; }
  getConfig(): AutoTraderConfig { return { ...this.config }; }

  async getStats(): Promise<DailyStats> {
    await this.ensureHydrated();
    this.resetDailyIfNeeded();
    return { ...this.dailyStats };
  }

  async getRecentTrades(n = 50): Promise<TradeRecord[]> {
    await this.ensureHydrated();
    return this.trades.slice(-n);
  }

  async getPerformance(): Promise<PerformanceStats> {
    await this.ensureHydrated();
    const resolved = this.trades.filter(t => t.resolved && (t.status === 'placed' || t.status === 'dry_run'));
    const pending = this.trades.filter(t => !t.resolved && (t.status === 'placed' || t.status === 'dry_run'));
    const allActive = this.trades.filter(t => t.status === 'placed' || t.status === 'dry_run');

    const wins = resolved.filter(t => t.outcome === 'win');
    const losses = resolved.filter(t => t.outcome === 'loss');
    const totalPnl = resolved.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalDeployed = allActive.reduce((s, t) => s + t.size, 0);
    const avgEdge = allActive.length > 0
      ? allActive.reduce((s, t) => s + Math.abs(t.edgePct), 0) / allActive.length
      : 0;

    let brierSum = 0;
    for (const t of resolved) {
      const predicted = t.signal === 'BUY_YES' ? t.fairValue : (1 - t.fairValue);
      const actual = t.outcome === 'win' ? 1 : 0;
      brierSum += (predicted - actual) ** 2;
    }
    const brierScore = resolved.length > 0 ? brierSum / resolved.length : 0;

    let streak = 0;
    for (let i = resolved.length - 1; i >= 0; i--) {
      const dir = resolved[i].outcome === 'win' ? 1 : -1;
      if (streak === 0) { streak = dir; continue; }
      if ((streak > 0 && dir > 0) || (streak < 0 && dir < 0)) streak += dir;
      else break;
    }

    const pnls = resolved.map(t => t.pnl ?? 0);

    return {
      totalSignals: allActive.length,
      resolvedSignals: resolved.length,
      pendingSignals: pending.length,
      wins: wins.length,
      losses: losses.length,
      winRate: resolved.length > 0 ? wins.length / resolved.length : 0,
      totalPnl,
      avgPnlPerTrade: resolved.length > 0 ? totalPnl / resolved.length : 0,
      avgEdgeAtEntry: avgEdge,
      roi: totalDeployed > 0 ? totalPnl / totalDeployed : 0,
      totalDeployed,
      bestTrade: pnls.length > 0 ? Math.max(...pnls) : 0,
      worstTrade: pnls.length > 0 ? Math.min(...pnls) : 0,
      streakCurrent: streak,
      brierScore,
    };
  }

  private resetDailyIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyStats.date !== today) {
      this.recomputeDailyStats();
    }
  }

  /** Public so a background interval can resolve DB-backed trades after server restarts. */
  async resolveExpiredTrades() {
    await this.ensureHydrated();
    const now = Date.now();
    const unresolved = this.trades.filter(
      t => !t.resolved && (t.status === 'placed' || t.status === 'dry_run') && t.expiryTime && t.expiryTime < now
    );

    if (unresolved.length === 0) return;

    for (const trade of unresolved) {
      try {
        let marketResolved = false;
        let yesWon: boolean | null = null;

        // Primary: use Gamma market closed status + outcomePrices (authoritative)
        try {
          const mkt = await gammaClient.getMarketById(trade.marketId);
          if (mkt && mkt.closed) {
            marketResolved = true;
            const prices = parseOutcomePrices(mkt.outcomePrices ?? '[]');
            if (prices.length >= 2) yesWon = prices[0] > 0.5;
          }
        } catch { /* ignore */ }

        // Fallback only if market is closed long enough: fetch historical price at expiry
        // (not current price — that would give wrong outcome for old markets)
        if (!marketResolved && trade.expiryTime && trade.expiryTime < now - 5 * 60_000) {
          try {
            const coin = (trade as any).coin || 'bitcoin';
            const klines = await getCoinKlines(coin, '5m', 3);
            // Only use if expiry was recent (within last 15 min) so current price is valid proxy
            const expiryAge = now - trade.expiryTime;
            if (expiryAge < 15 * 60_000 && klines.length > 0) {
              const spotAtExpiry = klines[klines.length - 1].close;
              const parsed = parseCryptoPriceMarket(trade.question);
              if (parsed) {
                const above = spotAtExpiry > parsed.target;
                if (parsed.direction === 'above') yesWon = above;
                else if (parsed.direction === 'below') yesWon = !above;
                else if (parsed.targetHigh && parsed.direction === 'between') {
                  yesWon = spotAtExpiry >= parsed.target && spotAtExpiry <= parsed.targetHigh;
                }
                marketResolved = true;
                trade.spotAtExpiry = spotAtExpiry;
              }
            }
          } catch { /* ignore */ }
        }

        if (marketResolved && yesWon !== null) {
          trade.resolved = true;
          trade.resolvedAt = now;

          const weWin = (trade.signal === 'BUY_YES' && yesWon) || (trade.signal === 'BUY_NO' && !yesWon);
          trade.outcome = weWin ? 'win' : 'loss';

          if (weWin) trade.pnl = (1 - trade.price) * trade.size;
          else trade.pnl = -(trade.price) * trade.size;
          trade.resolvedPrice = yesWon ? 1 : 0;

          // Only update dailyStats if this trade is from today
          const today = new Date().toISOString().slice(0, 10);
          const tradeDate = new Date(trade.timestamp).toISOString().slice(0, 10);
          if (tradeDate === today) {
            this.dailyStats.resolvedTrades++;
            this.dailyStats.realizedPnl += trade.pnl;
            if (weWin) this.dailyStats.wins++;
            else this.dailyStats.losses++;
            this.dailyStats.openPositions = Math.max(0, this.dailyStats.openPositions - 1);
            this.dailyStats.estimatedPnl = this.dailyStats.realizedPnl;
          }

          if (trade.dbId) {
            try {
              await prisma.btcAutoTrade.update({
                where: { id: trade.dbId },
                data: {
                  resolved: true,
                  outcome: trade.outcome,
                  pnl: trade.pnl,
                  resolvedAt: new Date(trade.resolvedAt),
                  resolvedPrice: trade.resolvedPrice,
                  spotAtExpiry: trade.spotAtExpiry,
                },
              });
            } catch (e: any) {
              console.error('[btc-auto] db resolve:', e.message);
            }
          }

          console.log(`[btc-auto] RESOLVED: ${trade.outcome.toUpperCase()} | ${trade.signal} "${trade.question.slice(0, 50)}" | PnL: $${trade.pnl.toFixed(2)} | entry=${trade.price.toFixed(3)}`);
        }
      } catch (e: any) {
        console.error(`[btc-auto] resolve error for ${trade.marketId}:`, e.message);
      }
    }
  }

  private async tick() {
    if (!this.config.enabled) return;
    await this.ensureHydrated();
    this.resetDailyIfNeeded();

    const lossLimit = this.config.bankroll * (this.config.maxDailyLossPct / 100);
    if (this.dailyStats.estimatedPnl < -lossLimit) {
      console.log(`[btc-auto] daily loss limit hit ($${this.dailyStats.estimatedPnl.toFixed(2)}), pausing`);
      return;
    }

    if (this.dailyStats.openPositions >= this.config.maxOpenPositions) return;

    try {
      // Pre-fetch indicators for each supported coin in parallel
      const SUPPORTED_COINS = ['bitcoin', 'ethereum', 'solana'];
      const candleMinutes = intervalToMinutes(this.config.interval);
      const coinIndicators = new Map<string, ReturnType<typeof computeAll>>();

      await Promise.all(SUPPORTED_COINS.map(async (coin) => {
        try {
          const klines = await getCoinKlines(coin, this.config.interval, 200);
          const { highs, lows, closes, volumes } = extractArrays(klines);
          coinIndicators.set(coin, computeAll(highs, lows, closes, volumes, candleMinutes));
        } catch (e: any) {
          console.warn(`[btc-auto] failed to fetch ${coin} klines:`, e.message);
        }
      }));

      const events = await gammaClient.getEvents({
        limit: 200, active: true, closed: false, archived: false, order: 'volume24hr', ascending: false,
      });

      // Strike-band dedup: track which strike bands we already traded this tick.
      // Bucket = round strike to nearest $1000 + direction — prevents correlated bets
      // like "$66k dip", "$67k dip", "$68k dip" all firing at once.
      const tradedBands = new Set<string>();

      for (const event of events) {
        if (this.dailyStats.openPositions >= this.config.maxOpenPositions) break;

        for (const market of event.markets ?? []) {
          if (this.dailyStats.openPositions >= this.config.maxOpenPositions) break;
          if (!market.active || market.closed || !market.acceptingOrders) continue;
          if (this.tradedMarkets.has(market.id)) continue;

          const question = market.question ?? event.title ?? '';
          const parsed = parseCryptoPriceMarket(question);
          if (!parsed || !SUPPORTED_COINS.includes(parsed.coin)) continue;

          const indicators = coinIndicators.get(parsed.coin);
          if (!indicators) continue;

          const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
          if (prices.length < 2 || prices.some(p => p < 0.005 || p > 0.995)) continue;

          const liq = market.liquidityNum ?? parseFloat(market.liquidity ?? '0');
          if (liq < this.config.minLiquidity) continue;

          const hoursLeft = market.endDate
            ? Math.max(0, (new Date(market.endDate).getTime() - Date.now()) / 3600000)
            : 0;
          if (hoursLeft < this.config.minHoursLeft) continue;

          const yesPrice = prices[0];
          const analysis = analyzeMarket({
            spot: indicators.spot,
            strike: parsed.target,
            strikeHigh: parsed.targetHigh,
            direction: parsed.direction,
            hoursLeft,
            marketYesPrice: yesPrice,
            indicators,
          });

          if (analysis.signal === 'FAIR') continue;

          const absEdgePct = Math.abs(analysis.edgePct);
          if (absEdgePct < this.config.minEdgePct) continue;

          // BUY_YES filter: require strong edge AND high indicator consensus.
          // BUY_YES on trend-following signals has poor live track record —
          // only take it when model is very confident (edge ≥20%, confidence ≥0.5).
          if (analysis.signal === 'BUY_YES') {
            if (absEdgePct < 20 || analysis.confidence < 0.5) {
              console.log(`[btc-auto] BUY_YES filtered (edge=${absEdgePct.toFixed(1)}% conf=${analysis.confidence.toFixed(2)}): ${question.slice(0, 50)}`);
              continue;
            }
          }

          // Strike-band dedup: skip if we already have a correlated bet in this $1k band+direction.
          const strikeBand = `${Math.round(parsed.target / 1000)}k-${parsed.direction}-${analysis.signal}`;
          if (tradedBands.has(strikeBand)) {
            console.log(`[btc-auto] Strike band dedup (${strikeBand}): ${question.slice(0, 50)}`);
            continue;
          }

          // Kelly sizing: scale up for high-confidence BUY_NO (far OTM, edge >50%).
          // Standard Kelly is capped at 0.25 fractional; for near-certain NO bets we allow 0.5.
          let effectiveKelly = analysis.kellyFraction;
          if (analysis.signal === 'BUY_NO' && absEdgePct >= 50) {
            effectiveKelly = Math.min(analysis.kellyFraction * 2, 0.06); // up to 6% of bankroll
          }

          const kellySize = this.config.bankroll * effectiveKelly * this.config.kellyMultiplier;
          const tradeSize = Math.min(kellySize, this.config.maxPositionUsd);
          if (tradeSize < 1) continue;

          let clobTokenIds: string[] = [];
          try { clobTokenIds = JSON.parse(market.clobTokenIds ?? '[]'); } catch { continue; }
          if (clobTokenIds.length < 2) continue;

          const tokenIdx = analysis.signal === 'BUY_YES' ? 0 : 1;
          const tokenId = clobTokenIds[tokenIdx];
          const buyPrice = analysis.signal === 'BUY_YES' ? yesPrice : (1 - yesPrice);

          const expiryMs = market.endDate ? new Date(market.endDate).getTime() : undefined;

          tradedBands.add(strikeBand);

          await this.executeTrade({
            marketId: market.id,
            question,
            signal: analysis.signal,
            tokenId,
            price: buyPrice,
            size: tradeSize,
            edge: analysis.edge,
            edgePct: analysis.edgePct,
            fairValue: analysis.fairValue,
            expiryTime: expiryMs,
            spotAtEntry: indicators.spot,
            coin: parsed.coin,
          });
        }
      }

      this.lastScanAt = Date.now();
    } catch (e: any) {
      console.error('[btc-auto] tick error:', e.message);
    }
  }

  private async executeTrade(params: {
    marketId: string;
    question: string;
    signal: 'BUY_YES' | 'BUY_NO';
    tokenId: string;
    price: number;
    size: number;
    edge: number;
    edgePct: number;
    fairValue: number;
    expiryTime?: number;
    spotAtEntry?: number;
    coin?: string;
  }) {
    const record: TradeRecord = {
      timestamp: Date.now(),
      marketId: params.marketId,
      question: params.question,
      signal: params.signal,
      tokenId: params.tokenId,
      price: params.price,
      size: params.size,
      edge: params.edge,
      edgePct: params.edgePct,
      fairValue: params.fairValue,
      status: 'dry_run',
      expiryTime: params.expiryTime,
      spotAtEntry: params.spotAtEntry,
    };

    if (this.config.dryRun) {
      console.log(`[btc-auto] DRY RUN: ${params.signal} on "${params.question.slice(0, 60)}" | edge=${params.edgePct.toFixed(1)}% | $${params.size.toFixed(2)} @ ${params.price.toFixed(3)}`);
      record.status = 'dry_run';
    } else {
      if (!isClobReady()) {
        record.status = 'failed';
        record.error = 'CLOB not ready';
      } else {
        try {
          const result = await placeBuyOrder(params.tokenId, params.price, params.size);
          if (result.success) {
            record.status = 'placed';
            record.orderId = result.orderID;
            this.dailyStats.openPositions++;
            console.log(`[btc-auto] PLACED: ${params.signal} orderId=${result.orderID} | "${params.question.slice(0, 50)}" | $${params.size.toFixed(2)}`);
          } else {
            record.status = 'failed';
            record.error = result.error;
            console.warn(`[btc-auto] FAILED: ${result.error}`);
          }
        } catch (e: any) {
          record.status = 'failed';
          record.error = e.message;
        }
      }
    }

    try {
      const row = await prisma.btcAutoTrade.create({
        data: {
          timestamp: new Date(record.timestamp),
          marketId: params.marketId,
          question: params.question,
          signal: params.signal,
          tokenId: params.tokenId,
          price: params.price,
          size: params.size,
          edge: params.edge,
          edgePct: params.edgePct,
          fairValue: params.fairValue,
          orderId: record.orderId,
          status: record.status,
          error: record.error,
          expiryTime: params.expiryTime != null ? BigInt(params.expiryTime) : null,
          spotAtEntry: params.spotAtEntry,
          coin: params.coin ?? 'bitcoin',
        },
      });
      record.dbId = row.id;
    } catch (e: any) {
      console.error('[btc-auto] db create:', e.message);
    }

    this.trades.push(record);
    this.tradedMarkets.add(params.marketId);
    this.dailyStats.tradesPlaced++;
    this.dailyStats.totalUsdDeployed += params.size;

    if (this.trades.length > 3000) this.trades = this.trades.slice(-3000);
  }
}

function intervalToMinutes(interval: KlineInterval): number {
  const map: Record<KlineInterval, number> = { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
  return map[interval] || 5;
}

let _instance: BtcAutoTrader | null = null;
let _resolveInterval: ReturnType<typeof setInterval> | null = null;

export function getBtcAutoTrader(): BtcAutoTrader {
  if (!_instance) {
    _instance = new BtcAutoTrader();
    // Resolve pending trades from DB even when auto-trader loop is stopped (after restarts)
    if (!_resolveInterval) {
      _resolveInterval = setInterval(() => {
        void _instance?.resolveExpiredTrades();
      }, 90_000);
    }
  }
  return _instance;
}

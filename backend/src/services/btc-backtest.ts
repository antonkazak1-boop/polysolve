import { Kline, extractArrays } from '../clients/binance-client';
import { computeAll, AllIndicators } from './indicators';
import { analyzeMarket, enhancedBinaryFairValue } from './btc-probability-model';
import { binaryOptionFairValue } from '../clients/coingecko-client';

export interface BacktestConfig {
  strikeOffsetPct: number;    // e.g. 2 = simulate "BTC above spot+2%"
  direction: 'above' | 'below';
  horizonCandles: number;     // how many candles ahead is "expiry"
  edgeThreshold: number;      // min edge% to trigger a trade (default 5)
  kellyMultiplier: number;    // fractional Kelly (default 0.25)
  maxPositionPct: number;     // max % of bankroll per trade (default 10)
  startingBankroll: number;   // initial capital (default 1000)
}

export interface BacktestTrade {
  entryIdx: number;
  entryTime: number;
  entrySpot: number;
  strike: number;
  direction: 'above' | 'below';
  signal: 'BUY_YES' | 'BUY_NO';
  marketPrice: number;     // simulated market = static BS model
  fairValue: number;       // our enhanced model
  edge: number;
  kellyFraction: number;
  betSize: number;
  outcome: 'win' | 'loss';
  pnl: number;
  expirySpot: number;
  expiryTime: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: BacktestTrade[];
  summary: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    totalReturn: number;   // as % of starting bankroll
    sharpe: number;
    maxDrawdown: number;
    avgEdge: number;
    equityCurve: { time: number; equity: number }[];
  };
  candlesUsed: number;
  candleInterval: string;
}

const DEFAULT_CONFIG: BacktestConfig = {
  strikeOffsetPct: 2,
  direction: 'above',
  horizonCandles: 12,       // 12 x 5m = 1 hour default horizon
  edgeThreshold: 5,
  kellyMultiplier: 0.25,
  maxPositionPct: 10,
  startingBankroll: 1000,
};

export function runBacktest(klines: Kline[], candleMinutes: number, userConfig: Partial<BacktestConfig> = {}): BacktestResult {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const { opens, highs, lows, closes, volumes, times } = extractArrays(klines);

  const WARMUP = 60; // need enough candles for indicators
  const trades: BacktestTrade[] = [];
  let bankroll = config.startingBankroll;
  const equityCurve: { time: number; equity: number }[] = [];
  let peakEquity = bankroll;
  let maxDrawdown = 0;

  for (let i = WARMUP; i < closes.length - config.horizonCandles; i++) {
    const sliceH = highs.slice(0, i + 1);
    const sliceL = lows.slice(0, i + 1);
    const sliceC = closes.slice(0, i + 1);
    const sliceV = volumes.slice(0, i + 1);

    const indicators = computeAll(sliceH, sliceL, sliceC, sliceV, candleMinutes);
    const spot = closes[i];
    const strike = config.direction === 'above'
      ? spot * (1 + config.strikeOffsetPct / 100)
      : spot * (1 - config.strikeOffsetPct / 100);

    const hoursLeft = (config.horizonCandles * candleMinutes) / 60;

    // Simulated "market price" = static BS model (what a naive Polymarket trader would price it)
    const staticVol = 0.55;
    const marketPrice = binaryOptionFairValue(spot, strike, hoursLeft, staticVol, config.direction);

    // Our enhanced model price
    const analysis = analyzeMarket({
      spot,
      strike,
      direction: config.direction,
      hoursLeft,
      marketYesPrice: marketPrice,
      indicators,
    });

    if (analysis.signal === 'FAIR') continue;
    if (Math.abs(analysis.edgePct) < config.edgeThreshold) continue;

    // Determine actual outcome at expiry
    const expiryIdx = i + config.horizonCandles;
    const expirySpot = closes[expiryIdx];
    const yesWins = config.direction === 'above' ? expirySpot >= strike : expirySpot <= strike;

    const betOnYes = analysis.signal === 'BUY_YES';
    const betPrice = betOnYes ? marketPrice : (1 - marketPrice);

    // Size: Kelly-based, capped
    const rawKelly = analysis.kellyFraction;
    const positionPct = Math.min(rawKelly * 100, config.maxPositionPct);
    const betSize = bankroll * (positionPct / 100);

    if (betSize < 1 || bankroll < 10) continue;

    const traderWins = betOnYes ? yesWins : !yesWins;
    const payout = traderWins ? betSize * (1 / betPrice - 1) : -betSize;

    bankroll += payout;

    if (bankroll > peakEquity) peakEquity = bankroll;
    const dd = peakEquity > 0 ? (peakEquity - bankroll) / peakEquity : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    trades.push({
      entryIdx: i,
      entryTime: times[i],
      entrySpot: spot,
      strike: Math.round(strike * 100) / 100,
      direction: config.direction,
      signal: analysis.signal,
      marketPrice: Math.round(marketPrice * 1000) / 1000,
      fairValue: analysis.fairValue,
      edge: analysis.edge,
      kellyFraction: analysis.kellyFraction,
      betSize: Math.round(betSize * 100) / 100,
      outcome: traderWins ? 'win' : 'loss',
      pnl: Math.round(payout * 100) / 100,
      expirySpot,
      expiryTime: times[expiryIdx],
    });

    equityCurve.push({ time: times[i], equity: Math.round(bankroll * 100) / 100 });
  }

  const wins = trades.filter(t => t.outcome === 'win').length;
  const pnls = trades.map(t => t.pnl);
  const avgPnl = pnls.length > 0 ? pnls.reduce((s, v) => s + v, 0) / pnls.length : 0;
  const stdPnl = pnls.length > 1
    ? Math.sqrt(pnls.reduce((s, v) => s + (v - avgPnl) ** 2, 0) / (pnls.length - 1))
    : 1;
  const sharpe = stdPnl > 0 ? (avgPnl / stdPnl) * Math.sqrt(252) : 0;

  return {
    config,
    trades,
    summary: {
      totalTrades: trades.length,
      wins,
      losses: trades.length - wins,
      winRate: trades.length > 0 ? Math.round((wins / trades.length) * 1000) / 10 : 0,
      totalPnl: Math.round((bankroll - config.startingBankroll) * 100) / 100,
      totalReturn: Math.round(((bankroll - config.startingBankroll) / config.startingBankroll) * 10000) / 100,
      sharpe: Math.round(sharpe * 100) / 100,
      maxDrawdown: Math.round(maxDrawdown * 10000) / 100,
      avgEdge: trades.length > 0
        ? Math.round(trades.reduce((s, t) => s + Math.abs(t.edge), 0) / trades.length * 1000) / 1000
        : 0,
      equityCurve,
    },
    candlesUsed: klines.length,
    candleInterval: `${candleMinutes}m`,
  };
}

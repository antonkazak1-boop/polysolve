import { AllIndicators } from './indicators';

export interface DirectionalBias {
  drift: number;        // annualized drift (-0.5 to +0.5)
  confidence: number;   // 0-1, how many indicators agree
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  signals: Record<string, 'bullish' | 'bearish' | 'neutral'>;
}

export interface EnhancedFairValue {
  fairValue: number;
  adjustedVol: number;
  drift: number;
  confidence: number;
  edge: number;           // fairValue - marketPrice
  edgePct: number;
  signal: 'BUY_YES' | 'BUY_NO' | 'FAIR';
  signalStrength: 'strong' | 'moderate' | 'weak';
  kellyFraction: number;
  expectedValue: number;
  indicators: DirectionalBias;
}

// ─── Directional bias from indicators ───────────────────────────────────────

export function computeDirectionalBias(ind: AllIndicators): DirectionalBias {
  const signals: Record<string, 'bullish' | 'bearish' | 'neutral'> = {};

  // RSI-14: symmetric around 50
  if (ind.rsi14.value > 55) signals.rsi14 = 'bullish';
  else if (ind.rsi14.value < 45) signals.rsi14 = 'bearish';
  else signals.rsi14 = 'neutral';

  // RSI-50 (longer trend)
  if (ind.rsi50.value > 53) signals.rsi50 = 'bullish';
  else if (ind.rsi50.value < 47) signals.rsi50 = 'bearish';
  else signals.rsi50 = 'neutral';

  // MACD: use histogram magnitude — near-zero histogram means neutral
  const histPctOfPrice = ind.spot > 0 ? Math.abs(ind.macd.histogram) / ind.spot * 100 : 0;
  if (histPctOfPrice < 0.005) signals.macd = 'neutral';
  else signals.macd = ind.macd.bullish ? 'bullish' : 'bearish';

  // Bollinger %B: symmetric around 0.5
  if (ind.bollinger.percentB > 0.6) signals.bollinger = 'bullish';
  else if (ind.bollinger.percentB < 0.4) signals.bollinger = 'bearish';
  else signals.bollinger = 'neutral';

  // VWAP: symmetric around 0
  if (ind.vwap.deviation > 0.1) signals.vwap = 'bullish';
  else if (ind.vwap.deviation < -0.1) signals.vwap = 'bearish';
  else signals.vwap = 'neutral';

  // OBV: require meaningful slope relative to average volume
  if (ind.obv.slope > 0 && ind.obv.trend === 'rising') signals.obv = 'bullish';
  else if (ind.obv.slope < 0 && ind.obv.trend === 'falling') signals.obv = 'bearish';
  else signals.obv = 'neutral';

  // ATR trend: high ATR with price above VWAP = continuation, otherwise reversal risk
  const atrExpansion = ind.atr14.pctOfPrice > 0.3;
  if (atrExpansion && ind.vwap.deviation > 0) signals.atrTrend = 'bullish';
  else if (atrExpansion && ind.vwap.deviation < 0) signals.atrTrend = 'bearish';
  else signals.atrTrend = 'neutral';

  const values = Object.values(signals);
  const bullishCount = values.filter(v => v === 'bullish').length;
  const bearishCount = values.filter(v => v === 'bearish').length;
  const neutralCount = values.filter(v => v === 'neutral').length;
  const total = values.length;

  // Drift: only apply when there's genuine consensus, otherwise 0
  const netBias = (bullishCount - bearishCount) / total;
  const agreement = Math.max(bullishCount, bearishCount) / total;
  const drift = agreement >= 0.4 ? netBias * 0.4 * agreement : 0;

  const confidence = agreement;

  return { drift, confidence, bullishCount, bearishCount, neutralCount, signals };
}

// ─── Enhanced Black-Scholes with drift + realized vol ───────────────────────

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

export function enhancedBinaryFairValue(
  spot: number,
  strike: number,
  hoursLeft: number,
  realizedVol: number,
  drift: number,
  direction: 'above' | 'below',
): number {
  if (hoursLeft <= 0) {
    return direction === 'above' ? (spot >= strike ? 1 : 0) : (spot <= strike ? 1 : 0);
  }

  const T = hoursLeft / (365.25 * 24);
  const sigma = Math.max(realizedVol, 0.1); // floor at 10% annual
  const mu = drift;

  const d2 = (Math.log(spot / strike) + (mu - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const probAbove = normalCDF(d2);

  return direction === 'above' ? probAbove : (1 - probAbove);
}

export function enhancedRangeFairValue(
  spot: number,
  lo: number,
  hi: number,
  hoursLeft: number,
  realizedVol: number,
  drift: number,
): number {
  const pAboveLo = enhancedBinaryFairValue(spot, lo, hoursLeft, realizedVol, drift, 'above');
  const pAboveHi = enhancedBinaryFairValue(spot, hi, hoursLeft, realizedVol, drift, 'above');
  return Math.max(0, pAboveLo - pAboveHi);
}

// ─── Full analysis for a single market ──────────────────────────────────────

function kellyFraction(prob: number, price: number): number {
  if (price <= 0 || price >= 1 || prob <= 0 || prob >= 1) return 0;
  const b = (1 / price) - 1;
  const f = (prob * b - (1 - prob)) / b;
  return Math.max(0, Math.min(0.25, f));
}

export function analyzeMarket(params: {
  spot: number;
  strike: number;
  strikeHigh?: number;
  direction: 'above' | 'below' | 'between';
  hoursLeft: number;
  marketYesPrice: number;
  indicators: AllIndicators;
}): EnhancedFairValue {
  const { spot, strike, strikeHigh, direction, hoursLeft, marketYesPrice, indicators } = params;
  const bias = computeDirectionalBias(indicators);

  const vol = indicators.volatility.realized;
  // Blend realized vol with a baseline to avoid overfit on short samples
  const adjustedVol = vol * 0.7 + 0.55 * 0.3;

  let fairValue: number;
  if (direction === 'between' && strikeHigh) {
    fairValue = enhancedRangeFairValue(spot, strike, strikeHigh, hoursLeft, adjustedVol, bias.drift);
  } else {
    fairValue = enhancedBinaryFairValue(spot, strike, hoursLeft, adjustedVol, bias.drift, direction === 'below' ? 'below' : 'above');
  }

  const edge = fairValue - marketYesPrice;
  const edgePct = marketYesPrice > 0 ? (edge / marketYesPrice) * 100 : 0;

  const absEdge = Math.abs(edge);
  const absEdgePct = Math.abs(edgePct);

  let signal: EnhancedFairValue['signal'] = 'FAIR';
  let signalStrength: EnhancedFairValue['signalStrength'] = 'weak';

  if (absEdge >= 0.03 && absEdgePct >= 5) {
    signal = edge > 0 ? 'BUY_YES' : 'BUY_NO';
    signalStrength =
      absEdge >= 0.15 || absEdgePct >= 30 ? 'strong' :
      absEdge >= 0.07 || absEdgePct >= 15 ? 'moderate' : 'weak';
  }

  const betPrice = signal === 'BUY_YES' ? marketYesPrice
    : signal === 'BUY_NO' ? (1 - marketYesPrice)
    : marketYesPrice;
  const betProb = signal === 'BUY_YES' ? fairValue
    : signal === 'BUY_NO' ? (1 - fairValue)
    : fairValue;
  const ev = betProb * (1 / betPrice - 1) - (1 - betProb);
  const kelly = signal !== 'FAIR' ? kellyFraction(betProb, betPrice) * 0.25 : 0; // fractional Kelly

  return {
    fairValue: round4(fairValue),
    adjustedVol: round4(adjustedVol),
    drift: round4(bias.drift),
    confidence: round4(bias.confidence),
    edge: round4(edge),
    edgePct: round1(edgePct),
    signal,
    signalStrength,
    kellyFraction: round4(kelly),
    expectedValue: round4(ev),
    indicators: bias,
  };
}

function round4(n: number) { return Math.round(n * 10000) / 10000; }
function round1(n: number) { return Math.round(n * 10) / 10; }

// Pure math technical indicators — no external dependencies

export interface RSIResult {
  value: number;
  overbought: boolean; // > 70
  oversold: boolean;   // < 30
}

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
  bullish: boolean;
}

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
  percentB: number; // where current price sits (0 = lower, 1 = upper)
}

export interface ATRResult {
  value: number;
  pctOfPrice: number; // ATR as % of current close
}

export interface VWAPResult {
  value: number;
  deviation: number; // current price vs VWAP in %
}

export interface OBVResult {
  value: number;
  trend: 'rising' | 'falling' | 'flat';
  slope: number;
}

export interface VolatilityResult {
  realized: number;   // annualized
  hourly: number;     // raw hourly vol
  regime: 'low' | 'normal' | 'high' | 'extreme';
}

export interface AllIndicators {
  rsi14: RSIResult;
  rsi50: RSIResult;
  macd: MACDResult;
  bollinger: BollingerResult;
  atr14: ATRResult;
  vwap: VWAPResult;
  obv: OBVResult;
  volatility: VolatilityResult;
  spot: number;
  timestamp: number;
}

// ─── RSI ─────────────────────────────────────────────────────────────────────

export function rsi(closes: number[], period: number = 14): RSIResult {
  if (closes.length < period + 1) return { value: 50, overbought: false, oversold: false };

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const value = 100 - 100 / (1 + rs);
  return { value, overbought: value > 70, oversold: value < 30 };
}

// ─── EMA helper ──────────────────────────────────────────────────────────────

function ema(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// ─── MACD ────────────────────────────────────────────────────────────────────

export function macd(closes: number[], fast = 12, slow = 26, sig = 9): MACDResult {
  if (closes.length < slow + sig) return { macd: 0, signal: 0, histogram: 0, bullish: false };

  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine.slice(slow - 1), sig);

  const macdVal = macdLine[macdLine.length - 1];
  const sigVal = signalLine[signalLine.length - 1];
  const hist = macdVal - sigVal;

  return { macd: macdVal, signal: sigVal, histogram: hist, bullish: hist > 0 };
}

// ─── Bollinger Bands ─────────────────────────────────────────────────────────

function sma(data: number[], period: number): number {
  const slice = data.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

function stdDev(data: number[], period: number): number {
  const slice = data.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

export function bollingerBands(closes: number[], period = 20, mult = 2): BollingerResult {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, middle: last, lower: last, bandwidth: 0, percentB: 0.5 };
  }

  const middle = sma(closes, period);
  const sd = stdDev(closes, period);
  const upper = middle + mult * sd;
  const lower = middle - mult * sd;
  const bandwidth = upper - lower;
  const current = closes[closes.length - 1];
  const percentB = bandwidth > 0 ? (current - lower) / bandwidth : 0.5;

  return { upper, middle, lower, bandwidth, percentB };
}

// ─── ATR ─────────────────────────────────────────────────────────────────────

export function atr(highs: number[], lows: number[], closes: number[], period = 14): ATRResult {
  if (closes.length < period + 1) return { value: 0, pctOfPrice: 0 };

  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trs.push(tr);
  }

  let atrVal = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]) / period;
  }

  const lastClose = closes[closes.length - 1];
  return { value: atrVal, pctOfPrice: lastClose > 0 ? (atrVal / lastClose) * 100 : 0 };
}

// ─── VWAP ────────────────────────────────────────────────────────────────────

export function vwap(highs: number[], lows: number[], closes: number[], volumes: number[]): VWAPResult {
  if (closes.length === 0) return { value: 0, deviation: 0 };

  let cumVol = 0;
  let cumTpVol = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumVol += volumes[i];
    cumTpVol += tp * volumes[i];
  }

  const vwapVal = cumVol > 0 ? cumTpVol / cumVol : closes[closes.length - 1];
  const current = closes[closes.length - 1];
  const deviation = vwapVal > 0 ? ((current - vwapVal) / vwapVal) * 100 : 0;

  return { value: vwapVal, deviation };
}

// ─── OBV ─────────────────────────────────────────────────────────────────────

export function obv(closes: number[], volumes: number[]): OBVResult {
  if (closes.length < 2) return { value: 0, trend: 'flat', slope: 0 };

  let obvVal = 0;
  const obvSeries: number[] = [0];

  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obvVal += volumes[i];
    else if (closes[i] < closes[i - 1]) obvVal -= volumes[i];
    obvSeries.push(obvVal);
  }

  const lookback = Math.min(10, obvSeries.length);
  const recent = obvSeries.slice(-lookback);
  const slope = recent.length >= 2
    ? (recent[recent.length - 1] - recent[0]) / lookback
    : 0;

  const trend: OBVResult['trend'] =
    slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat';

  return { value: obvVal, trend, slope };
}

// ─── Realized Volatility ────────────────────────────────────────────────────

export function realizedVol(closes: number[], candleMinutes: number): VolatilityResult {
  if (closes.length < 3) return { realized: 0.55, hourly: 0, regime: 'normal' };

  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      logReturns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }

  if (logReturns.length < 2) return { realized: 0.55, hourly: 0, regime: 'normal' };

  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const variance = logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (logReturns.length - 1);
  const perCandleVol = Math.sqrt(variance);

  const candlesPerYear = (365.25 * 24 * 60) / candleMinutes;
  const annualized = perCandleVol * Math.sqrt(candlesPerYear);

  const candlesPerHour = 60 / candleMinutes;
  const hourly = perCandleVol * Math.sqrt(candlesPerHour);

  const regime: VolatilityResult['regime'] =
    annualized > 1.2 ? 'extreme' :
    annualized > 0.8 ? 'high' :
    annualized > 0.4 ? 'normal' : 'low';

  return { realized: annualized, hourly, regime };
}

// ─── Compute all indicators at once ─────────────────────────────────────────

export function computeAll(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
  candleMinutes: number,
): AllIndicators {
  return {
    rsi14: rsi(closes, 14),
    rsi50: rsi(closes, 50),
    macd: macd(closes),
    bollinger: bollingerBands(closes),
    atr14: atr(highs, lows, closes, 14),
    vwap: vwap(highs, lows, closes, volumes),
    obv: obv(closes, volumes),
    volatility: realizedVol(closes, candleMinutes),
    spot: closes[closes.length - 1] ?? 0,
    timestamp: Date.now(),
  };
}

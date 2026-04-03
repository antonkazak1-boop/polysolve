import { getBtcKlines, extractArrays, findKlineByOpenTime, Kline } from '../clients/binance-client';
import { getBitcoinUsdSpot } from '../clients/coingecko-client';
import { computeAll } from './indicators';
import { computeDirectionalBias, enhancedBinaryFairValue } from './btc-probability-model';
import prisma from '../config/database';

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_IN_MEMORY = 2000;

export interface Prediction {
  id: number;
  candleOpenTime: number;
  candleCloseTime: number;
  generatedAt: number;
  spot: number;
  direction: 'UP' | 'DOWN';
  confidence: number;
  probUp: number;
  indicators: {
    rsi14: number;
    macd: 'bullish' | 'bearish' | 'neutral';
    bollinger: number;
    obv: string;
    vwap: number;
    momentum: string;
  };
  resolved: boolean;
  spotAtExpiry?: number;
  actualDirection?: 'UP' | 'DOWN';
  correct?: boolean;
  changePct?: number;
  /** CoinGecko BTC/USD near signal / resolve (Polymarket may use Chainlink — not identical). */
  refUsdOpen?: number;
  refUsdClose?: number;
}

export interface PredictionStats {
  total: number;
  resolved: number;
  pending: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgConfidenceOnWins: number;
  avgConfidenceOnLosses: number;
  currentStreak: number;
  bestStreak: number;
  avgMovePct: number;
  last20WinRate: number | null;
}

function currentCandleOpen(): number {
  const now = Date.now();
  return now - (now % INTERVAL_MS);
}

function nextCandleOpen(): number {
  return currentCandleOpen() + INTERVAL_MS;
}

function msUntilNextCandle(): number {
  return nextCandleOpen() - Date.now();
}

class BtcPredictionTracker {
  private predictions: Prediction[] = [];
  private resolveTimer: ReturnType<typeof setInterval> | null = null;
  private generateTimeout: ReturnType<typeof setTimeout> | null = null;
  private _running = false;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      const rows = await prisma.btcFiveMinPrediction.findMany({
        orderBy: { candleOpenTime: 'desc' },
        take: MAX_IN_MEMORY,
      });
      this.predictions = rows.reverse().map(r => this.rowToPred(r));
      this.loaded = true;
    })();
    await this.loadPromise;
    this.loadPromise = null;
  }

  private rowToPred(r: {
    id: number;
    candleOpenTime: bigint;
    candleCloseTime: bigint;
    generatedAt: Date;
    spot: number;
    direction: string;
    confidence: number;
    probUp: number;
    indicatorsJson: string;
    resolved: boolean;
    spotAtExpiry: number | null;
    actualDirection: string | null;
    correct: boolean | null;
    changePct: number | null;
    refUsdOpen: number | null;
    refUsdClose: number | null;
  }): Prediction {
    let indicators: Prediction['indicators'];
    try {
      indicators = JSON.parse(r.indicatorsJson) as Prediction['indicators'];
    } catch {
      indicators = {
        rsi14: 50, macd: 'neutral', bollinger: 50, obv: 'flat', vwap: 0, momentum: 'flat',
      };
    }
    return {
      id: r.id,
      candleOpenTime: Number(r.candleOpenTime),
      candleCloseTime: Number(r.candleCloseTime),
      generatedAt: r.generatedAt.getTime(),
      spot: r.spot,
      direction: r.direction as 'UP' | 'DOWN',
      confidence: r.confidence,
      probUp: r.probUp,
      indicators,
      resolved: r.resolved,
      spotAtExpiry: r.spotAtExpiry ?? undefined,
      actualDirection: (r.actualDirection as 'UP' | 'DOWN') || undefined,
      correct: r.correct ?? undefined,
      changePct: r.changePct ?? undefined,
      refUsdOpen: r.refUsdOpen ?? undefined,
      refUsdClose: r.refUsdClose ?? undefined,
    };
  }

  async start(): Promise<void> {
    if (this._running) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      await this.ensureLoaded();
      if (this._running) return;
      this._running = true;

      await this.generateForCurrentCandle();
      this.scheduleNextGeneration();
      this.resolveTimer = setInterval(() => void this.resolveExpired(), 15_000);

      console.log(`[btc-predict] tracker started, synced to 5-min grid. Next candle in ${(msUntilNextCandle() / 1000).toFixed(0)}s`);
    })();
    await this.startPromise;
    this.startPromise = null;
  }

  stop() {
    this._running = false;
    if (this.generateTimeout) { clearTimeout(this.generateTimeout); this.generateTimeout = null; }
    if (this.resolveTimer) { clearInterval(this.resolveTimer); this.resolveTimer = null; }
  }

  isRunning(): boolean { return this._running; }

  private scheduleNextGeneration() {
    if (!this._running) return;
    const delay = msUntilNextCandle() + 2000;
    this.generateTimeout = setTimeout(() => {
      void (async () => {
        await this.resolveExpired();
        await this.generateForCurrentCandle();
        this.scheduleNextGeneration();
      })();
    }, delay);
  }

  getCurrent(): Prediction | null {
    const pending = this.predictions.filter(p => !p.resolved);
    return pending.length > 0 ? pending[pending.length - 1] : null;
  }

  getHistory(limit = 100): Prediction[] {
    return this.predictions.slice(-limit).reverse();
  }

  getStats(): PredictionStats {
    const resolved = this.predictions.filter(p => p.resolved);
    const wins = resolved.filter(p => p.correct);
    const losses = resolved.filter(p => p.resolved && !p.correct);

    let streak = 0;
    let bestStreak = 0;
    let currentPositive = 0;
    for (let i = resolved.length - 1; i >= 0; i--) {
      const dir = resolved[i].correct ? 1 : -1;
      if (streak === 0) { streak = dir; continue; }
      if ((streak > 0 && dir > 0) || (streak < 0 && dir < 0)) streak += dir;
      else break;
    }
    for (const p of resolved) {
      if (p.correct) { currentPositive++; bestStreak = Math.max(bestStreak, currentPositive); }
      else currentPositive = 0;
    }

    const avgConfWins = wins.length > 0
      ? wins.reduce((s, p) => s + p.confidence, 0) / wins.length : 0;
    const avgConfLosses = losses.length > 0
      ? losses.reduce((s, p) => s + p.confidence, 0) / losses.length : 0;
    const avgMove = resolved.length > 0
      ? resolved.reduce((s, p) => s + Math.abs(p.changePct ?? 0), 0) / resolved.length : 0;

    const last20 = resolved.slice(-20);
    const last20Wins = last20.filter(p => p.correct).length;

    return {
      total: this.predictions.length,
      resolved: resolved.length,
      pending: this.predictions.filter(p => !p.resolved).length,
      wins: wins.length,
      losses: losses.length,
      winRate: resolved.length > 0 ? wins.length / resolved.length : null,
      avgConfidenceOnWins: Math.round(avgConfWins),
      avgConfidenceOnLosses: Math.round(avgConfLosses),
      currentStreak: streak,
      bestStreak,
      avgMovePct: Math.round(avgMove * 1000) / 1000,
      last20WinRate: last20.length > 0 ? last20Wins / last20.length : null,
    };
  }

  /** Full history from DB (not capped by in-memory window). */
  async getHistoryFromDb(limit = 500): Promise<Prediction[]> {
    await this.ensureLoaded();
    const rows = await prisma.btcFiveMinPrediction.findMany({
      orderBy: { candleOpenTime: 'desc' },
      take: Math.min(limit, 5000),
    });
    return rows.map(r => this.rowToPred(r));
  }

  /** Stats over all rows in DB (accurate counts; streak/avg from recent resolved sample). */
  async getStatsFromDb(): Promise<PredictionStats> {
    await this.ensureLoaded();
    const [total, resolved, wins, losses] = await Promise.all([
      prisma.btcFiveMinPrediction.count(),
      prisma.btcFiveMinPrediction.count({ where: { resolved: true } }),
      prisma.btcFiveMinPrediction.count({ where: { resolved: true, correct: true } }),
      prisma.btcFiveMinPrediction.count({ where: { resolved: true, correct: false } }),
    ]);
    const pending = Math.max(0, total - resolved);

    const resolvedSample = await prisma.btcFiveMinPrediction.findMany({
      where: { resolved: true },
      orderBy: { candleOpenTime: 'asc' },
      take: 3000,
      skip: Math.max(0, resolved - 3000),
    });
    const resChrono = resolvedSample;

    let streak = 0;
    let bestStreak = 0;
    let currentPositive = 0;
    for (let i = resChrono.length - 1; i >= 0; i--) {
      const dir = resChrono[i].correct ? 1 : -1;
      if (streak === 0) { streak = dir; continue; }
      if ((streak > 0 && dir > 0) || (streak < 0 && dir < 0)) streak += dir;
      else break;
    }
    for (const p of resChrono) {
      if (p.correct) { currentPositive++; bestStreak = Math.max(bestStreak, currentPositive); }
      else currentPositive = 0;
    }

    const winRows = resChrono.filter(r => r.correct === true);
    const lossRows = resChrono.filter(r => r.correct === false);
    const avgConfWins = winRows.length > 0
      ? winRows.reduce((s, p) => s + p.confidence, 0) / winRows.length : 0;
    const avgConfLosses = lossRows.length > 0
      ? lossRows.reduce((s, p) => s + p.confidence, 0) / lossRows.length : 0;
    const avgMove = resChrono.length > 0
      ? resChrono.reduce((s, p) => s + Math.abs(p.changePct ?? 0), 0) / resChrono.length : 0;
    const last20 = resChrono.slice(-20);
    const last20Wins = last20.filter(r => r.correct === true).length;

    return {
      total,
      resolved,
      pending,
      wins,
      losses,
      winRate: resolved > 0 ? wins / resolved : null,
      avgConfidenceOnWins: Math.round(avgConfWins),
      avgConfidenceOnLosses: Math.round(avgConfLosses),
      currentStreak: streak,
      bestStreak,
      avgMovePct: Math.round(avgMove * 1000) / 1000,
      last20WinRate: last20.length > 0 ? last20Wins / last20.length : null,
    };
  }

  private async generateForCurrentCandle() {
    await this.ensureLoaded();
    const candleOpen = currentCandleOpen();
    if (this.predictions.some(p => p.candleOpenTime === candleOpen)) return;
    const exists = await prisma.btcFiveMinPrediction.findUnique({
      where: { candleOpenTime: BigInt(candleOpen) },
    });
    if (exists) {
      const pred = this.rowToPred(exists);
      if (!this.predictions.some(p => p.id === pred.id)) this.predictions.push(pred);
      this.predictions.sort((a, b) => a.candleOpenTime - b.candleOpenTime);
      if (this.predictions.length > MAX_IN_MEMORY) this.predictions = this.predictions.slice(-MAX_IN_MEMORY);
      return;
    }
    await this.generatePrediction(candleOpen);
  }

  async generatePrediction(candleOpenOverride?: number): Promise<Prediction | null> {
    await this.ensureLoaded();
    const candleOpen = candleOpenOverride ?? currentCandleOpen();
    const candleClose = candleOpen + INTERVAL_MS;

    if (this.predictions.some(p => p.candleOpenTime === candleOpen)) return null;

    try {
      const klines5m = await getBtcKlines('5m', 200, true);
      const klines15m = await getBtcKlines('15m', 200);
      const { highs, lows, closes, volumes } = extractArrays(klines5m);
      const ind5m = computeAll(highs, lows, closes, volumes, 5);
      const arr15 = extractArrays(klines15m);
      const ind15m = computeAll(arr15.highs, arr15.lows, arr15.closes, arr15.volumes, 15);

      const bias5m = computeDirectionalBias(ind5m);
      const bias15m = computeDirectionalBias(ind15m);

      const modelSpot = ind5m.spot;
      const candleK = findKlineByOpenTime(klines5m, candleOpen);
      const spotWindowOpen = candleK?.open
        ?? klines5m[klines5m.length - 1]?.open
        ?? modelSpot;

      const vol = ind5m.volatility;
      const adjustedVol = vol.realized * 0.7 + 0.55 * 0.3;

      const net5m = bias5m.bullishCount - bias5m.bearishCount;
      const net15m = bias15m.bullishCount - bias15m.bearishCount;
      const combinedScore = net5m * 0.6 + net15m * 0.4;
      const totalSigs = Object.keys(bias5m.signals).length;

      const probUp = enhancedBinaryFairValue(modelSpot, modelSpot, 5 / 60, adjustedVol, bias5m.drift, 'above');

      let direction: 'UP' | 'DOWN';
      if (combinedScore > 0) direction = 'UP';
      else if (combinedScore < 0) direction = 'DOWN';
      else direction = probUp >= 0.5 ? 'UP' : 'DOWN';

      const confidence = Math.min(85, Math.round(Math.abs(combinedScore) / totalSigs * 100));

      const recentCloses = closes.slice(-4);
      let upC = 0; let dnC = 0;
      for (let i = 1; i < recentCloses.length; i++) {
        if (recentCloses[i] > recentCloses[i - 1]) upC++; else dnC++;
      }

      const indicators: Prediction['indicators'] = {
        rsi14: Math.round(ind5m.rsi14.value),
        macd: bias5m.signals.macd ?? 'neutral',
        bollinger: Math.round(ind5m.bollinger.percentB * 100),
        obv: ind5m.obv.trend,
        vwap: Math.round(ind5m.vwap.deviation * 100) / 100,
        momentum: upC > dnC ? 'up' : upC < dnC ? 'down' : 'flat',
      };

      const refUsdOpen = await getBitcoinUsdSpot();

      const row = await prisma.btcFiveMinPrediction.create({
        data: {
          candleOpenTime: BigInt(candleOpen),
          candleCloseTime: BigInt(candleClose),
          generatedAt: new Date(),
          spot: spotWindowOpen,
          direction,
          confidence,
          probUp: Math.round(probUp * 1000) / 10,
          indicatorsJson: JSON.stringify(indicators),
          refUsdOpen: refUsdOpen ?? undefined,
        },
      });

      const pred: Prediction = {
        id: row.id,
        candleOpenTime: candleOpen,
        candleCloseTime: candleClose,
        generatedAt: row.generatedAt.getTime(),
        spot: spotWindowOpen,
        direction,
        confidence,
        probUp: Math.round(probUp * 1000) / 10,
        indicators,
        resolved: false,
        refUsdOpen: refUsdOpen ?? undefined,
      };

      this.predictions.push(pred);
      this.predictions.sort((a, b) => a.candleOpenTime - b.candleOpenTime);
      if (this.predictions.length > MAX_IN_MEMORY) this.predictions = this.predictions.slice(-MAX_IN_MEMORY);

      const candleTime = new Date(candleOpen).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' });
      console.log(`[btc-predict] #${pred.id} candle ${candleTime} → ${pred.direction} open=$${spotWindowOpen.toFixed(0)} | conf=${confidence}% probUp=${pred.probUp}%`);
      return pred;
    } catch (e: any) {
      if (e?.code === 'P2002') return null;
      console.error('[btc-predict] generation error:', e.message);
      return null;
    }
  }

  /** Resolve closed candles (safe to call from background interval). */
  async tickResolveOnly(): Promise<void> {
    await this.ensureLoaded();
    await this.resolveExpired();
  }

  private async resolveExpired() {
    await this.ensureLoaded();
    const now = Date.now();
    const toResolve = this.predictions.filter(p => !p.resolved && p.candleCloseTime <= now);
    if (toResolve.length === 0) return;

    let klines: Kline[];
    try {
      klines = await getBtcKlines('5m', 50);
    } catch { return; }

    for (const pred of toResolve) {
      const matchingKline = klines.find(k => k.openTime === pred.candleOpenTime);

      if (!matchingKline) {
        if (now - pred.candleCloseTime > 10 * 60_000) {
          const lastKline = klines[klines.length - 1];
          if (lastKline) await this.resolvePrediction(pred, lastKline.close);
        }
        continue;
      }

      await this.resolvePrediction(pred, matchingKline.close);
    }
  }

  private async resolvePrediction(pred: Prediction, closePrice: number) {
    pred.resolved = true;
    pred.spotAtExpiry = closePrice;
    pred.actualDirection = closePrice >= pred.spot ? 'UP' : 'DOWN';
    pred.correct = pred.direction === pred.actualDirection;
    pred.changePct = pred.spot > 0 ? ((closePrice - pred.spot) / pred.spot) * 100 : 0;

    const refUsdClose = await getBitcoinUsdSpot();
    pred.refUsdClose = refUsdClose ?? undefined;

    try {
      await prisma.btcFiveMinPrediction.update({
        where: { id: pred.id },
        data: {
          resolved: true,
          spotAtExpiry: closePrice,
          actualDirection: pred.actualDirection,
          correct: pred.correct,
          changePct: pred.changePct,
          refUsdClose: refUsdClose ?? undefined,
        },
      });
    } catch (e: any) {
      console.error('[btc-predict] db resolve:', e.message);
    }

    const icon = pred.correct ? 'OK' : 'XX';
    const time = new Date(pred.candleOpenTime).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' });
    console.log(`[btc-predict] #${pred.id} [${icon}] ${time} predicted=${pred.direction} actual=${pred.actualDirection} | $${pred.spot.toFixed(0)}→$${closePrice.toFixed(0)} (${pred.changePct >= 0 ? '+' : ''}${pred.changePct.toFixed(3)}%)`);
  }
}

let _instance: BtcPredictionTracker | null = null;
let _predResolveInterval: ReturnType<typeof setInterval> | null = null;

export function getPredictionTracker(): BtcPredictionTracker {
  if (!_instance) {
    _instance = new BtcPredictionTracker();
    if (!_predResolveInterval) {
      _predResolveInterval = setInterval(() => {
        void _instance?.tickResolveOnly();
      }, 30_000);
    }
  }
  return _instance;
}

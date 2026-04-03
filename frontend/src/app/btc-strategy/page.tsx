'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine,
} from 'recharts';
import api from '@/lib/api';

// ─── Types ──────────────────────────────────────────────────────────────────

interface IndicatorSnapshot {
  rsi14: { value: number; overbought: boolean; oversold: boolean };
  rsi50: { value: number };
  macd: { macd: number; signal: number; histogram: number; bullish: boolean };
  bollinger: { upper: number; middle: number; lower: number; percentB: number; bandwidth: number };
  atr14: { value: number; pctOfPrice: number };
  vwap: { value: number; deviation: number };
  obv: { value: number; trend: string; slope: number };
  volatility: { realized: number; hourly: number; regime: string };
  spot: number;
  timestamp: number;
}

interface ScanMarket {
  marketId: string;
  eventSlug: string;
  question: string;
  strike: number;
  strikeHigh?: number;
  direction: 'above' | 'below' | 'between';
  spot: number;
  hoursLeft: number;
  marketYesPrice: number;
  clobTokenIds: string[] | null;
  liquidity: number;
  volume24h: number;
  fairValue: number;
  adjustedVol: number;
  drift: number;
  confidence: number;
  edge: number;
  edgePct: number;
  signal: 'BUY_YES' | 'BUY_NO' | 'FAIR';
  signalStrength: 'strong' | 'moderate' | 'weak';
  kellyFraction: number;
  expectedValue: number;
}

interface LiveBtcMarket {
  marketId: string;
  eventSlug: string;
  eventTitle: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  hoursLeft: number | null;
  timeCategory: 'short' | 'medium' | 'long';
  expiryLabel: string;
  liquidity: number;
  volume24h: number;
  oneDayChange: number;
  acceptingOrders: boolean;
  hasParsedStrike: boolean;
  strike: number | null;
  direction: string | null;
}

interface BacktestSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalReturn: number;
  sharpe: number;
  maxDrawdown: number;
  avgEdge: number;
  equityCurve: { time: number; equity: number }[];
}

interface AutoTraderStatus {
  running: boolean;
  config: Record<string, any>;
  stats: {
    date: string;
    tradesPlaced: number;
    totalUsdDeployed: number;
    estimatedPnl: number;
    realizedPnl: number;
    openPositions: number;
    resolvedTrades: number;
    wins: number;
    losses: number;
  };
  recentTrades: {
    timestamp: number;
    question: string;
    signal: string;
    price: number;
    size: number;
    edgePct: number;
    status: string;
    orderId?: string;
    resolved?: boolean;
    outcome?: 'win' | 'loss';
    pnl?: number;
  }[];
}

interface PerformanceData {
  performance: {
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
  };
  equityCurve: {
    time: number;
    equity: number;
    pnl: number;
    outcome: string;
    signal: string;
    edge: number;
    question: string;
  }[];
  edgeBuckets: Record<string, { count: number; wins: number; totalPnl: number }>;
  signalBreakdown: {
    buyYes: { total: number; wins: number; pnl: number };
    buyNo: { total: number; wins: number; pnl: number };
  };
}

type Tab = 'live5m' | 'indicators' | 'scan' | 'backtest' | 'autotrader' | 'performance';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt$(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtBtc(n: number): string {
  return `$${n.toLocaleString('en', { maximumFractionDigits: 0 })}`;
}

function pct(v: number, signed = true): string {
  const sign = signed && v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function regimeColor(r: string): string {
  if (r === 'extreme') return 'text-red-400';
  if (r === 'high') return 'text-orange-400';
  if (r === 'normal') return 'text-yellow-400';
  return 'text-green-400';
}

// ─── Stat Box ───────────────────────────────────────────────────────────────

function Stat({ label, value, color = 'text-white', sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="bg-gray-800/50 rounded-lg p-3 text-center">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-lg font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-600 mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── Indicator Gauge ────────────────────────────────────────────────────────

function Gauge({ label, value, min, max, zones, unit = '' }: {
  label: string; value: number; min: number; max: number; unit?: string;
  zones?: { from: number; to: number; color: string }[];
}) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-gray-500">
        <span>{label}</span>
        <span className="font-mono text-gray-300">{value.toFixed(1)}{unit}</span>
      </div>
      <div className="relative h-2 bg-gray-800 rounded-full overflow-hidden">
        {zones?.map((z, i) => (
          <div key={i} className={`absolute h-full ${z.color}`}
            style={{ left: `${((z.from - min) / (max - min)) * 100}%`, width: `${((z.to - z.from) / (max - min)) * 100}%` }} />
        ))}
        <div className="absolute h-full w-1 bg-white rounded z-10" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── BTC 5-Min Panel ────────────────────────────────────────────────────────

interface FiveMinModelSignal {
  signal: 'BUY_YES' | 'BUY_NO' | 'FAIR';
  edge: number;
  fairValue: number;
  strength: 'strong' | 'moderate' | 'weak';
  kelly: number;
}

interface FiveMinMarket {
  marketId: string;
  conditionId?: string;
  eventSlug: string;
  eventTitle?: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  clobTokenIds?: string[];
  endTime: number | null;
  hoursLeft: number | null;
  isActive: boolean;
  isClosed: boolean;
  isExpired: boolean;
  outcome: 'yes' | 'no' | null;
  liquidity: number;
  strike: number | null;
  direction: string | null;
  modelSignal: FiveMinModelSignal | null;
  signalResult: 'win' | 'loss' | null;
  trade: {
    signal: string;
    edge: number;
    fairValue: number;
    price: number;
    size: number;
    resolved: boolean;
    outcome: 'win' | 'loss' | null;
    pnl: number | null;
    spotAtEntry: number | null;
  } | null;
}

interface FiveMinHistory {
  total: number;
  active: number;
  closed: number;
  expired: number;
  withSignal: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  btcSpot: number;
  markets: FiveMinMarket[];
}

interface PredictionData {
  id: number;
  candleOpenTime: number;
  candleCloseTime: number;
  generatedAt: number;
  spot: number;
  direction: 'UP' | 'DOWN';
  confidence: number;
  probUp: number;
  indicators: { rsi14: number; macd: string; bollinger: number; obv: string; vwap: number; momentum: string };
  resolved: boolean;
  spotAtExpiry?: number;
  actualDirection?: string;
  correct?: boolean;
  changePct?: number;
  refUsdOpen?: number;
  refUsdClose?: number;
}

interface PredictionResponse {
  current: PredictionData | null;
  history: PredictionData[];
  priceNote?: string;
  stats: {
    total: number; resolved: number; pending: number;
    wins: number; losses: number; winRate: number | null;
    avgConfidenceOnWins: number; avgConfidenceOnLosses: number;
    currentStreak: number; bestStreak: number;
    avgMovePct: number; last20WinRate: number | null;
  };
}

function Btc5MinPanel({ spot, indicators }: {
  spot: number;
  indicators: IndicatorSnapshot | null;
}) {
  const [history, setHistory] = useState<FiveMinHistory | null>(null);
  const [prediction, setPrediction] = useState<PredictionResponse | null>(null);
  const [clobStatus, setClobStatus] = useState<{ ready: boolean; error: string | null; tradingAddress: string | null } | null>(null);
  const [tradeMarketId, setTradeMarketId] = useState('');
  const [tradeSide, setTradeSide] = useState<'YES' | 'NO'>('YES');
  const [tradeUsd, setTradeUsd] = useState(10);
  const [tradeMaxPx, setTradeMaxPx] = useState('');
  const [tradeBusy, setTradeBusy] = useState(false);
  const [tradeMsg, setTradeMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'active' | 'resolved'>('all');
  const [now, setNow] = useState(Date.now());

  const fetchAll = useCallback(async () => {
    try {
      const [histRes, predRes, clobRes] = await Promise.all([
        api.get('/btc-strategy/markets/5min-history'),
        api.get('/btc-strategy/prediction'),
        api.get('/btc-strategy/trading-status').catch(() => ({ data: null })),
      ]);
      setHistory(histRes.data);
      setPrediction(predRes.data);
      if (clobRes.data) setClobStatus(clobRes.data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
    const t = window.setInterval(fetchAll, 10_000);
    return () => window.clearInterval(t);
  }, [fetchAll]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!history) return;
    const t = history.markets.filter(m => m.isActive && (m.clobTokenIds?.length ?? 0) >= 2);
    if (t.length === 0) return;
    if (!tradeMarketId || !t.some(m => m.marketId === tradeMarketId)) {
      setTradeMarketId(t[0].marketId);
    }
  }, [history, tradeMarketId]);

  function countdownSec(targetMs: number): string {
    const remaining = Math.max(0, Math.floor((targetMs - now) / 1000));
    if (remaining <= 0) return '0:00';
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function countdown(endTime: number | null): string {
    if (endTime === null) return '--:--';
    return countdownSec(endTime);
  }

  if (loading) return <div className="h-40 animate-pulse bg-gray-800/40 rounded-xl" />;
  if (!history) return <div className="text-center py-12 text-gray-600">Failed to load data</div>;

  const cur = prediction?.current ?? null;
  const predStats = prediction?.stats ?? null;
  const predHistory = prediction?.history ?? [];
  const priceNote = prediction?.priceNote;

  const tradableMarkets = history.markets.filter(
    m => m.isActive && (m.clobTokenIds?.length ?? 0) >= 2,
  );
  const selectedTradeMarket = tradableMarkets.find(m => m.marketId === tradeMarketId);

  const filtered = filter === 'all'
    ? history.markets
    : filter === 'active'
      ? history.markets.filter(m => m.isActive)
      : history.markets.filter(m => m.isClosed || m.isExpired);

  return (
    <div className="space-y-4">
      {/* Current prediction card */}
      {cur ? (
        <div className={`rounded-xl p-5 border-2 ${
          cur.direction === 'UP'
            ? 'bg-green-950/30 border-green-500/50'
            : 'bg-red-950/30 border-red-500/50'
        }`}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className={`text-4xl font-black ${
                cur.direction === 'UP' ? 'text-green-400' : 'text-red-400'
              }`}>
                {cur.direction === 'UP' ? '▲' : '▼'}
              </div>
              <div>
                <div className="text-lg font-bold text-white">
                  <span className={cur.direction === 'UP' ? 'text-green-400' : 'text-red-400'}>
                    BTC {cur.direction}
                  </span>
                  <span className="text-xs text-gray-500 font-normal ml-2">
                    {new Date(cur.candleOpenTime).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' })}
                    –{new Date(cur.candleCloseTime).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="text-xs text-gray-400">
                  Confidence: <span className="text-white font-bold">{cur.confidence}%</span>
                  {' '}— P(up): <span className="font-mono text-blue-400">{cur.probUp}%</span>
                  {' '}— P(down): <span className="font-mono text-blue-400">{(100 - cur.probUp).toFixed(1)}%</span>
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-gray-500 uppercase">5m open (Binance)</div>
              <div className="text-2xl font-bold font-mono text-orange-400 tabular-nums">{fmtBtc(cur.spot)}</div>
              {cur.refUsdOpen != null && (
                <div className="text-[10px] text-cyan-400/90 font-mono">CG USD ~{fmtBtc(cur.refUsdOpen)}</div>
              )}
              <div className={`text-sm font-bold font-mono tabular-nums ${
                cur.candleCloseTime > now ? 'text-yellow-400' : 'text-gray-500'
              }`}>
                {cur.candleCloseTime > now ? countdownSec(cur.candleCloseTime) : 'resolving...'}
              </div>
            </div>
          </div>

          {priceNote && (
            <p className="text-[10px] text-gray-500 leading-relaxed border-t border-gray-800/60 pt-2 mt-1">{priceNote}</p>
          )}

          {/* Indicator chips */}
          <div className="flex gap-1.5 text-[10px] flex-wrap">
            <span className={`px-1.5 py-0.5 rounded ${cur.indicators.rsi14 > 55 ? 'bg-green-500/15 text-green-400' : cur.indicators.rsi14 < 45 ? 'bg-red-500/15 text-red-400' : 'bg-gray-800 text-gray-500'}`}>
              RSI {cur.indicators.rsi14}
            </span>
            <span className={`px-1.5 py-0.5 rounded ${cur.indicators.macd === 'bullish' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
              MACD {cur.indicators.macd === 'bullish' ? '▲' : '▼'}
            </span>
            <span className={`px-1.5 py-0.5 rounded ${cur.indicators.bollinger > 50 ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
              BB {cur.indicators.bollinger}%
            </span>
            <span className={`px-1.5 py-0.5 rounded ${cur.indicators.obv === 'rising' ? 'bg-green-500/15 text-green-400' : cur.indicators.obv === 'falling' ? 'bg-red-500/15 text-red-400' : 'bg-gray-800 text-gray-500'}`}>
              OBV {cur.indicators.obv === 'rising' ? '▲' : cur.indicators.obv === 'falling' ? '▼' : '—'}
            </span>
            <span className={`px-1.5 py-0.5 rounded ${cur.indicators.vwap > 0 ? 'bg-green-500/15 text-green-400' : cur.indicators.vwap < 0 ? 'bg-red-500/15 text-red-400' : 'bg-gray-800 text-gray-500'}`}>
              VWAP {cur.indicators.vwap > 0 ? '+' : ''}{cur.indicators.vwap}%
            </span>
            <span className={`px-1.5 py-0.5 rounded ${cur.indicators.momentum === 'up' ? 'bg-green-500/15 text-green-400' : cur.indicators.momentum === 'down' ? 'bg-red-500/15 text-red-400' : 'bg-gray-800 text-gray-500'}`}>
              Momentum {cur.indicators.momentum}
            </span>
          </div>
        </div>
      ) : (
        <div className="rounded-xl p-5 border border-gray-700 bg-gray-900 text-center">
          <div className="text-xl mb-1">₿</div>
          <div className="text-sm text-gray-400">Generating first prediction...</div>
          <div className="text-[10px] text-gray-600 mt-1">Predictions are generated every 5 minutes</div>
        </div>
      )}

      {/* Prediction stats + history */}
      {predStats && predStats.total > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Stat label="Predictions" value={String(predStats.total)}
            sub={`${predStats.pending} pending`} />
          <Stat label="Win Rate"
            value={predStats.winRate !== null ? `${(predStats.winRate * 100).toFixed(0)}%` : '—'}
            color={predStats.winRate !== null ? (predStats.winRate > 0.55 ? 'text-green-400' : predStats.winRate < 0.45 ? 'text-red-400' : 'text-yellow-400') : 'text-gray-500'}
            sub={predStats.resolved > 0 ? `${predStats.wins}W / ${predStats.losses}L` : ''} />
          <Stat label="Last 20"
            value={predStats.last20WinRate !== null ? `${(predStats.last20WinRate * 100).toFixed(0)}%` : '—'}
            color={predStats.last20WinRate !== null ? (predStats.last20WinRate > 0.55 ? 'text-green-400' : predStats.last20WinRate < 0.45 ? 'text-red-400' : 'text-yellow-400') : 'text-gray-500'}
            sub="recent form" />
          <Stat label="Streak" value={predStats.currentStreak === 0 ? '—' : `${predStats.currentStreak > 0 ? '+' : ''}${predStats.currentStreak}`}
            color={predStats.currentStreak > 0 ? 'text-green-400' : predStats.currentStreak < 0 ? 'text-red-400' : 'text-gray-400'}
            sub={`best: ${predStats.bestStreak}`} />
          <Stat label="Avg Move" value={`${predStats.avgMovePct.toFixed(3)}%`} color="text-blue-400" />
          <Stat label="Avg Conf" value={predStats.avgConfidenceOnWins > 0 ? `W:${predStats.avgConfidenceOnWins} L:${predStats.avgConfidenceOnLosses}` : '—'}
            color="text-gray-300" sub="wins vs losses" />
        </div>
      )}

      {/* Prediction history log */}
      {predHistory.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-800 flex items-center justify-between">
            <span className="text-xs font-bold text-gray-300">Prediction History</span>
            <span className="text-[10px] text-gray-600">{predHistory.length} entries</span>
          </div>
          <div className="max-h-[300px] overflow-y-auto">
            {predHistory.slice(0, 30).map(p => {
              const time = new Date(p.candleOpenTime).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' });
              return (
                <div key={p.id} className={`px-4 py-2 border-b border-gray-800/40 flex items-center gap-3 text-xs ${
                  p.resolved
                    ? p.correct ? 'bg-green-950/10' : 'bg-red-950/10'
                    : ''
                }`}>
                  <span className="text-gray-600 font-mono w-12">{time}</span>
                  <span className={`font-bold w-8 ${p.direction === 'UP' ? 'text-green-400' : 'text-red-400'}`}>
                    {p.direction === 'UP' ? '▲' : '▼'}
                  </span>
                  <span className="text-gray-400 font-mono w-16">{fmtBtc(p.spot)}</span>
                  <span className="text-gray-600 w-8 text-center">{p.confidence}%</span>
                  {p.resolved ? (
                    <>
                      <span className="text-gray-600">→</span>
                      <span className="text-gray-400 font-mono w-16" title="Binance 5m close">
                        {fmtBtc(p.spotAtExpiry ?? 0)}
                        {p.refUsdClose != null ? <span className="block text-[9px] text-cyan-500/80">~{fmtBtc(p.refUsdClose)}</span> : null}
                      </span>
                      <span className={`font-mono w-16 ${(p.changePct ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {(p.changePct ?? 0) >= 0 ? '+' : ''}{(p.changePct ?? 0).toFixed(3)}%
                      </span>
                      <span className={`font-bold px-2 py-0.5 rounded text-[10px] ${
                        p.correct
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-red-500/20 text-red-400'
                      }`}>
                        {p.correct ? 'OK' : 'MISS'}
                      </span>
                    </>
                  ) : (
                    <span className="text-yellow-400 text-[10px] font-bold">PENDING {countdownSec(p.candleCloseTime)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Quick CLOB trade */}
      <div className="rounded-xl border border-amber-500/35 bg-amber-950/15 p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-sm font-bold text-amber-100">Быстрая сделка (5m BTC)</h3>
          {clobStatus?.ready ? (
            <span className="text-[10px] text-green-400/90 font-mono truncate max-w-[220px]" title={clobStatus.tradingAddress ?? ''}>
              {clobStatus.tradingAddress ?? ''}
            </span>
          ) : (
            <span className="text-[10px] text-red-400/90 max-w-[280px]">{clobStatus?.error || 'Проверка кошелька…'}</span>
          )}
        </div>
        {tradableMarkets.length === 0 ? (
          <p className="text-xs text-gray-500">Нет активных коротких BTC рынков с CLOB. Загляните позже или обновите список.</p>
        ) : (
          <>
            <label className="text-[10px] text-gray-500 uppercase block">Рынок</label>
            <select
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-2 py-2 text-xs text-white"
              value={tradeMarketId}
              onChange={e => { setTradeMarketId(e.target.value); setTradeMsg(null); }}
            >
              {tradableMarkets.map(m => (
                <option key={m.marketId} value={m.marketId}>
                  {(m.question || m.eventTitle || m.marketId).slice(0, 90)}
                  {(m.question || '').length > 90 ? '…' : ''} · YES {(m.yesPrice * 100).toFixed(0)}¢
                </option>
              ))}
            </select>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <span className="text-[10px] text-gray-500 uppercase block mb-1">Сторона</span>
                <div className="flex gap-1">
                  <button type="button" onClick={() => { setTradeSide('YES'); setTradeMsg(null); }}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors ${tradeSide === 'YES' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                    YES
                  </button>
                  <button type="button" onClick={() => { setTradeSide('NO'); setTradeMsg(null); }}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors ${tradeSide === 'NO' ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                    NO
                  </button>
                </div>
              </div>
              <div>
                <span className="text-[10px] text-gray-500 uppercase block mb-1">Сумма (USDC)</span>
                <div className="flex flex-wrap gap-1 mb-1">
                  {[5, 10, 25, 50, 100].map(a => (
                    <button key={a} type="button" onClick={() => { setTradeUsd(a); setTradeMsg(null); }}
                      className={`px-2 py-1 rounded text-[10px] font-medium ${tradeUsd === a ? 'bg-amber-600 text-black' : 'bg-gray-800 text-gray-400'}`}>
                      ${a}
                    </button>
                  ))}
                </div>
                <input type="number" min={1} step={1} value={tradeUsd}
                  onChange={e => setTradeUsd(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono text-white" />
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[140px]">
                <span className="text-[10px] text-gray-500 uppercase">Лимит (опц., 0–1)</span>
                <input placeholder="напр. 0.58" value={tradeMaxPx}
                  onChange={e => setTradeMaxPx(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono text-white mt-1" />
              </div>
              <button type="button" disabled={tradeBusy || !clobStatus?.ready || !tradeMarketId}
                onClick={async () => {
                  setTradeBusy(true);
                  setTradeMsg(null);
                  try {
                    const body: Record<string, unknown> = {
                      marketId: tradeMarketId,
                      side: tradeSide,
                      usdAmount: tradeUsd,
                    };
                    const mx = tradeMaxPx.trim();
                    if (mx !== '') body.maxPrice = Number(mx);
                    const res = await api.post('/btc-strategy/markets/5min-order', body);
                    const d = res.data as { success?: boolean; orderID?: string; error?: string; limitPrice?: number; actualUsdcAmount?: number; midPrice?: number };
                    if (d.success) {
                      const oid = d.orderID ?? '';
                      setTradeMsg(`Ок: ордер ${oid || 'принят'} · ~$${(d.actualUsdcAmount ?? tradeUsd).toFixed(2)} @ ${(d.limitPrice ?? d.midPrice ?? 0).toFixed(3)}`);
                    } else setTradeMsg(d.error || 'Ошибка');
                  } catch (e: unknown) {
                    const ax = e as { response?: { data?: { error?: string } }; message?: string };
                    setTradeMsg(ax.response?.data?.error || ax.message || 'Ошибка запроса');
                  } finally {
                    setTradeBusy(false);
                  }
                }}
                className="px-5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-bold text-black">
                {tradeBusy ? '…' : 'Купить'}
              </button>
              {selectedTradeMarket?.eventSlug ? (
                <a href={`https://polymarket.com/event/${encodeURIComponent(selectedTradeMarket.eventSlug)}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-[10px] text-cyan-400/90 underline py-2 shrink-0">
                  На сайте Polymarket ↗
                </a>
              ) : null}
            </div>
            {tradeMsg && (
              <p className={`text-xs ${tradeMsg.startsWith('Ок') ? 'text-green-400' : 'text-red-400'}`}>{tradeMsg}</p>
            )}
          </>
        )}
      </div>

      {/* Polymarket 5-min markets section */}
      <div className="border-t border-gray-800 pt-4 mt-2">
        <h3 className="text-sm font-bold text-gray-400 mb-3 uppercase tracking-wider">Polymarket 5-Min Markets</h3>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-7 gap-3">
        <Stat label="BTC Spot" value={fmtBtc(history.btcSpot || spot)} color="text-orange-400" />
        <Stat label="Active" value={String(history.active)} color="text-yellow-400" />
        <Stat label="Signals" value={String(history.withSignal)} color="text-blue-400"
          sub={`of ${history.total} markets`} />
        <Stat label="Resolved" value={String(history.resolved)}
          sub={history.resolved > 0 ? `${history.wins}W / ${history.losses}L` : 'awaiting close'} />
        <Stat label="Win Rate"
          value={history.winRate !== null ? `${(history.winRate * 100).toFixed(0)}%` : '—'}
          color={history.winRate !== null ? (history.winRate > 0.55 ? 'text-green-400' : history.winRate < 0.45 ? 'text-red-400' : 'text-yellow-400') : 'text-gray-500'}
          sub={history.winRate !== null ? 'signal accuracy' : ''} />
        <Stat label="Total P&L"
          value={history.totalPnl !== 0 ? `$${history.totalPnl.toFixed(2)}` : '—'}
          color={history.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}
          sub="auto-trader only" />
        <Stat label="Closed" value={String(history.closed + history.expired)} color="text-gray-400" />
      </div>

      {/* Filter tabs */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-300">BTC 5-Min Markets</h3>
        <div className="flex gap-1 bg-gray-900 rounded-lg p-0.5 border border-gray-800">
          {([
            { key: 'all' as const, label: `All (${history.total})` },
            { key: 'active' as const, label: `Active (${history.active})` },
            { key: 'resolved' as const, label: `Resolved (${history.closed + history.expired})` },
          ]).map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors ${
                filter === f.key ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Markets list */}
      {filtered.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-600">
          <div className="text-2xl mb-2">₿</div>
          <div>{filter === 'active' ? 'No active 5-minute BTC markets right now' : 'No resolved markets yet'}</div>
          <div className="text-[10px] text-gray-700 mt-1">
            {filter === 'active' ? 'They appear during active trading hours' : 'Markets appear after they close'}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(m => {
            const isActive = m.isActive;
            const isDone = m.isClosed || m.isExpired;
            const ms = m.modelSignal;
            const hasSignal = ms && ms.signal !== 'FAIR';

            // Card border color based on signal result
            let statusBorder = 'border-gray-800';
            let statusBg = 'bg-gray-900';
            if (isActive && hasSignal) {
              statusBorder = ms.signal === 'BUY_YES' ? 'border-green-500/40' : 'border-red-500/40';
            } else if (isActive) {
              statusBorder = 'border-orange-500/30';
            } else if (isDone && m.signalResult === 'win') {
              statusBorder = 'border-green-500/30';
              statusBg = 'bg-green-950/20';
            } else if (isDone && m.signalResult === 'loss') {
              statusBorder = 'border-red-500/30';
              statusBg = 'bg-red-950/20';
            }

            const endTimeStr = m.endTime
              ? new Date(m.endTime).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' })
              : '—';

            return (
              <div key={m.marketId} className={`${statusBg} border ${statusBorder} rounded-xl p-4`}>
                {/* Row 1: Status + Signal + Result */}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  {/* Timer / Status */}
                  {isActive && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 border border-orange-500/30 font-bold font-mono">
                      LIVE {countdown(m.endTime)}
                    </span>
                  )}
                  {isDone && m.outcome === 'yes' && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/30 font-bold">
                      YES WON
                    </span>
                  )}
                  {isDone && m.outcome === 'no' && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30 font-bold">
                      NO WON
                    </span>
                  )}
                  {isDone && !m.outcome && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-500/15 text-gray-400 border border-gray-500/30 font-bold">
                      PENDING
                    </span>
                  )}

                  {/* Our model signal — always show for every market */}
                  {hasSignal ? (
                    <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                      ms.signal === 'BUY_YES'
                        ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                        : 'bg-red-500/20 text-red-400 border border-red-500/30'
                    }`}>
                      Signal: {ms.signal === 'BUY_YES' ? '▲ YES' : '▼ NO'} ({ms.edge > 0 ? '+' : ''}{ms.edge.toFixed(1)}% edge)
                    </span>
                  ) : ms ? (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-500 border border-gray-700">
                      Signal: FAIR (no edge)
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-600 border border-gray-700">
                      No model data
                    </span>
                  )}

                  {/* Signal result for resolved markets */}
                  {isDone && m.signalResult === 'win' && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-green-500/25 text-green-300 border border-green-500/40 font-bold">
                      SIGNAL CORRECT
                    </span>
                  )}
                  {isDone && m.signalResult === 'loss' && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-red-500/25 text-red-300 border border-red-500/40 font-bold">
                      SIGNAL WRONG
                    </span>
                  )}

                  {/* Trade PnL if auto-trader placed a trade */}
                  {m.trade?.resolved && m.trade.pnl !== null && (
                    <span className={`text-[10px] px-2 py-0.5 rounded font-bold font-mono ${
                      m.trade.pnl >= 0
                        ? 'bg-green-500/15 text-green-300 border border-green-500/30'
                        : 'bg-red-500/15 text-red-300 border border-red-500/30'
                    }`}>
                      {m.trade.pnl >= 0 ? '+' : ''}${m.trade.pnl.toFixed(2)}
                    </span>
                  )}
                </div>

                {/* Row 2: Question */}
                <a href={`https://polymarket.com/event/${m.eventSlug}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-xs text-gray-200 hover:text-blue-400 transition-colors block truncate mb-2">
                  {m.question}
                </a>

                {/* Row 3: Data grid */}
                <div className="flex items-center gap-3 text-[10px] flex-wrap">
                  {/* YES / NO prices */}
                  <div className="flex items-center gap-1.5">
                    <span className={`font-mono font-bold px-1.5 py-0.5 rounded ${
                      isDone && m.outcome === 'yes'
                        ? 'bg-green-500/20 text-green-400'
                        : hasSignal && ms.signal === 'BUY_YES' && isActive
                          ? 'bg-green-500/10 text-green-400'
                          : 'text-gray-400'
                    }`}>
                      Y:{(m.yesPrice * 100).toFixed(0)}c
                    </span>
                    <span className={`font-mono font-bold px-1.5 py-0.5 rounded ${
                      isDone && m.outcome === 'no'
                        ? 'bg-red-500/20 text-red-400'
                        : hasSignal && ms.signal === 'BUY_NO' && isActive
                          ? 'bg-red-500/10 text-red-400'
                          : 'text-gray-400'
                    }`}>
                      N:{(m.noPrice * 100).toFixed(0)}c
                    </span>
                  </div>

                  <span className="text-gray-700">|</span>

                  {m.strike && (
                    <>
                      <span className="text-gray-500">Strike: <span className="text-yellow-400 font-mono">{fmtBtc(m.strike)}</span></span>
                      <span className="text-gray-700">|</span>
                    </>
                  )}

                  {hasSignal && (
                    <>
                      <span className="text-gray-500">Fair: <span className="text-blue-400 font-mono">{(ms.fairValue * 100).toFixed(0)}c</span></span>
                      <span className="text-gray-700">|</span>
                    </>
                  )}

                  <span className="text-gray-500">Ends: <span className="text-gray-400 font-mono">{endTimeStr}</span></span>

                  {m.trade?.spotAtEntry && (
                    <>
                      <span className="text-gray-700">|</span>
                      <span className="text-gray-500">BTC: <span className="text-orange-400 font-mono">{fmtBtc(m.trade.spotAtEntry)}</span></span>
                    </>
                  )}

                  <span className="text-gray-700">|</span>
                  <span className="text-gray-600 font-mono">{fmt$(m.liquidity)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Live Markets Panel ─────────────────────────────────────────────────────

function LiveMarketsPanel({ markets }: { markets: LiveBtcMarket[] }) {
  const [filter, setFilter] = useState<'all' | 'short' | 'medium' | 'long'>('all');

  const filtered = filter === 'all' ? markets : markets.filter(m => m.timeCategory === filter);
  const shortCount = markets.filter(m => m.timeCategory === 'short').length;
  const medCount = markets.filter(m => m.timeCategory === 'medium').length;
  const longCount = markets.filter(m => m.timeCategory === 'long').length;

  const catLabel = { short: '5-30m', medium: '1-4h', long: '4h+' };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-300">Live BTC Markets on Polymarket</h3>
        <div className="flex gap-1 bg-gray-900 rounded-lg p-0.5 border border-gray-800">
          {([
            { key: 'all' as const, label: `All (${markets.length})` },
            { key: 'short' as const, label: `Short (${shortCount})` },
            { key: 'medium' as const, label: `Med (${medCount})` },
            { key: 'long' as const, label: `Long (${longCount})` },
          ]).map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors ${
                filter === f.key ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-8 text-gray-600 text-sm">No BTC markets found</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-gray-500 text-left border-b border-gray-800">
                <th className="pb-2 pr-2">Market</th>
                <th className="pb-2 pr-2 text-center">YES</th>
                <th className="pb-2 pr-2 text-center">NO</th>
                <th className="pb-2 pr-2 text-center">Expiry</th>
                <th className="pb-2 pr-2 text-right">24h</th>
                <th className="pb-2 pr-2 text-right">Liq</th>
                <th className="pb-2 text-right">Vol 24h</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(m => {
                const isShort = m.timeCategory === 'short';
                const isMed = m.timeCategory === 'medium';
                return (
                  <tr key={m.marketId} className="border-t border-gray-800/40 hover:bg-gray-800/30">
                    <td className="py-2 pr-2 max-w-[300px]">
                      <a href={`https://polymarket.com/event/${m.eventSlug}`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-gray-200 hover:text-blue-400 truncate block transition-colors">
                        {m.question}
                      </a>
                      {m.hasParsedStrike && m.strike && (
                        <span className="text-[9px] text-gray-600 font-mono">
                          {m.direction?.toUpperCase()} {fmtBtc(m.strike)}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-center">
                      <span className={`font-mono font-bold px-2 py-0.5 rounded ${
                        m.yesPrice > 0.6 ? 'text-green-400 bg-green-500/10' :
                        m.yesPrice < 0.4 ? 'text-red-400 bg-red-500/10' :
                        'text-yellow-400 bg-yellow-500/10'
                      }`}>
                        {(m.yesPrice * 100).toFixed(1)}c
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-center">
                      <span className={`font-mono font-bold px-2 py-0.5 rounded ${
                        m.noPrice > 0.6 ? 'text-red-400 bg-red-500/10' :
                        m.noPrice < 0.4 ? 'text-green-400 bg-green-500/10' :
                        'text-yellow-400 bg-yellow-500/10'
                      }`}>
                        {(m.noPrice * 100).toFixed(1)}c
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                        isShort ? 'bg-orange-500/15 text-orange-400 border border-orange-500/20' :
                        isMed ? 'bg-blue-500/15 text-blue-400 border border-blue-500/20' :
                        'bg-gray-500/15 text-gray-400 border border-gray-500/20'
                      }`}>
                        {m.expiryLabel}
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-right font-mono">
                      <span className={m.oneDayChange > 0 ? 'text-green-400' : m.oneDayChange < 0 ? 'text-red-400' : 'text-gray-500'}>
                        {m.oneDayChange > 0 ? '+' : ''}{(m.oneDayChange * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-right text-gray-400 font-mono">{fmt$(m.liquidity)}</td>
                    <td className="py-2 text-right text-gray-400 font-mono">{fmt$(m.volume24h)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Indicators Panel ───────────────────────────────────────────────────────

function IndicatorsPanel({ ind, liveMarkets }: { ind: IndicatorSnapshot; liveMarkets: LiveBtcMarket[] }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="BTC Spot" value={fmtBtc(ind.spot)} color="text-orange-400" />
        <Stat label="Realized Vol" value={`${(ind.volatility.realized * 100).toFixed(0)}%`}
          color={regimeColor(ind.volatility.regime)} sub={ind.volatility.regime} />
        <Stat label="VWAP" value={fmtBtc(ind.vwap.value)}
          sub={`${ind.vwap.deviation >= 0 ? '+' : ''}${ind.vwap.deviation.toFixed(2)}%`} />
        <Stat label="ATR" value={`$${ind.atr14.value.toFixed(0)}`}
          sub={`${ind.atr14.pctOfPrice.toFixed(2)}% of price`} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-bold text-gray-300">Momentum</h3>
          <Gauge label="RSI (14)" value={ind.rsi14.value} min={0} max={100}
            zones={[
              { from: 0, to: 30, color: 'bg-red-500/20' },
              { from: 30, to: 70, color: 'bg-gray-700/30' },
              { from: 70, to: 100, color: 'bg-green-500/20' },
            ]} />
          <Gauge label="RSI (50)" value={ind.rsi50.value} min={0} max={100}
            zones={[
              { from: 0, to: 30, color: 'bg-red-500/20' },
              { from: 30, to: 70, color: 'bg-gray-700/30' },
              { from: 70, to: 100, color: 'bg-green-500/20' },
            ]} />
          <Gauge label="Bollinger %B" value={ind.bollinger.percentB * 100} min={0} max={100} unit="%"
            zones={[
              { from: 0, to: 30, color: 'bg-red-500/20' },
              { from: 30, to: 70, color: 'bg-gray-700/30' },
              { from: 70, to: 100, color: 'bg-green-500/20' },
            ]} />
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-bold text-gray-300">Trend</h3>
          <div className="grid grid-cols-2 gap-2">
            <div className="text-center p-2 bg-gray-800/60 rounded-lg">
              <div className="text-[10px] text-gray-500">MACD</div>
              <div className={`text-sm font-bold ${ind.macd.bullish ? 'text-green-400' : 'text-red-400'}`}>
                {ind.macd.bullish ? 'BULLISH' : 'BEARISH'}
              </div>
              <div className="text-[10px] text-gray-600 font-mono">H: {ind.macd.histogram.toFixed(1)}</div>
            </div>
            <div className="text-center p-2 bg-gray-800/60 rounded-lg">
              <div className="text-[10px] text-gray-500">OBV</div>
              <div className={`text-sm font-bold ${
                ind.obv.trend === 'rising' ? 'text-green-400' : ind.obv.trend === 'falling' ? 'text-red-400' : 'text-gray-400'
              }`}>
                {ind.obv.trend.toUpperCase()}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="p-2 bg-gray-800/60 rounded-lg">
              <div className="text-[10px] text-gray-500">Bollinger Upper</div>
              <div className="text-sm font-mono text-gray-300">{fmtBtc(ind.bollinger.upper)}</div>
            </div>
            <div className="p-2 bg-gray-800/60 rounded-lg">
              <div className="text-[10px] text-gray-500">Bollinger Lower</div>
              <div className="text-sm font-mono text-gray-300">{fmtBtc(ind.bollinger.lower)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Live BTC market quotes */}
      <LiveMarketsPanel markets={liveMarkets} />
    </div>
  );
}

// ─── Scan Panel ─────────────────────────────────────────────────────────────

function ScanPanel({ markets, spot }: { markets: ScanMarket[]; spot: number }) {
  const withEdge = markets.filter(m => m.signal !== 'FAIR');
  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-400">
        {markets.length} BTC markets scanned, <span className="text-yellow-400 font-bold">{withEdge.length}</span> with edge
      </div>

      {markets.length === 0 ? (
        <div className="text-center py-12 text-gray-600">No active BTC markets found</div>
      ) : (
        <div className="space-y-3">
          {markets.map(m => (
            <div key={m.marketId} className={`bg-gray-900 border rounded-xl p-4 ${
              m.signal !== 'FAIR' && m.signalStrength === 'strong' ? 'border-yellow-500/30' :
              m.signal !== 'FAIR' ? 'border-gray-700' : 'border-gray-800'
            }`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-100 truncate mb-1">{m.question}</div>
                  <div className="flex flex-wrap gap-2 text-[10px] text-gray-500">
                    <span>Strike: {fmtBtc(m.strike)}</span>
                    <span>{m.direction.toUpperCase()}</span>
                    <span>{m.hoursLeft.toFixed(1)}h left</span>
                    <span>Liq: {fmt$(m.liquidity)}</span>
                    <span>Vol: {fmt$(m.volume24h)}</span>
                  </div>
                </div>

                <div className="flex items-center gap-3 flex-shrink-0">
                  {m.signal !== 'FAIR' ? (
                    <span className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${
                      m.signal === 'BUY_YES'
                        ? 'bg-green-500/15 text-green-400 border-green-500/30'
                        : 'bg-red-500/15 text-red-400 border-red-500/30'
                    }`}>
                      {m.signal === 'BUY_YES' ? '▲ BUY YES' : '▼ BUY NO'}
                    </span>
                  ) : (
                    <span className="px-3 py-1.5 rounded-lg text-xs text-gray-600 border border-gray-800">FAIR</span>
                  )}
                </div>
              </div>

              {m.signal !== 'FAIR' && (
                <div className="grid grid-cols-6 gap-2 mt-3 text-center text-[11px]">
                  <div>
                    <div className="text-gray-500">Market</div>
                    <div className="font-mono text-white">{(m.marketYesPrice * 100).toFixed(1)}c</div>
                  </div>
                  <div>
                    <div className="text-gray-500">Fair</div>
                    <div className="font-mono text-yellow-400">{(m.fairValue * 100).toFixed(1)}c</div>
                  </div>
                  <div>
                    <div className="text-gray-500">Edge</div>
                    <div className={`font-mono font-bold ${m.edge > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {pct(m.edgePct)}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500">Vol</div>
                    <div className="font-mono text-gray-300">{(m.adjustedVol * 100).toFixed(0)}%</div>
                  </div>
                  <div>
                    <div className="text-gray-500">Drift</div>
                    <div className={`font-mono ${m.drift > 0 ? 'text-green-400' : m.drift < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                      {pct(m.drift * 100)}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-500">Kelly</div>
                    <div className="font-mono text-blue-400">{(m.kellyFraction * 100).toFixed(1)}%</div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Backtest Panel ─────────────────────────────────────────────────────────

function BacktestPanel() {
  const [result, setResult] = useState<BacktestSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [params, setParams] = useState({
    interval: '5m',
    limit: '500',
    strikeOffset: '2',
    direction: 'above',
    horizon: '12',
    edgeThreshold: '5',
    bankroll: '1000',
  });

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/btc-strategy/backtest', { params });
      setResult(res.data.summary);
    } catch { /* ignore */ }
    setLoading(false);
  }, [params]);

  const isPositive = (result?.totalPnl ?? 0) >= 0;

  return (
    <div className="space-y-4">
      {/* Config */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-bold text-gray-300 mb-3">Backtest Parameters</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { key: 'interval', label: 'Interval', opts: ['5m', '15m', '1h'] },
            { key: 'direction', label: 'Direction', opts: ['above', 'below'] },
          ].map(f => (
            <div key={f.key}>
              <label className="text-[10px] text-gray-500 uppercase">{f.label}</label>
              <select value={(params as any)[f.key]}
                onChange={e => setParams(p => ({ ...p, [f.key]: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 mt-1">
                {f.opts.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          ))}
          {[
            { key: 'limit', label: 'Candles' },
            { key: 'strikeOffset', label: 'Strike %' },
            { key: 'horizon', label: 'Horizon (candles)' },
            { key: 'edgeThreshold', label: 'Min Edge %' },
            { key: 'bankroll', label: 'Bankroll $' },
          ].map(f => (
            <div key={f.key}>
              <label className="text-[10px] text-gray-500 uppercase">{f.label}</label>
              <input type="number" value={(params as any)[f.key]}
                onChange={e => setParams(p => ({ ...p, [f.key]: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 font-mono mt-1" />
            </div>
          ))}
        </div>
        <button onClick={run} disabled={loading}
          className="mt-3 px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 rounded-lg text-sm font-medium text-white transition-colors">
          {loading ? 'Running...' : 'Run Backtest'}
        </button>
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="Trades" value={String(result.totalTrades)} />
            <Stat label="Win Rate" value={`${result.winRate}%`}
              color={result.winRate > 50 ? 'text-green-400' : 'text-red-400'} />
            <Stat label="Total P&L" value={`$${result.totalPnl.toFixed(0)}`}
              color={isPositive ? 'text-green-400' : 'text-red-400'} />
            <Stat label="Sharpe" value={result.sharpe.toFixed(2)}
              color={result.sharpe > 1 ? 'text-green-400' : result.sharpe > 0 ? 'text-yellow-400' : 'text-red-400'} />
            <Stat label="Max DD" value={`${result.maxDrawdown.toFixed(1)}%`}
              color={result.maxDrawdown < 10 ? 'text-green-400' : result.maxDrawdown < 25 ? 'text-yellow-400' : 'text-red-400'} />
          </div>

          {result.equityCurve.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <h3 className="text-sm font-bold text-gray-300 mb-3">Equity Curve</h3>
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={result.equityCurve} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                  <defs>
                    <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="time" tickFormatter={t => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                    tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `$${v.toFixed(0)}`}
                    tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} width={60} />
                  <Tooltip labelFormatter={t => new Date(t).toLocaleString()}
                    formatter={(v: any) => [`$${Number(v).toFixed(2)}`, 'Equity']}
                    contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: '8px', fontSize: '11px' }} />
                  <ReferenceLine y={parseFloat(params.bankroll)} stroke="#4b5563" strokeDasharray="4 4" />
                  <Area type="monotone" dataKey="equity" stroke={isPositive ? '#22c55e' : '#ef4444'}
                    strokeWidth={2} fill="url(#eqGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Performance Panel ──────────────────────────────────────────────────────

function PerformancePanel() {
  const [data, setData] = useState<PerformanceData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPerf = useCallback(async () => {
    try {
      const res = await api.get('/btc-strategy/auto-trade/performance');
      setData(res.data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchPerf();
    const t = window.setInterval(fetchPerf, 15_000);
    return () => window.clearInterval(t);
  }, [fetchPerf]);

  if (loading) return <div className="h-40 animate-pulse bg-gray-800/40 rounded-xl" />;
  if (!data) return <div className="text-center py-12 text-gray-600">No performance data — start the auto trader first</div>;

  const p = data.performance;
  const hasResolved = p.resolvedSignals > 0;

  return (
    <div className="space-y-4">
      {/* Headline stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Total Signals" value={String(p.totalSignals)}
          sub={`${p.pendingSignals} pending`} />
        <Stat label="Resolved" value={String(p.resolvedSignals)}
          color="text-blue-400" sub={`${p.wins}W / ${p.losses}L`} />
        <Stat label="Win Rate" value={hasResolved ? `${(p.winRate * 100).toFixed(1)}%` : '—'}
          color={p.winRate > 0.55 ? 'text-green-400' : p.winRate > 0.45 ? 'text-yellow-400' : 'text-red-400'} />
        <Stat label="Total P&L" value={hasResolved ? `$${p.totalPnl.toFixed(2)}` : '—'}
          color={p.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'} />
        <Stat label="ROI" value={hasResolved ? `${(p.roi * 100).toFixed(1)}%` : '—'}
          color={p.roi >= 0 ? 'text-green-400' : 'text-red-400'} />
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Avg P&L / Trade" value={hasResolved ? `$${p.avgPnlPerTrade.toFixed(2)}` : '—'}
          color={p.avgPnlPerTrade >= 0 ? 'text-green-400' : 'text-red-400'} />
        <Stat label="Avg Edge at Entry" value={`${p.avgEdgeAtEntry.toFixed(1)}%`}
          color="text-yellow-400" />
        <Stat label="Best Trade" value={hasResolved ? `$${p.bestTrade.toFixed(2)}` : '—'}
          color="text-green-400" />
        <Stat label="Worst Trade" value={hasResolved ? `$${p.worstTrade.toFixed(2)}` : '—'}
          color="text-red-400" />
        <Stat label="Streak" value={p.streakCurrent === 0 ? '—' :
          `${p.streakCurrent > 0 ? '+' : ''}${p.streakCurrent}`}
          color={p.streakCurrent > 0 ? 'text-green-400' : p.streakCurrent < 0 ? 'text-red-400' : 'text-gray-400'}
          sub={p.streakCurrent > 0 ? 'win streak' : p.streakCurrent < 0 ? 'loss streak' : ''} />
      </div>

      {/* Brier score & calibration */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-bold text-gray-300 mb-3">Signal Calibration</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="text-center bg-gray-800/50 rounded-lg p-4">
            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Brier Score</div>
            <div className={`text-2xl font-bold font-mono ${
              p.brierScore < 0.2 ? 'text-green-400' :
              p.brierScore < 0.3 ? 'text-yellow-400' : 'text-red-400'
            }`}>
              {hasResolved ? p.brierScore.toFixed(3) : '—'}
            </div>
            <div className="text-[10px] text-gray-600 mt-1">
              {p.brierScore < 0.2 ? 'Well calibrated' :
               p.brierScore < 0.3 ? 'Moderate' : 'Poorly calibrated'}
            </div>
          </div>

          {/* Signal type breakdown */}
          <div className="bg-gray-800/50 rounded-lg p-4">
            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-2">BUY YES signals</div>
            {data.signalBreakdown.buyYes.total > 0 ? (
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Win rate</span>
                  <span className="text-green-400 font-mono font-bold">
                    {((data.signalBreakdown.buyYes.wins / data.signalBreakdown.buyYes.total) * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">P&L</span>
                  <span className={`font-mono font-bold ${data.signalBreakdown.buyYes.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    ${data.signalBreakdown.buyYes.pnl.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Count</span>
                  <span className="text-gray-300 font-mono">{data.signalBreakdown.buyYes.total}</span>
                </div>
              </div>
            ) : (
              <div className="text-xs text-gray-600">No resolved trades yet</div>
            )}
          </div>

          <div className="bg-gray-800/50 rounded-lg p-4">
            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-2">BUY NO signals</div>
            {data.signalBreakdown.buyNo.total > 0 ? (
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Win rate</span>
                  <span className="text-green-400 font-mono font-bold">
                    {((data.signalBreakdown.buyNo.wins / data.signalBreakdown.buyNo.total) * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">P&L</span>
                  <span className={`font-mono font-bold ${data.signalBreakdown.buyNo.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    ${data.signalBreakdown.buyNo.pnl.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Count</span>
                  <span className="text-gray-300 font-mono">{data.signalBreakdown.buyNo.total}</span>
                </div>
              </div>
            ) : (
              <div className="text-xs text-gray-600">No resolved trades yet</div>
            )}
          </div>
        </div>
      </div>

      {/* Edge buckets */}
      {Object.keys(data.edgeBuckets).length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-300 mb-3">Performance by Edge Range</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {['<5%', '5-10%', '10-20%', '20%+'].map(bucket => {
              const b = data.edgeBuckets[bucket];
              if (!b || b.count === 0) return (
                <div key={bucket} className="bg-gray-800/50 rounded-lg p-3 text-center">
                  <div className="text-[10px] text-gray-500 uppercase mb-1">{bucket} edge</div>
                  <div className="text-xs text-gray-700">No trades</div>
                </div>
              );
              const wr = (b.wins / b.count * 100).toFixed(0);
              return (
                <div key={bucket} className="bg-gray-800/50 rounded-lg p-3">
                  <div className="text-[10px] text-gray-500 uppercase mb-2">{bucket} edge</div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Trades</span>
                      <span className="text-gray-300 font-mono">{b.count}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Win rate</span>
                      <span className={`font-mono font-bold ${Number(wr) > 55 ? 'text-green-400' : Number(wr) < 45 ? 'text-red-400' : 'text-yellow-400'}`}>
                        {wr}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">P&L</span>
                      <span className={`font-mono font-bold ${b.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        ${b.totalPnl.toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Equity curve */}
      {data.equityCurve.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-300 mb-3">
            Live Equity Curve ({data.equityCurve.length} resolved trades)
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={data.equityCurve} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
              <defs>
                <linearGradient id="perfGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={p.totalPnl >= 0 ? '#22c55e' : '#ef4444'} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={p.totalPnl >= 0 ? '#22c55e' : '#ef4444'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="time"
                tickFormatter={t => new Date(t).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' })}
                tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `$${v.toFixed(0)}`}
                tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} width={50} />
              <Tooltip
                labelFormatter={t => new Date(t).toLocaleString()}
                formatter={(v: any, name: string) => {
                  if (name === 'equity') return [`$${Number(v).toFixed(2)}`, 'Equity'];
                  return [v, name];
                }}
                contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: '8px', fontSize: '11px' }} />
              <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="4 4" />
              <Area type="monotone" dataKey="equity" stroke={p.totalPnl >= 0 ? '#22c55e' : '#ef4444'}
                strokeWidth={2} fill="url(#perfGrad)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* P&L per Trade */}
      {data.equityCurve.length > 0 && (() => {
        const bd = data.equityCurve.map((t, i) => ({ i: i + 1, pnl: +t.pnl.toFixed(2), label: (t.question ?? '').slice(0, 30) }));
        return (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h3 className="text-sm font-bold text-gray-300 mb-3">P&L per Trade</h3>
            <ResponsiveContainer width="100%" height={170}>
              <AreaChart data={bd} margin={{ top:4, right:4, bottom:4, left:4 }}>
                <defs>
                  <linearGradient id="pnlG" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.25}/>
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937"/>
                <XAxis dataKey="i" tick={{ fontSize:9, fill:'#6b7280' }} axisLine={false} tickLine={false}/>
                <YAxis tickFormatter={v => `$${v}`} tick={{ fontSize:9, fill:'#6b7280' }} axisLine={false} tickLine={false} width={40}/>
                <Tooltip formatter={(v:any) => [`$${Number(v).toFixed(2)}`, 'P&L']} labelFormatter={(i:any) => bd[Number(i)-1]?.label || `Trade ${i}`} contentStyle={{ background:'#111827', border:'1px solid #374151', borderRadius:'8px', fontSize:'11px' }}/>
                <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="4 4"/>
                <Area type="monotone" dataKey="pnl" stroke="#6b7280" strokeWidth={1} fill="url(#pnlG)"
                  dot={(p:any) => <circle key={p.key} cx={p.cx} cy={p.cy} r={4} fill={p.payload.pnl>=0?'#22c55e':'#ef4444'} stroke="none"/>}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        );
      })()}

      {/* Rolling Win Rate */}
      {data.equityCurve.length >= 5 && (() => {
        const W = 10;
        const rd = data.equityCurve.map((_, i) => {
          const sl = data.equityCurve.slice(Math.max(0, i - W + 1), i + 1);
          return { i: i + 1, wr: Math.round(sl.filter(x => x.outcome === 'win').length / sl.length * 100) };
        });
        return (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h3 className="text-sm font-bold text-gray-300 mb-1">Rolling Win Rate <span className="text-[10px] text-gray-600 font-normal">(last 10 trades)</span></h3>
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={rd} margin={{ top:4, right:4, bottom:4, left:4 }}>
                <defs>
                  <linearGradient id="wrG" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937"/>
                <XAxis dataKey="i" tick={{ fontSize:9, fill:'#6b7280' }} axisLine={false} tickLine={false}/>
                <YAxis domain={[0,100]} tickFormatter={v => `${v}%`} tick={{ fontSize:9, fill:'#6b7280' }} axisLine={false} tickLine={false} width={36}/>
                <Tooltip formatter={(v:any) => [`${v}%`, 'Win Rate']} contentStyle={{ background:'#111827', border:'1px solid #374151', borderRadius:'8px', fontSize:'11px' }}/>
                <ReferenceLine y={50} stroke="#4b5563" strokeDasharray="4 4"/>
                <Area type="monotone" dataKey="wr" stroke="#3b82f6" strokeWidth={2} fill="url(#wrG)" dot={false}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        );
      })()}

      {/* By Coin */}
      {data.equityCurve.length > 0 && (() => {
        type CoinStat = { wins:number; total:number; pnl:number; label:string; color:string };
        const cs: Record<string, CoinStat> = {
          bitcoin:  { wins:0, total:0, pnl:0, label:'Bitcoin',  color:'text-orange-400' },
          ethereum: { wins:0, total:0, pnl:0, label:'Ethereum', color:'text-blue-400'   },
          solana:   { wins:0, total:0, pnl:0, label:'Solana',   color:'text-purple-400' },
        };
        for (const t of data.equityCurve) {
          const c = (t as any).coin || 'bitcoin';
          if (cs[c]) { cs[c].total++; cs[c].pnl += t.pnl; if (t.outcome==='win') cs[c].wins++; }
        }
        const active = Object.entries(cs).filter(([,v]) => v.total > 0);
        if (active.length < 2) return null;
        return (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h3 className="text-sm font-bold text-gray-300 mb-3">By Coin</h3>
            <div className="grid grid-cols-3 gap-3">
              {active.map(([coin, s]) => (
                <div key={coin} className="bg-gray-800/50 rounded-lg p-3">
                  <div className={`text-xs font-bold mb-2 ${s.color}`}>{s.label}</div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between"><span className="text-gray-500">Trades</span><span className="font-mono text-gray-300">{s.total}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Win Rate</span><span className={`font-mono font-bold ${s.wins/s.total>0.55?'text-green-400':'text-yellow-400'}`}>{(s.wins/s.total*100).toFixed(0)}%</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">P&L</span><span className={`font-mono font-bold ${s.pnl>=0?'text-green-400':'text-red-400'}`}>${s.pnl.toFixed(2)}</span></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

            {/* Resolved trade log */}
      {data.equityCurve.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-bold text-gray-300 mb-3">Resolved Trades</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-500 text-left border-b border-gray-800">
                  <th className="pb-2 pr-2">Time</th>
                  <th className="pb-2 pr-2">Signal</th>
                  <th className="pb-2 pr-2">Result</th>
                  <th className="pb-2 pr-2 text-right">Edge</th>
                  <th className="pb-2 pr-2 text-right">P&L</th>
                  <th className="pb-2 pr-2 text-right">Equity</th>
                  <th className="pb-2">Market</th>
                </tr>
              </thead>
              <tbody>
                {data.equityCurve.slice().reverse().map((t, i) => (
                  <tr key={i} className="border-t border-gray-800/40 hover:bg-gray-800/30">
                    <td className="py-1.5 pr-2 text-gray-500 font-mono whitespace-nowrap">
                      {new Date(t.time).toLocaleTimeString('en', { hour12: false })}
                    </td>
                    <td className="py-1.5 pr-2">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                        t.signal === 'BUY_YES' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'
                      }`}>
                        {t.signal === 'BUY_YES' ? '▲ YES' : '▼ NO'}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                        t.outcome === 'win' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'
                      }`}>
                        {t.outcome === 'win' ? 'WIN' : 'LOSS'}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono text-yellow-400">
                      {t.edge.toFixed(1)}%
                    </td>
                    <td className={`py-1.5 pr-2 text-right font-mono font-bold ${t.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}
                    </td>
                    <td className={`py-1.5 pr-2 text-right font-mono ${t.equity >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      ${t.equity.toFixed(2)}
                    </td>
                    <td className="py-1.5 text-gray-500 truncate max-w-[200px]">{t.question}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!hasResolved && p.totalSignals > 0 && (
        <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4 text-center">
          <div className="text-yellow-400 text-sm font-bold mb-1">
            {p.pendingSignals} signal{p.pendingSignals !== 1 ? 's' : ''} waiting for resolution
          </div>
          <div className="text-xs text-gray-500">
            Trades resolve automatically when markets expire. Check back after expiry for results.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Auto Trader Panel ──────────────────────────────────────────────────────

function AutoTraderPanel() {
  const [status, setStatus] = useState<AutoTraderStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.get('/btc-strategy/auto-trade/status');
      setStatus(res.data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const toggle = async () => {
    try {
      const action = status?.running ? 'stop' : 'start';
      await api.post('/btc-strategy/auto-trade', { action, config: { dryRun: true } });
      fetchStatus();
    } catch { /* ignore */ }
  };

  if (loading) return <div className="h-40 animate-pulse bg-gray-800/40 rounded-xl" />;

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-bold text-gray-300">Auto Trader</h3>
            <div className="text-[10px] text-gray-500 mt-0.5">
              {status?.running ? 'Running — scanning for opportunities' : 'Stopped'}
            </div>
          </div>
          <button onClick={toggle}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              status?.running
                ? 'bg-red-600/20 text-red-400 border border-red-500/30 hover:bg-red-600/30'
                : 'bg-green-600/20 text-green-400 border border-green-500/30 hover:bg-green-600/30'
            }`}>
            {status?.running ? 'Stop' : 'Start (Dry Run)'}
          </button>
        </div>

        {status?.config && (
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-center text-[10px]">
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-gray-500">Mode</div>
              <div className={`font-bold ${status.config.dryRun ? 'text-yellow-400' : 'text-green-400'}`}>
                {status.config.dryRun ? 'DRY RUN' : 'LIVE'}
              </div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-gray-500">Bankroll</div>
              <div className="text-white font-mono">${status.config.bankroll}</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-gray-500">Max/Trade</div>
              <div className="text-white font-mono">${status.config.maxPositionUsd}</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-gray-500">Min Edge</div>
              <div className="text-white font-mono">{status.config.minEdgePct}%</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-gray-500">Max Positions</div>
              <div className="text-white font-mono">{status.config.maxOpenPositions}</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-gray-500">Loss Limit</div>
              <div className="text-white font-mono">{status.config.maxDailyLossPct}%</div>
            </div>
          </div>
        )}
      </div>

      {/* Daily stats */}
      {status?.stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Stat label="Trades Today" value={String(status.stats.tradesPlaced)} />
          <Stat label="USD Deployed" value={`$${status.stats.totalUsdDeployed.toFixed(0)}`} />
          <Stat label="Open Positions" value={String(status.stats.openPositions)} />
          <Stat label="Resolved" value={String(status.stats.resolvedTrades)}
            sub={`${status.stats.wins}W / ${status.stats.losses}L`} />
          <Stat label="Realized P&L" value={`$${status.stats.realizedPnl.toFixed(2)}`}
            color={status.stats.realizedPnl >= 0 ? 'text-green-400' : 'text-red-400'} />
          <Stat label="Est. P&L" value={`$${status.stats.estimatedPnl.toFixed(2)}`}
            color={status.stats.estimatedPnl >= 0 ? 'text-green-400' : 'text-red-400'} />
        </div>
      )}

      {/* Terminal-style trade log */}
      {status?.recentTrades && status.recentTrades.length > 0 && (
        <div className="bg-black border border-gray-800 rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2 bg-gray-900 border-b border-gray-800">
            <div className="flex gap-1.5">
              <div className="w-3 h-3 rounded-full bg-red-500/60" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
              <div className="w-3 h-3 rounded-full bg-green-500/60" />
            </div>
            <span className="text-[10px] text-gray-500 font-mono ml-2">btc-auto-trader — trade log</span>
            <span className="text-[10px] text-gray-700 font-mono ml-auto">
              {status.recentTrades.length} entries
            </span>
          </div>
          <div className="p-3 font-mono text-[11px] leading-relaxed max-h-[400px] overflow-y-auto space-y-0.5">
            {status.recentTrades.slice(-30).reverse().map((t, i) => {
              const time = new Date(t.timestamp).toLocaleTimeString('en', { hour12: false });
              const statusColor =
                t.status === 'placed' ? 'text-green-400' :
                t.status === 'dry_run' ? 'text-yellow-400' : 'text-red-400';
              const statusTag =
                t.status === 'placed' ? 'LIVE' :
                t.status === 'dry_run' ? 'SIM ' : 'FAIL';

              const entryPrice = t.price;
              const potentialPnl = t.size * (1 / entryPrice - 1);

              return (
                <div key={i} className="flex flex-wrap gap-x-1">
                  <span className="text-gray-600">[{time}]</span>
                  <span className={statusColor}>[{statusTag}]</span>
                  <span className={t.signal === 'BUY_YES' ? 'text-green-400' : 'text-red-400'}>
                    {t.signal === 'BUY_YES' ? 'BUY YES' : 'BUY NO '}
                  </span>
                  <span className="text-gray-500">@</span>
                  <span className="text-white">{(entryPrice * 100).toFixed(1)}c</span>
                  <span className="text-gray-600">|</span>
                  <span className="text-gray-500">size:</span>
                  <span className="text-white">${t.size.toFixed(2)}</span>
                  <span className="text-gray-600">|</span>
                  <span className="text-gray-500">edge:</span>
                  <span className="text-yellow-400">{pct(t.edgePct)}</span>
                  <span className="text-gray-600">|</span>
                  {t.resolved ? (
                    <>
                      <span className={t.outcome === 'win' ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>
                        {t.outcome === 'win' ? 'WIN' : 'LOSS'}
                      </span>
                      <span className="text-gray-600">|</span>
                      <span className={`font-bold ${(t.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {(t.pnl ?? 0) >= 0 ? '+' : ''}${(t.pnl ?? 0).toFixed(2)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-gray-500">if win:</span>
                      <span className="text-green-400">+${potentialPnl.toFixed(2)}</span>
                      <span className="text-gray-600">|</span>
                      <span className="text-gray-500">if lose:</span>
                      <span className="text-red-400">-${t.size.toFixed(2)}</span>
                    </>
                  )}
                  <span className="text-gray-700 block w-full truncate pl-[72px]">
                    {t.question}
                  </span>
                </div>
              );
            })}
            {status.recentTrades.length === 0 && (
              <div className="text-gray-600">Waiting for signals...</div>
            )}
            <div className="text-gray-700 mt-2">
              {'>'} _<span className="animate-pulse">|</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function BtcStrategyPage() {
  const [tab, setTab] = useState<Tab>('indicators');
  const [indicators, setIndicators] = useState<IndicatorSnapshot | null>(null);
  const [scanMarkets, setScanMarkets] = useState<ScanMarket[]>([]);
  const [liveMarkets, setLiveMarkets] = useState<LiveBtcMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [interval, setInterval_] = useState('5m');
  const [lastUpdate, setLastUpdate] = useState('');

  const fetchData = useCallback(async () => {
    setError('');
    try {
      const [indRes, scanRes, mktsRes] = await Promise.all([
        api.get('/btc-strategy/indicators', { params: { interval } }),
        api.get('/btc-strategy/scan', { params: { interval } }),
        api.get('/btc-strategy/markets'),
      ]);
      setIndicators(indRes.data.indicators);
      setScanMarkets(scanRes.data.markets || []);
      setLiveMarkets(mktsRes.data.markets || []);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch {
      setError('Failed to load data. Is the backend running?');
    }
    setLoading(false);
  }, [interval]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const timer = window.setInterval(() => fetchData(), 30_000);
    return () => window.clearInterval(timer);
  }, [fetchData]);

  const shortCount = liveMarkets.filter(m => m.timeCategory === 'short').length;

  const tabs: { key: Tab; label: string; badge?: string }[] = [
    { key: 'live5m', label: 'BTC 5 Min', badge: shortCount > 0 ? String(shortCount) : undefined },
    { key: 'indicators', label: 'Indicators' },
    { key: 'scan', label: 'Market Scan' },
    { key: 'backtest', label: 'Backtest' },
    { key: 'autotrader', label: 'Auto Trader' },
    { key: 'performance', label: 'Performance' },
  ];

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl">₿</span>
            <h1 className="text-2xl font-bold text-white">BTC Strategy Engine</h1>
          </div>
          <p className="text-gray-400 text-sm">
            Indicator-enhanced probability model for Polymarket BTC price markets
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select value={interval} onChange={e => setInterval_(e.target.value)}
            className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-xs text-gray-300">
            <option value="5m">5m candles</option>
            <option value="15m">15m candles</option>
            <option value="1h">1h candles</option>
          </select>
          <button onClick={() => { setLoading(true); fetchData(); }}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs text-gray-300 transition-colors">
            Refresh
          </button>
          {lastUpdate && <span className="text-[10px] text-gray-600">Updated: {lastUpdate}</span>}
        </div>
      </div>

      {/* Quick stats */}
      {indicators && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="BTC Price" value={fmtBtc(indicators.spot)} color="text-orange-400" />
          <Stat label="Volatility" value={`${(indicators.volatility.realized * 100).toFixed(0)}%`}
            color={regimeColor(indicators.volatility.regime)} sub={`Regime: ${indicators.volatility.regime}`} />
          <Stat label="RSI (14)" value={indicators.rsi14.value.toFixed(1)}
            color={indicators.rsi14.overbought ? 'text-green-400' : indicators.rsi14.oversold ? 'text-red-400' : 'text-gray-300'} />
          <Stat label="Live BTC Markets" value={String(liveMarkets.length)}
            color="text-blue-400" sub={`${liveMarkets.filter(m => m.timeCategory === 'short').length} short-term`} />
          <Stat label="Markets w/ Edge" value={String(scanMarkets.filter(m => m.signal !== 'FAIR').length)}
            color="text-yellow-400" sub={`of ${scanMarkets.length} modeled`} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 rounded-lg p-1 border border-gray-800 w-fit">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${
              tab === t.key ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
            }`}>
            {t.label}
            {t.badge && (
              <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-orange-500/20 text-orange-400 border border-orange-500/30">
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4 text-sm text-red-400">{error}</div>
      )}

      {/* Tab content */}
      {loading && !indicators ? (
        <div className="h-64 bg-gray-800/40 rounded-xl animate-pulse" />
      ) : (
        <>
          {tab === 'live5m' && <Btc5MinPanel spot={indicators?.spot ?? 0} indicators={indicators} />}
          {tab === 'indicators' && indicators && <IndicatorsPanel ind={indicators} liveMarkets={liveMarkets} />}
          {tab === 'scan' && <ScanPanel markets={scanMarkets} spot={indicators?.spot ?? 0} />}
          {tab === 'backtest' && <BacktestPanel />}
          {tab === 'autotrader' && <AutoTraderPanel />}
          {tab === 'performance' && <PerformancePanel />}
        </>
      )}
    </div>
  );
}

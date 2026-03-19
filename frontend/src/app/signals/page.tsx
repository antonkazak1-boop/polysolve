'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import DemoTradeModal from '@/components/DemoTradeModal';

// ─── Types ────────────────────────────────────────────────────────────────────

type Horizon = 'fast' | 'medium' | 'long';
type Side = 'YES' | 'NO';
type ConfidenceLevel = 'strong' | 'good' | 'speculative';

interface Signal {
  id: string;
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  marketId: string;
  marketQuestion: string;
  side: Side;
  horizon: Horizon;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  entryPrice: number;
  potentialRoi: number;
  roiMultiple: number;
  volume24h: number;
  liquidity: number;
  daysUntilClose: number | null;
  oneDayChange: number;
  oneWeekChange: number;
  prices: number[];
  outcomes: string[];
  tags: string[];
  category: string;
  reasons: string[];
  anomalyTypes: string[];
  news?: { summary: string; sentiment: string; relevance: number };
  correlationWarning?: string;
  marketEfficiency?: number;
  suggestedStakePct?: number;
  generatedAt: string;
}

interface Counts {
  fast: number;
  medium: number;
  long: number;
  total: number;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(v: number): string {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function fmtTimeLeft(days: number | null): string {
  if (days === null) return 'Open-ended';
  if (days < 0) return 'Expired';
  if (days === 0) return 'Today';
  const hours = Math.round(days * 24);
  if (hours <= 24) return `${hours}h left`;
  if (days <= 7) return `${days}d left`;
  return `${days}d left`;
}

function polymarketUrl(slug?: string, id?: string) {
  if (slug) return `https://polymarket.com/event/${slug}`;
  if (id) return `https://polymarket.com/event/${id}`;
  return 'https://polymarket.com';
}

// ─── Horizon tabs config ─────────────────────────────────────────────────────

const HORIZONS: { key: Horizon | 'all'; label: string; sublabel: string; color: string }[] = [
  { key: 'all',    label: 'All Signals', sublabel: '',            color: 'text-white'  },
  { key: 'fast',   label: 'Fast',        sublabel: '< 24h',      color: 'text-red-400' },
  { key: 'medium', label: 'Medium',      sublabel: '1–7 days',   color: 'text-yellow-400' },
  { key: 'long',   label: 'Long',        sublabel: '7–60 days',  color: 'text-blue-400' },
];

// ─── Confidence bar ──────────────────────────────────────────────────────────

function ConfidenceBar({ value, level }: { value: number; level: ConfidenceLevel }) {
  const color = level === 'strong' ? 'bg-green-500' : level === 'good' ? 'bg-yellow-500' : 'bg-gray-500';
  const textColor = level === 'strong' ? 'text-green-400' : level === 'good' ? 'text-yellow-400' : 'text-gray-400';

  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs font-medium ${textColor}`}>{value}%</span>
      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden max-w-[80px]">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className={`text-[10px] uppercase font-medium ${textColor}`}>{level}</span>
    </div>
  );
}

// ─── Side badge ──────────────────────────────────────────────────────────────

function SideBadge({ side }: { side: Side }) {
  const isYes = side === 'YES';
  return (
    <div className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg font-bold text-sm ${
      isYes
        ? 'bg-green-500/15 text-green-400 border border-green-500/30'
        : 'bg-red-500/15 text-red-400 border border-red-500/30'
    }`}>
      <span className="text-base">{isYes ? '▲' : '▼'}</span>
      BET {side}
    </div>
  );
}

// ─── Horizon badge ───────────────────────────────────────────────────────────

function HorizonBadge({ horizon, daysLeft }: { horizon: Horizon; daysLeft: number | null }) {
  const cfg = {
    fast:   { icon: '⚡', color: 'bg-red-500/10 text-red-400 border-red-500/20' },
    medium: { icon: '⏳', color: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
    long:   { icon: '📅', color: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
  }[horizon];

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-medium ${cfg.color}`}>
      {cfg.icon} {horizon.toUpperCase()} · {fmtTimeLeft(daysLeft)}
    </span>
  );
}

// ─── Signal card ─────────────────────────────────────────────────────────────

function SignalCard({ signal, onTrade }: { signal: Signal; onTrade: (s: Signal) => void }) {
  const { side, entryPrice, roiMultiple, confidence, confidenceLevel: cl, reasons, anomalyTypes } = signal;
  const pmUrl = polymarketUrl(signal.eventSlug, signal.eventId);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-all">
      {/* Top row: horizon + confidence */}
      <div className="flex items-center justify-between mb-3">
        <HorizonBadge horizon={signal.horizon} daysLeft={signal.daysUntilClose} />
        <ConfidenceBar value={confidence} level={cl} />
      </div>

      {/* Title */}
      <div className="mb-3">
        <div className="text-xs text-gray-500 truncate mb-0.5">{signal.eventTitle}</div>
        <div className="text-sm font-medium text-gray-100 line-clamp-2 leading-snug">
          {signal.marketQuestion !== signal.eventTitle ? signal.marketQuestion : signal.eventTitle}
        </div>
      </div>

      {/* Action row: side badge + price/ROI */}
      <div className="flex items-center gap-4 mb-4">
        <SideBadge side={side} />
        <div className="flex-1 grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-[10px] text-gray-500">Entry</div>
            <div className="text-base font-bold text-white font-mono">{(entryPrice * 100).toFixed(0)}¢</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">If wins</div>
            <div className="text-base font-bold text-yellow-400 font-mono">{roiMultiple.toFixed(1)}x</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">ROI</div>
            <div className="text-base font-bold text-green-400 font-mono">+{signal.potentialRoi.toFixed(0)}%</div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-2 text-center text-xs text-gray-500 mb-4 bg-gray-800/40 rounded-lg py-2">
        <div>
          <div className="text-[10px]">Vol 24h</div>
          <div className="text-gray-300">{fmt(signal.volume24h)}</div>
        </div>
        <div>
          <div className="text-[10px]">Liq</div>
          <div className="text-gray-300">{fmt(signal.liquidity)}</div>
        </div>
        <div>
          <div className="text-[10px]">24h</div>
          <div className={signal.oneDayChange > 0 ? 'text-green-400' : signal.oneDayChange < 0 ? 'text-red-400' : 'text-gray-500'}>
            {fmtPct(signal.oneDayChange)}
          </div>
        </div>
        <div>
          <div className="text-[10px]">7d</div>
          <div className={signal.oneWeekChange > 0 ? 'text-green-400' : signal.oneWeekChange < 0 ? 'text-red-400' : 'text-gray-500'}>
            {fmtPct(signal.oneWeekChange)}
          </div>
        </div>
      </div>

      {/* Reasons (why) */}
      <div className="space-y-1 mb-4">
        <div className="text-[10px] text-gray-500 uppercase font-medium tracking-wide">Why this signal</div>
        {reasons.slice(0, 4).map((r, i) => (
          <div key={i} className="flex items-start gap-1.5 text-xs">
            <span className="text-gray-600 mt-0.5">&#x2022;</span>
            <span className="text-gray-400">{r}</span>
          </div>
        ))}
      </div>

      {/* Anomaly + category badges */}
      <div className="flex items-center gap-1.5 flex-wrap mb-3">
        {anomalyTypes.slice(0, 3).map(t => (
          <span key={t} className="text-[10px] bg-red-500/10 text-red-400 border border-red-500/15 px-1.5 py-0.5 rounded">{t}</span>
        ))}
        {signal.category !== 'General' && (
          <span className="text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/15 px-1.5 py-0.5 rounded">{signal.category}</span>
        )}
        {signal.tags.slice(0, 2).map(t => (
          <span key={t} className="text-[10px] bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded">{t}</span>
        ))}
      </div>

      {/* News if available */}
      {signal.news && signal.news.relevance > 30 && (
        <div className="bg-blue-500/5 border border-blue-500/10 rounded-lg px-3 py-2 mb-3">
          <div className="text-[10px] text-blue-400 font-medium mb-1">
            News: {signal.news.sentiment} ({signal.news.relevance}% relevant)
          </div>
          <div className="text-xs text-gray-400 line-clamp-2">{signal.news.summary}</div>
        </div>
      )}

      {/* Correlation warning */}
      {signal.correlationWarning && (
        <div className="bg-yellow-500/5 border border-yellow-500/15 rounded-lg px-3 py-1.5 mb-3 flex items-center gap-1.5">
          <span className="text-yellow-400 text-xs">⚠</span>
          <span className="text-[10px] text-yellow-400/80">{signal.correlationWarning}</span>
        </div>
      )}

      {/* Efficiency + Kelly */}
      <div className="flex items-center justify-between text-[10px] text-gray-500 mb-3">
        {signal.marketEfficiency != null && (
          <span className={`px-1.5 py-0.5 rounded ${
            signal.marketEfficiency < 30 ? 'bg-green-500/10 text-green-500' :
            signal.marketEfficiency < 60 ? 'bg-gray-800 text-gray-400' :
            'bg-gray-800 text-gray-600'
          }`}>
            Efficiency: {signal.marketEfficiency < 30 ? 'Low' : signal.marketEfficiency < 60 ? 'Mid' : 'High'} ({signal.marketEfficiency})
          </span>
        )}
        <span className="text-blue-400" title="Рек. % банкролла по Кelly (макс. 5%)">
          Kelly: {signal.suggestedStakePct != null ? `${signal.suggestedStakePct.toFixed(1)}%` : '—'} stake
        </span>
      </div>

      {/* Action row */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onTrade(signal)}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
            side === 'YES'
              ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25 border border-green-500/20'
              : 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20'
          }`}
        >
          Demo Trade {side}
        </button>
        <Link
          href={`/events/${signal.eventId}`}
          className="px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 transition-colors"
        >
          Details
        </Link>
        <a
          href={pmUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-2 rounded-lg text-sm text-green-400 hover:text-green-300 bg-gray-800 hover:bg-gray-700 transition-colors"
        >
          PM &#x2197;
        </a>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SignalsPage() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [counts, setCounts] = useState<Counts>({ fast: 0, medium: 0, long: 0, total: 0 });
  const [horizon, setHorizon] = useState<Horizon | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [tradeSignal, setTradeSignal] = useState<Signal | null>(null);
  const [tradeSuccess, setTradeSuccess] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchSignals = useCallback(async (skipNews = false) => {
    setError('');
    try {
      const res = await api.get('/signals', { params: { horizon, limit: 50, skipNews: skipNews ? 'true' : undefined } });
      const list = Array.isArray(res.data?.signals) ? res.data.signals : [];
      setSignals(list);
      setCounts(res.data?.counts || { fast: 0, medium: 0, long: 0, total: list.length });
      setLastUpdated(new Date());
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Не удалось загрузить сигналы. Проверьте, что бэкенд запущен.');
    }
  }, [horizon]);

  useEffect(() => {
    setLoading(true);
    fetchSignals().finally(() => setLoading(false));
  }, [fetchSignals]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await api.post('/signals/refresh');
      await fetchSignals();
    } catch {
      setError('Failed to refresh.');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
            </span>
            <h1 className="text-2xl font-bold text-white">Trading Signals</h1>
          </div>
          <p className="text-gray-400 text-sm">
            Automated analysis of all Polymarket data — anomalies, momentum, volume, news — into actionable bets.
          </p>
        </div>
        <div className="text-right space-y-1.5">
          <div className="flex gap-2">
            <Link
              href="/signals/history"
              className="px-4 py-2 rounded-lg text-sm bg-gray-800 text-gray-400 hover:bg-gray-700 transition-colors"
            >
              📊 Accuracy
            </Link>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="px-4 py-2 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50 transition-colors"
            >
              {refreshing ? 'Refreshing...' : '↻ Refresh'}
            </button>
          </div>
          {lastUpdated && (
            <div className="text-[10px] text-gray-600 text-right">
              Updated {lastUpdated.toLocaleTimeString()}
            </div>
          )}
        </div>
      </div>

      {/* Strategy legend */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 text-sm">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <div className="text-red-400 font-medium text-xs mb-1">&#x26A1; Fast (&lt; 24h)</div>
            <div className="text-gray-500 text-xs">Market resolves soon. High urgency, closing spikes. Act fast.</div>
          </div>
          <div>
            <div className="text-yellow-400 font-medium text-xs mb-1">&#x23F3; Medium (1-7 days)</div>
            <div className="text-gray-500 text-xs">Scalp and insider signals. Buy cheap, sell on momentum.</div>
          </div>
          <div>
            <div className="text-blue-400 font-medium text-xs mb-1">&#x1F4C5; Long (7-60 days)</div>
            <div className="text-gray-500 text-xs">Asymmetric holds. Low win rate, massive payoff when right.</div>
          </div>
        </div>
      </div>

      {/* Trade success toast */}
      {tradeSuccess && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 text-sm px-4 py-3 rounded-xl flex items-center justify-between">
          <span>{tradeSuccess}</span>
          <button onClick={() => setTradeSuccess(null)} className="ml-4 text-green-600 hover:text-green-400">x</button>
        </div>
      )}

      {/* Horizon tabs */}
      <div className="flex gap-1 border-b border-gray-800">
        {HORIZONS.map(h => (
          <button
            key={h.key}
            onClick={() => setHorizon(h.key)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors flex items-center gap-2 ${
              horizon === h.key
                ? `bg-gray-800 ${h.color} border border-gray-700 border-b-0`
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <span>{h.label}</span>
            {h.sublabel && <span className="text-[10px] text-gray-500">{h.sublabel}</span>}
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
              horizon === h.key ? 'bg-gray-700 text-gray-300' : 'bg-gray-900 text-gray-600'
            }`}>
              {h.key === 'all' ? counts.total : counts[h.key as Horizon]}
            </span>
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4 text-sm text-red-400">{error}</div>
      )}

      {/* Signals grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-5 animate-pulse h-72" />
          ))}
        </div>
      ) : signals.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {signals.map(s => (
            <SignalCard key={s.id} signal={s} onTrade={setTradeSignal} />
          ))}
        </div>
      ) : (
        <div className="text-center py-16 text-gray-500">
          <div className="text-4xl mb-3">&#x1F4E1;</div>
          <div className="font-medium text-gray-400">Сейчас нет сигналов по выбранному горизонту</div>
          <div className="text-xs mt-2 text-gray-600 max-w-md mx-auto">
            Нажмите Refresh — бэкенд подтянет события и пересчитает. Или загрузите без проверки новостей (быстрее).
          </div>
          <div className="flex justify-center gap-2 mt-4">
            <button
              onClick={() => fetchSignals(true)}
              className="px-4 py-2 rounded-lg text-sm bg-gray-700 text-gray-300 hover:bg-gray-600"
            >
              Без проверки новостей
            </button>
            <button
              onClick={() => fetchSignals(false)}
              className="px-4 py-2 rounded-lg text-sm bg-gray-800 text-gray-400 hover:bg-gray-700"
            >
              Обновить
            </button>
          </div>
        </div>
      )}

      {/* Demo Trade Modal */}
      {tradeSignal && (
        <DemoTradeModal
          eventId={tradeSignal.eventId}
          eventTitle={tradeSignal.eventTitle}
          marketId={tradeSignal.marketId}
          marketQuestion={tradeSignal.marketQuestion}
          prices={tradeSignal.prices}
          outcomes={tradeSignal.outcomes}
          tags={tradeSignal.tags}
          onClose={() => setTradeSignal(null)}
          onSuccess={(trade, newBal) => {
            setTradeSignal(null);
            setTradeSuccess(`Opened ${trade.outcome} on "${tradeSignal.marketQuestion}" — $${trade.amount.toFixed(0)}. Balance: $${newBal.toFixed(0)}`);
          }}
        />
      )}
    </div>
  );
}

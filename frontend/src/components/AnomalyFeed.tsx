'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';

export type AnomalyType =
  | 'PRICE_SPIKE'
  | 'VOLUME_SURGE'
  | 'INSIDER_SIGNAL'
  | 'SMART_MONEY'
  | 'CLOSING_SPIKE'
  | 'REVERSAL';

export interface Anomaly {
  id: string;
  type: AnomalyType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  score: number;
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  marketId: string;
  marketQuestion: string;
  prices: number[];
  outcomes: string[];
  oneDayChange: number;
  oneWeekChange: number;
  volume24h: number;
  liquidity: number;
  tags: string[];
  daysUntilClose?: number;
  potentialRoi?: number;
  reasoning: string;
  detectedAt: string;
}

// ─── meta for each anomaly type ──────────────────────────────────────────────

const TYPE_META: Record<AnomalyType, { icon: string; label: string; color: string; bg: string }> = {
  PRICE_SPIKE:    { icon: '📈', label: 'Price Spike',    color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20' },
  VOLUME_SURGE:   { icon: '🌊', label: 'Volume Surge',   color: 'text-blue-400',   bg: 'bg-blue-500/10 border-blue-500/20' },
  INSIDER_SIGNAL: { icon: '🕵️', label: 'Insider Signal', color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/20' },
  SMART_MONEY:    { icon: '🐋', label: 'Smart Money',    color: 'text-cyan-400',   bg: 'bg-cyan-500/10 border-cyan-500/20' },
  CLOSING_SPIKE:  { icon: '⏰', label: 'Closing Spike',  color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/20' },
  REVERSAL:       { icon: '🔄', label: 'Reversal',       color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20' },
};

const SEVERITY_COLOR: Record<string, string> = {
  LOW:      'text-gray-400 bg-gray-700',
  MEDIUM:   'text-yellow-400 bg-yellow-500/10',
  HIGH:     'text-orange-400 bg-orange-500/10',
  CRITICAL: 'text-red-400 bg-red-500/20',
};

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number, showPlus = true): string {
  const sign = showPlus && n > 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(1)}%`;
}

// ─── single card ─────────────────────────────────────────────────────────────

function AnomalyCard({ anomaly }: { anomaly: Anomaly }) {
  const meta = TYPE_META[anomaly.type];
  const isBinary = anomaly.prices.length === 2;
  const pmUrl = `https://polymarket.com/event/${anomaly.eventSlug || anomaly.eventId}`;

  return (
    <div className={`border rounded-xl p-4 transition-all ${meta.bg}`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-lg leading-none">{meta.icon}</span>
          <div>
            <span className={`text-xs font-semibold ${meta.color}`}>{meta.label}</span>
            <span className={`ml-2 text-xs px-1.5 py-0.5 rounded font-medium ${SEVERITY_COLOR[anomaly.severity]}`}>
              {anomaly.severity}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-right">
            <div className="text-sm font-bold text-white">{anomaly.score}</div>
            <div className="text-xs text-gray-500">score</div>
          </div>
          {/* Polymarket link */}
          <a
            href={pmUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-gray-500 hover:text-blue-400 transition-colors p-1"
            title="Open on Polymarket"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      </div>

        {/* Event + Market title */}
        <div className="mb-2">
          <div className="text-xs text-gray-500 truncate">{anomaly.eventTitle}</div>
          <div className="text-sm font-medium text-gray-100 line-clamp-2 leading-snug mt-0.5">
            {anomaly.marketQuestion !== anomaly.eventTitle ? anomaly.marketQuestion : anomaly.eventTitle}
          </div>
        </div>

        {/* Prices */}
        {isBinary && (
          <div className="flex gap-1.5 mb-3">
            {anomaly.outcomes.map((outcome, i) => (
              <div key={i} className="flex-1 bg-gray-900/60 rounded px-2 py-1.5 text-center">
                <div className="text-xs text-gray-500">{outcome}</div>
                <div className={`text-base font-bold font-mono ${i === 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {anomaly.prices[i] !== undefined ? `${(anomaly.prices[i] * 100).toFixed(0)}¢` : '-'}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Reasoning */}
        <div className="text-xs text-gray-400 leading-relaxed mb-3 line-clamp-2">
          {anomaly.reasoning}
        </div>

        {/* Stats strip */}
        <div className="flex items-center justify-between text-xs text-gray-500 flex-wrap gap-y-1 mb-3">
          <div className="flex items-center gap-3">
            <span>
              24h:{' '}
              <span className={anomaly.oneDayChange > 0 ? 'text-green-400' : anomaly.oneDayChange < 0 ? 'text-red-400' : 'text-gray-400'}>
                {fmtPct(anomaly.oneDayChange)}
              </span>
            </span>
            <span>Vol: <span className="text-gray-300">{fmt(anomaly.volume24h)}</span></span>
            <span>Liq: <span className="text-gray-300">{fmt(anomaly.liquidity)}</span></span>
          </div>
          <div className="flex items-center gap-2">
            {anomaly.potentialRoi && anomaly.potentialRoi > 100 && (
              <span className="text-yellow-400">
                ⚡ {anomaly.potentialRoi >= 10000
                  ? `${(anomaly.potentialRoi / 100).toFixed(0)}x`
                  : `+${anomaly.potentialRoi.toFixed(0)}%`}
              </span>
            )}
            {anomaly.daysUntilClose !== undefined && anomaly.daysUntilClose >= 0 && (
              <span className={anomaly.daysUntilClose <= 2 ? 'text-red-400' : 'text-gray-500'}>
                {anomaly.daysUntilClose === 0 ? 'today' : `${anomaly.daysUntilClose}d`}
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          <Link
            href={`/events/${anomaly.eventId}`}
            className="flex-1 text-center bg-gray-800/80 hover:bg-gray-700 text-gray-300 text-xs py-1.5 rounded-lg transition-colors"
          >
            View Details
          </Link>
          <a
            href={pmUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 bg-blue-600/20 hover:bg-blue-600/40 border border-blue-500/30 text-blue-400 text-xs px-3 py-1.5 rounded-lg transition-colors"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            Polymarket
          </a>
        </div>
    </div>
  );
}

// ─── exported feed component ─────────────────────────────────────────────────

const ALL_TYPES: AnomalyType[] = [
  'PRICE_SPIKE', 'VOLUME_SURGE', 'INSIDER_SIGNAL', 'SMART_MONEY', 'CLOSING_SPIKE', 'REVERSAL',
];

interface AnomalyFeedProps {
  compact?: boolean;
  maxItems?: number;
  autoRefresh?: boolean;        // poll every 2 min
  defaultType?: AnomalyType | 'ALL';
  showFilters?: boolean;
}

export default function AnomalyFeed({
  compact = false,
  maxItems,
  autoRefresh = false,
  defaultType = 'ALL',
  showFilters = true,
}: AnomalyFeedProps) {
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [typeFilter, setTypeFilter] = useState<AnomalyType | 'ALL'>(defaultType);
  const [minScore, setMinScore] = useState(20);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [scannedAt, setScannedAt] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const fetch = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError('');

    try {
      const params: Record<string, any> = { minScore, limit: 200 };
      if (typeFilter !== 'ALL') params.type = typeFilter;

      const res = await api.get('/anomalies', { params });
      setAnomalies(res.data.anomalies || []);
      setSummary(res.data.summary || {});
      setScannedAt(res.data.scannedAt || '');
    } catch {
      setError('Failed to load anomalies. Make sure the backend is running.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [typeFilter, minScore]);

  useEffect(() => { fetch(); }, [fetch]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => fetch(true), 5 * 60 * 1000); // 5 min (was 2) — less VPN/load
    return () => clearInterval(id);
  }, [autoRefresh, fetch]);

  const displayed = maxItems ? anomalies.slice(0, maxItems) : anomalies;

  return (
    <div className="space-y-4">
      {showFilters && !compact && (
        <>
          {/* Type filter tabs */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setTypeFilter('ALL')}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${typeFilter === 'ALL' ? 'bg-gray-600 text-white font-medium' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
            >
              All
              {summary && Object.values(summary).reduce((a, b) => a + b, 0) > 0 && (
                <span className="ml-1.5 text-xs text-gray-400">
                  {Object.values(summary).reduce((a, b) => a + b, 0)}
                </span>
              )}
            </button>
            {ALL_TYPES.map(t => {
              const m = TYPE_META[t];
              return (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  className={`px-3 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-1 ${typeFilter === t ? `${m.bg} ${m.color} font-medium border` : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >
                  {m.icon} {m.label}
                  {summary[t] > 0 && (
                    <span className={`text-xs ml-0.5 ${typeFilter === t ? m.color : 'text-gray-500'}`}>
                      {summary[t]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Score filter + refresh */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Min score:</span>
              {[20, 40, 60, 80].map(s => (
                <button
                  key={s}
                  onClick={() => setMinScore(s)}
                  className={`px-2.5 py-1 rounded text-xs transition-colors ${minScore === s ? 'bg-gray-600 text-white' : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}
                >
                  {s}+
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              {scannedAt && (
                <span className="text-xs text-gray-600">
                  Updated {new Date(scannedAt).toLocaleTimeString()}
                </span>
              )}
              <button
                onClick={() => fetch(true)}
                disabled={refreshing}
                className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40"
              >
                {refreshing ? '↻ Refreshing…' : '↻ Refresh'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {Array.from({ length: compact ? 3 : 6 }).map((_, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 animate-pulse h-44" />
          ))}
        </div>
      ) : displayed.length > 0 ? (
        <div className={compact ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'}>
          {displayed.map(a => <AnomalyCard key={a.id} anomaly={a} />)}
        </div>
      ) : (
        <div className="text-center py-12 text-gray-600">
          <div className="text-3xl mb-2">🔇</div>
          <div className="text-sm">No anomalies detected with current filters</div>
        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';

interface FeedEvent {
  id: string;
  ts: number;
  address: string;
  shortAddr: string;
  userName?: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  usdValue: number;
  title: string;
  marketId?: string;
  eventSlug?: string;
  category?: string;
  isWhale: boolean;
  isWatched: boolean;
  rank?: string;
  hoursToResolution?: number;
}

type Filter = 'all' | 'whale' | 'watched';

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'Sports', label: '⚽ Спорт' },
  { value: 'Politics', label: '🏛 Политика' },
  { value: 'Crypto', label: '₿ Крипто' },
  { value: 'Economy', label: '📊 Экономика' },
  { value: 'Iran/Middle East', label: '🌍 Ближний Восток' },
  { value: 'General', label: '📋 Общее' },
];

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}м`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}ч`;
  return `${Math.floor(h / 24)}д`;
}

function fmtUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtPrice(p: number): string {
  return `${(p * 100).toFixed(1)}¢`;
}

const OUTCOME_COLOR: Record<string, string> = {
  YES: 'text-green-400',
  NO: 'text-red-400',
};

export default function SmartMoneyFeed({ className = '' }: { className?: string }) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [category, setCategory] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  const [newCount, setNewCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevIdsRef = useRef<Set<string>>(new Set());

  const fetchFeed = useCallback(async (isAuto = false) => {
    try {
      const params: Record<string, string | number> = { limit: 80, filter };
      if (category && category !== 'all') params.category = category;
      const res = await api.get('/wallets/activity-feed', { params });
      const incoming: FeedEvent[] = res.data.events || [];
      const meta = res.data.meta || {};

      const fresh = incoming.filter(e => !prevIdsRef.current.has(e.id));
      if (isAuto && fresh.length > 0) setNewCount(n => n + fresh.length);
      for (const e of incoming) prevIdsRef.current.add(e.id);

      setEvents(incoming);
      if (meta.lastRefreshed) setLastRefreshed(meta.lastRefreshed);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [filter, category]);

  // Initial load + auto-refresh every 30s
  useEffect(() => {
    setLoading(true);
    setNewCount(0);
    fetchFeed(false);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => fetchFeed(true), 30_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchFeed]);

  const handleManualRefresh = () => {
    setNewCount(0);
    setLoading(true);
    fetchFeed(false);
  };

  return (
    <div className={`flex flex-col bg-gray-900 border border-gray-800 rounded-xl overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900/80 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="font-semibold text-sm text-white">Smart Money Feed</span>
          {newCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
              +{newCount} new
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {lastRefreshed && (
            <span className="text-[10px] text-gray-600">
              {timeAgo(lastRefreshed)} назад
            </span>
          )}
          <button
            onClick={handleManualRefresh}
            className="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Filter tabs: source */}
      <div className="flex border-b border-gray-800 text-xs">
        {(['all', 'whale', 'watched'] as Filter[]).map(f => (
          <button
            key={f}
            onClick={() => { setFilter(f); setNewCount(0); }}
            className={`flex-1 py-1.5 font-medium transition-colors ${filter === f ? 'text-cyan-400 border-b-2 border-cyan-400 bg-cyan-500/5' : 'text-gray-500 hover:text-gray-300'}`}
          >
            {f === 'all' ? 'Все' : f === 'whale' ? '🐳 Киты ≥$5K' : '⭐ Watched'}
          </button>
        ))}
      </div>

      {/* Category filter */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-gray-800 bg-gray-900/50">
        <span className="text-[11px] text-gray-500 mr-1">Категория:</span>
        {CATEGORY_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => { setCategory(opt.value); setNewCount(0); }}
            className={`text-xs px-2 py-1 rounded-md transition-colors ${category === opt.value ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-gray-500 hover:text-gray-300 border border-transparent'}`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Events list */}
      <div className="flex-1 overflow-y-auto divide-y divide-gray-800/60" style={{ maxHeight: '600px' }}>
        {loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-14 rounded-lg bg-gray-800/60 animate-pulse" />
            ))}
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-600 text-sm">
            <span className="text-2xl mb-2">📡</span>
            <p>Нет данных</p>
            <p className="text-xs mt-1">Бэкенд собирает ленту...</p>
          </div>
        ) : (
          events.map(ev => (
            <FeedRow key={ev.id} ev={ev} />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600 flex items-center justify-between">
        <span>
          Топ {filter === 'whale' ? 'киты' : filter === 'watched' ? 'watched' : '25'} кошельков
          {category !== 'all' && ` · ${CATEGORY_OPTIONS.find(o => o.value === category)?.label ?? category}`}
          {' · обновление 60с'}
        </span>
        <span>{events.length} сделок</span>
      </div>
    </div>
  );
}

function FeedRow({ ev }: { ev: FeedEvent }) {
  const outcomeColor = OUTCOME_COLOR[ev.outcome] || 'text-yellow-400';
  const isBuy = ev.side === 'BUY';

  const inner = (
    <div className={`
      flex gap-3 px-4 py-4 transition-colors cursor-pointer
      ${ev.isWhale ? 'bg-yellow-500/5 hover:bg-yellow-500/10' : 'hover:bg-gray-800/50'}
      ${ev.isWatched ? 'border-l-2 border-cyan-500/60' : ''}
    `}>
      {/* Side indicator */}
      <div className="flex-shrink-0 flex flex-col items-center pt-0.5">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold
          ${isBuy ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
          {isBuy ? '↑' : '↓'}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Row 1: trader name + time */}
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-1.5 min-w-0">
            {ev.rank && <span className="text-[10px] text-gray-600 flex-shrink-0">#{ev.rank}</span>}
            {ev.isWatched && <span className="text-[10px] text-cyan-500 flex-shrink-0">⭐</span>}
            {ev.isWhale && <span className="text-[10px] text-yellow-500 flex-shrink-0">🐳</span>}
            <span className="text-sm font-medium text-gray-200 truncate">
              {ev.userName || ev.shortAddr}
            </span>
            {ev.userName && (
              <span className="text-[10px] text-gray-600 flex-shrink-0">{ev.shortAddr}</span>
            )}
          </div>
          <span className="text-xs text-gray-500 flex-shrink-0">{timeAgo(ev.ts)}</span>
        </div>

        {/* Row 2: event title — крупнее */}
        <div className="mb-1.5">
          <span className="text-base font-semibold text-white leading-snug line-clamp-2">
            {ev.title || 'Unknown market'}
          </span>
        </div>

        {/* Row 3: outcome + action */}
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-xs font-bold flex-shrink-0 ${outcomeColor}`}>{ev.outcome || '?'}</span>
          <span className={`text-xs flex-shrink-0 ${isBuy ? 'text-green-500' : 'text-red-400'}`}>
            {isBuy ? 'купил' : 'продал'}
          </span>
        </div>

        {/* Row 4: тип рынка + цена входа + объём — крупнее */}
        <div className="flex items-center gap-2 flex-wrap">
          {ev.category && (
            <span className="text-sm text-gray-400 bg-gray-800/60 px-2 py-0.5 rounded">
              {ev.category}
            </span>
          )}
          <span className="text-sm font-medium text-gray-300">
            по {fmtPrice(ev.price)}
          </span>
          <span className="text-sm text-gray-500">·</span>
          <span className={`text-sm font-semibold ${ev.isWhale ? 'text-yellow-400' : 'text-gray-300'}`}>
            {fmtUsd(ev.usdValue)}
          </span>
          {ev.hoursToResolution != null && (
            <>
              <span className="text-sm text-gray-500">·</span>
              <span className={`text-[10px] ${ev.hoursToResolution < 24 ? 'text-orange-400' : 'text-gray-500'}`}>
                {ev.hoursToResolution < 24 ? `${ev.hoursToResolution.toFixed(0)}h to resolve` : `${(ev.hoursToResolution / 24).toFixed(0)}d to resolve`}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );

  const href = ev.eventSlug
    ? `/events/${ev.eventSlug}`
    : ev.marketId
    ? `/events/resolve/${ev.marketId}`
    : null;

  return href ? <Link href={href}>{inner}</Link> : <div>{inner}</div>;
}

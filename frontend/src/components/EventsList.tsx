'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';

const CATEGORIES = [
  { slug: 'all', label: 'All' },
  { slug: 'politics', label: 'Politics' },
  { slug: 'crypto', label: 'Crypto' },
  { slug: 'sports', label: 'Sports' },
  { slug: 'finance', label: 'Finance' },
  { slug: 'economy', label: 'Economy' },
  { slug: 'science', label: 'Science' },
  { slug: 'tech', label: 'Tech' },
  { slug: 'culture', label: 'Culture' },
  { slug: 'world', label: 'World' },
];

const SORT_OPTIONS = [
  { value: 'volume24hr', label: 'Volume 24h' },
  { value: 'volume', label: 'Total Volume' },
  { value: 'liquidity', label: 'Liquidity' },
  { value: 'startDate', label: 'Newest' },
  { value: 'endDate', label: 'Closing Soon' },
];

interface Market {
  id: string;
  question: string;
  conditionId: string;
  outcomes: string[];
  prices: number[];
  volume: number;
  liquidity: number;
  lastTradePrice: number;
  bestBid?: number;
  bestAsk?: number;
  oneDayPriceChange?: number;
  endDate: string;
  acceptingOrders: boolean;
  closed: boolean;
  potentialRoi: number;
  isAsymmetric: boolean;
  bestRoi: number;
  bestOutcomeIndex: number;
  groupItemTitle?: string;
}

interface Event {
  id: string;
  slug: string;
  title: string;
  description: string;
  image?: string;
  liquidity: number;
  volume: number;
  volume24hr: number;
  active: boolean;
  closed: boolean;
  endDate: string;
  competitive: number;
  commentCount: number;
  tags: Array<{ id: string; label: string; slug: string }>;
  markets: Market[];
  hasAsymmetricReturn: boolean;
  maxPotentialRoi: number;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtRoi(roi: number): string {
  if (roi >= 10000) return `${(roi / 100).toFixed(0)}x`;
  return `+${roi.toFixed(0)}%`;
}

function PriceChange({ change }: { change?: number }) {
  if (!change) return null;
  const pct = (change * 100).toFixed(1);
  return (
    <span className={`text-xs font-mono ${change > 0 ? 'text-green-400' : change < 0 ? 'text-red-400' : 'text-gray-500'}`}>
      {change > 0 ? '+' : ''}{pct}%
    </span>
  );
}

function EventCard({ event }: { event: Event }) {
  const mainMarket = event.markets[0];
  const isBinary = mainMarket && mainMarket.outcomes.length === 2;

  return (
    <Link href={`/events/${event.id}`}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-blue-600/50 hover:bg-gray-800/60 transition-all cursor-pointer group">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className="font-medium text-sm text-gray-100 leading-snug line-clamp-2 group-hover:text-white flex-1">
            {event.title}
          </h3>
          <div className="flex flex-col items-end gap-1 shrink-0">
            {event.hasAsymmetricReturn && (
              <span className="bg-yellow-500/20 text-yellow-400 text-xs font-bold px-2 py-0.5 rounded-full border border-yellow-500/30">
                ⚡ {fmtRoi(event.maxPotentialRoi)}
              </span>
            )}
          </div>
        </div>

        {/* Main market prices */}
        {mainMarket && isBinary && mainMarket.prices.length >= 2 && (
          <div className="flex gap-2 mb-3">
            <div className="flex-1 bg-gray-800 rounded-lg p-2.5 text-center">
              <div className="text-xs text-gray-400 mb-1">{mainMarket.outcomes[0] || 'Yes'}</div>
              <div className="text-lg font-bold text-green-400 font-mono">
                {(mainMarket.prices[0] * 100).toFixed(0)}¢
              </div>
              <PriceChange change={mainMarket.oneDayPriceChange} />
            </div>
            <div className="flex-1 bg-gray-800 rounded-lg p-2.5 text-center">
              <div className="text-xs text-gray-400 mb-1">{mainMarket.outcomes[1] || 'No'}</div>
              <div className="text-lg font-bold text-red-400 font-mono">
                {(mainMarket.prices[1] * 100).toFixed(0)}¢
              </div>
            </div>
          </div>
        )}

        {/* Multi-outcome event */}
        {mainMarket && !isBinary && event.markets.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-1">
            {event.markets.slice(0, 4).map((m) => (
              <div key={m.id} className="bg-gray-800 rounded px-2 py-1 flex items-center gap-1">
                <span className="text-xs text-gray-400 truncate max-w-[80px]">{m.groupItemTitle || m.question}</span>
                <span className="text-xs font-mono text-blue-300">{m.prices[0] ? `${(m.prices[0] * 100).toFixed(0)}¢` : '-'}</span>
              </div>
            ))}
            {event.markets.length > 4 && (
              <div className="bg-gray-800 rounded px-2 py-1 text-xs text-gray-500">+{event.markets.length - 4} more</div>
            )}
          </div>
        )}

        {/* Stats */}
        <div className="flex items-center justify-between text-xs text-gray-500 mt-2">
          <div className="flex items-center gap-3">
            <span title="24h Volume" className="flex items-center gap-1">
              <span className="text-gray-600">Vol 24h</span>
              <span className="text-gray-300 font-mono">{fmt(event.volume24hr)}</span>
            </span>
            <span title="Liquidity" className="flex items-center gap-1">
              <span className="text-gray-600">Liq</span>
              <span className="text-gray-300 font-mono">{fmt(event.liquidity)}</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            {event.tags.slice(0, 1).map(t => (
              <span key={t.id} className="bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded text-xs">{t.label}</span>
            ))}
            {/* Polymarket direct link */}
            <a
              href={`https://polymarket.com/event/${event.slug || event.id}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="text-gray-600 hover:text-blue-400 transition-colors"
              title="Open on Polymarket"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function EventsList({
  initialTag = 'all',
  compact = false,
  maxItems,
}: {
  initialTag?: string;
  compact?: boolean;
  maxItems?: number;
}) {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tag, setTag] = useState(initialTag);
  const [sort, setSort] = useState('volume24hr');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState('');
  const LIMIT = 20;

  const fetchEvents = useCallback(async (reset = false) => {
    try {
      setLoading(true);
      setError('');
      const currentOffset = reset ? 0 : offset;
      const res = await api.get('/markets', {
        params: {
          limit: LIMIT,
          offset: currentOffset,
          tag: tag !== 'all' ? tag : undefined,
          order: sort,
        },
      });
      const data = res.data;
      const newEvents: Event[] = data.events || [];
      if (reset) {
        setEvents(newEvents);
        setOffset(newEvents.length);
      } else {
        setEvents(prev => [...prev, ...newEvents]);
        setOffset(prev => prev + newEvents.length);
      }
      setHasMore(data.hasMore && !maxItems);
    } catch (err: any) {
      setError('Failed to connect to backend. Make sure the server is running on port 3002.');
    } finally {
      setLoading(false);
    }
  }, [tag, sort, offset, maxItems]);

  useEffect(() => {
    setOffset(0);
    fetchEvents(true);
  }, [tag, sort]);

  const filtered = search
    ? events.filter(e => e.title.toLowerCase().includes(search.toLowerCase()))
    : events;

  const displayed = maxItems ? filtered.slice(0, maxItems) : filtered;

  return (
    <div className="space-y-4">
      {!compact && (
        <>
          {/* Search */}
          <div className="relative">
            <input
              type="text"
              placeholder="Search events..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 pl-9 text-sm focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
            <span className="absolute left-3 top-2.5 text-gray-500 text-sm">🔍</span>
          </div>

          {/* Category tabs */}
          <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-hide">
            {CATEGORIES.map(cat => (
              <button
                key={cat.slug}
                onClick={() => setTag(cat.slug)}
                className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
                  tag === cat.slug
                    ? 'bg-blue-600 text-white font-medium'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Sort */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">Sort:</span>
            {SORT_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setSort(opt.value)}
                className={`px-3 py-1 rounded text-xs transition-colors ${
                  sort === opt.value
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Events grid */}
      {displayed.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {displayed.map(event => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      ) : !loading && (
        <div className="text-center py-16 text-gray-500">
          <div className="text-4xl mb-3">📊</div>
          <div>No events found</div>
        </div>
      )}

      {/* Loading skeletons */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 animate-pulse">
              <div className="h-4 bg-gray-800 rounded mb-3 w-3/4" />
              <div className="h-4 bg-gray-800 rounded mb-3 w-1/2" />
              <div className="flex gap-2 mb-3">
                <div className="flex-1 h-16 bg-gray-800 rounded-lg" />
                <div className="flex-1 h-16 bg-gray-800 rounded-lg" />
              </div>
              <div className="h-3 bg-gray-800 rounded w-full" />
            </div>
          ))}
        </div>
      )}

      {/* Load more */}
      {hasMore && !loading && (
        <div className="text-center pt-2">
          <button
            onClick={() => fetchEvents(false)}
            className="px-6 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

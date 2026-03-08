'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import AnomalyFeed, { AnomalyType } from '@/components/AnomalyFeed';

// ─── Insider tab ─────────────────────────────────────────────────────────────

interface InsiderMarket {
  marketId: string;
  marketQuestion: string;
  eventTitle: string;
  eventId: string;
  estimatedEntryPrice: number;
  currentPrice: number;
  oneDayChange: number;
  potentialRoi: number;
  volume24h: number;
  liquidity: number;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function InsiderMarketsPanel() {
  const [markets, setMarkets] = useState<InsiderMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/anomalies/insider-markets')
      .then(res => setMarkets(res.data.markets || []))
      .catch(() => setError('Could not load insider market data'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="space-y-2">
      {[1, 2, 3, 4].map(i => <div key={i} className="h-24 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />)}
    </div>
  );
  if (error) return <div className="text-sm text-red-400 py-4">{error}</div>;
  if (markets.length === 0) return (
    <div className="text-center py-12 text-gray-600 text-sm">
      No insider market patterns detected right now
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Explanation banner */}
      <div className="bg-purple-500/5 border border-purple-500/20 rounded-xl p-4 text-sm text-gray-400">
        <span className="text-purple-400 font-semibold">🕵️ How we detect insider patterns: </span>
        Markets where a low-probability outcome (&lt;22¢) experienced a significant price jump (&gt;4%) in 24h,
        combined with elevated volume. This pattern often precedes public news — informed traders move first.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {markets.map(m => {
          const roi = m.potentialRoi;
          return (
            <Link key={m.marketId} href={`/events/${m.eventId}`}>
              <div className="bg-gray-900 border border-purple-500/20 hover:border-purple-500/50 rounded-xl p-4 transition-all cursor-pointer">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-500 truncate">{m.eventTitle}</div>
                    <div className="text-sm font-medium text-gray-100 line-clamp-2 mt-0.5 leading-snug">
                      {m.marketQuestion !== m.eventTitle ? m.marketQuestion : m.eventTitle}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-lg font-bold text-purple-400">
                      +{(m.oneDayChange * 100).toFixed(1)}%
                    </div>
                    <div className="text-xs text-gray-500">24h move</div>
                  </div>
                </div>

                <div className="flex gap-2 mb-3">
                  <div className="flex-1 bg-gray-800 rounded-lg p-2.5 text-center">
                    <div className="text-xs text-gray-500 mb-0.5">Est. entry price</div>
                    <div className="text-base font-bold text-gray-300 font-mono">
                      {(Math.max(0.001, m.estimatedEntryPrice) * 100).toFixed(1)}¢
                    </div>
                  </div>
                  <div className="flex-1 bg-purple-500/10 border border-purple-500/20 rounded-lg p-2.5 text-center">
                    <div className="text-xs text-gray-500 mb-0.5">Now</div>
                    <div className="text-base font-bold text-purple-400 font-mono">
                      {(m.currentPrice * 100).toFixed(1)}¢
                    </div>
                  </div>
                  <div className="flex-1 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-2.5 text-center">
                    <div className="text-xs text-gray-500 mb-0.5">If resolves</div>
                    <div className="text-base font-bold text-yellow-400 font-mono">
                      {roi >= 10000 ? `${(roi / 100).toFixed(0)}x` : `+${roi.toFixed(0)}%`}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>Vol 24h: <span className="text-gray-300">{fmt(m.volume24h)}</span></span>
                  <span>Liq: <span className="text-gray-300">{fmt(m.liquidity)}</span></span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────

type Tab = 'all' | 'price' | 'volume' | 'insider' | 'closing' | 'reversal';

const TABS: { id: Tab; label: string; icon: string; type?: AnomalyType }[] = [
  { id: 'all',      label: 'All',            icon: '🔔' },
  { id: 'insider',  label: 'Insider Signals', icon: '🕵️' },
  { id: 'price',    label: 'Price Spikes',    icon: '📈', type: 'PRICE_SPIKE' },
  { id: 'volume',   label: 'Volume Surges',   icon: '🌊', type: 'VOLUME_SURGE' },
  { id: 'closing',  label: 'Closing Spikes',  icon: '⏰', type: 'CLOSING_SPIKE' },
  { id: 'reversal', label: 'Reversals',       icon: '🔄', type: 'REVERSAL' },
];

export default function AnomaliesPage() {
  const [tab, setTab] = useState<Tab>('all');

  const activeTab = TABS.find(t => t.id === tab)!;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-2xl">🔔</span>
          <h1 className="text-2xl font-bold text-white">Anomaly Scanner</h1>
        </div>
        <p className="text-gray-400 text-sm">
          Real-time detection of unusual market activity — price spikes, volume surges, insider-like patterns, and momentum shifts.
          Data refreshes from live Polymarket API.
        </p>
      </div>

      {/* Strategy callout */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
        <div className="bg-orange-500/5 border border-orange-500/20 rounded-xl p-3">
          <div className="text-orange-400 font-semibold mb-1">📈 Price Spikes</div>
          <div className="text-gray-400 text-xs">Prices that moved &gt;8% in 24h signal crowd repricing. Often precedes a big resolution move.</div>
        </div>
        <div className="bg-purple-500/5 border border-purple-500/20 rounded-xl p-3">
          <div className="text-purple-400 font-semibold mb-1">🕵️ Insider Signals</div>
          <div className="text-gray-400 text-xs">Low-prob outcomes (&lt;22¢) jumping with high volume — someone knows something before the market.</div>
        </div>
        <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-xl p-3">
          <div className="text-yellow-400 font-semibold mb-1">⏰ Closing Spikes</div>
          <div className="text-gray-400 text-xs">Events closing within 7 days with price movement = last chance entries at skewed odds.</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3.5 py-2 rounded-lg text-sm whitespace-nowrap transition-colors flex items-center gap-1.5 ${
              tab === t.id
                ? 'bg-gray-700 text-white font-medium'
                : 'bg-gray-900 text-gray-400 hover:bg-gray-800 hover:text-white'
            }`}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === 'insider' ? (
        <InsiderMarketsPanel />
      ) : (
        <AnomalyFeed
          defaultType={activeTab.type ?? 'ALL'}
          autoRefresh={true}
          showFilters={true}
        />
      )}
    </div>
  );
}

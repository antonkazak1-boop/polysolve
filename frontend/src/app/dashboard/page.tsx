'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import EventsList from '@/components/EventsList';
import AnomalyFeed, { Anomaly } from '@/components/AnomalyFeed';
import TopRecommendations from '@/components/TopRecommendations';
import DemoTradeModal from '@/components/DemoTradeModal';
import SignalsPreview from '@/components/SignalsPreview';

interface AsymmetricOpportunity {
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  eventVolume24hr: number;
  tags: Array<{ id: string; label: string }>;
  market: {
    id: string;
    question: string;
    prices: number[];
    outcomes: string[];
    bestRoi: number;
    bestOutcomeIndex: number;
    liquidity: number;
    volume: number;
    oneDayPriceChange?: number;
  };
  liquidity: number;
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

function AsymmetricCard({ opp }: { opp: AsymmetricOpportunity }) {
  const { market } = opp;
  const outcomeIdx = market.bestOutcomeIndex;
  const price = market.prices[outcomeIdx] ?? 0;
  const outcomeName = market.outcomes[outcomeIdx] ?? 'Yes';

  return (
    <Link href={`/events/${opp.eventId}`}>
      <div className="bg-gray-900 border border-yellow-500/20 rounded-xl p-4 hover:border-yellow-500/50 hover:bg-gray-800/60 transition-all cursor-pointer">
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-gray-500 mb-1 truncate">{opp.eventTitle}</div>
            <div className="text-sm font-medium text-gray-100 line-clamp-2 leading-snug">{market.question}</div>
          </div>
          <div className="ml-3 shrink-0 text-right">
            <div className="text-xl font-bold text-yellow-400">{fmtRoi(market.bestRoi)}</div>
            <div className="text-xs text-gray-500">potential ROI</div>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 flex-1 text-center">
            <div className="text-xs text-gray-400 mb-0.5">Bet on: {outcomeName}</div>
            <div className="text-lg font-bold text-yellow-400 font-mono">{(price * 100).toFixed(0)}¢</div>
          </div>
          <div className="text-right text-xs text-gray-500 space-y-1">
            <div>Vol 24h: <span className="text-gray-300">{fmt(opp.eventVolume24hr)}</span></div>
            <div>Liq: <span className="text-gray-300">{fmt(opp.liquidity)}</span></div>
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function DashboardPage() {
  const [opportunities, setOpportunities] = useState<AsymmetricOpportunity[]>([]);
  const [oppsLoading, setOppsLoading] = useState(true);
  const [tradeMarket, setTradeMarket] = useState<any>(null);
  const [tradeSuccess, setTradeSuccess] = useState<string | null>(null);

  useEffect(() => {
    api.get('/markets/asymmetric', { params: { limit: 6, minRoi: 300, minLiquidity: 10000 } })
      .then(res => setOpportunities(res.data.opportunities || []))
      .catch(() => {})
      .finally(() => setOppsLoading(false));
  }, []);

  function handleRecommendationTrade(rec: any) {
    setTradeMarket({
      eventId: rec.eventId,
      eventTitle: rec.eventTitle,
      marketId: rec.marketId,
      marketQuestion: rec.marketQuestion,
      prices: [rec.price, 1 - rec.price],
      outcomes: ['Yes', 'No'],
      tags: rec.tags,
    });
  }

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-1">Live Polymarket data — events, prices, asymmetric returns, anomalies</p>
      </div>

      {/* Trade success toast */}
      {tradeSuccess && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 text-sm px-4 py-3 rounded-xl flex items-center justify-between">
          <span>✓ {tradeSuccess}</span>
          <button onClick={() => setTradeSuccess(null)} className="ml-4 text-green-600 hover:text-green-400">×</button>
        </div>
      )}

      {/* Top 5 Trading Signals */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
            </span>
            <h2 className="text-lg font-semibold">Trading Signals</h2>
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">Auto-analyzed</span>
          </div>
          <Link href="/signals" className="text-sm text-blue-400 hover:text-blue-300">
            All signals →
          </Link>
        </div>
        <SignalsPreview limit={5} />
      </section>

      {/* Live Anomaly Feed */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-red-400 text-lg">🔔</span>
            <h2 className="text-lg font-semibold">Live Anomalies</h2>
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">Price spikes · Volume · Insider signals</span>
          </div>
          <Link href="/anomalies" className="text-sm text-blue-400 hover:text-blue-300">
            View all →
          </Link>
        </div>
        <AnomalyFeed compact maxItems={3} showFilters={false} autoRefresh={true} />
      </section>

      {/* Asymmetric Returns section */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-yellow-400 text-lg">⚡</span>
            <h2 className="text-lg font-semibold">Asymmetric Returns</h2>
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">High ROI opportunities</span>
          </div>
          <Link href="/asymmetric" className="text-sm text-blue-400 hover:text-blue-300">
            View all →
          </Link>
        </div>

        {oppsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 animate-pulse h-36" />
            ))}
          </div>
        ) : opportunities.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {opportunities.slice(0, 6).map(opp => (
              <AsymmetricCard key={`${opp.eventId}-${opp.market.id}`} opp={opp} />
            ))}
          </div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center text-gray-500 text-sm">
            No asymmetric opportunities found right now
          </div>
        )}
      </section>

      {/* Top 10 Recommendations */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-purple-400 text-lg">🎯</span>
            <h2 className="text-lg font-semibold">Top Recommendations</h2>
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">AI scored · Politics · Iran · Crypto</span>
          </div>
          <Link href="/recommendations" className="text-sm text-blue-400 hover:text-blue-300">
            View all →
          </Link>
        </div>
        <TopRecommendations limit={5} compact onTrade={handleRecommendationTrade} />
      </section>

      {/* Trending markets */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-blue-400 text-lg">🔥</span>
            <h2 className="text-lg font-semibold">Trending by Volume</h2>
          </div>
          <Link href="/events" className="text-sm text-blue-400 hover:text-blue-300">
            All markets →
          </Link>
        </div>
        <EventsList compact maxItems={6} />
      </section>

      {/* Demo Trade Modal */}
      {tradeMarket && (
        <DemoTradeModal
          eventId={tradeMarket.eventId}
          eventTitle={tradeMarket.eventTitle}
          marketId={tradeMarket.marketId}
          marketQuestion={tradeMarket.marketQuestion}
          prices={tradeMarket.prices}
          outcomes={tradeMarket.outcomes}
          tags={tradeMarket.tags}
          onClose={() => setTradeMarket(null)}
          onSuccess={(trade, newBal) => {
            setTradeMarket(null);
            setTradeSuccess(`Opened ${trade.outcome} — $${trade.amount.toFixed(0)}. Balance: $${newBal.toFixed(0)}`);
          }}
        />
      )}
    </div>
  );
}

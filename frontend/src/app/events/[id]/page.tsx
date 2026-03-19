'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import DemoTradeModal from '@/components/DemoTradeModal';

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtRoi(roi: number): string {
  if (roi >= 10000) return `${(roi / 100).toFixed(0)}x return`;
  return `+${roi.toFixed(0)}% ROI`;
}

function fmtDate(d: string) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function polymarketUrl(slug?: string, id?: string): string {
  if (slug) return `https://polymarket.com/event/${slug}`;
  if (id) return `https://polymarket.com/event/${id}`;
  return 'https://polymarket.com';
}

function PriceChangeTag({ change }: { change?: number }) {
  if (!change) return null;
  const up = change > 0;
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-mono ${up ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
      {up ? '+' : ''}{(change * 100).toFixed(1)}% 24h
    </span>
  );
}

const SENTIMENT_COLOR: Record<string, string> = {
  BULLISH: 'text-green-400',
  BEARISH: 'text-red-400',
  NEUTRAL: 'text-gray-400',
};
const SENTIMENT_BG: Record<string, string> = {
  BULLISH: 'bg-green-500/10 border-green-500/20',
  BEARISH: 'bg-red-500/10 border-red-500/20',
  NEUTRAL: 'bg-gray-800 border-gray-700',
};

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [event, setEvent] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tradeMarket, setTradeMarket] = useState<any>(null);
  const [news, setNews] = useState<any>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const [tradeSuccess, setTradeSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.get(`/markets/${id}`)
      .then(res => setEvent(res.data))
      .catch(() => setError('Event not found'))
      .finally(() => setLoading(false));
  }, [id]);

  const fetchNews = useCallback(() => {
    if (!id || newsLoading) return;
    setNewsLoading(true);
    api.get(`/events/${id}/news`)
      .then(res => setNews(res.data.news))
      .catch(() => setNews({ error: true }))
      .finally(() => setNewsLoading(false));
  }, [id, newsLoading]);

  if (loading) return (
    <div className="space-y-4 animate-pulse">
      <div className="h-8 bg-gray-800 rounded w-2/3" />
      <div className="h-4 bg-gray-800 rounded w-full" />
      <div className="h-4 bg-gray-800 rounded w-3/4" />
    </div>
  );

  if (error || !event) return (
    <div className="text-center py-20 text-gray-500">
      <div className="text-4xl mb-3">⚠️</div>
      <div>{error || 'Event not found'}</div>
      <Link href="/events" className="mt-4 inline-block text-blue-400 hover:underline">← Back to events</Link>
    </div>
  );

  const pmUrl = polymarketUrl(event.slug, event.id);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Link href="/events" className="hover:text-gray-300">Markets</Link>
        <span>/</span>
        <span className="text-gray-300 truncate">{event.title}</span>
      </div>

      {/* Event header */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-3 mb-2">
              {event.image && (
                <img src={event.image} alt="" className="w-10 h-10 rounded-xl shrink-0 object-cover" />
              )}
              <h1 className="text-xl font-bold text-white leading-snug">{event.title}</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {event.tags?.map((t: any) => (
                <span key={t.id} className="bg-gray-800 text-gray-400 text-xs px-2 py-0.5 rounded-full">{t.label}</span>
              ))}
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${event.active && !event.closed ? 'bg-green-500/10 text-green-400' : 'bg-gray-700 text-gray-400'}`}>
                {event.active && !event.closed ? '● Active' : 'Closed'}
              </span>
              {event.hasAsymmetricReturn && (
                <span className="bg-yellow-500/20 text-yellow-400 text-xs font-bold px-2 py-0.5 rounded-full border border-yellow-500/30">
                  ⚡ {fmtRoi(event.maxPotentialRoi)}
                </span>
              )}
            </div>
          </div>

          {/* Polymarket link */}
          <a
            href={pmUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-3 py-2 rounded-xl transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            Polymarket
          </a>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          <StatBox label="Volume 24h" value={fmt(event.volume24hr)} />
          <StatBox label="Total Volume" value={fmt(event.volume)} />
          <StatBox label="Liquidity" value={fmt(event.liquidity)} />
          <StatBox label="Closes" value={fmtDate(event.endDate)} />
        </div>

        {event.description && (
          <div className="mt-4 text-sm text-gray-400 leading-relaxed border-t border-gray-800 pt-4">
            {event.description.slice(0, 500)}{event.description.length > 500 ? '...' : ''}
          </div>
        )}
      </div>

      {/* News block (Perplexity) */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-base">📰</span>
            <h2 className="text-base font-semibold text-white">News & Sentiment</h2>
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">via Perplexity AI</span>
          </div>
          <button
            onClick={fetchNews}
            disabled={newsLoading}
            className="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
          >
            {newsLoading ? (
              <>
                <span className="animate-spin">⟳</span> Fetching...
              </>
            ) : (
              <>🔍 Fetch News</>
            )}
          </button>
        </div>

        {!news && !newsLoading && (
          <div className="text-center py-6 text-gray-600 text-sm">
            <div className="text-3xl mb-2">📡</div>
            <div>Click &ldquo;Fetch News&rdquo; to get latest news and sentiment analysis</div>
          </div>
        )}

        {newsLoading && (
          <div className="space-y-2 animate-pulse">
            <div className="h-4 bg-gray-800 rounded w-full" />
            <div className="h-4 bg-gray-800 rounded w-5/6" />
            <div className="h-4 bg-gray-800 rounded w-4/6" />
          </div>
        )}

        {news && !news.error && (
          <div className="space-y-4">
            {/* Sentiment badge + summary */}
            <div className={`border rounded-xl p-4 ${SENTIMENT_BG[news.sentiment] ?? 'bg-gray-800 border-gray-700'}`}>
              <div className="flex items-center gap-3 mb-2">
                <span className={`text-sm font-bold ${SENTIMENT_COLOR[news.sentiment] ?? 'text-gray-400'}`}>
                  {news.sentiment === 'BULLISH' ? '📈' : news.sentiment === 'BEARISH' ? '📉' : '➡️'} {news.sentiment}
                </span>
                <span className="text-xs text-gray-500">relevance {news.relevance}%</span>
                <span className="text-xs text-gray-600 ml-auto">{new Date(news.fetchedAt).toLocaleTimeString()}</span>
              </div>
              <p className="text-sm text-gray-300 leading-relaxed">{news.summary}</p>
            </div>

            {/* Key points */}
            {news.keyPoints?.length > 0 && (
              <div>
                <div className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wide">Key Points</div>
                <ul className="space-y-1.5">
                  {news.keyPoints.map((pt: string, i: number) => (
                    <li key={i} className="flex gap-2 text-sm text-gray-400">
                      <span className="text-gray-600 shrink-0 mt-0.5">•</span>
                      <span>{pt}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Sources */}
            {news.sources?.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <span className="text-xs text-gray-500">Sources:</span>
                {news.sources.map((s: string, i: number) => (
                  <span key={i} className="text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">{s}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {news?.error && (
          <div className="text-center py-4 text-red-400 text-sm">Failed to fetch news. Check Perplexity API key.</div>
        )}
      </div>

      {/* Trade success toast */}
      {tradeSuccess && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 text-sm px-4 py-3 rounded-xl flex items-center justify-between">
          <span>✓ {tradeSuccess}</span>
          <button onClick={() => setTradeSuccess(null)} className="text-green-600 hover:text-green-400 ml-4">×</button>
        </div>
      )}

      {/* Markets */}
      <div>
        <h2 className="text-lg font-semibold mb-3 text-white">
          {event.markets?.length === 1 ? 'Market' : `Markets (${event.markets?.length})`}
        </h2>
        <div className="space-y-3">
          {event.markets?.map((market: any) => (
            <MarketRow
              key={market.id}
              market={market}
              eventId={event.id}
              eventTitle={event.title}
              eventSlug={event.slug}
              tags={event.tags?.map((t: any) => t.label)}
              onTrade={() => setTradeMarket(market)}
            />
          ))}
        </div>
      </div>

      {/* Demo Trade Modal */}
      {tradeMarket && (
        <DemoTradeModal
          eventId={event.id}
          eventTitle={event.title}
          marketId={tradeMarket.id}
          marketQuestion={tradeMarket.question}
          prices={tradeMarket.prices ?? []}
          outcomes={tradeMarket.outcomes ?? ['Yes', 'No']}
          tags={event.tags?.map((t: any) => t.label)}
          onClose={() => setTradeMarket(null)}
          onSuccess={(trade, newBal) => {
            setTradeMarket(null);
            setTradeSuccess(`Opened ${trade.outcome} position — $${trade.amount.toFixed(0)}. Balance: $${newBal.toFixed(0)}`);
          }}
        />
      )}
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800/60 rounded-xl p-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-base font-bold text-white font-mono">{value}</div>
    </div>
  );
}

function MarketRow({ market, eventId, eventTitle, eventSlug, tags, onTrade }: {
  market: any;
  eventId?: string;
  eventTitle?: string;
  eventSlug?: string;
  tags?: string[];
  onTrade?: () => void;
}) {
  const prices: number[] = market.prices || [];
  const outcomes: string[] = market.outcomes || ['Yes', 'No'];
  const isBinary = prices.length === 2 && outcomes.length === 2;
  const canTrade = market.acceptingOrders && !market.closed && prices.some((p: number) => p > 0.005 && p < 0.995);

  // Polymarket link for this specific market (uses clobTokenIds or market slug)
  const marketSlug = market.slug ?? eventSlug;
  const pmMarketUrl = marketSlug
    ? `https://polymarket.com/event/${eventSlug ?? eventId}/${marketSlug}`
    : `https://polymarket.com/event/${eventSlug ?? eventId}`;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <h3 className="font-medium text-gray-100 text-sm leading-snug flex-1">{market.question}</h3>
        <div className="flex items-center gap-2 shrink-0">
          <PriceChangeTag change={market.oneDayPriceChange} />
          {market.isAsymmetric && (
            <span className="bg-yellow-500/20 text-yellow-400 text-xs font-bold px-2 py-0.5 rounded-full">
              ⚡ {market.bestRoi >= 10000 ? `${(market.bestRoi / 100).toFixed(0)}x` : `+${market.bestRoi.toFixed(0)}%`}
            </span>
          )}
          <a
            href={pmMarketUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-blue-400 transition-colors"
            title="Open on Polymarket"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      </div>

      {isBinary && (
        <div className="flex gap-2">
          {outcomes.map((outcome, idx) => {
            const price = prices[idx] ?? 0;
            const roi = price > 0 && price < 1 ? (1 / price - 1) * 100 : 0;
            const isYes = idx === 0;
            return (
              <div key={idx} className={`flex-1 rounded-lg p-3 border ${isYes ? 'bg-green-500/5 border-green-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
                <div className="text-xs text-gray-400 mb-1">{outcome}</div>
                <div className={`text-2xl font-bold font-mono mb-0.5 ${isYes ? 'text-green-400' : 'text-red-400'}`}>
                  {(price * 100).toFixed(0)}¢
                </div>
                {roi > 100 && (
                  <div className="text-xs text-yellow-500">Win: {fmtRoi(roi)}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between mt-3 text-xs text-gray-500">
        <div className="flex items-center gap-3">
          <span>Vol: <span className="text-gray-300">{fmt(market.volume || 0)}</span></span>
          {market.liquidity > 0 && <span>Liq: <span className="text-gray-300">{fmt(market.liquidity)}</span></span>}
        </div>
        <div className="flex items-center gap-2">
          {!market.acceptingOrders && !market.closed && <span className="text-orange-400">Orders paused</span>}
          {market.closed && <span className="text-gray-500">Closed</span>}
          {market.endDate && <span>Ends {fmtDate(market.endDate)}</span>}
          {canTrade && onTrade && (
            <button
              onClick={onTrade}
              className="bg-green-600 hover:bg-green-500 text-white px-3 py-1 rounded-lg text-xs font-semibold transition-colors"
            >
              Demo Trade
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

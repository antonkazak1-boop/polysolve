'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Opportunity {
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  eventVolume24hr: number;
  tags: Array<{ id: string; label: string }>;
  liquidity: number;
  score: number;
  market: {
    id: string;
    question: string;
    prices: number[];
    outcomes: string[];
    targetOutcomeIndex: number;
    targetOutcome: string;
    targetPrice: number;
    targetRoi: number;
    bestRoi: number;
    oneDayPriceChange?: number;
    oneWeekPriceChange?: number;
    endDate?: string;
  };
}

interface Scalp {
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  eventVolume24hr: number;
  tags: Array<{ id: string; label: string }>;
  liquidity: number;
  score: number;
  isCrypto: boolean;
  isSports: boolean;
  market: {
    id: string;
    question: string;
    prices: number[];
    outcomes: string[];
    targetOutcomeIndex: number;
    targetOutcome: string;
    targetPrice: number;
    target2x: number;
    target3x: number;
    roi2x: number;
    roi3x: number;
    dayChange: number;
    weekChange: number;
    volLiqRatio: number;
    endDate?: string;
  };
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

function fmtDate(d?: string) {
  if (!d) return '—';
  const dt = new Date(d);
  const days = Math.ceil((dt.getTime() - Date.now()) / 86400000);
  if (days < 0) return 'Expired';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days <= 30) return `${days}d left`;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function polymarketUrl(slug?: string, id?: string) {
  if (slug) return `https://polymarket.com/event/${slug}`;
  if (id) return `https://polymarket.com/event/${id}`;
  return 'https://polymarket.com';
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {[1, 2, 3, 4, 5, 6].map(i => (
        <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 animate-pulse h-44" />
      ))}
    </div>
  );
}

// ─── Tab bar ─────────────────────────────────────────────────────────────────

type Tab = 'opportunities' | 'scalp';

// ─── Main page ───────────────────────────────────────────────────────────────

export default function AsymmetricPage() {
  const [tab, setTab] = useState<Tab>('opportunities');
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [scalps, setScalps] = useState<Scalp[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Opportunity filters
  const [minPrice, setMinPrice] = useState(0.04);
  const [maxPrice, setMaxPrice] = useState(0.20);
  const [minLiquidity, setMinLiquidity] = useState(2000);

  // Scalp filters
  const [scalpMinPrice, setScalpMinPrice] = useState(0.05);
  const [scalpMaxPrice, setScalpMaxPrice] = useState(0.40);
  const [scalpMinMomentum, setScalpMinMomentum] = useState(0.02);

  const fetchOpportunities = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/markets/opportunities', {
        params: { limit: 60, minPrice, maxPrice, minLiquidity },
      });
      setOpportunities(res.data.opportunities || []);
    } catch {
      setError('Failed to load opportunities.');
    } finally {
      setLoading(false);
    }
  };

  const fetchScalps = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/markets/scalp', {
        params: { limit: 40, minPrice: scalpMinPrice, maxPrice: scalpMaxPrice, minMomentum: scalpMinMomentum },
      });
      setScalps(res.data.scalps || []);
    } catch {
      setError('Failed to load scalp opportunities.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'opportunities') fetchOpportunities();
    else fetchScalps();
  }, [tab, minPrice, maxPrice, minLiquidity, scalpMinPrice, scalpMaxPrice, scalpMinMomentum]);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-yellow-400 text-2xl">⚡</span>
          <h1 className="text-2xl font-bold text-white">Asymmetric Strategies</h1>
        </div>
        <p className="text-gray-400 text-sm">
          Two complementary strategies for outsized returns on Polymarket.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-800">
        <button
          onClick={() => setTab('opportunities')}
          className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
            tab === 'opportunities'
              ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 border-b-0'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          💎 Hold-to-Resolution
        </button>
        <button
          onClick={() => setTab('scalp')}
          className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
            tab === 'scalp'
              ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30 border-b-0'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          ⚡ Scalp / Flip
        </button>
      </div>

      {/* Strategy explanation */}
      {tab === 'opportunities' ? (
        <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-xl p-4 text-sm">
          <div className="font-semibold text-yellow-400 mb-2">💎 Hold-to-Resolution Strategy</div>
          <div className="text-gray-300 leading-relaxed space-y-1">
            <p>
              Buy outcomes priced <strong className="text-white">4¢–20¢</strong> on active markets with real volume.
              If correct, you earn <strong className="text-yellow-300">4x–24x</strong> your stake.
            </p>
            <p className="text-gray-400 text-xs">
              Key rule: win rate doesn't matter. A 20% win rate with 10x average payout is extremely profitable.
              We filter out &ldquo;dead&rdquo; outcomes (0–3¢) that the market has essentially declared impossible.
              4¢+ means there is still meaningful disagreement.
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 text-sm">
          <div className="font-semibold text-blue-400 mb-2">⚡ Scalp / Flip Strategy</div>
          <div className="text-gray-300 leading-relaxed space-y-1">
            <p>
              Buy at <strong className="text-white">5¢–40¢</strong>, sell when price reaches{' '}
              <strong className="text-blue-300">2x or 3x your entry</strong> — without waiting for resolution.
            </p>
            <p className="text-gray-400 text-xs">
              Polymarket has a live orderbook — you can exit any time. The trick is finding markets with strong
              momentum where price is actively moving. Crypto price markets are ideal: e.g. buy &ldquo;BTC above $100K&rdquo;
              at 10¢ → wait for sentiment to push it to 20¢ → sell. Pure trading, no prediction required.
            </p>
            <p className="text-gray-400 text-xs">
              Filter shows only markets with real 24h price movement (&gt;2%) and active volume.
            </p>
          </div>
        </div>
      )}

      {/* Filters */}
      {tab === 'opportunities' ? (
        <div className="flex items-center gap-4 flex-wrap text-sm">
          <div className="flex items-center gap-2">
            <span className="text-gray-400">Buy range:</span>
            {[
              { min: 0.04, max: 0.10, label: '4¢–10¢ (10x+)' },
              { min: 0.04, max: 0.20, label: '4¢–20¢ (4x+)' },
              { min: 0.08, max: 0.25, label: '8¢–25¢' },
            ].map(opt => (
              <button
                key={opt.label}
                onClick={() => { setMinPrice(opt.min); setMaxPrice(opt.max); }}
                className={`px-3 py-1 rounded text-xs transition-colors ${
                  minPrice === opt.min && maxPrice === opt.max
                    ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-400">Min Liq:</span>
            {[1000, 2000, 10000, 50000].map(val => (
              <button
                key={val}
                onClick={() => setMinLiquidity(val)}
                className={`px-3 py-1 rounded text-xs transition-colors ${
                  minLiquidity === val
                    ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {fmt(val)}
              </button>
            ))}
          </div>
          {!loading && (
            <span className="text-xs text-gray-600 ml-auto">{opportunities.length} found</span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-4 flex-wrap text-sm">
          <div className="flex items-center gap-2">
            <span className="text-gray-400">Entry range:</span>
            {[
              { min: 0.05, max: 0.20, label: '5¢–20¢' },
              { min: 0.05, max: 0.40, label: '5¢–40¢' },
              { min: 0.10, max: 0.50, label: '10¢–50¢' },
            ].map(opt => (
              <button
                key={opt.label}
                onClick={() => { setScalpMinPrice(opt.min); setScalpMaxPrice(opt.max); }}
                className={`px-3 py-1 rounded text-xs transition-colors ${
                  scalpMinPrice === opt.min && scalpMaxPrice === opt.max
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-400">Min move:</span>
            {[
              { val: 0.01, label: '1%/day' },
              { val: 0.02, label: '2%/day' },
              { val: 0.05, label: '5%/day' },
            ].map(opt => (
              <button
                key={opt.val}
                onClick={() => setScalpMinMomentum(opt.val)}
                className={`px-3 py-1 rounded text-xs transition-colors ${
                  scalpMinMomentum === opt.val
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {!loading && (
            <span className="text-xs text-gray-600 ml-auto">{scalps.length} found</span>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4 text-sm text-red-400">{error}</div>
      )}

      {/* Content */}
      {loading ? (
        <Skeleton />
      ) : tab === 'opportunities' ? (
        <OpportunitiesGrid items={opportunities} />
      ) : (
        <ScalpGrid items={scalps} />
      )}
    </div>
  );
}

// ─── Opportunity card ─────────────────────────────────────────────────────────

function OpportunitiesGrid({ items }: { items: Opportunity[] }) {
  if (items.length === 0) {
    return (
      <div className="text-center py-16 text-gray-500">
        <div className="text-4xl mb-3">🔍</div>
        <div>No opportunities match current filters</div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {items.map((opp, i) => {
        const { market } = opp;
        const price = market.targetPrice;
        const roi = market.targetRoi;
        const roiX = (roi / 100 + 1).toFixed(1);
        const dayChange = market.oneDayPriceChange;
        const hasMomentum = dayChange && dayChange > 0.01;
        const pmUrl = polymarketUrl(opp.eventSlug, opp.eventId);

        return (
          <div key={`${opp.eventId}-${market.id}-${i}`} className="bg-gray-900 border border-gray-800 hover:border-yellow-500/30 rounded-xl p-4 transition-all hover:bg-gray-800/60">
            {/* Header row */}
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-500 mb-0.5 truncate">{opp.eventTitle}</div>
                <div className="text-sm font-medium text-gray-100 line-clamp-2 leading-snug">
                  {market.question !== opp.eventTitle ? market.question : opp.eventTitle}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-xs text-gray-500">if wins</div>
                <div className="text-lg font-bold text-yellow-400">{roiX}x</div>
              </div>
            </div>

            {/* Price box + stats */}
            <div className="flex items-stretch gap-3">
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 text-center min-w-[70px]">
                <div className="text-[10px] text-gray-400 mb-0.5">"{market.targetOutcome}"</div>
                <div className="text-2xl font-bold text-yellow-400 font-mono leading-none">
                  {(price * 100).toFixed(0)}¢
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">entry price</div>
              </div>

              <div className="flex-1 text-xs text-gray-500 space-y-1">
                <div className="flex justify-between">
                  <span>Target (4x)</span>
                  <span className="text-gray-300 font-mono">{(price * 4 > 1 ? 100 : price * 4 * 100).toFixed(0)}¢</span>
                </div>
                <div className="flex justify-between">
                  <span>Vol 24h</span>
                  <span className="text-gray-300">{fmt(opp.eventVolume24hr)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Liquidity</span>
                  <span className="text-gray-300">{fmt(opp.liquidity)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Closes</span>
                  <span className="text-gray-300">{fmtDate(market.endDate)}</span>
                </div>
                {dayChange !== undefined && (
                  <div className="flex justify-between">
                    <span>24h move</span>
                    <span className={dayChange > 0 ? 'text-green-400' : dayChange < 0 ? 'text-red-400' : 'text-gray-500'}>
                      {fmtPct(dayChange)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Badges + links */}
            <div className="flex items-center gap-1.5 mt-3 flex-wrap">
              {hasMomentum && (
                <span className="bg-green-500/10 text-green-400 border border-green-500/20 text-[10px] px-1.5 py-0.5 rounded font-medium">
                  📈 RISING
                </span>
              )}
              {opp.tags.slice(0, 2).map(t => (
                <span key={t.id} className="bg-gray-800 text-gray-500 text-[10px] px-1.5 py-0.5 rounded">{t.label}</span>
              ))}
              <div className="ml-auto flex gap-1.5">
                <Link href={`/events/${opp.eventId}`} className="text-[10px] text-blue-400 hover:underline">Details</Link>
                <span className="text-gray-700">·</span>
                <a href={pmUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-green-400 hover:underline">Polymarket ↗</a>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Scalp card ───────────────────────────────────────────────────────────────

function ScalpGrid({ items }: { items: Scalp[] }) {
  if (items.length === 0) {
    return (
      <div className="text-center py-16 text-gray-500">
        <div className="text-4xl mb-3">📉</div>
        <div>No scalp setups match current filters</div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {items.map((sc, i) => {
        const { market } = sc;
        const price = market.targetPrice;
        const pmUrl = polymarketUrl(sc.eventSlug, sc.eventId);

        return (
          <div key={`${sc.eventId}-${market.id}-${i}`} className="bg-gray-900 border border-gray-800 hover:border-blue-500/30 rounded-xl p-4 transition-all hover:bg-gray-800/60">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  {sc.isCrypto && <span className="text-[10px] bg-orange-500/10 text-orange-400 border border-orange-500/20 px-1.5 py-0.5 rounded">₿ CRYPTO</span>}
                  {sc.isSports && <span className="text-[10px] bg-green-500/10 text-green-400 border border-green-500/20 px-1.5 py-0.5 rounded">🏆 SPORTS</span>}
                  <span className="text-xs text-gray-500 truncate">{sc.eventTitle}</span>
                </div>
                <div className="text-sm font-medium text-gray-100 line-clamp-2 leading-snug">
                  {market.question !== sc.eventTitle ? market.question : sc.eventTitle}
                </div>
              </div>
            </div>

            {/* Entry + targets */}
            <div className="flex gap-2 mb-3">
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-center min-w-[65px]">
                <div className="text-[10px] text-gray-400 mb-0.5">buy at</div>
                <div className="text-xl font-bold text-blue-400 font-mono leading-none">{(price * 100).toFixed(0)}¢</div>
                <div className="text-[10px] text-gray-500 mt-0.5">{market.targetOutcome}</div>
              </div>
              <div className="flex-1 grid grid-cols-2 gap-1.5">
                <div className="bg-green-500/5 border border-green-500/15 rounded-lg px-2 py-1.5 text-center">
                  <div className="text-[10px] text-gray-500">sell 2x</div>
                  <div className="text-sm font-bold text-green-400 font-mono">{(market.target2x * 100).toFixed(0)}¢</div>
                  <div className="text-[10px] text-green-500">+{market.roi2x.toFixed(0)}%</div>
                </div>
                <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-lg px-2 py-1.5 text-center">
                  <div className="text-[10px] text-gray-500">sell 3x</div>
                  <div className="text-sm font-bold text-emerald-400 font-mono">{(market.target3x * 100).toFixed(0)}¢</div>
                  <div className="text-[10px] text-emerald-500">+{market.roi3x.toFixed(0)}%</div>
                </div>
              </div>
            </div>

            {/* Momentum + stats */}
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <div className="flex-1 space-y-1">
                <div className="flex justify-between">
                  <span>24h move</span>
                  <span className={market.dayChange > 0 ? 'text-green-400 font-medium' : market.dayChange < 0 ? 'text-red-400' : 'text-gray-500'}>
                    {fmtPct(market.dayChange)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>7d move</span>
                  <span className={market.weekChange > 0 ? 'text-green-400' : market.weekChange < 0 ? 'text-red-400' : 'text-gray-500'}>
                    {fmtPct(market.weekChange)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Vol/Liq</span>
                  <span className="text-gray-300">{market.volLiqRatio.toFixed(2)}x</span>
                </div>
                <div className="flex justify-between">
                  <span>Vol 24h</span>
                  <span className="text-gray-300">{fmt(sc.eventVolume24hr)}</span>
                </div>
              </div>
            </div>

            {/* Links */}
            <div className="flex items-center gap-1.5 mt-3 flex-wrap">
              {sc.tags.slice(0, 2).map(t => (
                <span key={t.id} className="bg-gray-800 text-gray-500 text-[10px] px-1.5 py-0.5 rounded">{t.label}</span>
              ))}
              <div className="ml-auto flex gap-1.5">
                <Link href={`/events/${sc.eventId}`} className="text-[10px] text-blue-400 hover:underline">Details</Link>
                <span className="text-gray-700">·</span>
                <a href={pmUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-green-400 hover:underline">Polymarket ↗</a>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

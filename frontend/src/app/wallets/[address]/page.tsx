'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WalletPosition {
  marketId: string;
  eventSlug?: string;
  eventId?: string;
  title: string;
  outcome: 'YES' | 'NO';
  size: number;
  value: number;
  price: number;
  cashPnl?: number;
  percentPnl?: number;
  endDate?: string;
  category?: string;
}

interface WalletTrade {
  id?: string;
  marketId?: string;
  eventSlug?: string;
  eventId?: string;
  title: string;
  outcome: string;
  side: string;
  size: number;
  price: number;
  amount: number;
  timestamp: string;
}

interface WalletStats {
  totalPositions: number;
  totalValue: number;
  yesPositions: number;
  noPositions: number;
  yesPct: number;
  noPct: number;
  avgEntryPrice: number;
  avgPositionSize: number;
  categoryBreakdown: Record<string, { count: number; value: number }>;
  priceRangeBreakdown: { cheap: number; medium: number; expensive: number };
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

interface WalletProfile {
  address: string;
  userName?: string;
  rank?: string;
  pnl?: number;
  vol?: number;
  isWatched: boolean;
  label?: string;
  positions: WalletPosition[];
  recentTrades: WalletTrade[];
  stats: WalletStats;
  insights: string[];
  fetchedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt$ = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
};

const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function copyToClipboard(text: string, setCopied: (b: boolean) => void) {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  } catch {
    // ignore
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color = 'text-white' }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

function OutcomeBar({ yesPct, noPct }: { yesPct: number; noPct: number }) {
  return (
    <div className="flex rounded-full overflow-hidden h-3 bg-gray-800">
      <div
        className="bg-green-500 transition-all duration-500"
        style={{ width: `${yesPct}%` }}
        title={`YES: ${yesPct}%`}
      />
      <div
        className="bg-red-500 transition-all duration-500"
        style={{ width: `${noPct}%` }}
        title={`NO: ${noPct}%`}
      />
    </div>
  );
}

function PnlBadge({ value }: { value: number }) {
  const color = value > 0 ? 'text-green-400' : value < 0 ? 'text-red-400' : 'text-gray-400';
  return <span className={`font-mono text-sm ${color}`}>{fmt$(value)}</span>;
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
      outcome === 'YES' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
    }`}>
      {outcome}
    </span>
  );
}

function SideBadge({ side }: { side: string }) {
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
      side === 'BUY' ? 'bg-blue-500/20 text-blue-400' : 'bg-orange-500/20 text-orange-400'
    }`}>
      {side}
    </span>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function WalletProfilePage() {
  const params = useParams();
  const router = useRouter();
  const address = (params?.address as string) || '';

  const [profile, setProfile] = useState<WalletProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [labelEdit, setLabelEdit] = useState(false);
  const [labelInput, setLabelInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'positions' | 'trades' | 'analytics'>('positions');

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get(`/wallets/profile/${address}`);
      setProfile(data.data);
      setLabelInput(data.data.label || '');
    } catch (e: any) {
      setError(e.message || 'Failed to load wallet profile');
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { load(); }, [load]);

  const toggleWatch = async () => {
    if (!profile) return;
    setWatching(true);
    try {
      if (profile.isWatched) {
        await api.delete(`/wallets/watched/${address}`);
        setProfile(p => p ? { ...p, isWatched: false } : p);
      } else {
        await api.post('/wallets/watched', {
          address,
          label: labelInput || undefined,
          userName: profile.userName,
          pnl: profile.pnl,
          vol: profile.vol,
          rank: profile.rank,
        });
        setProfile(p => p ? { ...p, isWatched: true } : p);
      }
    } catch { /* ignore */ }
    setWatching(false);
  };

  const saveLabel = async () => {
    await api.post('/wallets/watched', {
      address,
      label: labelInput,
      userName: profile?.userName,
      pnl: profile?.pnl,
      vol: profile?.vol,
      rank: profile?.rank,
    });
    setProfile(p => p ? { ...p, label: labelInput } : p);
    setLabelEdit(false);
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-4 animate-pulse">
        <div className="h-8 bg-gray-800 rounded w-64" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-24 bg-gray-900 rounded-xl" />)}
        </div>
        <div className="h-64 bg-gray-900 rounded-xl" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="max-w-5xl mx-auto text-center py-20">
        <div className="text-4xl mb-3">⚠️</div>
        <div className="text-gray-400 mb-4">{error || 'Profile not found'}</div>
        <button onClick={() => router.back()} className="text-blue-400 hover:text-blue-300">← Go back</button>
      </div>
    );
  }

  const { stats } = profile;
  const totalPriceSlots = stats.priceRangeBreakdown.cheap + stats.priceRangeBreakdown.medium + stats.priceRangeBreakdown.expensive;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <button onClick={() => router.back()} className="text-gray-500 hover:text-gray-300 text-lg">←</button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">
                {profile.userName || (profile.label ? profile.label : shortAddr(address))}
              </h1>
              {profile.rank && <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-full">#{profile.rank}</span>}
              {profile.isWatched && <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full">★ Watching</span>}
            </div>
            {/* Address row */}
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs font-mono text-gray-500">{address}</span>
              <button
                onClick={() => copyToClipboard(address, setCopied)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 hover:bg-gray-700"
              >
                {copied ? '✓ copied' : '📋'}
              </button>
              <a
                href={`https://polymarket.com/profile/${address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-400 hover:bg-blue-800/40"
              >
                Polymarket ↗
              </a>
            </div>
            {/* Label edit */}
            {labelEdit ? (
              <div className="flex items-center gap-2 mt-2">
                <input
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white"
                  value={labelInput}
                  onChange={e => setLabelInput(e.target.value)}
                  placeholder="Custom label…"
                  autoFocus
                />
                <button onClick={saveLabel} className="text-xs bg-green-600 hover:bg-green-500 text-white px-3 py-1 rounded">Save</button>
                <button onClick={() => setLabelEdit(false)} className="text-xs text-gray-500">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setLabelEdit(true)} className="text-[10px] text-gray-600 hover:text-gray-400 mt-1">
                {profile.label ? `Label: "${profile.label}" (edit)` : '+ Add label'}
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={toggleWatch}
            disabled={watching}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              profile.isWatched
                ? 'bg-gray-800 text-gray-300 hover:bg-red-900/40 hover:text-red-400'
                : 'bg-yellow-600/20 border border-yellow-600/40 text-yellow-400 hover:bg-yellow-600/30'
            }`}
          >
            {watching ? '…' : profile.isWatched ? '★ Unwatch' : '☆ Watch'}
          </button>
          <button onClick={load} className="px-3 py-2 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700">
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Key stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Total PnL"
          value={profile.pnl != null ? fmt$(profile.pnl) : '—'}
          color={profile.pnl != null && profile.pnl > 0 ? 'text-green-400' : profile.pnl != null && profile.pnl < 0 ? 'text-red-400' : 'text-gray-400'}
        />
        <StatCard
          label="Volume"
          value={profile.vol != null ? fmt$(profile.vol) : '—'}
          sub="all time"
        />
        <StatCard
          label="Open Positions"
          value={stats.totalPositions.toString()}
          sub={`${fmt$(stats.totalValue)} total value`}
        />
        <StatCard
          label="Unrealized PnL"
          value={fmt$(stats.unrealizedPnl)}
          sub={fmtPct(stats.unrealizedPnlPct)}
          color={stats.unrealizedPnl > 0 ? 'text-green-400' : stats.unrealizedPnl < 0 ? 'text-red-400' : 'text-gray-400'}
        />
      </div>

      {/* Insights */}
      {profile.insights.length > 0 && (
        <div className="bg-blue-900/10 border border-blue-800/30 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-blue-400 mb-3">🧠 Wallet Intelligence</h3>
          <ul className="space-y-1.5">
            {profile.insights.map((ins, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                <span className="text-blue-500 mt-0.5 shrink-0">▸</span>
                {ins}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* YES/NO bar + category breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* YES/NO */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-400">YES / NO Bias</h3>
          <OutcomeBar yesPct={stats.yesPct} noPct={stats.noPct} />
          <div className="flex justify-between text-xs">
            <span className="text-green-400 font-mono">YES {stats.yesPct}% ({stats.yesPositions} pos)</span>
            <span className="text-red-400 font-mono">NO {stats.noPct}% ({stats.noPositions} pos)</span>
          </div>
          {/* Price range */}
          <div className="mt-2 pt-3 border-t border-gray-800">
            <div className="text-xs text-gray-500 mb-2">Entry price preference</div>
            <div className="space-y-1.5">
              {[
                { label: 'Cheap (<20¢)', count: stats.priceRangeBreakdown.cheap, color: 'bg-purple-500' },
                { label: 'Mid (20–60¢)', count: stats.priceRangeBreakdown.medium, color: 'bg-blue-500' },
                { label: 'Expensive (>60¢)', count: stats.priceRangeBreakdown.expensive, color: 'bg-orange-500' },
              ].map(row => (
                <div key={row.label} className="flex items-center gap-2">
                  <div className="text-[10px] text-gray-500 w-24 shrink-0">{row.label}</div>
                  <div className="flex-1 bg-gray-800 rounded-full h-2">
                    <div
                      className={`${row.color} h-2 rounded-full transition-all`}
                      style={{ width: `${totalPriceSlots > 0 ? (row.count / totalPriceSlots) * 100 : 0}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-gray-400 w-4 text-right">{row.count}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Category breakdown */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">Category Focus</h3>
          {Object.keys(stats.categoryBreakdown).length === 0 ? (
            <div className="text-xs text-gray-600">No position data</div>
          ) : (
            <div className="space-y-2">
              {Object.entries(stats.categoryBreakdown)
                .sort(([, a], [, b]) => b.value - a.value)
                .map(([cat, data]) => {
                  const maxVal = Math.max(...Object.values(stats.categoryBreakdown).map(d => d.value));
                  const pct = maxVal > 0 ? (data.value / maxVal) * 100 : 0;
                  return (
                    <div key={cat} className="flex items-center gap-2">
                      <div className="text-xs text-gray-400 w-24 shrink-0 truncate">{cat}</div>
                      <div className="flex-1 bg-gray-800 rounded-full h-2">
                        <div className="bg-cyan-500 h-2 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-[10px] text-gray-500 text-right">
                        {data.count} · {fmt$(data.value)}
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-800">
        <div className="flex gap-1">
          {(['positions', 'trades', 'analytics'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
                activeTab === tab
                  ? 'text-white border-b-2 border-blue-500'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab === 'positions' ? `Positions (${profile.positions.length})` : tab === 'trades' ? `Recent Trades (${profile.recentTrades.length})` : 'Analytics'}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'positions' && (
        <div className="space-y-2">
          {profile.positions.length === 0 ? (
            <div className="text-center py-12 text-gray-600">No open positions found</div>
          ) : (
            profile.positions
              .sort((a, b) => b.value - a.value)
              .map((pos, i) => {
                const directPath = pos.eventSlug || pos.eventId;
                const resolvePath = pos.marketId ? `/events/resolve/${encodeURIComponent(pos.marketId)}` : null;
                const href = directPath ? `/events/${directPath}` : resolvePath;
                const Wrapper = href ? Link : 'div';
                const wrapperProps = href ? { href } : {};
                return (
                  <Wrapper key={i} {...wrapperProps} className="block">
                    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-4 hover:border-cyan-500/40 hover:bg-gray-800/50 transition-all cursor-pointer">
                      <OutcomeBadge outcome={pos.outcome} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-white truncate">{pos.title}</div>
                        <div className="text-xs text-gray-500 mt-0.5 flex gap-2 items-center">
                          <span>{pos.category}</span>
                          {pos.endDate && <span>· ends {new Date(pos.endDate).toLocaleDateString()}</span>}
                          {href && (
                            <span className="text-cyan-400 font-medium">
                              {directPath ? '→ в событие' : '→ найти событие'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-mono text-white">{fmt$(pos.value)}</div>
                        <div className="text-xs text-gray-500">{(pos.price * 100).toFixed(1)}¢ · {pos.size.toFixed(0)} sh</div>
                        {pos.cashPnl != null && (
                          <div className={`text-xs font-mono mt-0.5 ${pos.cashPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {pos.cashPnl >= 0 ? '+' : ''}{fmt$(pos.cashPnl)} ({pos.percentPnl?.toFixed(1)}%)
                          </div>
                        )}
                      </div>
                    </div>
                  </Wrapper>
                );
              })
          )}
        </div>
      )}

      {activeTab === 'trades' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {profile.recentTrades.length === 0 ? (
            <div className="text-center py-12 text-gray-600">No recent trades</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500">
                  <th className="px-4 py-3 text-left">Market</th>
                  <th className="px-3 py-3 text-center">Side</th>
                  <th className="px-3 py-3 text-center">Outcome</th>
                  <th className="px-3 py-3 text-right">Price</th>
                  <th className="px-3 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-right">Time</th>
                  <th className="px-2 py-3 text-center w-16"></th>
                </tr>
              </thead>
              <tbody>
                {profile.recentTrades.map((t, i) => {
                  const directPath = t.eventSlug || t.eventId;
                  const resolvePath = t.marketId ? `/events/resolve/${encodeURIComponent(t.marketId)}` : null;
                  const href = directPath ? `/events/${directPath}` : resolvePath;
                  return (
                    <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors">
                      <td className="px-4 py-3">
                        <div className="text-sm text-white max-w-xs truncate">{t.title}</div>
                      </td>
                      <td className="px-3 py-3 text-center"><SideBadge side={t.side} /></td>
                      <td className="px-3 py-3 text-center"><OutcomeBadge outcome={t.outcome} /></td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-gray-300">{(t.price * 100).toFixed(1)}¢</td>
                      <td className="px-3 py-3 text-right font-mono text-sm text-white">{fmt$(t.amount)}</td>
                      <td className="px-4 py-3 text-right text-xs text-gray-500">
                        {new Date(t.timestamp).toLocaleDateString()}
                      </td>
                      <td className="px-2 py-3 text-center">
                        {href ? (
                          <Link href={href} className="text-cyan-400 hover:text-cyan-300 text-xs font-medium">
                            → событие
                          </Link>
                        ) : (
                          <span className="text-gray-600 text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === 'analytics' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <StatCard label="Avg Entry Price" value={`${(stats.avgEntryPrice * 100).toFixed(1)}¢`} />
            <StatCard label="Avg Position Size" value={fmt$(stats.avgPositionSize)} />
            <StatCard
              label="Strategy"
              value={
                stats.priceRangeBreakdown.cheap > stats.priceRangeBreakdown.medium &&
                stats.priceRangeBreakdown.cheap > stats.priceRangeBreakdown.expensive
                  ? 'Asymmetric' : stats.avgEntryPrice > 0.6 ? 'Favorite' : 'Balanced'
              }
            />
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-400 mb-3">How to Profit from This Wallet</h3>
            <div className="space-y-2 text-sm text-gray-300">
              {stats.yesPct >= 70 && (
                <p className="flex gap-2"><span className="text-green-400 shrink-0">▸</span>
                  Strongly bullish wallet — consider following YES bets on their positions if confidence score is high.
                </p>
              )}
              {stats.noPct >= 70 && (
                <p className="flex gap-2"><span className="text-blue-400 shrink-0">▸</span>
                  Contrarian wallet — they often fade consensus, best followed when entering NO on high-probability markets.
                </p>
              )}
              {stats.priceRangeBreakdown.cheap > (stats.totalPositions * 0.4) && (
                <p className="flex gap-2"><span className="text-purple-400 shrink-0">▸</span>
                  Asymmetric hunter — copies work best on cheap outcomes they hold (&lt;20¢). Wait for their entry, then follow quickly.
                </p>
              )}
              {stats.avgPositionSize > 5000 && (
                <p className="flex gap-2"><span className="text-yellow-400 shrink-0">▸</span>
                  Large conviction player — high position sizes suggest strong research backing. Copying with smaller size is lower risk.
                </p>
              )}
              <p className="flex gap-2"><span className="text-cyan-400 shrink-0">▸</span>
                Watch for new positions in <strong>{Object.keys(stats.categoryBreakdown)[0] || 'General'}</strong> — their specialty category.
              </p>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-400 mb-2">Quick Actions</h3>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={toggleWatch}
                className={`px-3 py-1.5 rounded text-sm ${
                  profile.isWatched
                    ? 'bg-red-900/30 text-red-400 hover:bg-red-900/50'
                    : 'bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30'
                }`}
              >
                {profile.isWatched ? '★ Unwatch wallet' : '☆ Watch wallet'}
              </button>
              <a
                href={`https://polymarket.com/profile/${address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 rounded text-sm bg-blue-900/30 text-blue-400 hover:bg-blue-800/40"
              >
                View on Polymarket ↗
              </a>
              <Link href="/wallets" className="px-3 py-1.5 rounded text-sm bg-gray-800 text-gray-400 hover:bg-gray-700">
                ← Back to leaderboard
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

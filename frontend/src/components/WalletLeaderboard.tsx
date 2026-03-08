'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';

interface Trader {
  rank: string;
  proxyWallet: string;
  proxy_wallet_address?: string;
  userName: string;
  xUsername?: string;
  verifiedBadge?: boolean;
  vol: number;
  pnl: number;
  profileImage?: string;
  positionsCount?: number;
  tradesCount?: number;
  avgTradeSize?: number;
  cacheStale?: boolean;
}

type Period = 'DAY' | 'WEEK' | 'MONTH' | 'ALL';
type OrderBy = 'PNL' | 'VOL';
type Category = 'OVERALL' | 'POLITICS' | 'SPORTS' | 'CRYPTO' | 'ECONOMICS' | 'FINANCE';

function fmt(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function shortAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr || '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  document.body.removeChild(ta);
  return Promise.resolve();
}

const PERIODS: { key: Period; label: string }[] = [
  { key: 'DAY',   label: '24h' },
  { key: 'WEEK',  label: '7d' },
  { key: 'MONTH', label: '30d' },
  { key: 'ALL',   label: 'All time' },
];

const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'OVERALL',   label: 'All' },
  { key: 'POLITICS',  label: 'Politics' },
  { key: 'CRYPTO',    label: 'Crypto' },
  { key: 'SPORTS',    label: 'Sports' },
  { key: 'ECONOMICS', label: 'Economy' },
  { key: 'FINANCE',   label: 'Finance' },
];

export default function WalletLeaderboard({ limit = 25 }: { limit?: number }) {
  const [traders, setTraders] = useState<Trader[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<Period>('ALL');
  const [orderBy, setOrderBy] = useState<OrderBy>('PNL');
  const [category, setCategory] = useState<Category>('OVERALL');
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  const [watchedAddrs, setWatchedAddrs] = useState<Set<string>>(new Set());
  const [watchingAddr, setWatchingAddr] = useState<string | null>(null);

  const loadWatched = useCallback(async () => {
    try {
      const res = await api.get('/wallets/watched');
      setWatchedAddrs(new Set((res.data as any[]).map((w: any) => w.address.toLowerCase())));
    } catch { /* non-critical */ }
  }, []);

  const fetchLeaderboard = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // enrich=1 → backend reads from local cache instantly, refreshes stale in background
      const res = await api.get('/leaderboard', {
        params: { limit, timePeriod: period, orderBy, category: category === 'OVERALL' ? undefined : category, enrich: '1' },
      });
      setTraders(res.data.traders || []);
    } catch {
      setError('Could not load leaderboard data from Polymarket');
    } finally {
      setLoading(false);
    }
  }, [limit, period, orderBy, category]);

  useEffect(() => {
    fetchLeaderboard();
    loadWatched();
  }, [fetchLeaderboard, loadWatched]);

  const handleCopy = async (addr: string) => {
    await copyToClipboard(addr);
    setCopiedAddr(addr);
    setTimeout(() => setCopiedAddr(null), 1500);
  };

  const toggleWatch = async (t: Trader) => {
    const addr = (t.proxyWallet || t.proxy_wallet_address || '').toLowerCase();
    if (!addr) return;
    setWatchingAddr(addr);
    try {
      if (watchedAddrs.has(addr)) {
        await api.delete(`/wallets/watched/${addr}`);
        setWatchedAddrs(prev => { const s = new Set(prev); s.delete(addr); return s; });
      } else {
        await api.post('/wallets/watched', {
          address: addr,
          userName: t.userName || undefined,
          pnl: t.pnl,
          vol: t.vol,
          rank: t.rank,
        });
        setWatchedAddrs(prev => new Set(prev).add(addr));
      }
    } catch { /* ignore */ }
    setWatchingAddr(null);
  };

  const walletAddr = (t: Trader) => t.proxyWallet || t.proxy_wallet_address || '';

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500 mr-1">Period:</span>
          {PERIODS.map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)}
              className={`px-3 py-1 rounded text-xs transition-colors ${period === p.key ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500 mr-1">Sort:</span>
          <button onClick={() => setOrderBy('PNL')}
            className={`px-3 py-1 rounded text-xs transition-colors ${orderBy === 'PNL' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
            By P&L
          </button>
          <button onClick={() => setOrderBy('VOL')}
            className={`px-3 py-1 rounded text-xs transition-colors ${orderBy === 'VOL' ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
            By Volume
          </button>
        </div>
      </div>

      {/* Category */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-xs text-gray-500 mr-1">Category:</span>
        {CATEGORIES.map(c => (
          <button key={c.key} onClick={() => setCategory(c.key)}
            className={`px-3 py-1 rounded text-xs transition-colors ${category === c.key ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
            {c.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400">{error}</div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-14 bg-gray-800 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : traders.length > 0 ? (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-800/40">
                <th className="px-4 py-3 text-left text-xs text-gray-500 font-medium w-10">#</th>
                <th className="px-4 py-3 text-left text-xs text-gray-500 font-medium">Trader</th>
                <th className="px-3 py-3 text-right text-xs text-gray-500 font-medium w-20">Сделок</th>
                <th className="px-3 py-3 text-right text-xs text-gray-500 font-medium w-20">Позиций</th>
                <th className="px-3 py-3 text-right text-xs text-gray-500 font-medium w-24">Ср. объём</th>
                <th className="px-4 py-3 text-right text-xs text-gray-500 font-medium w-28">P&L</th>
                <th className="px-4 py-3 text-right text-xs text-gray-500 font-medium w-24">Volume</th>
                <th className="px-4 py-3 text-right text-xs text-gray-500 font-medium w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {traders.map((t, i) => {
                const addr = walletAddr(t);
                const addrLower = addr.toLowerCase();
                const isWatched = watchedAddrs.has(addrLower);
                const isWatching = watchingAddr === addrLower;
                const displayName = t.userName || shortAddr(addr);
                const isTopThree = i < 3;
                const hasCached = t.tradesCount != null;

                return (
                  <tr key={addr || i} className="border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors group">
                    {/* Rank */}
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs font-bold ${
                        i === 0 ? 'text-yellow-400' :
                        i === 1 ? 'text-gray-300' :
                        i === 2 ? 'text-orange-400' :
                        'text-gray-600'
                      }`}>
                        {isTopThree ? ['🥇', '🥈', '🥉'][i] : `#${t.rank || i + 1}`}
                      </span>
                    </td>

                    {/* Trader name */}
                    <td className="px-4 py-3">
                      <div className="text-sm text-gray-200 font-medium flex items-center gap-1">
                        {displayName}
                        {t.verifiedBadge && <span className="text-blue-400 text-xs">✓</span>}
                        {isWatched && <span className="text-yellow-400 text-xs">★</span>}
                      </div>
                      {t.userName && (
                        <div className="text-[10px] font-mono text-gray-600">{shortAddr(addr)}</div>
                      )}
                    </td>

                    {/* Trades count */}
                    <td className="px-3 py-3 text-right font-mono text-xs">
                      {hasCached ? (
                        <span className="text-gray-300">{t.tradesCount}</span>
                      ) : (
                        <span className="text-gray-600 text-[10px]" title="Откройте карточку трейдера — данные сохранятся в кеш">—</span>
                      )}
                    </td>

                    {/* Positions count */}
                    <td className="px-3 py-3 text-right font-mono text-xs">
                      {hasCached ? (
                        <span className="text-gray-300">{t.positionsCount}</span>
                      ) : (
                        <span className="text-gray-600 text-[10px]">—</span>
                      )}
                    </td>

                    {/* Avg trade size */}
                    <td className="px-3 py-3 text-right font-mono text-xs">
                      {hasCached && t.avgTradeSize && t.avgTradeSize > 0 ? (
                        <span className="text-gray-300">{fmt(t.avgTradeSize)}</span>
                      ) : (
                        <span className="text-gray-600 text-[10px]">—</span>
                      )}
                    </td>

                    {/* P&L */}
                    <td className={`px-4 py-3 text-right font-mono text-sm font-bold ${t.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {t.pnl >= 0 ? '+' : ''}{fmt(t.pnl)}
                    </td>

                    {/* Volume */}
                    <td className="px-4 py-3 text-right font-mono text-xs text-gray-400">
                      {fmt(t.vol)}
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {addr && (
                          <>
                            <Link
                              href={`/wallets/${addr}`}
                              className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20"
                              title={t.cacheStale ? 'Данные устарели — кликните чтобы обновить' : 'Карточка трейдера'}
                            >
                              {t.cacheStale ? '↻ Card' : '📊 Card'}
                            </Link>
                            <a
                              href={`https://polymarket.com/profile/${addr}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[10px] px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20"
                            >
                              ↗
                            </a>
                            <button
                              onClick={() => toggleWatch(t)}
                              disabled={isWatching}
                              className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                                isWatched
                                  ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/30'
                                  : 'bg-gray-800 text-gray-400 hover:bg-yellow-500/20 hover:text-yellow-400'
                              }`}
                              title={isWatched ? 'Unwatch' : 'Watch wallet'}
                            >
                              {isWatching ? '…' : isWatched ? '★' : '☆'}
                            </button>
                            <button
                              onClick={() => handleCopy(addr)}
                              className="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 transition-colors"
                              title="Copy address"
                            >
                              {copiedAddr === addr ? '✓' : '📋'}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center py-10 text-gray-600 text-sm">No leaderboard data available</div>
      )}

      <div className="text-xs text-gray-700 text-center">
        Data from Polymarket · {period === 'ALL' ? 'All time' : period === 'DAY' ? 'Last 24h' : period === 'WEEK' ? 'Last 7 days' : 'Last 30 days'} · Sorted by {orderBy === 'PNL' ? 'profit' : 'volume'}
        <span className="ml-2 opacity-60">· Сделки/позиции из кеша (откройте 📊 Card чтобы заполнить)</span>
      </div>
    </div>
  );
}

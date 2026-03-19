'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import WalletLeaderboard from '@/components/WalletLeaderboard';
import SmartMoneyFeed from '@/components/SmartMoneyFeed';
import api from '@/lib/api';

interface WatchedWallet {
  id: string;
  address: string;
  label?: string;
  userName?: string;
  pnl?: number;
  vol?: number;
  rank?: string;
  addedAt: string;
}

interface ConvergenceWallet {
  address: string;
  userName?: string;
  rank?: string;
  outcome: string;
  value: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  eventSlug?: string;
}

interface ConvergenceMarket {
  marketId: string;
  title: string;
  category: string;
  eventSlug?: string;
  eventId?: string;
  wallets: ConvergenceWallet[];
  consensus: string;
  consensusPct: number;
  totalValue: number;
  walletCount: number;
  avgEntryPrice: number;
  endDate?: string;
  hoursToResolution?: number;
  currentYesPrice: number;
  currentNoPrice: number;
  currentConsensusPrice?: number;
  potentialRoiNow?: number;
}

interface WatchedConvergenceItem {
  id: string;
  marketId: string;
  title: string;
  eventSlug?: string;
  notes?: string;
  consensus?: string;
  walletCount?: number;
  avgEntryPrice?: number;
  addedAt: string;
}

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

function ConsensusBadge({ consensus }: { consensus: string }) {
  const upper = consensus.toUpperCase();
  const styles: Record<string, string> = {
    YES: 'bg-green-500/20 text-green-400 border-green-500/30',
    NO: 'bg-red-500/20 text-red-400 border-red-500/30',
    SPLIT: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  };
  const style = styles[upper] ?? 'bg-purple-500/20 text-purple-300 border-purple-500/30';
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${style}`}>
      {consensus}
    </span>
  );
}

function fmtTimeLeft(hours?: number): string {
  if (hours == null) return '—';
  if (hours < 1) return '<1h';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  if (rem === 0) return `${days}d`;
  return `${days}d ${rem}h`;
}

function fmtRoi(pct?: number): string {
  if (pct == null) return '—';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct}%`;
}

const CONV_MIN_VALUES = [
  { key: 100,  label: '>$100' },
  { key: 500,  label: '>$500' },
  { key: 1000, label: '>$1K' },
  { key: 5000, label: '>$5K' },
];

const CONV_SORT_OPTIONS = [
  { key: 'strongest', label: '🔥 Strongest consensus' },
  { key: 'volume',    label: '💰 Volume' },
  { key: 'roi',       label: '📈 ROI if now' },
  { key: 'time',      label: '⏰ Time to resolve' },
];

// ─── Convergence List Component (with sorting, filtering, bookmarks) ────────────

function ConvergenceList({
  markets,
  sort,
  hideResolved,
  watched,
  onWatch,
  onUnwatch,
}: {
  markets: ConvergenceMarket[];
  sort: 'strongest' | 'volume' | 'roi' | 'time';
  hideResolved: boolean;
  watched: WatchedConvergenceItem[];
  onWatch: (m: ConvergenceMarket) => void;
  onUnwatch: (id: string) => void;
}) {
  // Filter: hide near-resolved markets — any side at ≥95¢ means market is essentially done
  const filtered = hideResolved
    ? markets.filter(m => m.currentYesPrice < 0.95 && m.currentNoPrice < 0.95)
    : markets;

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    switch (sort) {
      case 'strongest':
        // Strong consensus first (100% > 70%), then by wallet count
        const strengthA = a.consensus === 'SPLIT' ? 0 : a.consensusPct;
        const strengthB = b.consensus === 'SPLIT' ? 0 : b.consensusPct;
        if (strengthB !== strengthA) return strengthB - strengthA;
        return b.walletCount - a.walletCount;
      case 'volume':
        return b.totalValue - a.totalValue;
      case 'roi':
        return (b.potentialRoiNow || 0) - (a.potentialRoiNow || 0);
      case 'time':
        // Soonest to resolve first (smaller hours = higher priority)
        const hoursA = a.hoursToResolution ?? Infinity;
        const hoursB = b.hoursToResolution ?? Infinity;
        return hoursA - hoursB;
      default:
        return 0;
    }
  });

  if (sorted.length === 0) {
    return (
      <div className="text-gray-600 text-sm py-4 text-center">
        {hideResolved ? 'No markets match filters. Try disabling "Hide >95¢".' : 'No convergence detected.'}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sorted.map((cm, i) => {
        const eventHref = cm.eventSlug ? `/events/${cm.eventSlug}` : cm.eventId ? `/events/${cm.eventId}` : null;
        const pmUrl = cm.eventSlug ? `https://polymarket.com/event/${cm.eventSlug}` : null;
        const isWatched = watched.some(w => w.marketId === cm.marketId);

        // Determine "hot" indicators
        const isHotConsensus = cm.consensus !== 'SPLIT' && cm.consensusPct >= 80;
        const roiVal = cm.potentialRoiNow || 0;
        const isHotRoi = roiVal > 50 && roiVal <= 300;  // exclude >300% — those are near-resolved risky bets
        const isHighRiskRoi = roiVal > 300;              // warn: very high ROI = near-resolved on opposite side
        const isHotTime = cm.hoursToResolution != null && cm.hoursToResolution < 48;

        return (
          <div key={cm.marketId} className={`bg-gray-800/50 rounded-xl p-3 border transition-all ${
            isHotConsensus ? 'border-purple-500/30 shadow-lg shadow-purple-900/10' : 'border-gray-700/30'
          }`}>
            {/* Title row with badges */}
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <div className="text-sm font-medium text-white leading-snug">{cm.title}</div>
                  {/* Hot badges */}
                  {isHotConsensus && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">🔥 Strong</span>}
                  {isHotRoi && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-300 border border-green-500/30">📈 {cm.potentialRoiNow}% ROI</span>}
                  {isHighRiskRoi && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/30">⚠️ {cm.potentialRoiNow}% HIGH RISK</span>}
                  {isHotTime && <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/30">⏰ {fmtTimeLeft(cm.hoursToResolution)}</span>}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] bg-gray-700/60 text-gray-400 px-1.5 py-0.5 rounded">{cm.category}</span>
                  <span className="text-[10px] text-gray-500">{cm.walletCount} wallets · {fmt(cm.totalValue)}</span>
                  {cm.avgEntryPrice > 0 && (
                    <span className="text-[10px] text-blue-400 font-mono">avg entry {(cm.avgEntryPrice * 100).toFixed(0)}¢</span>
                  )}
                  {/* Current market price */}
                  <span className="text-[10px] font-mono">
                    {cm.currentConsensusPrice != null && cm.consensus !== 'SPLIT' ? (
                      <span className="text-cyan-300">
                        {cm.consensus} {(cm.currentConsensusPrice * 100).toFixed(0)}¢
                      </span>
                    ) : (
                      <>
                        <span className="text-green-400">YES {(cm.currentYesPrice * 100).toFixed(0)}¢</span>
                        <span className="text-gray-600 mx-1">/</span>
                        <span className="text-red-400">NO {(cm.currentNoPrice * 100).toFixed(0)}¢</span>
                      </>
                    )}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <ConsensusBadge consensus={cm.consensus} />
                <span className="text-[10px] text-gray-500">{cm.consensusPct}%</span>
              </div>
            </div>

            {/* ROI & Time row (if applicable) */}
            {(cm.potentialRoiNow || cm.hoursToResolution != null) && (
              <div className="flex items-center gap-3 mb-2 bg-gray-900/30 rounded-lg px-2 py-1.5">
                {cm.potentialRoiNow ? (
                  <div className="text-xs">
                    <span className="text-gray-500">If enter now toward {cm.consensus}:</span>
                    <span className={`ml-1.5 font-bold ${cm.potentialRoiNow > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {fmtRoi(cm.potentialRoiNow)} ROI
                    </span>
                  </div>
                ) : null}
                {cm.hoursToResolution != null ? (
                  <div className="text-xs ml-auto">
                    <span className="text-gray-500">Resolves in:</span>
                    <span className={`ml-1.5 font-mono ${cm.hoursToResolution < 24 ? 'text-orange-400' : 'text-gray-300'}`}>
                      {fmtTimeLeft(cm.hoursToResolution)}
                    </span>
                  </div>
                ) : null}
              </div>
            )}

            {/* Wallet positions table */}
            <div className="space-y-1 mb-3">
              {cm.wallets.map((w, j) => {
                const upperOutcome = String(w.outcome).toUpperCase();
                const isBuyYes = upperOutcome === 'YES';
                const pnlPositive = w.pnl >= 0;
                // Calculate % return based on initial investment
                const invested = w.value - w.pnl; // approximate initial investment
                const pnlPct = invested > 0 ? Math.round((w.pnl / invested) * 100) : 0;
                return (
                  <div key={j} className="flex items-center gap-2 text-xs bg-gray-900/40 rounded px-2 py-1.5">
                    <span className={`shrink-0 font-bold text-[10px] px-1.5 py-0.5 rounded ${
                      upperOutcome === 'NO'
                        ? 'bg-red-500/20 text-red-400'
                        : 'bg-green-500/20 text-green-400'
                    }`}>
                      {upperOutcome === 'NO' ? '↓' : '↑'} {w.outcome}
                    </span>
                    <Link href={`/wallets/${w.address}`} className="font-medium text-gray-200 hover:text-blue-400 transition-colors truncate flex-1">
                      {w.userName || shortAddr(w.address)}
                      {w.rank && <span className="text-gray-600 ml-1 text-[10px]">#{w.rank}</span>}
                    </Link>
                    {w.entryPrice > 0 && w.currentPrice > 0 && (
                      <span className="text-gray-500 font-mono shrink-0 text-[10px]">
                        entry <span className="text-blue-400">{(w.entryPrice * 100).toFixed(0)}¢</span>
                        <span className="text-gray-600 mx-1">→</span>
                        <span className={w.currentPrice > w.entryPrice ? 'text-green-400' : 'text-red-400'}>
                          {(w.currentPrice * 100).toFixed(0)}¢
                        </span>
                      </span>
                    )}
                    <span className="text-gray-400 font-mono shrink-0">{fmt(w.value)}</span>
                    {w.pnl !== 0 && (
                      <span className={`font-mono shrink-0 text-[10px] ${pnlPositive ? 'text-green-400' : 'text-red-400'}`}>
                        {pnlPositive ? '+' : ''}{fmt(w.pnl)} ({pnlPositive ? '+' : ''}{pnlPct}%)
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Action links */}
            <div className="flex items-center gap-2">
              {eventHref && (
                <Link href={eventHref} className="text-[10px] px-2.5 py-1 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors">
                  🔍 Open Event
                </Link>
              )}
              {pmUrl && (
                <a href={pmUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] px-2.5 py-1 rounded-lg bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700 transition-colors">
                  ↗ Polymarket
                </a>
              )}
              {/* Bookmark button */}
              <button
                onClick={() => isWatched ? onUnwatch(cm.marketId) : onWatch(cm)}
                className={`ml-auto text-[10px] px-2.5 py-1 rounded-lg border transition-colors ${
                  isWatched
                    ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/20'
                    : 'bg-gray-800 text-gray-400 border-gray-700 hover:bg-gray-700'
                }`}
              >
                {isWatched ? '★ Saved' : '☆ Save'}
              </button>
              <span className="text-[10px] text-gray-600">#{i + 1}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function WalletsPage() {
  const [watched, setWatched] = useState<WatchedWallet[]>([]);
  const [convergence, setConvergence] = useState<ConvergenceMarket[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  const [showConvergence, setShowConvergence] = useState(false);
  const [convMinValue, setConvMinValue] = useState(100);
  const [convSort, setConvSort] = useState<'strongest' | 'volume' | 'roi' | 'time'>('strongest');
  const [hideResolved, setHideResolved] = useState(true);
  const [watchedConv, setWatchedConv] = useState<WatchedConvergenceItem[]>([]);
  const [convStats, setConvStats] = useState<{ total: number; resolved: number; wins: number; winRate: number; byConsensus: Record<string, { total: number; wins: number; winRate: number }> } | null>(null);

  const loadWatched = async () => {
    try {
      const res = await api.get('/wallets/watched');
      setWatched(res.data || []);
    } catch { /* ignore */ }
  };

  const loadWatchedConvergence = async () => {
    try {
      const res = await api.get('/wallets/convergence/watched');
      setWatchedConv(res.data || []);
    } catch { /* ignore */ }
  };

  const loadConvergenceStats = async () => {
    try {
      const res = await api.get('/wallets/convergence/stats');
      setConvStats(res.data || null);
    } catch { /* ignore */ }
  };

  const addWatchedConvergence = async (cm: ConvergenceMarket, notes?: string) => {
    try {
      await api.post('/wallets/convergence/watched', {
        marketId: cm.marketId,
        title: cm.title,
        eventSlug: cm.eventSlug,
        notes,
        consensus: cm.consensus,
        walletCount: cm.walletCount,
        avgEntryPrice: cm.avgEntryPrice,
      });
      await loadWatchedConvergence();
    } catch { /* ignore */ }
  };

  const removeWatchedConvergence = async (marketId: string) => {
    try {
      await api.delete(`/wallets/convergence/watched/${marketId}`);
      setWatchedConv(prev => prev.filter(w => w.marketId !== marketId));
    } catch { /* ignore */ }
  };

  const removeWatched = async (address: string) => {
    try {
      await api.delete(`/wallets/watched/${address}`);
      setWatched(prev => prev.filter(w => w.address !== address));
    } catch { /* ignore */ }
  };

  const loadConvergence = async (minValue = convMinValue) => {
    setConvLoading(true);
    try {
      const res = await api.get('/wallets/convergence', { params: { topN: 20, minValue } });
      setConvergence(res.data || []);
      setShowConvergence(true);
    } catch { /* ignore */ }
    setConvLoading(false);
  };

  useEffect(() => { loadWatched(); loadWatchedConvergence(); loadConvergenceStats(); }, []);

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Wallet Intelligence</h1>
        <p className="text-gray-400 text-sm mt-1">
          Track top traders, watch smart money, and detect market convergence signals.
        </p>
      </div>

      {/* Quick links */}
      <div className="flex flex-wrap gap-2">
        {[
          { href: '/whales', label: '🐋 Whale Feed', color: 'bg-blue-900/30 border-blue-800/40 text-blue-400' },
          { href: '/signals', label: '⚡ Signals', color: 'bg-green-900/30 border-green-800/40 text-green-400' },
          { href: '/anomalies', label: '🔍 Anomalies', color: 'bg-yellow-900/30 border-yellow-800/40 text-yellow-400' },
        ].map(link => (
          <Link key={link.href} href={link.href}
            className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-all hover:opacity-80 ${link.color}`}>
            {link.label}
          </Link>
        ))}
        <div className="flex items-center gap-1 flex-wrap">
          {CONV_MIN_VALUES.map(f => (
            <button
              key={f.key}
              onClick={() => {
                setConvMinValue(f.key);
                loadConvergence(f.key);
              }}
              disabled={convLoading}
              className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all disabled:opacity-50 ${
                convMinValue === f.key && showConvergence
                  ? 'border-purple-600/60 bg-purple-800/40 text-purple-300'
                  : 'border-purple-800/40 bg-purple-900/30 text-purple-400 hover:opacity-80'
              }`}
            >
              {convLoading && convMinValue === f.key ? '⏳' : '🔗'} {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Watched Wallets section */}
      {watched.length > 0 && (
        <div className="bg-gray-900 border border-yellow-800/30 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-yellow-400 flex items-center gap-2">
              ★ Watched Wallets <span className="text-xs text-gray-500 font-normal">({watched.length})</span>
            </h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {watched.map(w => (
              <div key={w.id} className="flex items-center justify-between gap-2 bg-gray-800/50 rounded-lg px-3 py-2">
                <Link href={`/wallets/${w.address}`} className="flex-1 min-w-0 hover:opacity-80 transition-opacity">
                  <div className="text-sm font-medium text-white truncate">
                    {w.label || w.userName || shortAddr(w.address)}
                  </div>
                  <div className="text-[10px] font-mono text-gray-600">{shortAddr(w.address)}</div>
                  {(w.pnl != null || w.vol != null) && (
                    <div className="text-xs mt-0.5 flex gap-2">
                      {w.pnl != null && (
                        <span className={w.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {w.pnl >= 0 ? '+' : ''}{fmt(w.pnl)} PnL
                        </span>
                      )}
                      {w.vol != null && <span className="text-gray-500">{fmt(w.vol)} vol</span>}
                    </div>
                  )}
                </Link>
                <div className="flex items-center gap-1 shrink-0">
                  <Link
                    href={`/wallets/${w.address}`}
                    className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20"
                  >
                    📊
                  </Link>
                  <button
                    onClick={() => removeWatched(w.address)}
                    className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20"
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Saved Convergence Bookmarks */}
      {watchedConv.length > 0 && (
        <div className="bg-gradient-to-r from-purple-900/20 to-blue-900/20 border border-purple-800/30 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-purple-300 flex items-center gap-2">
              🔖 Saved Convergence <span className="text-xs text-gray-500 font-normal">({watchedConv.length})</span>
            </h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {watchedConv.map(wc => (
              <div key={wc.id} className="flex items-center gap-2 bg-gray-800/60 rounded-lg px-3 py-2 border border-gray-700/50">
                <Link href={wc.eventSlug ? `/events/${wc.eventSlug}` : '#'} className="text-sm text-gray-200 hover:text-blue-400 transition-colors line-clamp-1 max-w-[200px]">
                  {wc.title}
                </Link>
                {wc.consensus && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    wc.consensus === 'YES' ? 'bg-green-500/20 text-green-400' :
                    wc.consensus === 'NO' ? 'bg-red-500/20 text-red-400' :
                    'bg-yellow-500/20 text-yellow-400'
                  }`}>
                    {wc.consensus}
                  </span>
                )}
                <button
                  onClick={() => removeWatchedConvergence(wc.marketId)}
                  className="text-gray-500 hover:text-red-400 text-xs"
                  title="Remove bookmark"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Convergence results */}
      {showConvergence && (
        <div className="bg-gray-900 border border-purple-800/30 rounded-xl p-4">
          {/* Header with controls */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-sm font-semibold text-purple-400 flex items-center gap-2">
                🔗 Convergence Markets
                <span className="text-xs text-gray-500 font-normal">
                  — {convergence.length} markets · min {fmt(convMinValue)}
                </span>
              </h2>
              {convStats && convStats.resolved > 0 && (
                <div className="flex items-center gap-3 mt-1 text-[10px]">
                  <span className="text-gray-400">
                    Win rate: <span className={convStats.winRate >= 60 ? 'text-green-400 font-bold' : convStats.winRate >= 40 ? 'text-yellow-400' : 'text-red-400'}>{convStats.winRate}%</span>
                    <span className="text-gray-600"> ({convStats.wins}/{convStats.resolved})</span>
                  </span>
                  {convStats.byConsensus?.YES && convStats.byConsensus.YES.total > 0 && (
                    <span className="text-gray-500">
                      YES: <span className={convStats.byConsensus.YES.winRate >= 60 ? 'text-green-400' : 'text-gray-400'}>{convStats.byConsensus.YES.winRate}%</span>
                    </span>
                  )}
                  {convStats.byConsensus?.NO && convStats.byConsensus.NO.total > 0 && (
                    <span className="text-gray-500">
                      NO: <span className={convStats.byConsensus.NO.winRate >= 60 ? 'text-green-400' : 'text-gray-400'}>{convStats.byConsensus.NO.winRate}%</span>
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Sort */}
              <select
                value={convSort}
                onChange={e => setConvSort(e.target.value as any)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-purple-500"
              >
                {CONV_SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              {/* Hide resolved toggle */}
              <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer bg-gray-800/50 px-2 py-1 rounded-lg border border-gray-700">
                <input type="checkbox" checked={hideResolved} onChange={e => setHideResolved(e.target.checked)} className="rounded" />
                Hide &gt;95¢
              </label>
              <button onClick={() => setShowConvergence(false)} className="text-gray-600 hover:text-gray-400 text-xs px-2">✕</button>
            </div>
          </div>

          {convergence.length === 0 ? (
            <div className="text-gray-600 text-sm py-4 text-center">
              No convergence detected with min ${convMinValue} positions. Try a lower threshold.
            </div>
          ) : (
            <ConvergenceList
              markets={convergence}
              sort={convSort}
              hideResolved={hideResolved}
              watched={watchedConv}
              onWatch={addWatchedConvergence}
              onUnwatch={removeWatchedConvergence}
            />
          )}
        </div>
      )}

      {/* Two-column layout: leaderboard + live feed */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-5 items-start">
        {/* LEFT: leaderboard */}
        <div className="space-y-4">
          {/* Strategy insight */}
          <div className="bg-gradient-to-r from-blue-900/20 to-purple-900/20 border border-blue-800/30 rounded-xl p-3">
            <p className="text-xs text-gray-400 leading-relaxed">
              <span className="text-white font-semibold">💡 Copy-trade:</span>{' '}
              Кликни <span className="text-cyan-400">📊 Card</span> — данные сохранятся в кеш и появятся в таблице.
              Используй <span className="text-purple-400">🔗 Convergence</span> чтобы найти рынки где несколько топ-кошельков ставят в одну сторону.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white mb-3">Top Traders Leaderboard</h2>
            <WalletLeaderboard limit={25} />
          </div>
        </div>

        {/* RIGHT: live activity feed */}
        <div className="xl:sticky xl:top-4">
          <SmartMoneyFeed />
        </div>
      </div>
    </div>
  );
}

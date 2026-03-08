'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import DemoTradeModal from '@/components/DemoTradeModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WhaleAlert {
  id: string;
  tradeId: string | null;
  walletAddress: string;
  walletName: string | null;
  marketId: string;
  eventId: string | null;
  eventTitle: string;
  marketQuestion: string;
  side: string;
  outcome: string;
  tradeType: string;
  amount: number;
  shares: number;
  price: number;
  pattern: string;
  significance: string;
  walletPnl: number | null;
  walletProfit: number | null;
  isTopTrader: boolean;
  tradedAt: string;
  detectedAt: string;
  hoursAgo?: number;
}

interface TraderSummary {
  address: string;
  name: string | null;
  count: number;
  totalVolume: number;
}

interface WhaleStats {
  total: number;
  today: number;
  topTraderCount: number;
  byPattern: Record<string, number>;
  biggestToday: WhaleAlert | null;
  lastScanAt: string | null;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtAddr(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function polymarketUrl(eventId?: string | null) {
  if (eventId) return `https://polymarket.com/event/${eventId}`;
  return 'https://polymarket.com';
}

function isRawAddress(name: string): boolean {
  return /^0x[0-9a-f]{10}/i.test(name);
}

function traderDisplay(alert: WhaleAlert): string {
  const name = alert.walletName;
  if (!name || isRawAddress(name)) return fmtAddr(alert.walletAddress);
  return name;
}

// ─── Pattern config ───────────────────────────────────────────────────────────

const PATTERN_CFG: Record<string, { icon: string; label: string; color: string; bg: string; desc: string }> = {
  LARGE_BET:    { icon: '🐋', label: 'Large Bet',    color: 'text-blue-400',   bg: 'bg-blue-500/10 border-blue-500/20',   desc: 'Single large position opened' },
  ACCUMULATION: { icon: '📈', label: 'Accumulation', color: 'text-green-400',  bg: 'bg-green-500/10 border-green-500/20', desc: 'Repeated buys building position' },
  EXIT:         { icon: '🚪', label: 'Exit',         color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20', desc: 'Wallet selling out position' },
  REVERSAL:     { icon: '🔄', label: 'Reversal',     color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/20', desc: 'Flipped to opposite side' },
};

const SIGNIFICANCE_CFG: Record<string, { label: string; color: string }> = {
  CRITICAL: { label: 'CRITICAL', color: 'text-red-400' },
  HIGH:     { label: 'HIGH',     color: 'text-yellow-400' },
};

// ─── Whale Card ───────────────────────────────────────────────────────────────

function WhaleCard({ alert, onCopy }: { alert: WhaleAlert; onCopy: (a: WhaleAlert) => void }) {
  const pcfg = PATTERN_CFG[alert.pattern] ?? PATTERN_CFG.LARGE_BET;
  const scfg = SIGNIFICANCE_CFG[alert.significance] ?? SIGNIFICANCE_CFG.HIGH;
  const isBuy = alert.tradeType === 'BUY';
  const pmUrl = polymarketUrl(alert.eventId);
  const name = traderDisplay(alert);

  return (
    <div className={`bg-gray-900 border rounded-xl p-4 transition-all hover:bg-gray-800/60 ${
      alert.significance === 'CRITICAL' ? 'border-red-500/30' : 'border-gray-800'
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] px-2 py-0.5 rounded border font-medium ${pcfg.bg} ${pcfg.color}`}>
            {pcfg.icon} {pcfg.label}
          </span>
          <span className={`text-[10px] font-bold ${scfg.color}`}>{scfg.label}</span>
          {alert.isTopTrader && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 font-medium">
              ⭐ TOP
            </span>
          )}
        </div>
        <span className="text-xs text-gray-500 shrink-0">{fmtAge(alert.tradedAt)}</span>
      </div>

      {/* Market */}
      <div className="mb-3">
        <div className="text-xs text-gray-500 truncate mb-0.5">{alert.eventTitle}</div>
        <div className="text-sm font-medium text-gray-100 line-clamp-2 leading-snug">{alert.marketQuestion || alert.eventTitle}</div>
      </div>

      {/* Trade details */}
      <div className="flex items-center gap-3 mb-3">
        <div className={`shrink-0 px-3 py-2 rounded-lg text-center ${
          isBuy
            ? 'bg-green-500/10 border border-green-500/20'
            : 'bg-red-500/10 border border-red-500/20'
        }`}>
          <div className={`text-xs font-bold ${isBuy ? 'text-green-400' : 'text-red-400'}`}>
            {isBuy ? '▲ BUY' : '▼ SELL'}
          </div>
          <div className={`text-lg font-bold font-mono ${isBuy ? 'text-green-300' : 'text-red-300'}`}>
            {alert.outcome}
          </div>
        </div>

        <div className="flex-1 grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-[10px] text-gray-500">Size</div>
            <div className="text-base font-bold text-white">{fmt(alert.amount)}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">Price</div>
            <div className="text-base font-bold text-gray-200 font-mono">{(alert.price * 100).toFixed(0)}¢</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500">Shares</div>
            <div className="text-base font-bold text-gray-200 font-mono">
              {alert.shares >= 1000 ? `${(alert.shares / 1000).toFixed(1)}K` : alert.shares.toFixed(0)}
            </div>
          </div>
        </div>
      </div>

      {/* Trader row */}
      <div className="flex items-center gap-2 mb-3 text-xs">
        <span className="text-gray-500">Trader:</span>
        <Link
          href={`/wallets/${alert.walletAddress}`}
          className="font-medium text-blue-400 hover:text-blue-300 transition-colors"
        >
          {name}
        </Link>
        {alert.walletName && (
          <span className="text-gray-600 font-mono">{fmtAddr(alert.walletAddress)}</span>
        )}
        {alert.walletPnl !== null && (
          <span className={`ml-auto font-medium ${alert.walletPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            P&L: {fmt(alert.walletPnl)}
          </span>
        )}
      </div>

      {/* Timing */}
      {alert.hoursAgo != null && (
        <div className="text-[10px] text-gray-500 mb-2">
          Entered <span className={`font-medium ${alert.hoursAgo < 24 ? 'text-orange-400' : alert.hoursAgo < 168 ? 'text-yellow-400' : 'text-gray-400'}`}>
            {alert.hoursAgo < 24 ? `${alert.hoursAgo.toFixed(0)}h ago` : `${(alert.hoursAgo / 24).toFixed(0)}d ago`}
          </span>
          {alert.hoursAgo < 24 && <span className="ml-1 text-orange-400/60">(recent entry)</span>}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2 border-t border-gray-800">
        <button
          onClick={() => onCopy(alert)}
          className="flex-1 text-xs py-1.5 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors"
        >
          📋 Copy Trade
        </button>
        <a
          href={pmUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 text-xs py-1.5 rounded-lg bg-gray-800 text-gray-400 hover:bg-gray-700 transition-colors text-center"
        >
          ↗ Polymarket
        </a>
        {alert.eventId && (
          <Link
            href={`/events/${alert.eventId}`}
            className="flex-1 text-xs py-1.5 rounded-lg bg-gray-800 text-gray-400 hover:bg-gray-700 transition-colors text-center"
          >
            🔍 Event
          </Link>
        )}
      </div>
    </div>
  );
}

// ─── Grouped trader section ───────────────────────────────────────────────────

function TraderGroup({ trader, alerts, onCopy }: {
  trader: TraderSummary;
  alerts: WhaleAlert[];
  onCopy: (a: WhaleAlert) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const name = (trader.name && !isRawAddress(trader.name)) ? trader.name : fmtAddr(trader.address);

  return (
    <div className="bg-gray-900/50 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-base">{alerts.some(a => a.isTopTrader) ? '⭐' : '🐋'}</span>
          <div className="text-left">
            <Link
              href={`/wallets/${trader.address}`}
              onClick={e => e.stopPropagation()}
              className="font-semibold text-white hover:text-blue-400 transition-colors"
            >
              {name}
            </Link>
            {trader.name && (
              <div className="text-[10px] text-gray-600 font-mono">{fmtAddr(trader.address)}</div>
            )}
          </div>
        </div>
          <div className="flex items-center gap-4 text-right">
          <div>
            <div className="text-xs text-gray-500">Trades</div>
            <div className="text-sm font-bold text-white">{trader.count}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Volume</div>
            <div className="text-sm font-bold text-yellow-400">{fmt(trader.totalVolume)}</div>
          </div>
          {alerts[0] && (
            <div className="hidden sm:block">
              <div className="text-xs text-gray-500">Latest</div>
              <div className="text-xs text-gray-400">{fmtAge(alerts[0].tradedAt)}</div>
            </div>
          )}
          <span className="text-gray-600 text-sm">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>
      {expanded && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 pt-0">
          {alerts.map(a => (
            <WhaleCard key={a.id} alert={a} onCopy={onCopy} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Filters ─────────────────────────────────────────────────────────────────

const PATTERN_FILTERS = [
  { key: 'all',         label: 'All' },
  { key: 'LARGE_BET',   label: '🐋 Large' },
  { key: 'ACCUMULATION',label: '📈 Accum.' },
  { key: 'EXIT',        label: '🚪 Exits' },
  { key: 'REVERSAL',    label: '🔄 Reversal' },
];

const SIZE_FILTERS = [
  { key: 10000,  label: '>$10K' },
  { key: 25000,  label: '>$25K' },
  { key: 50000,  label: '>$50K' },
  { key: 100000, label: '>$100K' },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WhalesPage() {
  const [alerts, setAlerts] = useState<WhaleAlert[]>([]);
  const [traders, setTraders] = useState<TraderSummary[]>([]);
  const [stats, setStats] = useState<WhaleStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [patternFilter, setPatternFilter] = useState('all');
  const [minAmount, setMinAmount] = useState(10000);
  const [topOnly, setTopOnly] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState<string>('all');
  const [groupByTrader, setGroupByTrader] = useState(true);
  const [tradeAlert, setTradeAlert] = useState<WhaleAlert | null>(null);
  const [tradeSuccess, setTradeSuccess] = useState<string | null>(null);
  const [walletInput, setWalletInput] = useState('');
  const [walletScanning, setWalletScanning] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [feedRes, statsRes] = await Promise.all([
        api.get('/whales/feed', { params: {
          limit: 100,
          minAmount,
          pattern: patternFilter !== 'all' ? patternFilter : undefined,
          topTraders: topOnly || undefined,
        }}),
        api.get('/whales/stats'),
      ]);
      setAlerts(Array.isArray(feedRes.data?.alerts) ? feedRes.data.alerts : []);
      setTraders(Array.isArray(feedRes.data?.traders) ? feedRes.data.traders : []);
      setStats(statsRes.data && typeof statsRes.data === 'object' ? statsRes.data : null);
    } catch {
      setAlerts([]);
      setTraders([]);
      setStats(null);
    }
  }, [minAmount, patternFilter, topOnly]);

  useEffect(() => {
    setLoading(true);
    const autoLoad = async () => {
      try {
        const statsRes = await api.get('/whales/stats');
        const s = statsRes.data;
        const lastScan = s?.lastScanAt ? new Date(s.lastScanAt).getTime() : 0;
        const stale = Date.now() - lastScan > 10 * 60 * 1000;
        if (stale || s?.total === 0) {
          setScanning(true);
          await api.post('/whales/scan').catch(() => {});
          setScanning(false);
        }
      } catch {}
      await fetchData();
    };
    autoLoad().finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    const t = setInterval(fetchData, 2 * 60 * 1000);
    return () => clearInterval(t);
  }, [fetchData]);

  const handleScan = async () => {
    setScanning(true);
    try { await api.post('/whales/scan'); await fetchData(); } catch {}
    finally { setScanning(false); }
  };

  const handleWalletScan = async () => {
    if (!walletInput.trim()) return;
    setWalletScanning(true);
    try { await api.post(`/whales/wallet/${walletInput.trim()}/scan`); await fetchData(); } catch {}
    finally { setWalletScanning(false); }
  };

  // Filter alerts client-side by selected wallet
  const filteredAlerts = useMemo(() =>
    selectedWallet === 'all'
      ? alerts
      : alerts.filter(a => a.walletAddress === selectedWallet),
    [alerts, selectedWallet]
  );

  // Sort alerts newest first
  const sortedAlerts = useMemo(() =>
    [...filteredAlerts].sort((a, b) => new Date(b.tradedAt).getTime() - new Date(a.tradedAt).getTime()),
    [filteredAlerts]
  );

  // Group filtered alerts by trader, groups sorted by most recent trade
  const groupedByTrader = useMemo(() => {
    const map = new Map<string, WhaleAlert[]>();
    for (const a of sortedAlerts) {
      if (!map.has(a.walletAddress)) map.set(a.walletAddress, []);
      map.get(a.walletAddress)!.push(a);
    }
    // Each group's alerts are already newest-first (inherited from sortedAlerts order)
    // Sort groups by their latest trade timestamp
    return [...map.entries()]
      .map(([addr, items]) => ({
        trader: traders.find(t => t.address === addr) ?? {
          address: addr,
          name: items[0]?.walletName ?? null,
          count: items.length,
          totalVolume: items.reduce((s, a) => s + a.amount, 0),
        },
        alerts: items,
        latestAt: new Date(items[0].tradedAt).getTime(),
      }))
      .sort((a, b) => b.latestAt - a.latestAt);
  }, [sortedAlerts, traders]);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-3xl">🐋</span>
            <h1 className="text-2xl font-bold text-white">Whale Tracker</h1>
          </div>
          <p className="text-gray-400 text-sm">
            Live feed of Polymarket trades larger than $10,000. Follow smart money before the crowd.
          </p>
        </div>
        <button
          onClick={handleScan}
          disabled={scanning}
          className="px-4 py-2 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {scanning ? '🔍 Scanning...' : '↻ Scan Now'}
        </button>
      </div>

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <div className="text-xs text-gray-500 mb-1">Today</div>
            <div className="text-2xl font-bold text-white">{stats.today}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <div className="text-xs text-gray-500 mb-1">Total Tracked</div>
            <div className="text-2xl font-bold text-white">{stats.total}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <div className="text-xs text-gray-500 mb-1">Traders</div>
            <div className="text-2xl font-bold text-blue-400">{traders.length}</div>
          </div>
          {stats.biggestToday && (
            <div className="bg-gray-900 border border-red-500/20 rounded-xl p-3 text-center">
              <div className="text-xs text-gray-500 mb-1">Biggest Trade</div>
              <div className="text-xl font-bold text-red-400">{fmt(stats.biggestToday.amount)}</div>
              <div className="text-[10px] text-gray-600 truncate">{stats.biggestToday.walletName ?? fmtAddr(stats.biggestToday.walletAddress)}</div>
            </div>
          )}
        </div>
      )}

      {/* Trader filter pills */}
      {traders.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 mb-2 font-medium">Filter by trader</div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setSelectedWallet('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                selectedWallet === 'all'
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              All traders
              <span className="ml-1.5 text-gray-500">{alerts.length}</span>
            </button>
            {traders.map(t => {
              const name = (t.name && !isRawAddress(t.name)) ? t.name : fmtAddr(t.address);
              const isActive = selectedWallet === t.address;
              const traderAlerts = alerts.filter(a => a.walletAddress === t.address);
              const isTopTrader = traderAlerts.some(a => a.isTopTrader);
              return (
                <button
                  key={t.address}
                  onClick={() => setSelectedWallet(isActive ? 'all' : t.address)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                    isActive
                      ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  {isTopTrader && <span>⭐</span>}
                  <span>{name}</span>
                  <span className={`${isActive ? 'text-yellow-500' : 'text-gray-600'}`}>{t.count}</span>
                  <span className={`font-mono ${isActive ? 'text-yellow-400' : 'text-gray-500'}`}>{fmt(t.totalVolume)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Controls row */}
      <div className="flex items-center gap-3 flex-wrap text-sm">
        {/* Pattern */}
        <div className="flex items-center gap-1">
          {PATTERN_FILTERS.map(f => (
            <button key={f.key} onClick={() => setPatternFilter(f.key)}
              className={`px-2.5 py-1 rounded text-xs transition-colors ${
                patternFilter === f.key
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}>{f.label}</button>
          ))}
        </div>
        {/* Size */}
        <div className="flex items-center gap-1">
          {SIZE_FILTERS.map(f => (
            <button key={f.key} onClick={() => setMinAmount(f.key)}
              className={`px-2.5 py-1 rounded text-xs transition-colors ${
                minAmount === f.key
                  ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}>{f.label}</button>
          ))}
        </div>
        {/* Top only */}
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
          <input type="checkbox" checked={topOnly} onChange={e => setTopOnly(e.target.checked)} className="rounded" />
          ⭐ Top traders only
        </label>
        {/* Group toggle */}
        <button
          onClick={() => setGroupByTrader(g => !g)}
          className={`ml-auto px-3 py-1 rounded text-xs transition-colors ${
            groupByTrader
              ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          {groupByTrader ? '👤 Grouped' : '📋 List'}
        </button>
        {!loading && (
          <span className="text-xs text-gray-600">{sortedAlerts.length} trades</span>
        )}
      </div>

      {/* Wallet scanner */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="text-sm font-medium text-gray-300 mb-3">Track specific wallet</div>
        <div className="flex gap-2">
          <input
            value={walletInput}
            onChange={e => setWalletInput(e.target.value)}
            placeholder="0x wallet address..."
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleWalletScan}
            disabled={walletScanning || !walletInput.trim()}
            className="px-4 py-2 rounded-lg text-sm bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 disabled:opacity-50 transition-colors"
          >
            {walletScanning ? 'Scanning...' : 'Scan Wallet'}
          </button>
        </div>
      </div>

      {/* Trade success */}
      {tradeSuccess && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 text-sm px-4 py-3 rounded-xl flex justify-between">
          <span>{tradeSuccess}</span>
          <button onClick={() => setTradeSuccess(null)}>×</button>
        </div>
      )}

      {/* Feed */}
      {loading || scanning ? (
        <div className="space-y-4">
          <div className="text-xs text-gray-500 text-center">
            {scanning ? '🔍 Scanning top traders for whale activity...' : 'Loading...'}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 animate-pulse h-52" />
            ))}
          </div>
        </div>
      ) : sortedAlerts.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <div className="text-4xl mb-3">🐋</div>
          <div className="mb-2">No whale trades found</div>
          <div className="text-xs text-gray-600 mb-4">
            {selectedWallet !== 'all'
              ? 'No trades from this trader with current filters.'
              : 'Click "Scan Now" to fetch the latest large trades from Polymarket.'}
          </div>
          {selectedWallet !== 'all' ? (
            <button onClick={() => setSelectedWallet('all')} className="px-4 py-2 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700">
              Show all traders
            </button>
          ) : (
            <button onClick={handleScan} disabled={scanning}
              className="px-6 py-2 rounded-lg text-sm bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 transition-colors">
              {scanning ? 'Scanning...' : 'Scan Now'}
            </button>
          )}
        </div>
      ) : groupByTrader ? (
        <div className="space-y-4">
          {groupedByTrader.map(({ trader, alerts: groupAlerts }) => (
            <TraderGroup key={trader.address} trader={trader} alerts={groupAlerts} onCopy={setTradeAlert} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sortedAlerts.map(a => (
            <WhaleCard key={a.id} alert={a} onCopy={setTradeAlert} />
          ))}
        </div>
      )}

      {/* Copy Trade Modal */}
      {tradeAlert && (
        <DemoTradeModal
          eventId={tradeAlert.eventId ?? tradeAlert.marketId}
          eventTitle={tradeAlert.eventTitle}
          marketId={tradeAlert.marketId}
          marketQuestion={tradeAlert.marketQuestion}
          prices={[tradeAlert.price, 1 - tradeAlert.price]}
          outcomes={['Yes', 'No']}
          tags={[]}
          onClose={() => setTradeAlert(null)}
          onSuccess={(trade, newBal) => {
            setTradeAlert(null);
            setTradeSuccess(`Copied: ${trade.outcome} on "${tradeAlert.marketQuestion}" — $${trade.amount.toFixed(0)}. Balance: $${newBal.toFixed(0)}`);
          }}
        />
      )}
    </div>
  );
}

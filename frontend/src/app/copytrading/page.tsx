'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/lib/api';

const PAGE_SIZE = 30;

interface CopyWallet {
  id: string;
  walletAddress: string;
  label: string | null;
  amountPerTrade: number;
  minOrderShares: number;
  copyScale: number;
  takeProfitEnabled: boolean;
  takeProfitRoiPercent: number;
  takeProfitClosePercent: number;
  takeProfitFallbackPrice: number;
  staleExitEnabled: boolean;
  staleExitDays: number;
  staleExitLossPct: number;
  preCloseExitHours: number;
  enabled: boolean;
  mode: 'demo' | 'live';
  lastCheckedAt: string | null;
  createdAt: string;
}

interface ClobStatus {
  ready: boolean;
  error: string | null;
}

interface Stats {
  totalCopied: number;
  totalSkipped: number;
  todayCopied: number;
  totalPnl: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number | null;
  invested?: number;
  unrealizedPnl?: number;
  openPositions?: number;
}

interface PerWalletStats {
  walletAddress: string;
  totalCopied: number;
  open: number;
  totalPnl: number;
  unrealizedPnl: number;
}

interface CopyLog {
  id: string;
  walletAddress: string;
  action: 'BUY' | 'SELL';
  marketId: string;
  marketTitle: string;
  outcome: string;
  sourcePrice: number;
  copyPrice: number;
  amount: number;
  demoTradeId: string | null;
  status: string;
  skipReason: string | null;
  copiedAt: string;
}

interface LivePosition {
  id: string;
  marketTitle: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  status: string;
  entryPrice: number;
  currentPrice: number | null;
  size: number;
  invested: number;
  pnl: number | null;
  roi: number | null;
  sourceWalletAddress: string | null;
  tokenId: string | null;
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
  errorMessage: string | null;
}

interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

function fmt(n: number) {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function shortAddr(addr: string) {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

const POSITION_TABS = ['open', 'closed', 'all'] as const;
type PositionTab = (typeof POSITION_TABS)[number];

export default function CopyTradingPage() {
  const [wallets, setWallets] = useState<CopyWallet[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [perWalletStats, setPerWalletStats] = useState<PerWalletStats[]>([]);
  const [logs, setLogs] = useState<CopyLog[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [logPage, setLogPage] = useState(0);
  const [positions, setPositions] = useState<LivePosition[]>([]);
  const [posTotal, setPosTotal] = useState(0);
  const [posPage, setPosPage] = useState(0);
  const [positionTab, setPositionTab] = useState<PositionTab>('open');
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [reconcileLoading, setReconcileLoading] = useState(false);
  const [reconcileData, setReconcileData] = useState<{
    tradingUser?: string;
    reconcileNote?: string;
    desynced: { asset: string; realSize: number; marketTitle?: string; outcome?: string }[];
    ghostCandidates: { marketTitle: string; tokenId: string; dbSize: number }[];
    realPositionsCount: number;
    meaningfulPositionsCount?: number;
    dbOpenBuysCount: number;
  } | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [collapsedPositionSources, setCollapsedPositionSources] = useState<Record<string, boolean>>({});
  const [clobStatus, setClobStatus] = useState<ClobStatus | null>(null);

  const [globalMinPrice, setGlobalMinPrice] = useState('0.004');
  const [globalMaxPrice, setGlobalMaxPrice] = useState('0.95');
  const [savingSettings, setSavingSettings] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [addAddr, setAddAddr] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [addAmount, setAddAmount] = useState('1');
  const [addMinShares, setAddMinShares] = useState('5');
  const [addCopyScale, setAddCopyScale] = useState('1');
  const [addMode, setAddMode] = useState<'demo' | 'live'>('demo');
  const [addTakeProfitEnabled, setAddTakeProfitEnabled] = useState(false);
  const [addTakeProfitRoi, setAddTakeProfitRoi] = useState('150');
  const [addTakeProfitClose, setAddTakeProfitClose] = useState('40');
  const [addTakeProfitFallback, setAddTakeProfitFallback] = useState('0.80');
  const [addStaleExitEnabled, setAddStaleExitEnabled] = useState(true);
  const [addStaleExitDays, setAddStaleExitDays] = useState('7');
  const [addStaleExitLossPct, setAddStaleExitLossPct] = useState('70');
  const [addPreCloseHours, setAddPreCloseHours] = useState('3');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editMinShares, setEditMinShares] = useState('5');
  const [editCopyScale, setEditCopyScale] = useState('1');
  const [editTakeProfitEnabled, setEditTakeProfitEnabled] = useState(false);
  const [editTakeProfitRoi, setEditTakeProfitRoi] = useState('150');
  const [editTakeProfitClose, setEditTakeProfitClose] = useState('40');
  const [editTakeProfitFallback, setEditTakeProfitFallback] = useState('0.80');
  const [editStaleExitEnabled, setEditStaleExitEnabled] = useState(true);
  const [editStaleExitDays, setEditStaleExitDays] = useState('7');
  const [editStaleExitLossPct, setEditStaleExitLossPct] = useState('70');
  const [editPreCloseHours, setEditPreCloseHours] = useState('3');

  const posStatusParam = positionTab === 'open' ? 'open' : positionTab === 'closed' ? 'closed' : 'all';

  const loadAll = useCallback(async () => {
    try {
      const walletQ = selectedWallet ? `?wallet=${selectedWallet}` : '';
      const posParams = new URLSearchParams({ status: posStatusParam, limit: String(PAGE_SIZE), offset: String(posPage * PAGE_SIZE) });
      if (selectedWallet) posParams.set('wallet', selectedWallet);
      const logParams = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(logPage * PAGE_SIZE) });
      if (selectedWallet) logParams.set('wallet', selectedWallet);

      const [wRes, sRes, pwRes, lRes, pRes, cRes, gRes] = await Promise.allSettled([
        api.get('/copytrading/wallets'),
        api.get('/copytrading/stats' + walletQ),
        api.get('/copytrading/live-stats'),
        api.get(`/copytrading/logs?${logParams}`),
        api.get(`/copytrading/live-positions?${posParams}`),
        api.get('/copytrading/clob-status'),
        api.get('/copytrading/settings'),
      ]);
      if (wRes.status === 'fulfilled') setWallets(wRes.value.data);
      if (sRes.status === 'fulfilled') setStats(sRes.value.data);
      if (pwRes.status === 'fulfilled') setPerWalletStats(pwRes.value.data);
      if (gRes.status === 'fulfilled') {
        const g = gRes.value.data;
        setGlobalMinPrice(String(g.minCopyPrice ?? 0.004));
        setGlobalMaxPrice(String(g.maxCopyPrice ?? 0.95));
      }
      if (lRes.status === 'fulfilled') {
        const d = lRes.value.data as Paginated<CopyLog>;
        setLogs(d.items);
        setLogTotal(d.total);
      }
      if (pRes.status === 'fulfilled') {
        const d = pRes.value.data as Paginated<LivePosition>;
        setPositions(d.items);
        setPosTotal(d.total);
      }
      if (cRes.status === 'fulfilled') setClobStatus(cRes.value.data);
      setLastUpdated(new Date());
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [selectedWallet, posPage, logPage, posStatusParam]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const refreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    refreshInterval.current = setInterval(loadAll, 30_000);
    return () => { if (refreshInterval.current) clearInterval(refreshInterval.current); };
  }, [loadAll]);

  async function addWallet() {
    const addr = addAddr.trim();
    if (!addr) return;
    setAdding(true);
    setAddError(null);
    try {
      await api.post('/copytrading/wallets', {
        walletAddress: addr,
        label: addLabel.trim() || undefined,
        amountPerTrade: parseFloat(addAmount) || 1,
        minOrderShares: Math.max(5, parseInt(addMinShares, 10) || 5),
        copyScale: Math.max(0.01, parseFloat(addCopyScale) || 1),
        takeProfitEnabled: addTakeProfitEnabled,
        takeProfitRoiPercent: parseFloat(addTakeProfitRoi) || 150,
        takeProfitClosePercent: parseFloat(addTakeProfitClose) || 40,
        takeProfitFallbackPrice: parseFloat(addTakeProfitFallback) || 0.80,
        staleExitEnabled: addStaleExitEnabled,
        staleExitDays: parseInt(addStaleExitDays) || 7,
        staleExitLossPct: parseFloat(addStaleExitLossPct) || 70,
        preCloseExitHours: parseInt(addPreCloseHours) || 3,
        enabled: true,
        mode: addMode,
      });
      setAddAddr(''); setAddLabel(''); setAddAmount('1'); setAddMinShares('5'); setAddCopyScale('1'); setAddMode('demo');
      setAddTakeProfitEnabled(false); setAddTakeProfitRoi('150'); setAddTakeProfitClose('40');
      setAddStaleExitEnabled(true); setAddStaleExitDays('7'); setAddStaleExitLossPct('70'); setAddPreCloseHours('3');
      setShowAddWallet(false);
      await loadAll();
    } catch (e: any) {
      setAddError(e.response?.data?.error || e.message);
    } finally { setAdding(false); }
  }

  async function toggleWallet(w: CopyWallet) {
    try { await api.patch(`/copytrading/wallets/${w.id}`, { enabled: !w.enabled }); await loadAll(); } catch {}
  }
  async function toggleMode(w: CopyWallet) {
    const newMode = w.mode === 'live' ? 'demo' : 'live';
    if (newMode === 'live' && !confirm('Switch to LIVE trading? Real orders will be placed on Polymarket!')) return;
    try { await api.patch(`/copytrading/wallets/${w.id}`, { mode: newMode }); await loadAll(); } catch {}
  }
  async function saveEdit(id: string) {
    if (!editAmount) return;
    try {
      await api.patch(`/copytrading/wallets/${id}`, {
        amountPerTrade: parseFloat(editAmount),
        minOrderShares: Math.max(5, parseInt(editMinShares, 10) || 5),
        copyScale: Math.max(0.01, parseFloat(editCopyScale) || 1),
        takeProfitEnabled: editTakeProfitEnabled,
        takeProfitRoiPercent: parseFloat(editTakeProfitRoi) || 150,
        takeProfitClosePercent: parseFloat(editTakeProfitClose) || 40,
        takeProfitFallbackPrice: parseFloat(editTakeProfitFallback) || 0.80,
        staleExitEnabled: editStaleExitEnabled,
        staleExitDays: parseInt(editStaleExitDays) || 7,
        staleExitLossPct: parseFloat(editStaleExitLossPct) || 70,
        preCloseExitHours: parseInt(editPreCloseHours) || 3,
      });
      setEditingId(null);
      await loadAll();
    } catch {}
  }
  async function saveGlobalSettings() {
    setSavingSettings(true);
    try {
      await api.patch('/copytrading/settings', {
        minCopyPrice: parseFloat(globalMinPrice) || 0.004,
        maxCopyPrice: parseFloat(globalMaxPrice) || 0.95,
      });
    } catch {} finally { setSavingSettings(false); }
  }
  async function deleteWallet(id: string) {
    if (!confirm('Delete this wallet from the list?')) return;
    try { await api.delete(`/copytrading/wallets/${id}`); if (selectedWallet) setSelectedWallet(null); await loadAll(); } catch {}
  }
  async function triggerPoll() {
    setTriggering(true);
    setTriggerResult(null);
    try {
      const res = await api.post('/copytrading/trigger');
      setTriggerResult(`Copied: ${res.data.copied} | Skipped: ${res.data.skipped} | Errors: ${res.data.errors}`);
      await loadAll();
    } catch (e: any) {
      setTriggerResult('Error: ' + (e.response?.data?.error || e.message));
    } finally { setTriggering(false); }
  }
  async function resyncPositions() {
    setResyncing(true);
    setTriggerResult(null);
    try {
      const res = await api.post('/copytrading/resync-positions');
      const msg = res.data?.message || 'Resync started';
      setTriggerResult(`${msg} — positions will refresh automatically`);
      // Auto-refresh positions after ~65s when background work should be done
      setTimeout(async () => { await loadAll(); setResyncing(false); }, 65_000);
    } catch (e: any) {
      setTriggerResult('Resync error: ' + (e.response?.data?.error || e.message));
      setResyncing(false);
    }
  }

  async function triggerReconcile() {
    setReconcileLoading(true); setReconcileData(null);
    try {
      const res = await api.get('/copytrading/reconcile');
      const d = res.data;
      if (!d.ok) {
        setReconcileData({
          desynced: [],
          ghostCandidates: [],
          realPositionsCount: 0,
          meaningfulPositionsCount: 0,
          dbOpenBuysCount: 0,
        });
        return;
      }
      setReconcileData({
        tradingUser: d.tradingUser,
        reconcileNote: d.reconcileNote,
        desynced: d.desynced || [],
        ghostCandidates: (d.ghostCandidates || []).map((g: any) => ({ marketTitle: g.marketTitle, tokenId: g.tokenId, dbSize: g.dbSize })),
        realPositionsCount: d.realPositionsCount ?? 0,
        meaningfulPositionsCount: d.meaningfulPositionsCount,
        dbOpenBuysCount: d.dbOpenBuysCount ?? 0,
      });
      await loadAll();
    } catch {
      setReconcileData({
        desynced: [],
        ghostCandidates: [],
        realPositionsCount: 0,
        meaningfulPositionsCount: 0,
        dbOpenBuysCount: 0,
      });
    }
    finally { setReconcileLoading(false); }
  }

  const totalPages = Math.ceil(posTotal / PAGE_SIZE);
  const logTotalPages = Math.ceil(logTotal / PAGE_SIZE);
  const getWalletStats = (addr: string) => perWalletStats.find(s => s.walletAddress.toLowerCase() === addr.toLowerCase());
  const getWalletLabel = (addr: string | null) => {
    if (!addr) return 'Unknown';
    const wallet = wallets.find(w => w.walletAddress.toLowerCase() === addr.toLowerCase());
    return wallet?.label || shortAddr(addr);
  };
  const positionsBySource = positions.reduce<Record<string, LivePosition[]>>((acc, p) => {
    const key = p.sourceWalletAddress || 'unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-gray-700 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-sm text-gray-500">Loading...</span>
        </div>
      </div>
    );
  }

  const enabledCount = wallets.filter(w => w.enabled).length;
  const liveCount = wallets.filter(w => w.mode === 'live').length;
  const pnlColor = (v: number) => v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-gray-400';

  return (
    <div className="max-w-6xl mx-auto space-y-5">

      {/* ─── Header ─── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-white tracking-tight">Copy Trading</h1>
          <div className="flex items-center gap-1.5">
            {clobStatus && (
              <span
                title={clobStatus.ready ? 'Polymarket CLOB готов к ордерам' : (clobStatus.error || 'CLOB не инициализирован — см. логи бэкенда')}
                className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium max-w-[min(100vw-8rem,22rem)] truncate
                ${clobStatus.ready ? 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20' : 'bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20'}`}>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${clobStatus.ready ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                {clobStatus.ready ? 'Connected' : 'Offline'}
                {!clobStatus.ready && clobStatus.error && (
                  <span className="text-[10px] text-amber-500/80 truncate hidden sm:inline" title={clobStatus.error}> — {clobStatus.error}</span>
                )}
              </span>
            )}
            {liveCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium bg-red-500/10 text-red-400 ring-1 ring-red-500/20">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-400" />
                </span>
                {liveCount} live
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && <span className="text-[11px] text-gray-600 tabular-nums">{lastUpdated.toLocaleTimeString()}</span>}
          <button onClick={triggerPoll} disabled={triggering}
            className="h-8 px-3 text-xs font-medium rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-gray-300 ring-1 ring-white/[0.06] transition-all disabled:opacity-40">
            {triggering ? 'Scanning...' : 'Scan now'}
          </button>
          <button
            onClick={resyncPositions}
            disabled={resyncing}
            title="Фон: syncTraderExits + sweep orphans + retry failed SELL (~60s). Нужен VPN если регион блокирует CLOB."
            className="h-8 px-3 text-xs font-medium rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/20 transition-all disabled:opacity-40">
            {resyncing ? 'Syncing...' : 'Sync positions'}
          </button>
          <button onClick={triggerReconcile} disabled={reconcileLoading}
            className="h-8 px-3 text-xs font-medium rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-gray-300 ring-1 ring-white/[0.06] transition-all disabled:opacity-40">
            {reconcileLoading ? 'Checking...' : 'Reconcile'}
          </button>
          <button onClick={() => setShowSettings(!showSettings)}
            className={`h-8 w-8 flex items-center justify-center rounded-lg transition-all ring-1
              ${showSettings ? 'bg-blue-500/10 text-blue-400 ring-blue-500/20' : 'bg-white/[0.04] text-gray-400 ring-white/[0.06] hover:bg-white/[0.08]'}`}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* ─── Flash messages ─── */}
      {triggerResult && (
        <div className="rounded-lg bg-blue-500/5 ring-1 ring-blue-500/10 px-4 py-2.5 text-blue-300 text-xs font-medium flex items-center justify-between">
          <span>{triggerResult}</span>
          <button onClick={() => setTriggerResult(null)} className="text-blue-500 hover:text-blue-300 ml-4">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {reconcileData && <ReconcilePanel data={reconcileData} onClose={() => setReconcileData(null)} />}

      {/* ─── Global settings panel ─── */}
      {showSettings && (
        <div className="rounded-xl bg-white/[0.02] ring-1 ring-white/[0.06] p-5">
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Entry Price Filters</div>
          <div className="flex flex-wrap items-end gap-4">
            <InputField label="Min price" value={globalMinPrice} onChange={setGlobalMinPrice} type="number" suffix="$" className="w-28" />
            <InputField label="Max price" value={globalMaxPrice} onChange={setGlobalMaxPrice} type="number" suffix="$" className="w-28" />
            <button onClick={saveGlobalSettings} disabled={savingSettings}
              className="h-9 px-4 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50">
              {savingSettings ? 'Saving...' : 'Save'}
            </button>
            <span className="text-[11px] text-gray-600 pb-2">Range: {globalMinPrice} – {globalMaxPrice}</span>
          </div>
        </div>
      )}

      {/* ─── Stats ─── */}
      {stats && (
        <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
          <MetricCard label="Copied" value={String(stats.totalCopied)} sub={`${stats.todayCopied} today`} />
          <MetricCard label="Invested" value={`$${(stats.invested ?? 0).toFixed(0)}`} sub={`${stats.openPositions ?? 0} open`} />
          <MetricCard label="Unrealized" value={fmt(stats.unrealizedPnl ?? 0)} color={pnlColor(stats.unrealizedPnl ?? 0)} />
          <MetricCard label="Realized" value={fmt(stats.totalPnl)} color={pnlColor(stats.totalPnl)} />
          <MetricCard label="Win Rate" value={stats.winRate != null ? `${stats.winRate}%` : '—'} sub={`${stats.wins}W / ${stats.losses}L`} />
          <MetricCard label="Wallets" value={`${enabledCount}/${wallets.length}`} sub={liveCount > 0 ? `${liveCount} live` : 'all demo'} />
        </div>
      )}

      {/* ─── Wallets ─── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-300">Following</h2>
          <button onClick={() => setShowAddWallet(!showAddWallet)}
            className={`h-7 px-3 text-[11px] font-medium rounded-md transition-all ring-1
              ${showAddWallet ? 'bg-blue-500/10 text-blue-400 ring-blue-500/20' : 'bg-white/[0.04] text-gray-400 ring-white/[0.06] hover:text-white'}`}>
            {showAddWallet ? 'Cancel' : '+ Add wallet'}
          </button>
        </div>

        {/* Add wallet form */}
        {showAddWallet && (
          <div className="mb-3 rounded-xl bg-white/[0.02] ring-1 ring-white/[0.06] p-5 space-y-4">
            <div className="flex flex-wrap gap-3 items-end">
              <InputField label="Address" value={addAddr} onChange={setAddAddr} placeholder="0x..." className="flex-1 min-w-[200px]" mono />
              <InputField label="Label" value={addLabel} onChange={setAddLabel} placeholder="e.g. plankton" className="w-28" />
              <InputField label="$/trade" value={addAmount} onChange={setAddAmount} type="number" className="w-20" />
              <InputField label="Min sh." value={addMinShares} onChange={setAddMinShares} type="number" className="w-20" />
              <InputField label="Scale" value={addCopyScale} onChange={setAddCopyScale} type="number" className="w-20" />
              <div className="w-20">
                <label className="text-[11px] text-gray-500 block mb-1">Mode</label>
                <select value={addMode} onChange={e => setAddMode(e.target.value as 'demo' | 'live')}
                  className="w-full h-9 bg-white/[0.04] ring-1 ring-white/[0.06] rounded-lg px-2 text-xs text-white focus:outline-none focus:ring-blue-500/40">
                  <option value="demo">Demo</option>
                  <option value="live">Live</option>
                </select>
              </div>
              <button onClick={addWallet} disabled={adding}
                className="h-9 px-4 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50">
                {adding ? '...' : 'Add'}
              </button>
            </div>
            {/* TP settings */}
            <div className="flex flex-wrap gap-3 items-end pt-2 border-t border-white/[0.04]">
              <label className="flex items-center gap-2 text-xs text-gray-400 pb-1.5">
                <input type="checkbox" checked={addTakeProfitEnabled} onChange={e => setAddTakeProfitEnabled(e.target.checked)}
                  className="rounded border-gray-600 bg-transparent text-blue-500 focus:ring-0 w-3.5 h-3.5" />
                Auto TP
              </label>
              <InputField label="ROI %" value={addTakeProfitRoi} onChange={setAddTakeProfitRoi} type="number" className="w-20" disabled={!addTakeProfitEnabled} />
              <InputField label="Close %" value={addTakeProfitClose} onChange={setAddTakeProfitClose} type="number" className="w-20" disabled={!addTakeProfitEnabled} />
              <InputField label="Cap $" value={addTakeProfitFallback} onChange={setAddTakeProfitFallback} type="number" className="w-20" disabled={!addTakeProfitEnabled} />
            </div>
            {addError && <p className="text-red-400 text-xs">{addError}</p>}
          </div>
        )}

        {wallets.length === 0 ? (
          <div className="rounded-xl bg-white/[0.01] ring-1 ring-white/[0.04] p-8 text-center">
            <p className="text-gray-500 text-sm">No wallets yet. Add a wallet to start copy-trading.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {wallets.map(w => {
              const ws = getWalletStats(w.walletAddress);
              const isSelected = selectedWallet === w.walletAddress;
              const isEditing = editingId === w.id;
              return (
                <div key={w.id}
                  className={`group rounded-xl ring-1 transition-all
                    ${isSelected ? 'bg-blue-500/[0.04] ring-blue-500/20' : 'bg-white/[0.015] ring-white/[0.05] hover:ring-white/[0.08]'}`}>
                  <div className="flex items-center gap-3 px-4 py-3">
                    {/* Toggle */}
                    <button onClick={() => toggleWallet(w)}
                      className={`w-7 h-4 rounded-full relative transition-colors flex-shrink-0
                        ${w.enabled ? 'bg-emerald-500/60' : 'bg-gray-700'}`}>
                      <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all
                        ${w.enabled ? 'left-3.5' : 'left-0.5'}`} />
                    </button>

                    {/* Info */}
                    <button onClick={() => setSelectedWallet(isSelected ? null : w.walletAddress)} className="flex-1 min-w-0 text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white truncate">{w.label || shortAddr(w.walletAddress)}</span>
                        {w.label && <span className="text-[11px] text-gray-600 font-mono">{shortAddr(w.walletAddress)}</span>}
                      </div>
                    </button>

                    {/* Stats inline */}
                    {ws && (
                      <div className="hidden sm:flex items-center gap-4 text-[11px] tabular-nums">
                        <span className="text-gray-500">{ws.open} open</span>
                        <span className={pnlColor(ws.unrealizedPnl)}>{fmt(ws.unrealizedPnl)}</span>
                        <span className={pnlColor(ws.totalPnl)}>P&L {fmt(ws.totalPnl)}</span>
                      </div>
                    )}

                    {/* Tags */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className="text-[10px] text-gray-500 tabular-nums">${w.amountPerTrade}</span>
                      <button onClick={() => toggleMode(w)}
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded transition-colors
                          ${w.mode === 'live' ? 'bg-red-500/15 text-red-400' : 'bg-gray-700/60 text-gray-400'}`}>
                        {w.mode === 'live' ? 'LIVE' : 'DEMO'}
                      </button>
                      {w.takeProfitEnabled && <span className="text-[10px] text-emerald-500/70 font-medium">TP</span>}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <button onClick={() => {
                        setEditingId(isEditing ? null : w.id);
                        setEditAmount(String(w.amountPerTrade)); setEditMinShares(String(w.minOrderShares ?? 5));
                        setEditCopyScale(String(w.copyScale ?? 1)); setEditTakeProfitEnabled(!!w.takeProfitEnabled);
                        setEditTakeProfitRoi(String(w.takeProfitRoiPercent ?? 150)); setEditTakeProfitClose(String(w.takeProfitClosePercent ?? 40));
                        setEditTakeProfitFallback(String(w.takeProfitFallbackPrice ?? 0.80)); setEditStaleExitEnabled(w.staleExitEnabled !== false);
                        setEditStaleExitDays(String(w.staleExitDays ?? 7)); setEditStaleExitLossPct(String(w.staleExitLossPct ?? 70));
                        setEditPreCloseHours(String(w.preCloseExitHours ?? 3));
                      }} className="h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-white hover:bg-white/[0.06] transition-colors">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                      </button>
                      <a href={`https://polymarket.com/profile/${w.walletAddress}`} target="_blank" rel="noopener noreferrer"
                        className="h-6 w-6 flex items-center justify-center rounded text-gray-500 hover:text-blue-400 hover:bg-white/[0.06] transition-colors">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                      </a>
                      <button onClick={() => deleteWallet(w.id)}
                        className="h-6 w-6 flex items-center justify-center rounded text-gray-600 hover:text-red-400 hover:bg-white/[0.06] transition-colors">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      </button>
                    </div>
                  </div>

                  {/* Edit panel */}
                  {isEditing && (
                    <div className="px-4 pb-4 pt-1 border-t border-white/[0.04] space-y-3">
                      <div className="text-[11px] text-gray-500 font-medium uppercase tracking-wider pt-2">Trade Settings</div>
                      <div className="flex flex-wrap gap-3 items-end">
                        <InputField label="$/trade" value={editAmount} onChange={setEditAmount} type="number" className="w-20" />
                        <InputField label="Min shares" value={editMinShares} onChange={setEditMinShares} type="number" className="w-20" />
                        <InputField label="Scale" value={editCopyScale} onChange={setEditCopyScale} type="number" className="w-20" />
                      </div>

                      <div className="text-[11px] text-gray-500 font-medium uppercase tracking-wider pt-1">Take Profit</div>
                      <div className="flex flex-wrap gap-3 items-end">
                        <label className="flex items-center gap-2 text-xs text-gray-400 pb-1.5">
                          <input type="checkbox" checked={editTakeProfitEnabled} onChange={e => setEditTakeProfitEnabled(e.target.checked)}
                            className="rounded border-gray-600 bg-transparent text-blue-500 focus:ring-0 w-3.5 h-3.5" />
                          Enable
                        </label>
                        <InputField label="ROI %" value={editTakeProfitRoi} onChange={setEditTakeProfitRoi} type="number" className="w-20" disabled={!editTakeProfitEnabled} />
                        <InputField label="Close %" value={editTakeProfitClose} onChange={setEditTakeProfitClose} type="number" className="w-20" disabled={!editTakeProfitEnabled} />
                        <InputField label="Cap $" value={editTakeProfitFallback} onChange={setEditTakeProfitFallback} type="number" className="w-20" disabled={!editTakeProfitEnabled} />
                      </div>

                      <div className="text-[11px] text-gray-500 font-medium uppercase tracking-wider pt-1">Auto Exit</div>
                      <div className="flex flex-wrap gap-3 items-end">
                        <label className="flex items-center gap-2 text-xs text-gray-400 pb-1.5">
                          <input type="checkbox" checked={editStaleExitEnabled} onChange={e => setEditStaleExitEnabled(e.target.checked)}
                            className="rounded border-gray-600 bg-transparent text-amber-500 focus:ring-0 w-3.5 h-3.5" />
                          Enable
                        </label>
                        <InputField label="After days" value={editStaleExitDays} onChange={setEditStaleExitDays} type="number" className="w-20" disabled={!editStaleExitEnabled} />
                        <InputField label="If drop %" value={editStaleExitLossPct} onChange={setEditStaleExitLossPct} type="number" className="w-20" disabled={!editStaleExitEnabled} />
                        <InputField label="Pre-close h" value={editPreCloseHours} onChange={setEditPreCloseHours} type="number" className="w-24" disabled={!editStaleExitEnabled} />
                      </div>

                      <div className="flex items-center gap-2 pt-1">
                        <button onClick={() => saveEdit(w.id)}
                          className="h-8 px-4 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors">
                          Save
                        </button>
                        <button onClick={() => setEditingId(null)}
                          className="h-8 px-3 text-xs text-gray-500 hover:text-white transition-colors">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Positions ─── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-gray-300">Positions</h2>
            <span className="text-[11px] text-gray-600 tabular-nums">{posTotal}</span>
          </div>
          <div className="flex items-center gap-0.5 bg-white/[0.03] rounded-lg p-0.5 ring-1 ring-white/[0.04]">
            {POSITION_TABS.map(tab => (
              <button key={tab} onClick={() => { setPositionTab(tab); setPosPage(0); }}
                className={`px-3 py-1 rounded-md text-[11px] font-medium capitalize transition-all
                  ${positionTab === tab ? 'bg-white/[0.08] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}>
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-xl ring-1 ring-white/[0.05] overflow-hidden">
          {positions.length === 0 ? (
            <div className="py-16 text-center text-gray-600 text-sm">No positions</div>
          ) : selectedWallet ? (
            <PositionsTable positions={positions} />
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {Object.entries(positionsBySource).map(([source, sp]) => {
                const isCollapsed = !!collapsedPositionSources[source];
                const ws = source === 'unknown' ? null : getWalletStats(source);
                return (
                  <div key={source}>
                    <button onClick={() => setCollapsedPositionSources(p => ({ ...p, [source]: !p[source] }))}
                      className="w-full px-4 py-2.5 flex items-center justify-between text-left hover:bg-white/[0.02] transition-colors">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xs font-medium text-gray-300">{getWalletLabel(source === 'unknown' ? null : source)}</span>
                        <span className="text-[11px] text-gray-600">{sp.length} pos</span>
                        {ws && <span className={`text-[11px] tabular-nums ${pnlColor(ws.unrealizedPnl)}`}>{fmt(ws.unrealizedPnl)}</span>}
                      </div>
                      <svg className={`w-3 h-3 text-gray-600 transition-transform ${isCollapsed ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {!isCollapsed && <PositionsTable positions={sp} />}
                  </div>
                );
              })}
            </div>
          )}
          {totalPages > 1 && <Pagination page={posPage} totalPages={totalPages} onPageChange={setPosPage} />}
        </div>
      </section>

      {/* ─── Log ─── */}
      <section>
        <button onClick={() => setShowLog(!showLog)}
          className="flex items-center gap-2 mb-3 text-sm font-semibold text-gray-300 hover:text-white transition-colors group">
          <span>Activity Log</span>
          <span className="text-[11px] text-gray-600 tabular-nums">{logTotal}</span>
          <svg className={`w-3 h-3 text-gray-600 transition-transform ${showLog ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showLog && (
          <div className="rounded-xl ring-1 ring-white/[0.05] overflow-hidden">
            {logs.length === 0 ? (
              <div className="py-12 text-center text-gray-600 text-sm">No logs yet</div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-gray-500 border-b border-white/[0.04]">
                        <th className="text-left py-2.5 px-4 font-medium">Status</th>
                        <th className="text-left py-2.5 font-medium">Side</th>
                        <th className="text-left py-2.5 font-medium">Market</th>
                        <th className="text-center py-2.5 font-medium">Outcome</th>
                        <th className="text-right py-2.5 font-medium">Price</th>
                        <th className="text-right py-2.5 font-medium">Amount</th>
                        <th className="text-right py-2.5 px-4 font-medium">Time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.03]">
                      {logs.map(log => (
                        <tr key={log.id} className="hover:bg-white/[0.015] transition-colors">
                          <td className="py-2 px-4">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium
                              ${log.status === 'COPIED' ? 'bg-emerald-500/10 text-emerald-400' :
                                log.status === 'FAILED' ? 'bg-red-500/10 text-red-400' : 'bg-gray-500/10 text-gray-400'}`}>
                              {log.status}
                            </span>
                          </td>
                          <td className="py-2">
                            <span className={`font-mono font-semibold ${log.action === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{log.action}</span>
                          </td>
                          <td className="py-2 max-w-[200px] truncate text-gray-300" title={log.skipReason || log.marketTitle}>{log.marketTitle || log.marketId}</td>
                          <td className="py-2 text-center">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold
                              ${log.outcome === 'YES' ? 'bg-blue-500/10 text-blue-400' : 'bg-orange-500/10 text-orange-400'}`}>{log.outcome}</span>
                          </td>
                          <td className="py-2 text-right font-mono text-gray-400">{(log.copyPrice * 100).toFixed(1)}c</td>
                          <td className="py-2 text-right font-mono text-gray-300">${log.amount.toFixed(2)}</td>
                          <td className="py-2 text-right text-gray-600 px-4">{timeAgo(log.copiedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {logTotalPages > 1 && <Pagination page={logPage} totalPages={logTotalPages} onPageChange={setLogPage} />}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/* ─── Subcomponents ─── */

function MetricCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.02] ring-1 ring-white/[0.05] p-4">
      <div className="text-[11px] text-gray-500 font-medium">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 tabular-nums ${color ?? 'text-white'}`}>{value}</div>
      {sub && <div className="text-[11px] text-gray-600 mt-0.5">{sub}</div>}
    </div>
  );
}

function InputField({ label, value, onChange, type, placeholder, suffix, className, mono, disabled }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; suffix?: string; className?: string; mono?: boolean; disabled?: boolean;
}) {
  return (
    <div className={className}>
      <label className="text-[11px] text-gray-500 block mb-1">{label}</label>
      <div className="relative">
        <input type={type || 'text'} value={value} onChange={e => onChange(e.target.value)}
          placeholder={placeholder} disabled={disabled}
          className={`w-full h-9 bg-white/[0.04] ring-1 ring-white/[0.06] rounded-lg px-3 text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-blue-500/40 transition-shadow disabled:opacity-40 ${mono ? 'font-mono' : ''} ${suffix ? 'pr-7' : ''}`} />
        {suffix && <span className="absolute right-3 top-2.5 text-gray-500 text-[11px]">{suffix}</span>}
      </div>
    </div>
  );
}

function PositionsTable({ positions }: { positions: LivePosition[] }) {
  const statusStyle: Record<string, { label: string; cls: string }> = {
    FILLED: { label: 'Open', cls: 'bg-blue-500/10 text-blue-400' },
    LIVE: { label: 'Pending', cls: 'bg-amber-500/10 text-amber-400' },
    CLOSED: { label: 'Closed', cls: 'bg-white/[0.04] text-gray-500' },
    FAILED: { label: 'Failed', cls: 'bg-red-500/10 text-red-400' },
    CANCELLED: { label: 'Cancelled', cls: 'bg-white/[0.04] text-gray-600' },
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-gray-500 border-b border-white/[0.04]">
            <th className="text-left py-2.5 px-4 font-medium w-16">Status</th>
            <th className="text-center py-2.5 font-medium w-12">Side</th>
            <th className="text-left py-2.5 font-medium">Market</th>
            <th className="text-right py-2.5 font-medium w-14">Entry</th>
            <th className="text-right py-2.5 font-medium w-14">Now</th>
            <th className="text-right py-2.5 font-medium w-16">Invested</th>
            <th className="text-right py-2.5 font-medium w-16">P&L</th>
            <th className="text-right py-2.5 font-medium w-14">ROI</th>
            <th className="text-right py-2.5 px-4 font-medium w-12">Age</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.03]">
          {positions.map(p => {
            const st = statusStyle[p.status] ?? { label: p.status, cls: 'bg-white/[0.04] text-gray-500' };
            const isOpen = p.status === 'FILLED';
            const pnl = p.pnl ?? 0;
            const roi = p.roi ?? 0;
            const pnlC = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-red-400' : 'text-gray-500';

            return (
              <tr key={p.id} className="hover:bg-white/[0.015] transition-colors" title={p.errorMessage || undefined}>
                <td className="py-2 px-4">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${st.cls}`}>{st.label}</span>
                </td>
                <td className="py-2 text-center">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${p.outcome === 'YES' ? 'bg-blue-500/10 text-blue-400' : 'bg-orange-500/10 text-orange-400'}`}>
                    {p.outcome}
                  </span>
                </td>
                <td className="py-2 max-w-[220px] truncate text-gray-300" title={p.marketTitle}>{p.marketTitle || '—'}</td>
                <td className="py-2 text-right font-mono text-gray-400">{(p.entryPrice * 100).toFixed(1)}c</td>
                <td className="py-2 text-right font-mono text-gray-400">
                  {isOpen && p.currentPrice !== null ? `${(p.currentPrice * 100).toFixed(1)}c` : '—'}
                </td>
                <td className="py-2 text-right font-mono text-gray-300">${p.invested.toFixed(2)}</td>
                <td className={`py-2 text-right font-mono font-medium ${pnlC}`}>{isOpen ? fmt(pnl) : '—'}</td>
                <td className={`py-2 text-right font-mono font-medium ${pnlC}`}>
                  {isOpen ? `${roi >= 0 ? '+' : ''}${roi.toFixed(0)}%` : '—'}
                </td>
                <td className="py-2 text-right text-gray-600 px-4">{timeAgo(p.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/[0.04]">
      <button disabled={page === 0} onClick={() => onPageChange(page - 1)}
        className="h-7 px-3 text-[11px] rounded-md bg-white/[0.04] text-gray-400 hover:text-white disabled:opacity-20 transition-all">
        Prev
      </button>
      <span className="text-[11px] text-gray-600 tabular-nums">{page + 1} / {totalPages}</span>
      <button disabled={page >= totalPages - 1} onClick={() => onPageChange(page + 1)}
        className="h-7 px-3 text-[11px] rounded-md bg-white/[0.04] text-gray-400 hover:text-white disabled:opacity-20 transition-all">
        Next
      </button>
    </div>
  );
}

function ReconcilePanel({ data, onClose }: {
  data: {
    tradingUser?: string;
    reconcileNote?: string;
    desynced: any[];
    ghostCandidates: any[];
    realPositionsCount: number;
    meaningfulPositionsCount?: number;
    dbOpenBuysCount: number;
  };
  onClose: () => void;
}) {
  const ok = data.desynced.length === 0 && data.ghostCandidates.length === 0;
  const meaningful = data.meaningfulPositionsCount ?? data.realPositionsCount;
  return (
    <div className={`rounded-xl ring-1 overflow-hidden ${ok ? 'ring-emerald-500/10 bg-emerald-500/[0.03]' : 'ring-amber-500/10 bg-amber-500/[0.03]'}`}>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <span className={`text-xs font-medium ${ok ? 'text-emerald-400' : 'text-amber-400'}`}>
            {ok ? 'All synced' : `${data.desynced.length + data.ghostCandidates.length} issues`}
          </span>
          <span className="text-[11px] text-gray-500">
            DB open FILLED: {data.dbOpenBuysCount} / on-chain positions: {data.realPositionsCount}
            {meaningful !== data.realPositionsCount && ` (≥1 sh: ${meaningful})`}
          </span>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-white">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
      {data.reconcileNote && (
        <div className="px-4 pb-2 text-[10px] text-gray-500 leading-relaxed border-b border-white/[0.04]">
          <span className="text-gray-600">Reconcile: </span>{data.reconcileNote}
        </div>
      )}
      {data.desynced.length > 0 && (
        <div className="px-4 pb-3 pt-2">
          <div className="text-[11px] text-amber-400 mb-1 font-medium">
            Desynced — цепь ещё держит шары, в БД BUY уже CLOSED ({data.desynced.length})
          </div>
          <div className="space-y-0.5 max-h-28 overflow-y-auto text-[11px] text-gray-400">
            {data.desynced.slice(0, 15).map((d, i) => <div key={i}>{d.marketTitle?.slice(0, 60)} — {d.realSize?.toFixed?.(2) ?? d.realSize} sh</div>)}
            {data.desynced.length > 15 && <div className="text-gray-600">+{data.desynced.length - 15} more…</div>}
          </div>
        </div>
      )}
      {data.ghostCandidates.length > 0 && (
        <div className="px-4 pb-3">
          <div className="text-[11px] text-gray-400 mb-1 font-medium">
            Ghost — в БД открытый FILLED, на цепи 0 шаров ({data.ghostCandidates.length})
          </div>
          <div className="space-y-0.5 max-h-28 overflow-y-auto text-[11px] text-gray-500">
            {data.ghostCandidates.slice(0, 15).map((g, i) => <div key={i}>{g.marketTitle?.slice(0, 60)}</div>)}
            {data.ghostCandidates.length > 15 && <div className="text-gray-600">+{data.ghostCandidates.length - 15} more…</div>}
          </div>
        </div>
      )}
    </div>
  );
}

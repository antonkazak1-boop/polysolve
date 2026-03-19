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
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function takeProfitLabel(wallet: Pick<CopyWallet, 'takeProfitEnabled' | 'takeProfitRoiPercent' | 'takeProfitClosePercent'>) {
  if (!wallet.takeProfitEnabled) return 'Auto-TP выкл';
  return `Auto-TP: ${wallet.takeProfitClosePercent}% по +${wallet.takeProfitRoiPercent}%`;
}

const POSITION_TABS = ['open', 'closed', 'all'] as const;
type PositionTab = (typeof POSITION_TABS)[number];

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  FILLED: { label: 'Open', className: 'bg-blue-500/20 text-blue-300' },
  LIVE:   { label: 'Pending', className: 'bg-yellow-500/20 text-yellow-300' },
  CLOSED: { label: 'Closed', className: 'bg-gray-500/20 text-gray-400' },
  FAILED: { label: 'Failed', className: 'bg-red-500/20 text-red-400' },
  CANCELLED: { label: 'Cancelled', className: 'bg-gray-600/20 text-gray-500' },
};

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
  const [reconcileLoading, setReconcileLoading] = useState(false);
  const [reconcileData, setReconcileData] = useState<{
    tradingUser?: string;
    desynced: { asset: string; realSize: number; marketTitle?: string; outcome?: string }[];
    ghostCandidates: { marketTitle: string; tokenId: string; dbSize: number }[];
    realPositionsCount: number;
    dbOpenBuysCount: number;
  } | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [collapsedPositionSources, setCollapsedPositionSources] = useState<Record<string, boolean>>({});

  const [clobStatus, setClobStatus] = useState<ClobStatus | null>(null);

  // Global price filter settings
  const [globalMinPrice, setGlobalMinPrice] = useState('0.004');
  const [globalMaxPrice, setGlobalMaxPrice] = useState('0.95');
  const [savingSettings, setSavingSettings] = useState(false);

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
    return () => {
      if (refreshInterval.current) clearInterval(refreshInterval.current);
    };
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
    try {
      await api.patch(`/copytrading/wallets/${w.id}`, { enabled: !w.enabled });
      await loadAll();
    } catch { /* ignore */ }
  }

  async function toggleMode(w: CopyWallet) {
    const newMode = w.mode === 'live' ? 'demo' : 'live';
    if (newMode === 'live' && !confirm('Переключить на LIVE торговлю? Будут размещаться реальные ордера на Polymarket!')) return;
    try {
      await api.patch(`/copytrading/wallets/${w.id}`, { mode: newMode });
      await loadAll();
    } catch { /* ignore */ }
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
    } catch { /* ignore */ }
  }

  async function saveGlobalSettings() {
    setSavingSettings(true);
    try {
      await api.patch('/copytrading/settings', {
        minCopyPrice: parseFloat(globalMinPrice) || 0.004,
        maxCopyPrice: parseFloat(globalMaxPrice) || 0.95,
      });
    } catch { /* ignore */ }
    finally { setSavingSettings(false); }
  }

  async function deleteWallet(id: string) {
    if (!confirm('Удалить кошелёк из списка?')) return;
    try {
      await api.delete(`/copytrading/wallets/${id}`);
      if (selectedWallet) setSelectedWallet(null);
      await loadAll();
    } catch { /* ignore */ }
  }

  async function triggerPoll() {
    setTriggering(true);
    setTriggerResult(null);
    try {
      const res = await api.post('/copytrading/trigger');
      const d = res.data;
      setTriggerResult(`Скопировано: ${d.copied} | Пропущено: ${d.skipped} | Ошибки: ${d.errors}`);
      await loadAll();
    } catch (e: any) {
      setTriggerResult('Ошибка: ' + (e.response?.data?.error || e.message));
    } finally { setTriggering(false); }
  }

  async function triggerReconcile() {
    setReconcileLoading(true);
    setReconcileData(null);
    try {
      const res = await api.get('/copytrading/reconcile');
      const d = res.data;
      if (!d.ok) {
        setReconcileData({ desynced: [], ghostCandidates: [], realPositionsCount: 0, dbOpenBuysCount: 0 });
        return;
      }
      setReconcileData({
        tradingUser: d.tradingUser,
        desynced: d.desynced || [],
        ghostCandidates: (d.ghostCandidates || []).map((g: { marketTitle: string; tokenId: string; dbSize: number }) => ({
          marketTitle: g.marketTitle,
          tokenId: g.tokenId,
          dbSize: g.dbSize,
        })),
        realPositionsCount: d.realPositionsCount ?? 0,
        dbOpenBuysCount: d.dbOpenBuysCount ?? 0,
      });
      await loadAll();
    } catch {
      setReconcileData({ desynced: [], ghostCandidates: [], realPositionsCount: 0, dbOpenBuysCount: 0 });
    } finally { setReconcileLoading(false); }
  }

  const totalPages = Math.ceil(posTotal / PAGE_SIZE);
  const logTotalPages = Math.ceil(logTotal / PAGE_SIZE);

  const getWalletStats = (addr: string) =>
    perWalletStats.find(s => s.walletAddress.toLowerCase() === addr.toLowerCase());
  const getWalletLabel = (addr: string | null) => {
    if (!addr) return 'Без источника';
    const wallet = wallets.find(w => w.walletAddress.toLowerCase() === addr.toLowerCase());
    return wallet?.label || shortAddr(addr);
  };
  const positionsBySource = positions.reduce<Record<string, LivePosition[]>>((acc, position) => {
    const key = position.sourceWalletAddress || 'unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(position);
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400 animate-pulse">Загрузка...</div>
      </div>
    );
  }

  const pnlColor = (stats?.totalPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400';
  const unrealizedColor = (stats?.unrealizedPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400';
  const enabledCount = wallets.filter(w => w.enabled).length;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">CopyTrading</h1>
          <p className="text-gray-400 text-sm mt-1">
            Копируем входы и выходы: при BUY — открываем позицию, при SELL — закрываем.
          </p>
          <div className="flex items-center gap-3 mt-1">
            {lastUpdated && (
              <span className="text-xs text-gray-600">Обновлено {lastUpdated.toLocaleTimeString()} (авто 30с)</span>
            )}
            {clobStatus && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${clobStatus.ready ? 'bg-green-500/15 text-green-400' : 'bg-yellow-500/15 text-yellow-400'}`}>
                CLOB: {clobStatus.ready ? 'подключен' : 'не настроен'}
              </span>
            )}
            {wallets.some(w => w.mode === 'live') && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 font-medium">
                LIVE торговля активна
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={triggerPoll}
            disabled={triggering}
            className="px-4 py-2 text-sm rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors disabled:opacity-50"
          >
            {triggering ? 'Проверяем...' : 'Проверить сейчас'}
          </button>
          <button
            onClick={triggerReconcile}
            disabled={reconcileLoading}
            className="px-4 py-2 text-sm rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors disabled:opacity-50"
            title="Сравнить реальные позиции на Polymarket с нашей базой"
          >
            {reconcileLoading ? 'Проверяем...' : 'Актуальность позиций'}
          </button>
        </div>
      </div>

      {triggerResult && (
        <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 px-4 py-2 text-blue-300 text-sm">
          {triggerResult}
        </div>
      )}

      {reconcileData && (
        <div className="rounded-xl bg-gray-900 border border-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 text-sm font-medium text-gray-300">
            Сверка с Polymarket
            {reconcileData.tradingUser && (
              <span className="text-gray-500 font-mono text-xs ml-2">кошелёк {reconcileData.tradingUser.slice(0, 10)}…</span>
            )}
            <div className="mt-1 text-gray-400 font-normal">
              В базе открытых: {reconcileData.dbOpenBuysCount}, на бирже позиций: {reconcileData.realPositionsCount}
              {reconcileData.dbOpenBuysCount === 0 && reconcileData.realPositionsCount === 0 && (
                <span className="text-green-400/80 ml-1">— расхождений нет.</span>
              )}
            </div>
          </div>
          {reconcileData.desynced.length > 0 && (
            <div className="px-4 py-3 border-b border-gray-800">
              <div className="text-amber-400 font-medium text-sm mb-1">
                Рассинхрон: на бирже есть позиции, в базе они помечены как закрытые ({reconcileData.desynced.length})
              </div>
              <ul className="text-sm text-gray-400 space-y-0.5 max-h-32 overflow-y-auto">
                {reconcileData.desynced.slice(0, 15).map((d, i) => (
                  <li key={i}>
                    {d.marketTitle?.slice(0, 50)} — {d.realSize} sh (прикрыть вручную на Polymarket или дождаться sync-exits)
                  </li>
                ))}
                {reconcileData.desynced.length > 15 && <li className="text-gray-500">… и ещё {reconcileData.desynced.length - 15}</li>}
              </ul>
            </div>
          )}
          {reconcileData.ghostCandidates.length > 0 && (
            <div className="px-4 py-3">
              <div className="text-gray-400 font-medium text-sm mb-1">
                В базе открыты, на бирже 0 акций (кандидаты ghost): {reconcileData.ghostCandidates.length}
              </div>
              <ul className="text-sm text-gray-500 space-y-0.5 max-h-24 overflow-y-auto">
                {reconcileData.ghostCandidates.slice(0, 10).map((g, i) => (
                  <li key={i}>{g.marketTitle?.slice(0, 50)}</li>
                ))}
              </ul>
            </div>
          )}
          {reconcileData.desynced.length === 0 && reconcileData.ghostCandidates.length === 0 && (
            <div className="px-4 py-3 text-sm text-green-400">Расхождений нет.</div>
          )}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="Скопировано" value={String(stats.totalCopied)} />
          <StatCard label="Сегодня" value={String(stats.todayCopied)} />
          <StatCard label="В позициях" value={fmt(stats.invested ?? 0)} sub={stats.openPositions != null ? `${stats.openPositions} откр.` : undefined} />
          <StatCard label="Нереал. P&L" value={fmt(stats.unrealizedPnl ?? 0)} color={unrealizedColor} />
          <StatCard label="Реал. P&L" value={fmt(stats.totalPnl)} color={pnlColor} />
          <StatCard
            label="Win rate"
            value={stats.winRate != null ? `${stats.winRate}%` : '—'}
            sub={stats.wins + stats.losses > 0 ? `${stats.wins}W / ${stats.losses}L` : undefined}
          />
        </div>
      )}

      {/* Add wallet — collapsible */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <button
          onClick={() => setShowAddWallet(!showAddWallet)}
          className="w-full px-5 py-3 flex items-center justify-between text-left text-sm font-semibold text-gray-300 hover:bg-gray-800/50 transition-colors"
        >
          <span>Добавить кошелёк</span>
          <span className="text-gray-500">{showAddWallet ? '−' : '+'}</span>
        </button>
        {showAddWallet && (
          <div className="px-5 pb-5 pt-0 space-y-3 border-t border-gray-800">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex-1 min-w-[200px]">
                <span className="text-xs text-gray-500 block mb-1">Адрес (0x...)</span>
                <input
                  value={addAddr}
                  onChange={e => setAddAddr(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500"
                  placeholder="0x..."
                />
              </label>
              <label className="w-32">
                <span className="text-xs text-gray-500 block mb-1">Метка</span>
                <input
                  value={addLabel}
                  onChange={e => setAddLabel(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  placeholder="planktonXD"
                />
              </label>
              <label className="w-24">
                <span className="text-xs text-gray-500 block mb-1">$ на сделку</span>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={addAmount}
                  onChange={e => setAddAmount(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </label>
              <label className="w-24" title="Минимум shares за ордер (Polymarket ≥5). Повышай постепенно — растёт и $-объём.">
                <span className="text-xs text-gray-500 block mb-1">Мин. shares</span>
                <input
                  type="number"
                  min={5}
                  max={10000}
                  step={1}
                  value={addMinShares}
                  onChange={e => setAddMinShares(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </label>
              <label className="w-24" title="0.1 = 10% от объёма трейдера. При его $9 → наш $0.90. amountPerTrade = потолок.">
                <span className="text-xs text-gray-500 block mb-1">Масштаб</span>
                <input
                  type="number"
                  min={0.01}
                  max={10}
                  step={0.01}
                  value={addCopyScale}
                  onChange={e => setAddCopyScale(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </label>
              <label className="w-24">
                <span className="text-xs text-gray-500 block mb-1">Режим</span>
                <select
                  value={addMode}
                  onChange={e => setAddMode(e.target.value as 'demo' | 'live')}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="demo">Demo</option>
                  <option value="live">Live</option>
                </select>
              </label>
              <button
                onClick={addWallet}
                disabled={adding}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg"
              >
                {adding ? '…' : 'Добавить'}
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[auto,120px,120px] gap-3 items-end rounded-lg border border-gray-800 bg-gray-800/40 p-3">
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={addTakeProfitEnabled}
                  onChange={e => setAddTakeProfitEnabled(e.target.checked)}
                  className="rounded border-gray-600 bg-gray-900 text-blue-500"
                />
                <span>Авто-выход лимиткой после входа</span>
              </label>
              <label>
                <span className="text-xs text-gray-500 block mb-1">ROI для TP</span>
                <div className="relative">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={addTakeProfitRoi}
                    onChange={e => setAddTakeProfitRoi(e.target.value)}
                    disabled={!addTakeProfitEnabled}
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 pr-7 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
                  />
                  <span className="absolute right-3 top-2 text-gray-500 text-sm">%</span>
                </div>
              </label>
              <label>
                <span className="text-xs text-gray-500 block mb-1">Закрыть от позиции</span>
                <div className="relative">
                  <input
                    type="number"
                    min="1"
                    max="95"
                    step="1"
                    value={addTakeProfitClose}
                    onChange={e => setAddTakeProfitClose(e.target.value)}
                    disabled={!addTakeProfitEnabled}
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 pr-7 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
                  />
                  <span className="absolute right-3 top-2 text-gray-500 text-sm">%</span>
                </div>
              </label>
            </div>
            <p className="text-xs text-gray-600">Работает для LIVE-режима: после filled BUY бот выставит SELL-лимитку на часть позиции.</p>
            {addError && <p className="text-red-400 text-sm">{addError}</p>}
          </div>
        )}
      </div>

      {/* Global price filter settings */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Глобальные фильтры входа</h2>
            <p className="text-xs text-gray-600 mt-1">Применяются ко всем кошелькам. Покупки вне диапазона игнорируются.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <label>
            <span className="text-xs text-gray-500 block mb-1">Мин. цена входа</span>
            <div className="relative">
              <input
                type="number" min="0.001" max="0.1" step="0.001"
                value={globalMinPrice}
                onChange={e => setGlobalMinPrice(e.target.value)}
                className="w-32 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 pr-7 text-sm text-white"
              />
              <span className="absolute right-3 top-2 text-gray-500 text-sm">¢</span>
            </div>
            <p className="text-xs text-gray-600 mt-1">Меньше — нет ликвидности (дефолт: 0.004)</p>
          </label>
          <label>
            <span className="text-xs text-gray-500 block mb-1">Макс. цена входа</span>
            <div className="relative">
              <input
                type="number" min="0.5" max="0.999" step="0.01"
                value={globalMaxPrice}
                onChange={e => setGlobalMaxPrice(e.target.value)}
                className="w-32 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 pr-7 text-sm text-white"
              />
              <span className="absolute right-3 top-2 text-gray-500 text-sm">¢</span>
            </div>
            <p className="text-xs text-gray-600 mt-1">Выше — рынок уже разрешён (дефолт: 0.95)</p>
          </label>
          <button
            onClick={saveGlobalSettings}
            disabled={savingSettings}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm text-white font-medium"
          >
            {savingSettings ? 'Сохраняю...' : 'Сохранить'}
          </button>
          <div className="text-xs text-gray-500 self-end pb-2">
            Сейчас: покупаем если <span className="text-gray-300">{globalMinPrice}–{globalMaxPrice}</span>
          </div>
        </div>
      </div>

      {/* Wallet list with per-wallet P&L */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
              Кошельки для фолловинга ({wallets.length}, активных {enabledCount})
            </h2>
            <p className="text-xs text-gray-600 mt-1">У каждого кошелька свои объём на сделку, режим и настройки авто-выхода.</p>
          </div>
        </div>
        {wallets.length === 0 ? (
          <p className="text-gray-500 text-sm">Добавьте кошелёк — с него будут копироваться BUY и SELL в демо-портфель.</p>
        ) : (
          <div className="space-y-3">
            {wallets.map(w => {
              const ws = getWalletStats(w.walletAddress);
              return (
                <div
                  key={w.id}
                  className={`rounded-xl border p-4 ${
                    selectedWallet === w.walletAddress ? 'bg-blue-500/10 border-blue-500/30' : 'bg-gray-800/50 border-gray-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <button
                      onClick={() => setSelectedWallet(selectedWallet === w.walletAddress ? null : w.walletAddress)}
                      className="text-left min-w-0 flex-1"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-white">{w.label || shortAddr(w.walletAddress)}</span>
                        <span className="text-gray-500 text-xs font-mono">{shortAddr(w.walletAddress)}</span>
                      </div>
                      <div className="text-xs text-gray-600 mt-1">
                        {w.lastCheckedAt ? `последняя проверка ${timeAgo(w.lastCheckedAt)}` : 'ещё не проверяли'}
                      </div>
                    </button>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => toggleMode(w)}
                        className={`px-2.5 py-1 rounded-md text-xs font-bold ${
                          (w.mode || 'demo') === 'live'
                            ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                            : 'bg-gray-700 text-gray-300'
                        }`}
                        title={(w.mode || 'demo') === 'live' ? 'Реальная торговля — нажмите для переключения на DEMO' : 'Демо режим — нажмите для переключения на LIVE'}
                      >
                        {(w.mode || 'demo') === 'live' ? 'LIVE' : 'DEMO'}
                      </button>
                      <button
                        onClick={() => toggleWallet(w)}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium ${w.enabled ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-500'}`}
                      >
                        {w.enabled ? 'Вкл' : 'Выкл'}
                      </button>
                      <button
                        onClick={() => {
                          setEditingId(editingId === w.id ? null : w.id);
                          setEditAmount(String(w.amountPerTrade));
                          setEditMinShares(String(w.minOrderShares ?? 5));
                          setEditCopyScale(String(w.copyScale ?? 1));
                          setEditTakeProfitEnabled(!!w.takeProfitEnabled);
                          setEditTakeProfitRoi(String(w.takeProfitRoiPercent ?? 150));
                          setEditTakeProfitClose(String(w.takeProfitClosePercent ?? 40));
                          setEditTakeProfitFallback(String(w.takeProfitFallbackPrice ?? 0.80));
                          setEditStaleExitEnabled(w.staleExitEnabled !== false);
                          setEditStaleExitDays(String(w.staleExitDays ?? 7));
                          setEditStaleExitLossPct(String(w.staleExitLossPct ?? 70));
                          setEditPreCloseHours(String(w.preCloseExitHours ?? 3));
                        }}
                        className="text-gray-400 hover:text-white text-xs"
                      >
                        настройки
                      </button>
                      <a href={`https://polymarket.com/profile/${w.walletAddress}`} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-blue-400 text-xs">Polymarket</a>
                      <a href={`/wallets/${w.walletAddress}`} className="text-gray-500 hover:text-blue-400 text-xs">профиль</a>
                      <button onClick={() => deleteWallet(w.id)} className="text-red-500/80 hover:text-red-400 text-xs">удалить</button>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
                    <div className="rounded-lg bg-gray-900/70 border border-gray-800 px-3 py-2">
                      <div className="text-gray-500">На сделку</div>
                      <div className="text-white font-medium">${w.amountPerTrade}</div>
                    </div>
                    <div className="rounded-lg bg-gray-900/70 border border-gray-800 px-3 py-2">
                      <div className="text-gray-500">Мин. shares</div>
                      <div className="text-white font-medium">{w.minOrderShares ?? 5}</div>
                    </div>
                    <div className="rounded-lg bg-gray-900/70 border border-gray-800 px-3 py-2" title="Масштаб копирования: ourUsd = traderUsd × copyScale. amountPerTrade = потолок.">
                      <div className="text-gray-500">Масштаб</div>
                      <div className="text-white font-medium">×{w.copyScale ?? 1}</div>
                    </div>
                    <div className="rounded-lg bg-gray-900/70 border border-gray-800 px-3 py-2">
                      <div className="text-gray-500">Take-profit</div>
                      <div className={`font-medium ${w.takeProfitEnabled ? 'text-green-400' : 'text-gray-500'}`}>
                        {w.takeProfitEnabled ? `+${w.takeProfitRoiPercent}% → ${w.takeProfitClosePercent}%` : 'выкл'}
                      </div>
                    </div>
                    <div className="rounded-lg bg-gray-900/70 border border-gray-800 px-3 py-2">
                      <div className="text-gray-500">Выход по времени</div>
                      <div className={`font-medium ${w.staleExitEnabled !== false ? 'text-yellow-400' : 'text-gray-500'}`}>
                        {w.staleExitEnabled !== false
                          ? `>${w.staleExitDays ?? 7}д −${w.staleExitLossPct ?? 70}%`
                          : 'выкл'}
                      </div>
                    </div>
                    <div className="rounded-lg bg-gray-900/70 border border-gray-800 px-3 py-2">
                      <div className="text-gray-500">До закрытия</div>
                      <div className={`font-medium ${w.staleExitEnabled !== false ? 'text-yellow-400' : 'text-gray-500'}`}>
                        {w.staleExitEnabled !== false ? `${w.preCloseExitHours ?? 3}ч до конца` : 'выкл'}
                      </div>
                    </div>
                  </div>

                  {ws && (
                    <div className="mt-3 flex flex-wrap gap-3 text-xs">
                      <span className="text-gray-500">открыто: {ws.open}</span>
                      <span className={`font-medium ${(ws.unrealizedPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        нереал. {fmt(ws.unrealizedPnl)}
                      </span>
                      <span className={`font-medium ${(ws.totalPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        P&L {fmt(ws.totalPnl)}
                      </span>
                    </div>
                  )}

                  {editingId === w.id && (
                    <div className="mt-3 rounded-lg border border-gray-700 bg-gray-900/80 p-3 space-y-3">
                      {/* Take-profit settings */}
                      <div>
                        <div className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wide">Take-profit (лимитный выход в плюс)</div>
                        <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
                          <label>
                            <span className="text-xs text-gray-500 block mb-1">$ на сделку</span>
                            <input type="number" min="0.1" step="0.1" value={editAmount} onChange={e => setEditAmount(e.target.value)}
                              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white" />
                          </label>
                          <label title="Мин. shares за BUY/часть TP (≥5, лимит Polymarket)">
                            <span className="text-xs text-gray-500 block mb-1">Мин. shares</span>
                            <input type="number" min={5} max={10000} step={1} value={editMinShares} onChange={e => setEditMinShares(e.target.value)}
                              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white" />
                          </label>
                          <label title="0.1 = 10% от объёма трейдера. При его $9 → наш $0.90. amountPerTrade = потолок.">
                            <span className="text-xs text-gray-500 block mb-1">Масштаб</span>
                            <input type="number" min={0.01} max={10} step={0.01} value={editCopyScale} onChange={e => setEditCopyScale(e.target.value)}
                              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white" />
                          </label>
                          <label className="flex items-center gap-2 md:pt-6 text-sm text-gray-300">
                            <input type="checkbox" checked={editTakeProfitEnabled} onChange={e => setEditTakeProfitEnabled(e.target.checked)}
                              className="rounded border-gray-600 bg-gray-900 text-blue-500" />
                            <span>Включить auto-TP</span>
                          </label>
                          <label>
                            <span className="text-xs text-gray-500 block mb-1">ROI для TP</span>
                            <div className="relative">
                              <input type="number" min="1" step="1" value={editTakeProfitRoi} onChange={e => setEditTakeProfitRoi(e.target.value)}
                                disabled={!editTakeProfitEnabled} className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 pr-7 text-sm text-white disabled:opacity-50" />
                              <span className="absolute right-3 top-2 text-gray-500 text-sm">%</span>
                            </div>
                          </label>
                          <label>
                            <span className="text-xs text-gray-500 block mb-1">Закрыть от позиции</span>
                            <div className="relative">
                              <input type="number" min="1" max="95" step="1" value={editTakeProfitClose} onChange={e => setEditTakeProfitClose(e.target.value)}
                                disabled={!editTakeProfitEnabled} className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 pr-7 text-sm text-white disabled:opacity-50" />
                              <span className="absolute right-3 top-2 text-gray-500 text-sm">%</span>
                            </div>
                          </label>
                          <label>
                            <span className="text-xs text-gray-500 block mb-1">Кап если цель &gt;$1</span>
                            <div className="relative">
                              <input type="number" min="0.1" max="0.99" step="0.01" value={editTakeProfitFallback} onChange={e => setEditTakeProfitFallback(e.target.value)}
                                disabled={!editTakeProfitEnabled} className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 pr-7 text-sm text-white disabled:opacity-50" />
                              <span className="absolute right-3 top-2 text-gray-500 text-sm">¢</span>
                            </div>
                            <p className="text-xs text-gray-600 mt-1">Если ROI цель ≥$1 — продаём по этой цене</p>
                          </label>
                        </div>
                      </div>
                      {/* Stale exit settings */}
                      <div className="border-t border-gray-700/60 pt-3">
                        <div className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wide">Защита от мёртвых сумок (авто-выход)</div>
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                          <label className="flex items-center gap-2 md:pt-6 text-sm text-gray-300">
                            <input type="checkbox" checked={editStaleExitEnabled} onChange={e => setEditStaleExitEnabled(e.target.checked)}
                              className="rounded border-gray-600 bg-gray-900 text-yellow-500" />
                            <span>Включить</span>
                          </label>
                          <label>
                            <span className="text-xs text-gray-500 block mb-1">Выход после (дней)</span>
                            <input type="number" min="1" max="90" step="1" value={editStaleExitDays} onChange={e => setEditStaleExitDays(e.target.value)}
                              disabled={!editStaleExitEnabled} className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white disabled:opacity-50" />
                          </label>
                          <label>
                            <span className="text-xs text-gray-500 block mb-1">Если цена упала на</span>
                            <div className="relative">
                              <input type="number" min="10" max="99" step="5" value={editStaleExitLossPct} onChange={e => setEditStaleExitLossPct(e.target.value)}
                                disabled={!editStaleExitEnabled} className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 pr-7 text-sm text-white disabled:opacity-50" />
                              <span className="absolute right-3 top-2 text-gray-500 text-sm">%</span>
                            </div>
                          </label>
                          <label>
                            <span className="text-xs text-gray-500 block mb-1">До закрытия рынка (ч)</span>
                            <input type="number" min="0" max="48" step="1" value={editPreCloseHours} onChange={e => setEditPreCloseHours(e.target.value)}
                              disabled={!editStaleExitEnabled} className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white disabled:opacity-50" />
                          </label>
                        </div>
                        <p className="text-xs text-gray-600 mt-1.5">Выходит если: позиция старше N дней И цена упала на X% ИЛИ рынок закрывается через &lt;N часов и цена ниже входа.</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <button onClick={() => saveEdit(w.id)} className="px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-sm text-white">Сохранить</button>
                        <button onClick={() => setEditingId(null)} className="text-gray-500 hover:text-white text-sm">Отмена</button>
                        <span className="text-xs text-gray-600">Auto-TP и stale exit работают только в LIVE режиме.</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Positions table with tabs */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
            Позиции {selectedWallet ? `(${shortAddr(selectedWallet)})` : '(все)'} — {posTotal}
          </h2>
          <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
            {POSITION_TABS.map(tab => (
              <button
                key={tab}
                onClick={() => { setPositionTab(tab); setPosPage(0); }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors ${
                  positionTab === tab ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {tab === 'open' ? 'Открытые' : tab === 'closed' ? 'Закрытые' : 'Все'}
              </button>
            ))}
          </div>
        </div>

        {positions.length === 0 ? (
          <div className="py-12 text-center text-gray-500 text-sm">
            {positionTab === 'open' ? 'Нет открытых позиций.' : positionTab === 'closed' ? 'Нет закрытых позиций.' : 'Нет позиций.'}
          </div>
        ) : (
          <>
            {selectedWallet ? (
              <PositionsTable positions={positions} showWalletColumn={false} />
            ) : (
              <div className="divide-y divide-gray-800">
                {Object.entries(positionsBySource).map(([source, sourcePositions]) => {
                  const isCollapsed = !!collapsedPositionSources[source];
                  const walletStats = source === 'unknown' ? null : getWalletStats(source);
                  return (
                    <div key={source}>
                      <button
                        onClick={() => setCollapsedPositionSources(prev => ({ ...prev, [source]: !prev[source] }))}
                        className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-gray-800/40 transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-gray-200">
                            Копируем от: {getWalletLabel(source === 'unknown' ? null : source)}
                          </div>
                          <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-3">
                            <span className="font-mono">{source === 'unknown' ? '—' : shortAddr(source)}</span>
                            <span>{sourcePositions.length} поз.</span>
                            {walletStats && <span>открыто: {walletStats.open}</span>}
                            {walletStats && <span className={(walletStats.unrealizedPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}>нереал. {fmt(walletStats.unrealizedPnl)}</span>}
                          </div>
                        </div>
                        <span className="text-gray-500">{isCollapsed ? '+' : '−'}</span>
                      </button>
                      {!isCollapsed && <PositionsTable positions={sourcePositions} showWalletColumn={false} />}
                    </div>
                  );
                })}
              </div>
            )}
            {totalPages > 1 && (
              <Pagination page={posPage} totalPages={totalPages} onPageChange={setPosPage} />
            )}
          </>
        )}
      </div>

      {/* Log — collapsible */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <button
          onClick={() => setShowLog(!showLog)}
          className="w-full px-5 py-3 flex items-center justify-between text-left text-sm font-semibold text-gray-300 hover:bg-gray-800/50 transition-colors"
        >
          <span>Лог копирования ({logTotal}) {selectedWallet ? `— ${shortAddr(selectedWallet)}` : ''}</span>
          <span className="text-gray-500">{showLog ? '−' : '+'}</span>
        </button>
        {showLog && (
          <div className="border-t border-gray-800">
            {logs.length === 0 ? (
              <p className="px-5 py-4 text-gray-500 text-sm">Нет записей. Включите кошельки и нажмите «Проверить сейчас».</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-800">
                        <th className="text-left py-2 pr-2 font-medium">Статус</th>
                        <th className="text-left py-2 pr-2 font-medium">Действие</th>
                        <th className="text-left py-2 pr-2 font-medium">Рынок</th>
                        <th className="text-left py-2 pr-2 font-medium">Исход</th>
                        <th className="text-right py-2 pr-2 font-medium">Цена</th>
                        <th className="text-right py-2 pr-2 font-medium">Сумма</th>
                        <th className="text-right py-2 font-medium">Время</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map(log => (
                        <tr key={log.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                          <td className="py-2 pr-2">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              log.status === 'COPIED' ? 'bg-green-500/20 text-green-400' :
                              log.status === 'FAILED' ? 'bg-red-500/20 text-red-400' :
                              'bg-gray-500/20 text-gray-400'
                            }`}>{log.status}</span>
                          </td>
                          <td className="py-2 pr-2">
                            <span className={`font-mono font-bold ${(log.action || 'BUY') === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{log.action || 'BUY'}</span>
                          </td>
                          <td className="py-2 pr-2 max-w-[200px] truncate text-gray-300" title={log.skipReason || log.marketTitle}>{log.marketTitle || log.marketId}</td>
                          <td className="py-2 pr-2">
                            <span className={`px-1 rounded ${log.outcome === 'YES' ? 'bg-blue-500/20 text-blue-300' : 'bg-orange-500/20 text-orange-300'}`}>{log.outcome}</span>
                          </td>
                          <td className="py-2 pr-2 text-right font-mono text-gray-400">{(log.copyPrice * 100).toFixed(1)}¢</td>
                          <td className="py-2 pr-2 text-right font-mono">${log.amount.toFixed(2)}</td>
                          <td className="py-2 text-right text-gray-600">{timeAgo(log.copiedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {logTotalPages > 1 && (
                  <Pagination page={logPage} totalPages={logTotalPages} onPageChange={setLogPage} />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${color ?? 'text-white'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-600 mt-0.5">{sub}</div>}
    </div>
  );
}

function PositionsTable({ positions, showWalletColumn }: { positions: LivePosition[]; showWalletColumn: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <th className="text-left py-2 pr-2 font-medium">Статус</th>
            <th className="text-left py-2 pr-2 font-medium">Исход</th>
            <th className="text-left py-2 pr-3 font-medium min-w-[180px]">Рынок</th>
            <th className="text-right py-2 pr-2 font-medium">Вход</th>
            <th className="text-right py-2 pr-2 font-medium">Текущ.</th>
            <th className="text-right py-2 pr-2 font-medium">Изм.</th>
            <th className="text-right py-2 pr-2 font-medium">Вложено</th>
            <th className="text-right py-2 pr-2 font-medium">P&L</th>
            <th className="text-right py-2 pr-2 font-medium">ROI</th>
            {showWalletColumn && <th className="text-left py-2 pr-2 font-medium">Кошелёк</th>}
            <th className="text-right py-2 font-medium">Время</th>
          </tr>
        </thead>
        <tbody>
          {positions.map(p => {
            const statusInfo = STATUS_STYLE[p.status] ?? { label: p.status, className: 'bg-gray-500/20 text-gray-400' };
            const cur = p.currentPrice ?? p.entryPrice;
            const changePct = p.entryPrice > 0 ? ((cur - p.entryPrice) / p.entryPrice) * 100 : 0;
            const pnl = p.pnl ?? 0;
            const roi = p.roi ?? 0;
            const isOpen = p.status === 'FILLED';
            return (
              <tr key={p.id} className="border-b border-gray-800/50 hover:bg-gray-800/30" title={p.errorMessage || undefined}>
                <td className="py-2.5 pr-2">
                  <span className={`px-1.5 py-0.5 rounded font-medium ${statusInfo.className}`}>{statusInfo.label}</span>
                </td>
                <td className="py-2.5 pr-2">
                  <span className={`px-1.5 rounded font-bold ${p.outcome === 'YES' ? 'bg-blue-500/20 text-blue-300' : 'bg-orange-500/20 text-orange-300'}`}>{p.outcome}</span>
                </td>
                <td className="py-2.5 pr-3 max-w-[200px] truncate text-gray-300" title={p.marketTitle}>{p.marketTitle || '—'}</td>
                <td className="py-2.5 pr-2 text-right font-mono text-gray-400">{(p.entryPrice * 100).toFixed(1)}¢</td>
                <td className="py-2.5 pr-2 text-right font-mono text-gray-400">
                  {isOpen && p.currentPrice !== null ? `${(p.currentPrice * 100).toFixed(1)}¢` : '—'}
                </td>
                <td className={`py-2.5 pr-2 text-right font-mono font-medium ${changePct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {isOpen ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%` : '—'}
                </td>
                <td className="py-2.5 pr-2 text-right font-mono text-gray-300">${p.invested.toFixed(2)}</td>
                <td className={`py-2.5 pr-2 text-right font-mono font-medium ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {isOpen ? fmt(pnl) : '—'}
                </td>
                <td className={`py-2.5 pr-2 text-right font-mono font-medium ${roi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {isOpen ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%` : '—'}
                </td>
                {showWalletColumn && (
                  <td className="py-2.5 pr-2 font-mono text-gray-600">{p.sourceWalletAddress ? shortAddr(p.sourceWalletAddress) : '—'}</td>
                )}
                <td className="py-2.5 text-right text-gray-600">{timeAgo(p.createdAt)}</td>
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
    <div className="flex items-center justify-between px-5 py-3 border-t border-gray-800">
      <button
        disabled={page === 0}
        onClick={() => onPageChange(page - 1)}
        className="px-3 py-1.5 text-xs rounded-md bg-gray-800 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        Назад
      </button>
      <span className="text-xs text-gray-500">
        {page + 1} / {totalPages}
      </span>
      <button
        disabled={page >= totalPages - 1}
        onClick={() => onPageChange(page + 1)}
        className="px-3 py-1.5 text-xs rounded-md bg-gray-800 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        Вперёд
      </button>
    </div>
  );
}

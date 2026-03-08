'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import EquityChart from '@/components/EquityChart';
import DemoTradeModal from '@/components/DemoTradeModal';

interface DemoTrade {
  id: string;
  eventId: string;
  eventTitle: string;
  marketId: string;
  marketQuestion: string;
  outcome: 'YES' | 'NO';
  amount: number;
  entryPrice: number;
  currentPrice?: number;
  exitPrice?: number;
  pnl?: number;
  roi?: number;
  status: 'OPEN' | 'CLOSED_WIN' | 'CLOSED_LOSS' | 'CLOSED_MANUAL';
  openedAt: string;
  closedAt?: string;
}

interface Balance {
  balance: number;
  invested: number;
  unrealizedPnl: number;
  total: number;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function pct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  OPEN: { label: 'Open', cls: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
  CLOSED_WIN: { label: 'Won', cls: 'bg-green-500/10 text-green-400 border-green-500/20' },
  CLOSED_LOSS: { label: 'Lost', cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
  CLOSED_MANUAL: { label: 'Closed', cls: 'bg-gray-700 text-gray-400 border-gray-600' },
};

function StatCard({ label, value, sub, positive }: { label: string; value: string; sub?: string; positive?: boolean }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-bold font-mono ${positive === true ? 'text-green-400' : positive === false ? 'text-red-400' : 'text-white'}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-gray-600 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function PortfolioPage() {
  const [trades, setTrades] = useState<DemoTrade[]>([]);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [activeTab, setActiveTab] = useState<'open' | 'closed' | 'all'>('open');
  const [refreshKey, setRefreshKey] = useState(0);
  const [tradeModal, setTradeModal] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [partialModal, setPartialModal] = useState<DemoTrade | null>(null);

  const fetchData = useCallback(() => {
    // Just read what's in DB without hitting Polymarket API
    api.get('/portfolio/demo/balance').then(r => setBalance(r.data)).catch(() => {});
    api.get('/portfolio/demo/trades').then(r => setTrades(r.data ?? [])).catch(() => {});
  }, []);

  const refreshPrices = useCallback(() => {
    setRefreshing(true);
    setRefreshKey(k => k + 1);
    api.post('/portfolio/demo/refresh-prices')
      .then(res => {
        setBalance(res.data);
        return api.get('/portfolio/demo/trades');
      })
      .then(res => {
        setTrades(res?.data ?? []);
        setLastRefreshed(new Date());
      })
      .catch(() => fetchData())
      .finally(() => setRefreshing(false));
  }, [fetchData]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function closeTrade(id: string) {
    if (!confirm('Close this position at current market price?')) return;
    setClosingId(id);
    try {
      await api.post(`/portfolio/demo/close/${id}`);
      refreshPrices();
    } catch (err: any) {
      alert(err.response?.data?.error ?? 'Failed to close trade');
    } finally {
      setClosingId(null);
    }
  }

  const filteredTrades = trades.filter(t => {
    if (activeTab === 'open') return t.status === 'OPEN';
    if (activeTab === 'closed') return t.status !== 'OPEN';
    return true;
  });

  const openTrades = trades.filter(t => t.status === 'OPEN');
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const winCount = closedTrades.filter(t => t.status === 'CLOSED_WIN').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Demo Portfolio</h1>
          <p className="text-gray-500 text-sm mt-1">Paper trading — practice strategies without real money</p>
          {lastRefreshed && (
            <p className="text-xs text-gray-600 mt-0.5">Prices updated {lastRefreshed.toLocaleTimeString()}</p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={refreshPrices}
            disabled={refreshing}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-3 py-2 rounded-xl text-sm transition-colors disabled:opacity-50"
          >
            {refreshing ? '⟳ Updating...' : '↻ Refresh Prices'}
          </button>
          <button
            onClick={() => setTradeModal(true)}
            className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-xl text-sm font-semibold transition-colors"
          >
            + Open Trade
          </button>
        </div>
      </div>

      {/* Balance stats */}
      {balance && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Available Balance" value={fmt(balance.balance)} sub="Demo USDC" />
          <StatCard label="Invested" value={fmt(balance.invested)} sub={`${openTrades.length} open positions`} />
          <StatCard
            label="Unrealized P&L"
            value={fmt(balance.unrealizedPnl)}
            positive={balance.unrealizedPnl >= 0}
          />
          <StatCard
            label="Realized P&L"
            value={fmt(totalPnl)}
            sub={closedTrades.length > 0 ? `${winCount}/${closedTrades.length} wins` : 'No closed trades'}
            positive={totalPnl >= 0}
          />
        </div>
      )}

      {/* Equity curve */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-base font-semibold text-white mb-4">Equity Curve</h2>
        <EquityChart refreshKey={refreshKey} startingBalance={10000} />
      </div>

      {/* Trades table */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-base font-semibold text-white">Positions</h2>
          <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
            {(['open', 'closed', 'all'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors ${
                  activeTab === tab ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {tab} {tab === 'open' ? `(${openTrades.length})` : tab === 'closed' ? `(${closedTrades.length})` : `(${trades.length})`}
              </button>
            ))}
          </div>
        </div>

        {filteredTrades.length === 0 ? (
          <div className="py-12 text-center text-gray-500 text-sm">
            {activeTab === 'open' ? (
              <>
                <div className="text-3xl mb-3">📂</div>
                <div>No open positions</div>
                <button onClick={() => setTradeModal(true)} className="mt-3 text-green-400 hover:text-green-300 text-sm">
                  Open your first trade →
                </button>
              </>
            ) : 'No trades here yet'}
          </div>
        ) : (
          <div className="divide-y divide-gray-800/60">
            {filteredTrades.map(trade => {
              const statusInfo = STATUS_STYLE[trade.status];
              // currentPrice=0 means not yet updated — fall back to entryPrice so we don't show 0¢
              const currentPrice = (trade.currentPrice && trade.currentPrice > 0)
                ? trade.currentPrice
                : trade.entryPrice;
              const priceChange = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

              return (
                <div key={trade.id} className="px-5 py-4 hover:bg-gray-800/20 transition-colors">
                  <div className="flex items-start gap-4">
                    {/* Outcome badge */}
                    <div className={`shrink-0 px-2 py-1 rounded-lg text-xs font-bold border ${
                      trade.outcome === 'YES' ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'
                    }`}>
                      {trade.outcome}
                    </div>

                    {/* Market info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-xs text-gray-500 truncate">{trade.eventTitle}</span>
                        {trade.eventId && (
                          <Link
                            href={`/events/${trade.eventId}`}
                            className="flex-shrink-0 text-[10px] text-blue-400 hover:text-blue-300 border border-blue-500/20 px-1.5 py-0.5 rounded hover:bg-blue-500/10 transition-colors"
                            title="Открыть событие"
                          >
                            ↗ событие
                          </Link>
                        )}
                      </div>
                      <div className="text-sm font-medium text-gray-100 line-clamp-1">{trade.marketQuestion}</div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                        <span>Opened {new Date(trade.openedAt).toLocaleDateString()}</span>
                        {trade.closedAt && <span>Closed {new Date(trade.closedAt).toLocaleDateString()}</span>}
                      </div>
                    </div>

                    {/* Prices */}
                    <div className="shrink-0 text-right space-y-1">
                      <div className="text-xs text-gray-500">Entry / Now</div>
                      <div className="text-sm font-mono">
                        <span className="text-gray-300">{(trade.entryPrice * 100).toFixed(0)}¢</span>
                        {trade.status === 'OPEN' && (
                          <>
                            <span className="text-gray-600"> → </span>
                            <span className={priceChange >= 0 ? 'text-green-400' : 'text-red-400'}>
                              {(currentPrice * 100).toFixed(0)}¢
                            </span>
                          </>
                        )}
                        {trade.exitPrice !== undefined && (
                          <>
                            <span className="text-gray-600"> → </span>
                            <span className={trade.pnl !== undefined && trade.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                              {(trade.exitPrice * 100).toFixed(0)}¢
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Amount + P&L */}
                    <div className="shrink-0 text-right space-y-0.5">
                      <div className="text-sm font-medium text-white">{fmt(trade.amount)}</div>
                      {trade.pnl !== undefined && (
                        <div className={`text-sm font-bold font-mono ${trade.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {trade.pnl >= 0 ? '+' : ''}{fmt(trade.pnl)}
                        </div>
                      )}
                      {trade.roi !== undefined && (
                        <div className={`text-xs ${trade.roi >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          {pct(trade.roi)}
                        </div>
                      )}
                    </div>

                    {/* Status + actions */}
                    <div className="shrink-0 flex flex-col items-end gap-1.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${statusInfo.cls}`}>
                        {statusInfo.label}
                      </span>
                      {trade.status === 'OPEN' && (
                        <div className="flex flex-col gap-1">
                          <button
                            onClick={() => closeTrade(trade.id)}
                            disabled={closingId === trade.id}
                            className="text-xs text-orange-400 hover:text-orange-300 border border-orange-500/20 hover:border-orange-500/40 px-2 py-1 rounded-lg transition-colors"
                          >
                            {closingId === trade.id ? '...' : 'Close 100%'}
                          </button>
                          <button
                            onClick={() => setPartialModal(trade)}
                            className="text-xs text-yellow-400 hover:text-yellow-300 border border-yellow-500/20 hover:border-yellow-500/40 px-2 py-1 rounded-lg transition-colors"
                          >
                            Partial ✂
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Demo trade modal */}
      {tradeModal && (
        <ManualTradeEntry
          onClose={() => setTradeModal(false)}
          onSuccess={() => { setTradeModal(false); refreshPrices(); }}
        />
      )}

      {/* Partial close modal */}
      {partialModal && (
        <PartialCloseModal
          trade={partialModal}
          onClose={() => setPartialModal(null)}
          onSuccess={() => { setPartialModal(null); refreshPrices(); }}
        />
      )}
    </div>
  );
}

// Partial close modal
function PartialCloseModal({ trade, onClose, onSuccess }: {
  trade: DemoTrade;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [fraction, setFraction] = useState(50); // percentage slider 1–99
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const closeAmount = (trade.amount * fraction / 100);
  const remainAmount = trade.amount - closeAmount;

  async function handleSubmit() {
    setLoading(true);
    setError('');
    try {
      await api.post(`/portfolio/demo/close-partial/${trade.id}`, { fraction: fraction / 100 });
      onSuccess();
    } catch (err: any) {
      setError(err.response?.data?.error ?? 'Failed to partially close');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-white">Partial Close ✂</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">×</button>
        </div>

        <div className="bg-gray-800/60 rounded-xl p-3 mb-4 text-sm">
          <div className="text-gray-400 text-xs mb-1 truncate">{trade.marketQuestion}</div>
          <div className="flex justify-between text-white font-mono">
            <span className={trade.outcome === 'YES' ? 'text-green-400' : 'text-red-400'}>{trade.outcome}</span>
            <span>{fmt(trade.amount)}</span>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-xs text-gray-400 mb-2">
              <span>Закрыть {fraction}%</span>
              <span className="font-mono text-white">{fmt(closeAmount)}</span>
            </div>
            <input
              type="range"
              min={1}
              max={99}
              value={fraction}
              onChange={e => setFraction(Number(e.target.value))}
              className="w-full accent-yellow-400"
            />
            <div className="flex justify-between text-[10px] text-gray-600 mt-1">
              <span>1%</span>
              <span>Останется: {fmt(remainAmount)}</span>
              <span>99%</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {[25, 50, 75].map(p => (
              <button
                key={p}
                onClick={() => setFraction(p)}
                className={`py-1.5 rounded-lg text-xs font-medium border transition-all ${
                  fraction === p ? 'bg-yellow-500/20 border-yellow-500/40 text-yellow-300' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                }`}
              >
                {p}%
              </button>
            ))}
          </div>

          {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs px-3 py-2 rounded-lg">{error}</div>}

          <button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full py-3 bg-yellow-600 hover:bg-yellow-500 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50"
          >
            {loading ? 'Closing...' : `Close ${fraction}% (${fmt(closeAmount)})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// Simplified manual trade entry (when no specific event is pre-selected)
function ManualTradeEntry({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [marketId, setMarketId] = useState('');
  const [outcome, setOutcome] = useState<'YES' | 'NO'>('YES');
  const [amount, setAmount] = useState('100');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (!marketId) return setError('Enter a market ID');
    const amountNum = parseFloat(amount);
    if (amountNum <= 0) return setError('Enter valid amount');
    setLoading(true);
    setError('');
    try {
      await api.post('/portfolio/demo/open', {
        marketId,
        outcome,
        amount: amountNum,
      });
      onSuccess();
    } catch (err: any) {
      setError(err.response?.data?.error ?? 'Failed to open trade');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-white">Open Demo Trade</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">×</button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-gray-400 mb-1.5 block">Market ID (from Polymarket)</label>
            <input
              value={marketId}
              onChange={e => setMarketId(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm font-mono focus:outline-none focus:border-blue-500"
              placeholder="e.g. 0xabc123..."
            />
            <div className="text-xs text-gray-600 mt-1">Find market IDs on the Events page</div>
          </div>
          <div className="flex gap-2">
            {(['YES', 'NO'] as const).map(side => (
              <button
                key={side}
                onClick={() => setOutcome(side)}
                className={`flex-1 py-2.5 rounded-xl border text-sm font-semibold transition-all ${
                  outcome === side
                    ? side === 'YES' ? 'bg-green-600 border-green-500 text-white' : 'bg-red-600 border-red-500 text-white'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                }`}
              >
                {side}
              </button>
            ))}
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1.5 block">Amount (USDC)</label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white font-mono focus:outline-none focus:border-blue-500"
            />
          </div>
          {error && <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs px-3 py-2 rounded-lg">{error}</div>}
          <button onClick={handleSubmit} disabled={loading} className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50">
            {loading ? 'Opening...' : 'Open Position'}
          </button>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import api from '@/lib/api';

interface TradeModalProps {
  eventId: string;
  eventTitle: string;
  marketId: string;
  marketQuestion: string;
  prices: number[];
  outcomes: string[];
  tags?: string[];
  onClose: () => void;
  onSuccess: (trade: any, newBalance: number) => void;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export default function DemoTradeModal({
  eventId, eventTitle, marketId, marketQuestion,
  prices, outcomes, tags, onClose, onSuccess,
}: TradeModalProps) {
  const [selectedOutcome, setSelectedOutcome] = useState<'YES' | 'NO'>('YES');
  const [amount, setAmount] = useState('100');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const yesPrice = prices[0] ?? 0.5;
  const noPrice = prices[1] ?? (1 - yesPrice);
  const entryPrice = selectedOutcome === 'YES' ? yesPrice : noPrice;
  const amountNum = parseFloat(amount) || 0;
  const potentialWin = entryPrice > 0 ? amountNum / entryPrice : 0;
  const potentialRoi = entryPrice > 0 ? (1 / entryPrice - 1) * 100 : 0;

  async function handleSubmit() {
    if (amountNum <= 0) return setError('Enter a valid amount');
    setLoading(true);
    setError('');
    try {
      const res = await api.post('/portfolio/demo/open', {
        eventId,
        eventTitle,
        marketId,
        marketQuestion,
        outcome: selectedOutcome,
        amount: amountNum,
        tags: tags ?? [],
      });
      onSuccess(res.data.trade, res.data.newBalance);
    } catch (err: any) {
      setError(err.response?.data?.error ?? 'Failed to open trade');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md shadow-2xl mx-4">
        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-gray-500 mb-1 truncate">{eventTitle}</div>
            <h2 className="text-base font-semibold text-white leading-snug line-clamp-2">{marketQuestion}</h2>
          </div>
          <button onClick={onClose} className="ml-3 text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Outcome selector */}
        <div className="flex gap-2 mb-5">
          {(['YES', 'NO'] as const).map(side => {
            const price = side === 'YES' ? yesPrice : noPrice;
            const roi = price > 0 ? (1 / price - 1) * 100 : 0;
            const selected = selectedOutcome === side;
            return (
              <button
                key={side}
                onClick={() => setSelectedOutcome(side)}
                className={`flex-1 rounded-xl p-3 border transition-all ${
                  selected
                    ? side === 'YES'
                      ? 'bg-green-500/15 border-green-500/60 ring-1 ring-green-500/30'
                      : 'bg-red-500/15 border-red-500/60 ring-1 ring-red-500/30'
                    : 'bg-gray-800 border-gray-700 hover:border-gray-500'
                }`}
              >
                <div className="text-xs text-gray-400 mb-1">{outcomes[side === 'YES' ? 0 : 1] ?? side}</div>
                <div className={`text-2xl font-bold font-mono ${side === 'YES' ? 'text-green-400' : 'text-red-400'}`}>
                  {(price * 100).toFixed(0)}¢
                </div>
                {roi > 5 && (
                  <div className="text-xs text-yellow-400 mt-0.5">
                    {roi >= 10000 ? `${(roi / 100).toFixed(0)}x ROI` : `+${roi.toFixed(0)}% ROI`}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Amount input */}
        <div className="mb-5">
          <label className="text-xs text-gray-400 mb-2 block">Bet amount (USDC)</label>
          <div className="flex gap-2">
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              min="1"
              step="10"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-lg font-mono focus:outline-none focus:border-blue-500"
              placeholder="100"
            />
            <div className="flex flex-col gap-1">
              {[50, 100, 500].map(v => (
                <button
                  key={v}
                  onClick={() => setAmount(String(v))}
                  className="bg-gray-800 border border-gray-700 hover:border-gray-500 rounded-lg px-3 py-1 text-xs text-gray-400 hover:text-white"
                >
                  ${v}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Preview */}
        {amountNum > 0 && (
          <div className="bg-gray-800/60 rounded-xl p-4 mb-5 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">Risk (max loss)</span>
              <span className="text-red-400 font-mono">${amountNum.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">If wins</span>
              <span className="text-green-400 font-mono">${potentialWin.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm font-bold border-t border-gray-700 pt-2">
              <span className="text-gray-300">Potential ROI</span>
              <span className="text-yellow-400 font-mono">
                {potentialRoi >= 10000 ? `${(potentialRoi / 100).toFixed(0)}x` : `+${potentialRoi.toFixed(0)}%`}
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-4 py-2 rounded-xl mb-4">
            {error}
          </div>
        )}

        <div className="text-xs text-gray-600 text-center mb-3">Demo paper trading — no real money involved</div>

        <button
          onClick={handleSubmit}
          disabled={loading || amountNum <= 0}
          className={`w-full py-3 rounded-xl font-semibold text-sm transition-all ${
            selectedOutcome === 'YES'
              ? 'bg-green-600 hover:bg-green-500 text-white disabled:bg-green-900 disabled:text-green-700'
              : 'bg-red-600 hover:bg-red-500 text-white disabled:bg-red-900 disabled:text-red-700'
          }`}
        >
          {loading ? 'Opening...' : `Open ${selectedOutcome} position — $${amountNum}`}
        </button>
      </div>
    </div>
  );
}

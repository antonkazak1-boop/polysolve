'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import api from '@/lib/api';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CoinInfo {
  coin: string;
  symbol: string;
  price: number;
  change24h: number;
  change7d: number;
  high24h: number;
  low24h: number;
}

interface CryptoMarket {
  marketId: string;
  eventId: string;
  eventSlug: string;
  question: string;
  coin: string;
  symbol: string;
  spotPrice: number;
  strike: number;
  strikeHigh?: number;
  direction: 'above' | 'below' | 'between';
  distancePct: number;
  distanceAbs: number;
  hoursLeft: number;
  expiryLabel: string;
  marketYesPrice: number;
  marketNoPrice: number;
  impliedProbMarket: number;
  fairValue: number;
  edge: number;
  edgePct: number;
  signal: 'BUY_YES' | 'BUY_NO' | 'FAIR' | 'SKIP';
  signalStrength: 'strong' | 'moderate' | 'weak';
  kellyFraction: number;
  expectedValue: number;
  volume24h: number;
  liquidity: number;
  oneDayChange: number;
}

interface Summary {
  totalMarkets: number;
  marketsWithEdge: number;
  strongEdge: number;
  avgEdge: number;
}

interface ModelInfo {
  type: string;
  vols: Record<string, number>;
  note: string;
}

type SortKey = 'edge' | 'distance' | 'expiry' | 'ev' | 'volume';
type FilterCoin = 'all' | 'bitcoin' | 'ethereum' | 'solana';
type FilterSignal = 'all' | 'edge' | 'strong';
type FilterDirection = 'all' | 'above' | 'below' | 'between';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPrice(n: number): string {
  if (n >= 1000) return `$${n.toLocaleString('en', { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function pct(v: number, signed = true): string {
  const sign = signed && v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function pmUrl(slug?: string) {
  return slug ? `https://polymarket.com/event/${slug}` : 'https://polymarket.com';
}

const COIN_ICONS: Record<string, string> = { bitcoin: '₿', ethereum: 'Ξ', solana: '◎' };
const COIN_COLORS: Record<string, string> = {
  bitcoin: 'text-orange-400',
  ethereum: 'text-blue-400',
  solana: 'text-purple-400',
};

// ─── Coin card ──────────────────────────────────────────────────────────────

function CoinCard({ coin }: { coin: CoinInfo }) {
  const icon = COIN_ICONS[coin.coin] ?? '●';
  const color = COIN_COLORS[coin.coin] ?? 'text-gray-400';

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex-1 min-w-[180px]">
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-2xl ${color}`}>{icon}</span>
        <div>
          <div className="text-sm font-bold text-white">{coin.symbol.toUpperCase()}</div>
          <div className="text-[10px] text-gray-500 capitalize">{coin.coin}</div>
        </div>
      </div>
      <div className="text-xl font-bold text-white font-mono mb-1">{fmtPrice(coin.price)}</div>
      <div className="flex gap-3 text-xs">
        <span className={coin.change24h >= 0 ? 'text-green-400' : 'text-red-400'}>
          24h {pct(coin.change24h)}
        </span>
        <span className={coin.change7d >= 0 ? 'text-green-400' : 'text-red-400'}>
          7d {pct(coin.change7d)}
        </span>
      </div>
      <div className="flex gap-3 text-[10px] text-gray-600 mt-1">
        <span>H: {fmtPrice(coin.high24h)}</span>
        <span>L: {fmtPrice(coin.low24h)}</span>
      </div>
    </div>
  );
}

// ─── Edge gauge visual ──────────────────────────────────────────────────────

function EdgeGauge({ edge, fairValue, marketPrice }: { edge: number; fairValue: number; marketPrice: number }) {
  const absEdge = Math.abs(edge);
  const barWidth = Math.min(100, absEdge * 200);
  const isPositive = edge > 0; // underpriced YES

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-gray-500">Market</span>
        <span className="text-gray-500">Fair Value</span>
      </div>
      <div className="relative h-6 bg-gray-800 rounded-full overflow-hidden">
        {/* Market price marker */}
        <div
          className="absolute top-0 h-full w-0.5 bg-gray-400 z-10"
          style={{ left: `${marketPrice * 100}%` }}
        />
        {/* Fair value marker */}
        <div
          className="absolute top-0 h-full w-1 bg-yellow-400 z-10 rounded"
          style={{ left: `${fairValue * 100}%` }}
        />
        {/* Edge zone */}
        <div
          className={`absolute top-0 h-full ${isPositive ? 'bg-green-500/20' : 'bg-red-500/20'}`}
          style={{
            left: `${Math.min(marketPrice, fairValue) * 100}%`,
            width: `${absEdge * 100}%`,
          }}
        />
        {/* Labels */}
        <div
          className="absolute top-0.5 text-[9px] font-mono font-bold z-20"
          style={{ left: `${marketPrice * 100 + 1}%` }}
        >
          <span className="text-gray-300">{(marketPrice * 100).toFixed(0)}¢</span>
        </div>
        <div
          className="absolute top-0.5 text-[9px] font-mono font-bold z-20"
          style={{ left: `${fairValue * 100 + 1}%` }}
        >
          <span className="text-yellow-300">{(fairValue * 100).toFixed(0)}¢</span>
        </div>
      </div>
      <div className="flex items-center justify-center gap-1 text-xs">
        <span className={isPositive ? 'text-green-400' : 'text-red-400'}>
          Edge: {pct(edge * 100, true)}
        </span>
      </div>
    </div>
  );
}

// ─── Distance visual ────────────────────────────────────────────────────────

function DistanceBar({ spot, strike, strikeHigh, direction }: {
  spot: number;
  strike: number;
  strikeHigh?: number;
  direction: string;
}) {
  const range = direction === 'between' && strikeHigh
    ? { lo: strike, hi: strikeHigh }
    : direction === 'below'
      ? { lo: strike * 0.9, hi: spot * 1.05 }
      : { lo: spot * 0.95, hi: strike * 1.1 };

  const total = range.hi - range.lo;
  const spotPct = Math.max(0, Math.min(100, ((spot - range.lo) / total) * 100));
  const strikePct = Math.max(0, Math.min(100, ((strike - range.lo) / total) * 100));
  const strikeHighPct = strikeHigh ? Math.max(0, Math.min(100, ((strikeHigh - range.lo) / total) * 100)) : null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] text-gray-500">
        <span>{fmtPrice(range.lo)}</span>
        <span>{fmtPrice(range.hi)}</span>
      </div>
      <div className="relative h-4 bg-gray-800 rounded-full overflow-hidden">
        {/* Strike zone */}
        {direction === 'between' && strikeHighPct !== null ? (
          <div
            className="absolute top-0 h-full bg-yellow-500/15 border-l border-r border-yellow-500/40"
            style={{ left: `${strikePct}%`, width: `${strikeHighPct - strikePct}%` }}
          />
        ) : (
          <div
            className={`absolute top-0 h-full ${direction === 'above' ? 'bg-green-500/10' : 'bg-red-500/10'}`}
            style={direction === 'above'
              ? { left: `${strikePct}%`, width: `${100 - strikePct}%` }
              : { left: '0%', width: `${strikePct}%` }
            }
          />
        )}
        {/* Strike line */}
        <div className="absolute top-0 h-full w-0.5 bg-yellow-400/60" style={{ left: `${strikePct}%` }} />
        {strikeHighPct !== null && (
          <div className="absolute top-0 h-full w-0.5 bg-yellow-400/60" style={{ left: `${strikeHighPct}%` }} />
        )}
        {/* Spot */}
        <div
          className="absolute top-0 h-full w-1.5 bg-white rounded z-10"
          style={{ left: `${Math.max(0, spotPct - 0.5)}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-white font-mono">Spot: {fmtPrice(spot)}</span>
        <span className="text-yellow-400 font-mono">
          {direction === 'between' && strikeHigh
            ? `${fmtPrice(strike)}–${fmtPrice(strikeHigh)}`
            : `Strike: ${fmtPrice(strike)}`}
        </span>
      </div>
    </div>
  );
}

// ─── Market card ────────────────────────────────────────────────────────────

function CryptoMarketCard({ m }: { m: CryptoMarket }) {
  const icon = COIN_ICONS[m.coin] ?? '●';
  const color = COIN_COLORS[m.coin] ?? 'text-gray-400';
  const hasEdge = m.signal === 'BUY_YES' || m.signal === 'BUY_NO';

  const signalColors = {
    BUY_YES: 'bg-green-500/15 text-green-400 border-green-500/30',
    BUY_NO: 'bg-red-500/15 text-red-400 border-red-500/30',
    FAIR: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
    SKIP: 'bg-gray-800 text-gray-600 border-gray-700',
  };

  const strengthDots = {
    strong: '●●●',
    moderate: '●●○',
    weak: '●○○',
  };

  const dirLabel = m.direction === 'between'
    ? `${fmtPrice(m.strike)}–${fmtPrice(m.strikeHigh!)}`
    : m.direction === 'above'
      ? `> ${fmtPrice(m.strike)}`
      : `< ${fmtPrice(m.strike)}`;

  return (
    <div className={`bg-gray-900 border rounded-xl p-5 transition-all hover:border-gray-600 ${
      hasEdge && m.signalStrength === 'strong'
        ? 'border-yellow-500/30'
        : hasEdge
          ? 'border-gray-700'
          : 'border-gray-800'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`text-lg ${color}`}>{icon}</span>
          <span className="text-xs text-gray-500 uppercase font-medium">{m.symbol}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
            m.direction === 'above' ? 'bg-green-500/10 text-green-400 border-green-500/20' :
            m.direction === 'below' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
            'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
          }`}>
            {m.direction.toUpperCase()} {dirLabel}
          </span>
        </div>
        <span className="text-xs text-gray-500">{m.expiryLabel}</span>
      </div>

      {/* Question */}
      <div className="text-sm font-medium text-gray-100 mb-4 leading-snug line-clamp-2">{m.question}</div>

      {/* Distance visualization */}
      <div className="mb-4">
        <DistanceBar spot={m.spotPrice} strike={m.strike} strikeHigh={m.strikeHigh} direction={m.direction} />
      </div>

      {/* Edge gauge */}
      <div className="mb-4">
        <EdgeGauge edge={m.edge} fairValue={m.fairValue} marketPrice={m.marketYesPrice} />
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-2 text-center bg-gray-800/40 rounded-lg py-2.5 px-2 mb-4">
        <div>
          <div className="text-[10px] text-gray-500">Distance</div>
          <div className={`text-sm font-bold font-mono ${Math.abs(m.distancePct) < 3 ? 'text-green-400' : Math.abs(m.distancePct) < 10 ? 'text-yellow-400' : 'text-red-400'}`}>
            {pct(m.distancePct, true)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500">Mkt Price</div>
          <div className="text-sm font-bold font-mono text-white">{(m.marketYesPrice * 100).toFixed(1)}¢</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500">Fair Value</div>
          <div className="text-sm font-bold font-mono text-yellow-400">{(m.fairValue * 100).toFixed(1)}¢</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500">EV / $1</div>
          <div className={`text-sm font-bold font-mono ${m.expectedValue > 0 ? 'text-green-400' : 'text-red-400'}`}>
            {m.expectedValue > 0 ? '+' : ''}{m.expectedValue.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Signal + Kelly */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border ${signalColors[m.signal]}`}>
            {m.signal === 'BUY_YES' ? '▲ BUY YES' : m.signal === 'BUY_NO' ? '▼ BUY NO' : '— FAIR'}
          </span>
          {hasEdge && (
            <span className={`text-[10px] ${
              m.signalStrength === 'strong' ? 'text-yellow-400' :
              m.signalStrength === 'moderate' ? 'text-gray-400' : 'text-gray-600'
            }`}>
              {strengthDots[m.signalStrength]}
            </span>
          )}
        </div>
        {hasEdge && m.kellyFraction > 0 && (
          <div className="text-right">
            <div className="text-[10px] text-gray-500">Kelly %</div>
            <div className="text-xs font-bold text-blue-400 font-mono">{(m.kellyFraction * 100).toFixed(1)}%</div>
          </div>
        )}
      </div>

      {/* Bottom row */}
      <div className="flex items-center justify-between text-[10px] text-gray-600">
        <div className="flex gap-3">
          <span>Vol 24h: {fmt(m.volume24h)}</span>
          <span>Liq: {fmt(m.liquidity)}</span>
        </div>
        <a
          href={pmUrl(m.eventSlug)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-green-500 hover:text-green-300 transition-colors font-medium"
        >
          Trade on PM ↗
        </a>
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function CryptoPage() {
  const [coins, setCoins] = useState<CoinInfo[]>([]);
  const [markets, setMarkets] = useState<CryptoMarket[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [filterCoin, setFilterCoin] = useState<FilterCoin>('all');
  const [filterSignal, setFilterSignal] = useState<FilterSignal>('edge');
  const [filterDirection, setFilterDirection] = useState<FilterDirection>('all');
  const [sortBy, setSortBy] = useState<SortKey>('edge');

  const fetchData = useCallback(async () => {
    setError('');
    try {
      const res = await api.get('/crypto');
      setCoins(res.data.coins || []);
      setMarkets(res.data.markets || []);
      setSummary(res.data.summary || null);
      setModel(res.data.model || null);
    } catch {
      setError('Failed to load crypto data. Is the backend running?');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchData().finally(() => setLoading(false));
  }, [fetchData]);

  const filtered = useMemo(() => {
    let result = [...markets];

    if (filterCoin !== 'all') result = result.filter(m => m.coin === filterCoin);
    if (filterSignal === 'edge') result = result.filter(m => m.signal === 'BUY_YES' || m.signal === 'BUY_NO');
    if (filterSignal === 'strong') result = result.filter(m => (m.signal === 'BUY_YES' || m.signal === 'BUY_NO') && m.signalStrength === 'strong');
    if (filterDirection !== 'all') result = result.filter(m => m.direction === filterDirection);

    const sortFns: Record<SortKey, (a: CryptoMarket, b: CryptoMarket) => number> = {
      edge: (a, b) => Math.abs(b.edge) - Math.abs(a.edge),
      distance: (a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct),
      expiry: (a, b) => a.hoursLeft - b.hoursLeft,
      ev: (a, b) => b.expectedValue - a.expectedValue,
      volume: (a, b) => b.volume24h - a.volume24h,
    };
    result.sort(sortFns[sortBy]);

    return result;
  }, [markets, filterCoin, filterSignal, filterDirection, sortBy]);

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-2xl">₿</span>
          <h1 className="text-2xl font-bold text-white">Crypto Options Analyzer</h1>
        </div>
        <p className="text-gray-400 text-sm">
          Polymarket crypto price markets as binary options — fair value via Black-Scholes, edge detection, Kelly sizing.
        </p>
      </div>

      {/* Coin prices */}
      <div className="flex gap-4 flex-wrap">
        {coins.map(c => <CoinCard key={c.coin} coin={c} />)}
      </div>

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-white">{summary.totalMarkets}</div>
            <div className="text-xs text-gray-500">Crypto Markets</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-yellow-400">{summary.marketsWithEdge}</div>
            <div className="text-xs text-gray-500">With Edge</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-green-400">{summary.strongEdge}</div>
            <div className="text-xs text-gray-500">Strong Edge</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-blue-400">{summary.avgEdge}%</div>
            <div className="text-xs text-gray-500">Avg Edge %</div>
          </div>
        </div>
      )}

      {/* Model info */}
      {model && (
        <div className="bg-blue-500/5 border border-blue-500/10 rounded-xl px-4 py-3 text-xs text-gray-400">
          <span className="text-blue-400 font-medium">Model:</span> {model.type}
          {' · '}Vols: {Object.entries(model.vols).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(', ')}
          {' · '}<span className="text-gray-600">{model.note}</span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Coin filter */}
        <div className="flex gap-1 bg-gray-900 rounded-lg p-1 border border-gray-800">
          {(['all', 'bitcoin', 'ethereum', 'solana'] as FilterCoin[]).map(c => (
            <button
              key={c}
              onClick={() => setFilterCoin(c)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                filterCoin === c ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {c === 'all' ? 'All' : (COIN_ICONS[c] ?? '') + ' ' + c.charAt(0).toUpperCase() + c.slice(1)}
            </button>
          ))}
        </div>

        {/* Signal filter */}
        <div className="flex gap-1 bg-gray-900 rounded-lg p-1 border border-gray-800">
          {([
            { key: 'all', label: 'All' },
            { key: 'edge', label: 'With Edge' },
            { key: 'strong', label: 'Strong Only' },
          ] as { key: FilterSignal; label: string }[]).map(f => (
            <button
              key={f.key}
              onClick={() => setFilterSignal(f.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                filterSignal === f.key ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Direction filter */}
        <div className="flex gap-1 bg-gray-900 rounded-lg p-1 border border-gray-800">
          {([
            { key: 'all', label: 'All' },
            { key: 'above', label: '↑ Above' },
            { key: 'below', label: '↓ Below' },
            { key: 'between', label: '↔ Range' },
          ] as { key: FilterDirection; label: string }[]).map(d => (
            <button
              key={d.key}
              onClick={() => setFilterDirection(d.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                filterDirection === d.key ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[10px] text-gray-600 uppercase">Sort by</span>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as SortKey)}
            className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-gray-600"
          >
            <option value="edge">Edge (abs)</option>
            <option value="distance">Distance to strike</option>
            <option value="expiry">Expiry (soonest)</option>
            <option value="ev">Expected Value</option>
            <option value="volume">Volume 24h</option>
          </select>
        </div>
      </div>

      {/* Count */}
      <div className="text-xs text-gray-600">
        Showing {filtered.length} of {markets.length} crypto markets
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4 text-sm text-red-400">{error}</div>
      )}

      {/* Markets grid */}
      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-5 animate-pulse h-80" />
          ))}
        </div>
      ) : filtered.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map(m => <CryptoMarketCard key={m.marketId} m={m} />)}
        </div>
      ) : (
        <div className="text-center py-16 text-gray-500">
          <div className="text-4xl mb-3">₿</div>
          <div>No crypto markets match filters</div>
          <div className="text-xs mt-2 text-gray-600">Try widening the filters</div>
        </div>
      )}
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import api from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamRating {
  team: string;
  wr: number;
  mapWins: number;
  mapLosses: number;
  series: number;
  recentForm: number;
}

interface LoLMarket {
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  marketId: string;
  question: string;
  type: string;
  teams: string[];
  format: string;
  pMarketYes: number;
  pMarketNo: number;
  volume: number;
  liquidity: number;
}

interface EdgeResult {
  market: LoLMarket;
  teamA: string;
  teamB: string;
  pModel: number;
  pMarket: number;
  edge: number;
  edgePct: string;
  confidence: string;
  kellyStake: number;
  simulation: MCResult;
}

interface MCResult {
  pSeriesWin: number;
  scoreDistribution: Record<string, number>;
  pOver: Record<string, number>;
  pHandicap: Record<string, number>;
  avgMaps: number;
  elapsedMs: number;
  nSims: number;
  pMap: number;
}

interface PlayerProfile {
  name: string;
  score: number;
  games: number;
  winRate: number;
  kda: number;
  seasons: string[];
}

interface DraftPickDetail {
  side: 'blue' | 'red';
  player?: string;
  champion: string;
  championMeta: number;
  playerProficiency: number;
  playerGames: number;
  combined: number;
}

interface FactorBreakdown {
  matchHistory: {
    wrA: number;
    wrB: number;
    delta: number;
    mapsA: number;
    mapsB: number;
    seriesA: number;
    seriesB: number;
  };
  playerStats?: {
    scoreA: number;
    scoreB: number;
    delta: number;
    playersA: PlayerProfile[];
    playersB: PlayerProfile[];
  };
  draft?: {
    scoreA: number;
    scoreB: number;
    delta: number;
    picks: DraftPickDetail[];
  };
}

interface CompositePrediction {
  pMap: number;
  factors: FactorBreakdown;
  weights: { matchHistory: number; playerStats: number; draft: number };
  seasonsUsed: string[];
}

interface PredictionResult {
  teamA: string;
  teamB: string;
  format: string;
  pMap: number;
  pModel: number;
  simulation: MCResult;
  draftApplied: boolean;
  composite: CompositePrediction;
}

interface ChampionPower {
  champion: string;
  metaScore: number;
  winrate: number;
  picks: number;
  gd15: number;
}

interface PlayerSearchResult {
  name: string;
  games: number;
  seasons: string[];
}

type Tab = 'scanner' | 'simulator' | 'draft';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function edgeColor(edge: number): string {
  if (edge >= 0.05) return 'text-green-400';
  if (edge >= 0.02) return 'text-green-300/80';
  if (edge <= -0.05) return 'text-red-400';
  if (edge <= -0.02) return 'text-red-300/80';
  return 'text-gray-400';
}

function confBadge(c: string) {
  const colors: Record<string, string> = {
    high: 'bg-green-500/20 text-green-300 border-green-500/30',
    medium: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    low: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  };
  return `text-[10px] px-1.5 py-0.5 rounded border ${colors[c] ?? colors.low}`;
}

function deltaColor(v: number) {
  if (v > 0.01) return 'text-green-400';
  if (v < -0.01) return 'text-red-400';
  return 'text-gray-400';
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PredictorPage() {
  const [tab, setTab] = useState<Tab>('simulator');

  // Scanner state
  const [edges, setEdges] = useState<EdgeResult[]>([]);
  const [markets, setMarkets] = useState<LoLMarket[]>([]);
  const [scanLoading, setScanLoading] = useState(false);

  // Team ratings
  const [ratings, setRatings] = useState<TeamRating[]>([]);

  // Simulator state
  const [teamA, setTeamA] = useState('');
  const [teamB, setTeamB] = useState('');
  const [format, setFormat] = useState<'BO1' | 'BO3' | 'BO5'>('BO3');
  const [simResult, setSimResult] = useState<PredictionResult | null>(null);
  const [simLoading, setSimLoading] = useState(false);

  // Draft state
  const [champions, setChampions] = useState<ChampionPower[]>([]);
  const [blueDraft, setBlueDraft] = useState<{ champion: string; player: string }[]>(
    Array.from({ length: 5 }, () => ({ champion: '', player: '' })),
  );
  const [redDraft, setRedDraft] = useState<{ champion: string; player: string }[]>(
    Array.from({ length: 5 }, () => ({ champion: '', player: '' })),
  );
  const [draftResult, setDraftResult] = useState<PredictionResult | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);

  // ── Loaders ──────────────────────────────────────────────────────────────

  const loadRatings = useCallback(async () => {
    try {
      const { data } = await api.get<{ ratings: TeamRating[] }>('/lol/golgg/predictor/ratings');
      setRatings(data.ratings);
      if (!teamA && data.ratings.length >= 2) {
        setTeamA(data.ratings[0].team);
        setTeamB(data.ratings[1].team);
      }
    } catch { /* empty */ }
  }, [teamA]);

  const loadChampions = useCallback(async () => {
    try {
      const { data } = await api.get<{ champions: ChampionPower[] }>('/lol/golgg/predictor/champions');
      setChampions(data.champions);
    } catch { /* empty */ }
  }, []);

  const scanMarkets = useCallback(async () => {
    setScanLoading(true);
    try {
      const { data } = await api.get<{ edges: EdgeResult[] }>('/lol/golgg/predictor/edges');
      setEdges(data.edges);
    } catch {
      try {
        const { data } = await api.get<{ markets: LoLMarket[] }>('/lol/golgg/predictor/markets');
        setMarkets(data.markets);
      } catch { /* empty */ }
    } finally {
      setScanLoading(false);
    }
  }, []);

  const runSimulation = useCallback(async () => {
    if (!teamA || !teamB) return;
    setSimLoading(true);
    try {
      const { data } = await api.get<PredictionResult>('/lol/golgg/predictor/edge', {
        params: { teamA, teamB, format },
      });
      setSimResult(data);
    } catch { /* empty */ }
    finally { setSimLoading(false); }
  }, [teamA, teamB, format]);

  const runDraft = useCallback(async () => {
    if (!teamA || !teamB) return;
    const bFilled = blueDraft.filter(d => d.champion);
    const rFilled = redDraft.filter(d => d.champion);
    if (bFilled.length !== 5 || rFilled.length !== 5) return;
    setDraftLoading(true);
    try {
      const { data } = await api.post<PredictionResult>('/lol/golgg/predictor/draft', {
        teamA,
        teamB,
        format,
        blueDraft: bFilled.map(d => ({ champion: d.champion, player: d.player || undefined })),
        redDraft: rFilled.map(d => ({ champion: d.champion, player: d.player || undefined })),
      });
      setDraftResult(data);
    } catch { /* empty */ }
    finally { setDraftLoading(false); }
  }, [teamA, teamB, format, blueDraft, redDraft]);

  useEffect(() => {
    void loadRatings();
    void loadChampions();
  }, [loadRatings, loadChampions]);

  useEffect(() => {
    if (tab === 'scanner' && edges.length === 0 && markets.length === 0) void scanMarkets();
  }, [tab, edges.length, markets.length, scanMarkets]);

  // ── Score distribution chart data ────────────────────────────────────────

  function scoreChartData(dist: Record<string, number>) {
    return Object.entries(dist)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([score, prob]) => ({ score, prob: Math.round(prob * 1000) / 10 }));
  }

  // ── Champion selector with autocomplete ──────────────────────────────────

  function ChampSelect({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
  }) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const filtered = champions.filter(
      (c) => c.champion.toLowerCase().includes(search.toLowerCase()) && c.picks > 5,
    );
    return (
      <div className="relative">
        <input
          type="text"
          value={value || search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (value) onChange('');
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-white"
        />
        {open && search.length > 0 && (
          <div className="absolute z-50 top-full left-0 w-full bg-gray-900 border border-gray-700 rounded mt-0.5 max-h-40 overflow-y-auto">
            {filtered.slice(0, 15).map((c) => (
              <button
                key={c.champion}
                onClick={() => {
                  onChange(c.champion);
                  setSearch('');
                  setOpen(false);
                }}
                className="w-full text-left px-2 py-1 text-xs hover:bg-gray-800 text-gray-300"
              >
                {c.champion}{' '}
                <span className="text-gray-500">
                  ({c.winrate.toFixed(0)}% wr, {c.picks}p)
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Player selector with API autocomplete ────────────────────────────────

  function PlayerInput({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
  }) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [results, setResults] = useState<PlayerSearchResult[]>([]);

    const doSearch = useCallback(async (q: string) => {
      if (q.length < 2) { setResults([]); return; }
      try {
        const { data } = await api.get<{ players: PlayerSearchResult[] }>('/lol/golgg/predictor/players', {
          params: { q },
        });
        setResults(data.players);
      } catch { setResults([]); }
    }, []);

    return (
      <div className="relative">
        <input
          type="text"
          value={value || search}
          onChange={(e) => {
            const v = e.target.value;
            setSearch(v);
            if (value) onChange('');
            setOpen(true);
            void doSearch(v);
          }}
          onFocus={() => { setOpen(true); if (search.length >= 2) void doSearch(search); }}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          placeholder={placeholder}
          className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-white/70"
        />
        {open && results.length > 0 && (
          <div className="absolute z-50 top-full left-0 w-full bg-gray-900 border border-gray-700 rounded mt-0.5 max-h-40 overflow-y-auto">
            {results.map((p) => (
              <button
                key={p.name}
                onClick={() => {
                  onChange(p.name);
                  setSearch('');
                  setOpen(false);
                }}
                className="w-full text-left px-2 py-1 text-xs hover:bg-gray-800 text-gray-300"
              >
                {p.name}{' '}
                <span className="text-gray-500">
                  ({p.games}g · {p.seasons.join(',')})
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Factor breakdown card ────────────────────────────────────────────────

  function FactorBreakdownCard({ comp, teamA: tA, teamB: tB }: { comp: CompositePrediction; teamA: string; teamB: string }) {
    const { factors, weights } = comp;
    return (
      <div className="bg-gray-900/40 border border-gray-800 rounded-xl p-4 space-y-4">
        <h3 className="text-sm font-medium text-gray-300">Factor Breakdown</h3>

        {/* Match History */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-gray-500 w-28">Match History</span>
            <span className="text-gray-400">×{weights.matchHistory}</span>
            <span className={`font-mono ml-auto ${deltaColor(factors.matchHistory.delta)}`}>
              {factors.matchHistory.delta >= 0 ? '+' : ''}{(factors.matchHistory.delta * 100).toFixed(1)}%
            </span>
          </div>
          <div className="flex gap-4 text-[11px] text-gray-500 pl-2">
            <span className="text-blue-400">{tA}: {(factors.matchHistory.wrA * 100).toFixed(1)}% wr ({factors.matchHistory.mapsA}W, {factors.matchHistory.seriesA} series)</span>
            <span className="text-red-400">{tB}: {(factors.matchHistory.wrB * 100).toFixed(1)}% wr ({factors.matchHistory.mapsB}W, {factors.matchHistory.seriesB} series)</span>
          </div>
        </div>

        {/* Player Stats */}
        {factors.playerStats && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-500 w-28">Player Stats</span>
              <span className="text-gray-400">×{weights.playerStats}</span>
              <span className={`font-mono ml-auto ${deltaColor(factors.playerStats.delta)}`}>
                {factors.playerStats.delta >= 0 ? '+' : ''}{(factors.playerStats.delta * 100).toFixed(1)}%
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] pl-2">
              <div className="space-y-0.5">
                <div className="text-blue-400 font-medium">Blue ({(factors.playerStats.scoreA * 100).toFixed(1)} pts)</div>
                {factors.playerStats.playersA.map(p => (
                  <div key={p.name} className="text-gray-500 flex justify-between">
                    <span>{p.name}</span>
                    <span className="font-mono">{p.winRate.toFixed(0)}% WR · {p.kda.toFixed(1)} KDA · {p.games}g</span>
                  </div>
                ))}
              </div>
              <div className="space-y-0.5">
                <div className="text-red-400 font-medium">Red ({(factors.playerStats.scoreB * 100).toFixed(1)} pts)</div>
                {factors.playerStats.playersB.map(p => (
                  <div key={p.name} className="text-gray-500 flex justify-between">
                    <span>{p.name}</span>
                    <span className="font-mono">{p.winRate.toFixed(0)}% WR · {p.kda.toFixed(1)} KDA · {p.games}g</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Draft */}
        {factors.draft && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-500 w-28">Draft Quality</span>
              <span className="text-gray-400">×{weights.draft}</span>
              <span className={`font-mono ml-auto ${deltaColor(factors.draft.delta)}`}>
                {factors.draft.delta >= 0 ? '+' : ''}{(factors.draft.delta * 100).toFixed(1)}%
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] pl-2">
              {(['blue', 'red'] as const).map(side => {
                const picks = factors.draft!.picks.filter(p => p.side === side);
                return (
                  <div key={side} className="space-y-0.5">
                    <div className={`font-medium ${side === 'blue' ? 'text-blue-400' : 'text-red-400'}`}>
                      {side === 'blue' ? tA : tB} ({(side === 'blue' ? factors.draft!.scoreA : factors.draft!.scoreB).toFixed(3)})
                    </div>
                    {picks.map((p, i) => (
                      <div key={i} className="flex justify-between text-gray-500">
                        <span>{p.champion} {p.player ? `(${p.player})` : ''}</span>
                        <span className="font-mono">
                          M:{p.championMeta > 0 ? '+' : ''}{p.championMeta.toFixed(2)}
                          {p.player ? ` P:${p.playerProficiency > 0 ? '+' : ''}${p.playerProficiency.toFixed(2)} (${p.playerGames}g)` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="border-t border-gray-800 pt-2 flex items-center gap-3 text-[11px] text-gray-500">
          <span>Seasons: {comp.seasonsUsed.join(', ')}</span>
          <span>pMap: {pct(comp.pMap)}</span>
          {!factors.playerStats && <span className="text-yellow-500/70">Player stats not provided</span>}
        </div>
      </div>
    );
  }

  // ── Win probability bar ──────────────────────────────────────────────────

  function WinBar({ result }: { result: PredictionResult }) {
    return (
      <div className="bg-gray-900/40 border border-gray-800 rounded-xl p-5 space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-blue-400 font-medium">{result.teamA}</span>
          <span className="text-red-400 font-medium">{result.teamB}</span>
        </div>
        <div className="flex h-8 rounded-lg overflow-hidden">
          <div
            className="bg-blue-500 flex items-center justify-center text-white text-xs font-bold transition-all"
            style={{ width: `${result.pModel * 100}%` }}
          >
            {pct(result.pModel)}
          </div>
          <div
            className="bg-red-500 flex items-center justify-center text-white text-xs font-bold transition-all"
            style={{ width: `${(1 - result.pModel) * 100}%` }}
          >
            {pct(1 - result.pModel)}
          </div>
        </div>
        <div className="flex justify-between text-xs text-gray-500">
          <span>
            Per-map: {pct(result.pMap)} | {result.simulation.nSims} sims
            in {result.simulation.elapsedMs}ms
          </span>
          <span>Avg maps: {result.simulation.avgMaps}</span>
        </div>
      </div>
    );
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  const TABS: { id: Tab; label: string }[] = [
    { id: 'scanner', label: 'Market Scanner' },
    { id: 'simulator', label: 'Match Simulator' },
    { id: 'draft', label: 'Draft Calculator' },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-gray-200 p-6 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">
              LoL Composite Predictor
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Match history + Player stats + Champion meta + Monte Carlo | gol.gg data across S14-S16
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/lol/golgg/stats"
              className="text-sm text-gray-400 hover:text-gray-200 border border-gray-700 rounded-lg px-3 py-2"
            >
              Stats DB
            </Link>
            <Link
              href="/lol/golgg"
              className="text-sm text-gray-400 hover:text-gray-200 border border-gray-700 rounded-lg px-3 py-2"
            >
              Game viewer
            </Link>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-800">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'text-white border-b-2 border-blue-500'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Market Scanner ──────────────────────────────────────────────── */}
        {tab === 'scanner' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-400">
                Scans active LoL markets on Polymarket, computes model probability, shows edge.
              </p>
              <button
                onClick={scanMarkets}
                disabled={scanLoading}
                className="text-sm bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg disabled:opacity-50"
              >
                {scanLoading ? 'Scanning...' : 'Rescan'}
              </button>
            </div>

            {edges.length > 0 ? (
              <div className="overflow-x-auto border border-gray-800 rounded-xl">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-800 bg-gray-900/40">
                      {['Market', 'Type', 'Polymarket', 'Model', 'Edge', 'Kelly', 'Conf', 'Vol'].map(
                        (h) => (
                          <th key={h} className="px-3 py-2 whitespace-nowrap">{h}</th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {edges.map((e, i) => (
                      <tr key={i} className="border-b border-gray-800/50 hover:bg-white/[0.02]">
                        <td className="px-3 py-2 text-white max-w-48 truncate">
                          <a
                            href={`https://polymarket.com/event/${e.market.eventSlug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-blue-400"
                          >
                            {e.market.question}
                          </a>
                        </td>
                        <td className="px-3 py-2 text-gray-400">{e.market.type}</td>
                        <td className="px-3 py-2 font-mono">{pct(e.pMarket)}</td>
                        <td className="px-3 py-2 font-mono font-medium text-white">{pct(e.pModel)}</td>
                        <td className={`px-3 py-2 font-mono font-bold ${edgeColor(e.edge)}`}>
                          {e.edgePct}
                        </td>
                        <td className="px-3 py-2 font-mono">
                          {e.kellyStake > 0 ? `${(e.kellyStake * 100).toFixed(1)}%` : '\u2014'}
                        </td>
                        <td className="px-3 py-2">
                          <span className={confBadge(e.confidence)}>{e.confidence}</span>
                        </td>
                        <td className="px-3 py-2 text-gray-400">
                          ${Math.round(e.market.volume).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : markets.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs text-gray-500">
                  No match_winner markets resolved to our DB teams. Raw markets:
                </p>
                <div className="overflow-x-auto border border-gray-800 rounded-xl">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500 border-b border-gray-800 bg-gray-900/40">
                        {['Market', 'Type', 'Yes', 'No', 'Vol'].map((h) => (
                          <th key={h} className="px-3 py-2">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {markets.map((m, i) => (
                        <tr key={i} className="border-b border-gray-800/50">
                          <td className="px-3 py-2 text-white max-w-60 truncate">{m.question}</td>
                          <td className="px-3 py-2 text-gray-400">{m.type}</td>
                          <td className="px-3 py-2 font-mono">{pct(m.pMarketYes)}</td>
                          <td className="px-3 py-2 font-mono">{pct(m.pMarketNo)}</td>
                          <td className="px-3 py-2 text-gray-400">
                            ${Math.round(m.volume).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : scanLoading ? (
              <div className="text-gray-500 text-sm py-8 text-center">Scanning Polymarket...</div>
            ) : (
              <div className="border border-gray-800 rounded-xl p-6 text-center text-gray-500 text-sm">
                No active LoL markets found on Polymarket.
              </div>
            )}
          </div>
        )}

        {/* ── Match Simulator ─────────────────────────────────────────────── */}
        {tab === 'simulator' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_auto] gap-3 items-end">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Team A (Blue)</label>
                <select
                  value={teamA}
                  onChange={(e) => setTeamA(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="">Select team...</option>
                  {ratings.map((r) => (
                    <option key={r.team} value={r.team}>
                      {r.team} ({r.wr}% WR)
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-gray-600 text-sm font-bold self-end pb-2">vs</div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Team B (Red)</label>
                <select
                  value={teamB}
                  onChange={(e) => setTeamB(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="">Select team...</option>
                  {ratings.map((r) => (
                    <option key={r.team} value={r.team}>
                      {r.team} ({r.wr}% WR)
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Format</label>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as 'BO1' | 'BO3' | 'BO5')}
                  className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="BO1">BO1</option>
                  <option value="BO3">BO3</option>
                  <option value="BO5">BO5</option>
                </select>
              </div>
              <button
                onClick={runSimulation}
                disabled={simLoading || !teamA || !teamB}
                className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-5 py-2 rounded-lg disabled:opacity-50 self-end"
              >
                {simLoading ? 'Simulating...' : 'Simulate 3000x'}
              </button>
            </div>

            {simResult && (
              <div className="space-y-4">
                <WinBar result={simResult} />

                {simResult.composite && (
                  <FactorBreakdownCard comp={simResult.composite} teamA={simResult.teamA} teamB={simResult.teamB} />
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-gray-900/40 border border-gray-800 rounded-xl p-4">
                    <h3 className="text-sm font-medium text-gray-300 mb-3">Score Distribution</h3>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={scoreChartData(simResult.simulation.scoreDistribution)}>
                        <XAxis dataKey="score" tick={{ fill: '#9ca3af', fontSize: 11 }} />
                        <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} unit="%" />
                        <Tooltip
                          contentStyle={{ background: '#1f2937', border: '1px solid #374151' }}
                          labelStyle={{ color: '#fff' }}
                        />
                        <Bar dataKey="prob" radius={[4, 4, 0, 0]}>
                          {scoreChartData(simResult.simulation.scoreDistribution).map((entry, i) => {
                            const [a] = entry.score.split('-').map(Number);
                            return <Cell key={i} fill={a > Number(entry.score.split('-')[1]) ? '#3b82f6' : '#ef4444'} />;
                          })}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="bg-gray-900/40 border border-gray-800 rounded-xl p-4 space-y-3">
                    <h3 className="text-sm font-medium text-gray-300 mb-2">Derived Markets</h3>
                    {Object.entries(simResult.simulation.pOver).map(([threshold, p]) => (
                      <div key={threshold} className="flex justify-between text-xs">
                        <span className="text-gray-400">Total Maps Over {threshold}</span>
                        <span className="font-mono text-white">{pct(p)}</span>
                      </div>
                    ))}
                    {Object.entries(simResult.simulation.pHandicap).map(([margin, p]) => (
                      <div key={margin} className="flex justify-between text-xs">
                        <span className="text-gray-400">
                          {simResult.teamA} Handicap {margin}
                        </span>
                        <span className="font-mono text-white">{pct(p)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Draft Calculator ────────────────────────────────────────────── */}
        {tab === 'draft' && (
          <div className="space-y-4">
            <div className="bg-purple-500/10 border border-purple-500/30 rounded-xl p-4">
              <p className="text-xs text-gray-400 leading-relaxed">
                Pick 5 champions per side. Optionally add player names to factor in
                <span className="text-white font-medium"> player-champion proficiency</span> from{' '}
                <span className="text-white font-medium">~47K champion pool records</span> across S14-S16.
              </p>
            </div>

            {/* Team selectors */}
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto] gap-3 items-end">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Team A (Blue Side)</label>
                <select
                  value={teamA}
                  onChange={(e) => setTeamA(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="">Select team...</option>
                  {ratings.map((r) => (
                    <option key={r.team} value={r.team}>{r.team} ({r.wr}%)</option>
                  ))}
                </select>
              </div>
              <div className="text-gray-600 text-sm font-bold self-end pb-2">vs</div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Team B (Red Side)</label>
                <select
                  value={teamB}
                  onChange={(e) => setTeamB(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="">Select team...</option>
                  {ratings.map((r) => (
                    <option key={r.team} value={r.team}>{r.team} ({r.wr}%)</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Format</label>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as 'BO1' | 'BO3' | 'BO5')}
                  className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="BO1">BO1</option>
                  <option value="BO3">BO3</option>
                  <option value="BO5">BO5</option>
                </select>
              </div>
            </div>

            {/* Draft picks */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 space-y-2">
                <h3 className="text-sm font-medium text-blue-400">Blue Side</h3>
                {blueDraft.map((pick, i) => (
                  <div key={`blue-${i}`} className="grid grid-cols-[1fr_1fr] gap-1">
                    <ChampSelect
                      value={pick.champion}
                      onChange={(v) => { const n = [...blueDraft]; n[i] = { ...n[i], champion: v }; setBlueDraft(n); }}
                      placeholder={`Champion ${i + 1}`}
                    />
                    <PlayerInput
                      value={pick.player}
                      onChange={(v) => { const n = [...blueDraft]; n[i] = { ...n[i], player: v }; setBlueDraft(n); }}
                      placeholder={`Player ${i + 1} (opt)`}
                    />
                  </div>
                ))}
              </div>
              <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 space-y-2">
                <h3 className="text-sm font-medium text-red-400">Red Side</h3>
                {redDraft.map((pick, i) => (
                  <div key={`red-${i}`} className="grid grid-cols-[1fr_1fr] gap-1">
                    <ChampSelect
                      value={pick.champion}
                      onChange={(v) => { const n = [...redDraft]; n[i] = { ...n[i], champion: v }; setRedDraft(n); }}
                      placeholder={`Champion ${i + 1}`}
                    />
                    <PlayerInput
                      value={pick.player}
                      onChange={(v) => { const n = [...redDraft]; n[i] = { ...n[i], player: v }; setRedDraft(n); }}
                      placeholder={`Player ${i + 1} (opt)`}
                    />
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={runDraft}
              disabled={draftLoading || !teamA || !teamB || blueDraft.filter(d => d.champion).length !== 5 || redDraft.filter(d => d.champion).length !== 5}
              className="w-full bg-purple-600 hover:bg-purple-500 text-white text-sm py-3 rounded-lg disabled:opacity-50 font-medium"
            >
              {draftLoading ? 'Calculating...' : 'Predict with Draft'}
            </button>

            {draftResult && (
              <div className="space-y-4">
                <WinBar result={draftResult} />

                {draftResult.composite && (
                  <FactorBreakdownCard comp={draftResult.composite} teamA={draftResult.teamA} teamB={draftResult.teamB} />
                )}

                <div className="bg-gray-900/40 border border-gray-800 rounded-xl p-4">
                  <h3 className="text-sm font-medium text-gray-300 mb-3">Score Distribution</h3>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={scoreChartData(draftResult.simulation.scoreDistribution)}>
                      <XAxis dataKey="score" tick={{ fill: '#9ca3af', fontSize: 11 }} />
                      <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} unit="%" />
                      <Tooltip
                        contentStyle={{ background: '#1f2937', border: '1px solid #374151' }}
                        labelStyle={{ color: '#fff' }}
                      />
                      <Bar dataKey="prob" radius={[4, 4, 0, 0]}>
                        {scoreChartData(draftResult.simulation.scoreDistribution).map((entry, i) => {
                          const [a] = entry.score.split('-').map(Number);
                          return <Cell key={i} fill={a > Number(entry.score.split('-')[1]) ? '#3b82f6' : '#ef4444'} />;
                        })}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Team Ratings reference ──────────────────────────────────────── */}
        {(tab === 'simulator' || tab === 'draft') && ratings.length > 0 && (
          <details className="border border-gray-800 rounded-xl">
            <summary className="px-4 py-3 text-sm text-gray-400 cursor-pointer hover:text-gray-300">
              Team Strength Rankings ({ratings.length} teams)
            </summary>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-800 bg-gray-900/40">
                    {['#', 'Team', 'WR%', 'Map W', 'Map L', 'Series', 'Form (45d)'].map((h) => (
                      <th key={h} className="px-3 py-2">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ratings.slice(0, 50).map((r, i) => (
                    <tr key={r.team} className="border-b border-gray-800/50">
                      <td className="px-3 py-1 text-gray-600">{i + 1}</td>
                      <td className="px-3 py-1 text-white font-medium">{r.team}</td>
                      <td className="px-3 py-1 font-mono">{r.wr}%</td>
                      <td className="px-3 py-1 text-green-400">{r.mapWins}</td>
                      <td className="px-3 py-1 text-red-400">{r.mapLosses}</td>
                      <td className="px-3 py-1">{r.series}</td>
                      <td className="px-3 py-1 font-mono">{r.recentForm}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

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
  elo: number;
  matches: number;
  wins: number;
  losses: number;
  winRate: number;
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
  eloA: number;
  eloB: number;
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

interface PredictionResult {
  teamA: string;
  teamB: string;
  format: string;
  eloA: number;
  eloB: number;
  pMap: number;
  pModel: number;
  simulation: MCResult;
  draftApplied: boolean;
  pBase?: number;
  pDraftDelta?: number;
  draft?: {
    adjustment: number;
    bluePower: number;
    redPower: number;
    blueChampions: { champion: string; powerScore: number; winrate: number }[];
    redChampions: { champion: string; powerScore: number; winrate: number }[];
  };
}

interface ChampionPower {
  champion: string;
  winrate: number;
  picks: number;
  powerScore: number;
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function PredictorPage() {
  const [tab, setTab] = useState<Tab>('scanner');

  // Scanner state
  const [edges, setEdges] = useState<EdgeResult[]>([]);
  const [markets, setMarkets] = useState<LoLMarket[]>([]);
  const [scanLoading, setScanLoading] = useState(false);

  // Simulator state
  const [ratings, setRatings] = useState<TeamRating[]>([]);
  const [teamA, setTeamA] = useState('');
  const [teamB, setTeamB] = useState('');
  const [format, setFormat] = useState<'BO1' | 'BO3' | 'BO5'>('BO3');
  const [simResult, setSimResult] = useState<PredictionResult | null>(null);
  const [simLoading, setSimLoading] = useState(false);

  // Draft state
  const [champions, setChampions] = useState<ChampionPower[]>([]);
  const [blueDraft, setBlueDraft] = useState<string[]>(['', '', '', '', '']);
  const [redDraft, setRedDraft] = useState<string[]>(['', '', '', '', '']);
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
    const bFilled = blueDraft.filter(Boolean);
    const rFilled = redDraft.filter(Boolean);
    if (bFilled.length !== 5 || rFilled.length !== 5) return;
    setDraftLoading(true);
    try {
      const { data } = await api.post<PredictionResult>('/lol/golgg/predictor/draft', {
        teamA,
        teamB,
        format,
        blueDraft: bFilled,
        redDraft: rFilled,
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

  // ── Champion selector ────────────────────────────────────────────────────

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
                  ({c.winrate.toFixed(0)}% wr, {c.picks} picks)
                </span>
              </button>
            ))}
          </div>
        )}
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
              LoL Predictor + Edge Finder
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Elo ratings + Monte Carlo simulation + Polymarket odds comparison
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
                Scans active LoL markets on Polymarket, computes model probability via Elo + MC, shows edge.
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
                          {e.kellyStake > 0 ? `${(e.kellyStake * 100).toFixed(1)}%` : '—'}
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
                  No match_winner markets resolved to our DB teams. Raw markets below:
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
                <label className="text-xs text-gray-500 block mb-1">Team A</label>
                <select
                  value={teamA}
                  onChange={(e) => setTeamA(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="">Select team...</option>
                  {ratings.map((r) => (
                    <option key={r.team} value={r.team}>
                      {r.team} ({r.elo} Elo)
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-gray-600 text-sm font-bold self-end pb-2">vs</div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Team B</label>
                <select
                  value={teamB}
                  onChange={(e) => setTeamB(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                >
                  <option value="">Select team...</option>
                  {ratings.map((r) => (
                    <option key={r.team} value={r.team}>
                      {r.team} ({r.elo} Elo)
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
                {/* Win probability bar */}
                <div className="bg-gray-900/40 border border-gray-800 rounded-xl p-5 space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-blue-400 font-medium">
                      {simResult.teamA} ({simResult.eloA} Elo)
                    </span>
                    <span className="text-red-400 font-medium">
                      {simResult.teamB} ({simResult.eloB} Elo)
                    </span>
                  </div>
                  <div className="flex h-8 rounded-lg overflow-hidden">
                    <div
                      className="bg-blue-500 flex items-center justify-center text-white text-xs font-bold transition-all"
                      style={{ width: `${simResult.pModel * 100}%` }}
                    >
                      {pct(simResult.pModel)}
                    </div>
                    <div
                      className="bg-red-500 flex items-center justify-center text-white text-xs font-bold transition-all"
                      style={{ width: `${(1 - simResult.pModel) * 100}%` }}
                    >
                      {pct(1 - simResult.pModel)}
                    </div>
                  </div>
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>
                      Per-map probability: {pct(simResult.pMap)} | {simResult.simulation.nSims} sims
                      in {simResult.simulation.elapsedMs}ms
                    </span>
                    <span>Avg maps: {simResult.simulation.avgMaps}</span>
                  </div>
                </div>

                {/* Score distribution */}
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
            {/* Redirect banner */}
            <div className="bg-violet-500/10 border border-violet-500/30 rounded-xl p-5 space-y-3">
              <div className="flex items-start gap-3">
                <div className="text-2xl">🧪</div>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-violet-200 mb-1">
                    Draft Analyzer — Oracle Elixir Edition
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    The full draft analysis has been upgraded and moved to a dedicated page.
                    It uses <span className="text-white font-medium">22 000+ pro games from Oracle&apos;s Elixir</span> (2024–2026)
                    and includes champion tier, role-weighted synergies, lane matchups with scaling detection,
                    player comfort coefficients, configurable data weights (T1 ×10), pre-draft team strength prior,
                    and built-in Monte Carlo simulation.
                  </p>
                </div>
              </div>
              <Link
                href="/lol/draft"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors"
              >
                Open Draft Analyzer →
              </Link>
            </div>

            {/* Legacy quick draft — still functional for Elo-only fast check */}
            <details className="border border-gray-800 rounded-xl">
              <summary className="px-4 py-3 text-sm text-gray-400 cursor-pointer hover:text-gray-300 select-none">
                Legacy draft (gol.gg champion power, Elo-only model)
              </summary>
              <div className="p-4 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto] gap-3 items-end">
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Team A (Blue Side)</label>
                    <select value={teamA} onChange={(e) => setTeamA(e.target.value)}
                      className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
                      <option value="">Select team...</option>
                      {ratings.map((r) => <option key={r.team} value={r.team}>{r.team} ({r.elo})</option>)}
                    </select>
                  </div>
                  <div className="text-gray-600 text-sm font-bold self-end pb-2">vs</div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Team B (Red Side)</label>
                    <select value={teamB} onChange={(e) => setTeamB(e.target.value)}
                      className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
                      <option value="">Select team...</option>
                      {ratings.map((r) => <option key={r.team} value={r.team}>{r.team} ({r.elo})</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Format</label>
                    <select value={format} onChange={(e) => setFormat(e.target.value as 'BO1' | 'BO3' | 'BO5')}
                      className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
                      <option value="BO1">BO1</option><option value="BO3">BO3</option><option value="BO5">BO5</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 space-y-2">
                    <h3 className="text-sm font-medium text-blue-400">Blue Side</h3>
                    {blueDraft.map((champ, i) => (
                      <ChampSelect key={`blue-${i}`} value={champ}
                        onChange={(v) => { const n = [...blueDraft]; n[i] = v; setBlueDraft(n); }}
                        placeholder={`Champion ${i + 1}`} />
                    ))}
                  </div>
                  <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 space-y-2">
                    <h3 className="text-sm font-medium text-red-400">Red Side</h3>
                    {redDraft.map((champ, i) => (
                      <ChampSelect key={`red-${i}`} value={champ}
                        onChange={(v) => { const n = [...redDraft]; n[i] = v; setRedDraft(n); }}
                        placeholder={`Champion ${i + 1}`} />
                    ))}
                  </div>
                </div>

                <button onClick={runDraft}
                  disabled={draftLoading || !teamA || !teamB || blueDraft.filter(Boolean).length !== 5 || redDraft.filter(Boolean).length !== 5}
                  className="w-full bg-purple-600 hover:bg-purple-500 text-white text-sm py-3 rounded-lg disabled:opacity-50 font-medium">
                  {draftLoading ? 'Calculating...' : 'Calculate (Legacy)'}
                </button>

                {draftResult && (
                  <div className="space-y-4">
                    <div className="bg-gray-900/40 border border-gray-800 rounded-xl p-5 space-y-4">
                      <div className="grid grid-cols-3 gap-4 text-center">
                        <div>
                          <div className="text-xs text-gray-500 mb-1">Base (Elo only)</div>
                          <div className="text-xl font-bold text-gray-300">{draftResult.pBase != null ? pct(draftResult.pBase) : '—'}</div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500 mb-1">Draft Shift</div>
                          <div className={`text-xl font-bold ${(draftResult.pDraftDelta ?? 0) > 0 ? 'text-green-400' : (draftResult.pDraftDelta ?? 0) < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                            {draftResult.pDraftDelta != null ? `${draftResult.pDraftDelta >= 0 ? '+' : ''}${(draftResult.pDraftDelta * 100).toFixed(1)}%` : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500 mb-1">Final</div>
                          <div className="text-xl font-bold text-white">{pct(draftResult.pModel)}</div>
                        </div>
                      </div>
                      <div className="flex h-8 rounded-lg overflow-hidden">
                        <div className="bg-blue-500 flex items-center justify-center text-white text-xs font-bold transition-all" style={{ width: `${draftResult.pModel * 100}%` }}>
                          {draftResult.teamA} {pct(draftResult.pModel)}
                        </div>
                        <div className="bg-red-500 flex items-center justify-center text-white text-xs font-bold transition-all" style={{ width: `${(1 - draftResult.pModel) * 100}%` }}>
                          {draftResult.teamB} {pct(1 - draftResult.pModel)}
                        </div>
                      </div>
                    </div>
                    <div className="bg-gray-900/40 border border-gray-800 rounded-xl p-4">
                      <h3 className="text-sm font-medium text-gray-300 mb-3">Score Distribution</h3>
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={scoreChartData(draftResult.simulation.scoreDistribution)}>
                          <XAxis dataKey="score" tick={{ fill: '#9ca3af', fontSize: 11 }} />
                          <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} unit="%" />
                          <Tooltip contentStyle={{ background: '#1f2937', border: '1px solid #374151' }} labelStyle={{ color: '#fff' }} />
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
            </details>
          </div>
        )}

        {/* ── Elo Ratings reference ──────────────────────────────────────── */}
        {(tab === 'simulator' || tab === 'draft') && ratings.length > 0 && (
          <details className="border border-gray-800 rounded-xl">
            <summary className="px-4 py-3 text-sm text-gray-400 cursor-pointer hover:text-gray-300">
              Team Elo Ratings ({ratings.length} teams)
            </summary>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-800 bg-gray-900/40">
                    {['#', 'Team', 'Elo', 'W', 'L', 'WR%'].map((h) => (
                      <th key={h} className="px-3 py-2">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ratings.slice(0, 40).map((r, i) => (
                    <tr key={r.team} className="border-b border-gray-800/50">
                      <td className="px-3 py-1 text-gray-600">{i + 1}</td>
                      <td className="px-3 py-1 text-white font-medium">{r.team}</td>
                      <td className="px-3 py-1 font-mono">{r.elo}</td>
                      <td className="px-3 py-1 text-green-400">{r.wins}</td>
                      <td className="px-3 py-1 text-red-400">{r.losses}</td>
                      <td className="px-3 py-1">{r.winRate}%</td>
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

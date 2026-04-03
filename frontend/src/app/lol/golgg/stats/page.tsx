'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Summary {
  tournaments: number;
  matches: number;
  champions: number;
  players: number;
  playerChampionRows: number;
  snapshots: number;
  lastScrapeAt: string | null;
}

interface ChampRow {
  id: string;
  champion: string;
  picks: number;
  bans: number;
  prioScore: string;
  wins: number;
  losses: number;
  winrate: string;
  kda: string;
  csm: number;
  dpm: number;
  gpm: number;
  csd15: number;
  gd15: number;
}

interface PlayerRow {
  id: string;
  playerId: number | null;
  playerName: string;
  country: string;
  games: number;
  winRate: string;
  kda: string;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  csm: number;
  dpm: number;
  gpm: number;
  gd15: number;
}

interface PlayerChampionRow {
  id: string;
  championId: number;
  champion: string;
  games: number;
  winRate: string | null;
  kda: string | null;
}

interface MatchRow {
  id: string;
  gameId: number;
  title: string;
  team1: string;
  team2: string;
  score: string;
  stage: string;
  patch: string;
  gameDate: string;
  tournamentName: string;
}

interface TournamentRow {
  id: string;
  name: string;
  region: string;
  season: string;
  nbGames: number;
  firstGame: string;
  lastGame: string;
  _count: { matches: number };
}

type Tab = 'overview' | 'champions' | 'players' | 'matches' | 'tournaments';

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GolGgStatsPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [champions, setChampions] = useState<ChampRow[]>([]);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [tournaments, setTournaments] = useState<TournamentRow[]>([]);
  const [season, setSeason] = useState('S16');
  const [split, setSplit] = useState('ALL');
  const [champSearch, setChampSearch] = useState('');
  const [playerSearch, setPlayerSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [poolForPlayerId, setPoolForPlayerId] = useState<number | null>(null);
  const [poolRows, setPoolRows] = useState<PlayerChampionRow[]>([]);
  const [poolLoading, setPoolLoading] = useState(false);
  const poolCache = useRef<Map<string, PlayerChampionRow[]>>(new Map());

  const loadSummary = useCallback(async () => {
    const { data } = await api.get<Summary>('/lol/golgg/stats/summary');
    setSummary(data);
  }, []);

  const loadChampions = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<{ rows: ChampRow[] }>('/lol/golgg/stats/champions', {
        params: { season, split },
      });
      setChampions(data.rows);
    } finally {
      setLoading(false);
    }
  }, [season, split]);

  const loadPlayers = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<{ rows: PlayerRow[] }>('/lol/golgg/stats/players', {
        params: { season, split },
      });
      setPlayers(data.rows);
    } finally {
      setLoading(false);
    }
  }, [season, split]);

  const loadMatches = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<{ rows: MatchRow[] }>('/lol/golgg/stats/matches');
      setMatches(data.rows);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTournaments = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<{ rows: TournamentRow[] }>('/lol/golgg/stats/tournaments');
      setTournaments(data.rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (tab === 'champions') void loadChampions();
    else if (tab === 'players') void loadPlayers();
    else if (tab === 'matches') void loadMatches();
    else if (tab === 'tournaments') void loadTournaments();
  }, [tab, loadChampions, loadPlayers, loadMatches, loadTournaments]);

  useEffect(() => {
    setPoolForPlayerId(null);
    setPoolRows([]);
    poolCache.current.clear();
  }, [season, split]);

  const fetchPlayerChampionPool = useCallback(
    async (playerId: number) => {
      const cacheKey = `${season}|${split}|ALL|${playerId}`;
      setPoolLoading(true);
      setPoolRows([]);
      try {
        const { data } = await api.get<{ rows: PlayerChampionRow[] }>('/lol/golgg/stats/player-champions', {
          params: { playerId, season, split, tournament: 'ALL' },
        });
        poolCache.current.set(cacheKey, data.rows);
        setPoolRows(data.rows);
      } catch {
        setPoolRows([]);
      } finally {
        setPoolLoading(false);
      }
    },
    [season, split],
  );

  const togglePlayerPool = useCallback(
    (p: PlayerRow) => {
      if (p.playerId == null) return;
      if (poolForPlayerId === p.playerId) {
        setPoolForPlayerId(null);
        return;
      }
      setPoolForPlayerId(p.playerId);
      const cacheKey = `${season}|${split}|ALL|${p.playerId}`;
      const cached = poolCache.current.get(cacheKey);
      if (cached) {
        setPoolRows(cached);
        setPoolLoading(false);
        return;
      }
      void fetchPlayerChampionPool(p.playerId);
    },
    [poolForPlayerId, season, split, fetchPlayerChampionPool],
  );

  const filteredChamps = champions.filter((c) =>
    c.champion.toLowerCase().includes(champSearch.toLowerCase()),
  );
  const filteredPlayers = players.filter((p) =>
    p.playerName.toLowerCase().includes(playerSearch.toLowerCase()),
  );

  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'champions', label: `Champions (${summary?.champions ?? '…'})` },
    { id: 'players', label: `Players (${summary?.players ?? '…'})` },
    { id: 'matches', label: `Matches (${summary?.matches ?? '…'})` },
    { id: 'tournaments', label: `Tournaments (${summary?.tournaments ?? '…'})` },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-gray-200 p-6 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">GoL.gg Stats Database</h1>
            <p className="text-sm text-gray-500 mt-1">
              Scraped data: чемпионы, игроки, матчи всех топ-лиг S16. Обновляй скриптом:
              <code className="ml-1 text-gray-400 bg-gray-900 px-1 rounded text-xs">
                npx tsx scripts/scrape-golgg.ts
              </code>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/lol/golgg" className="text-sm text-gray-400 hover:text-gray-200 border border-gray-700 rounded-lg px-3 py-2">
              ← Game viewer
            </Link>
            <button
              onClick={async () => {
                setScraping(true);
                try {
                  await api.post('/lol/golgg/stats/scrape');
                  await loadSummary();
                } catch {
                  alert('Scrape endpoint not available — run manually');
                } finally {
                  setScraping(false);
                }
              }}
              disabled={scraping}
              className="text-sm bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg disabled:opacity-50"
            >
              {scraping ? 'Scraping…' : '🔄 Re-scrape'}
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-gray-500">Season:</span>
            {['S16', 'S15', 'S14'].map((s) => (
              <button
                key={s}
                onClick={() => setSeason(s)}
                className={`px-2 py-1 rounded border ${season === s ? 'border-blue-500 text-blue-400 bg-blue-500/10' : 'border-gray-700 text-gray-400'}`}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500">Split:</span>
            {['ALL', 'Winter', 'Spring', 'Summer'].map((s) => (
              <button
                key={s}
                onClick={() => setSplit(s)}
                className={`px-2 py-1 rounded border ${split === s ? 'border-blue-500 text-blue-400 bg-blue-500/10' : 'border-gray-700 text-gray-400'}`}
              >
                {s}
              </button>
            ))}
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

        {/* Overview */}
        {tab === 'overview' && summary && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              {[
                { label: 'Tournaments', value: summary.tournaments, color: 'text-blue-400' },
                { label: 'Matches', value: summary.matches, color: 'text-green-400' },
                { label: 'Champions', value: summary.champions, color: 'text-yellow-400' },
                { label: 'Players', value: summary.players, color: 'text-purple-400' },
                {
                  label: 'Player×champ',
                  value: summary.playerChampionRows ?? 0,
                  color: 'text-cyan-400',
                },
                { label: 'Game snapshots', value: summary.snapshots, color: 'text-pink-400' },
              ].map((c) => (
                <div key={c.label} className="bg-gray-900/40 border border-gray-800 rounded-xl p-4 text-center">
                  <div className="text-xs text-gray-500 mb-1">{c.label}</div>
                  <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
                </div>
              ))}
            </div>
            {summary.lastScrapeAt && (
              <p className="text-xs text-gray-600">
                Last scraped: {new Date(summary.lastScrapeAt).toLocaleString('ru-RU')}
              </p>
            )}
            {summary.champions === 0 && (
              <div className="border border-yellow-500/30 bg-yellow-500/10 rounded-xl p-5 text-sm text-yellow-300">
                База пустая — запусти сбор данных:
                <pre className="mt-2 bg-gray-950 rounded px-3 py-2 text-gray-300 text-xs overflow-x-auto">
                  cd backend && npx tsx scripts/scrape-golgg.ts
                </pre>
                Займёт ~2–5 мин (rate-limited). После — обновляй кнопкой «Re-scrape» или скриптом с флагом <code>--update</code>.
              </div>
            )}
            <p className="text-xs text-gray-600">
              Таблица чемпионов по игроку (как на gol.gg champion pool):{' '}
              <code className="text-gray-400 bg-gray-900 px-1 rounded">npx tsx scripts/scrape-golgg.ts --player-pools</code>
              — один HTTP на игрока (~800 ms пауза). Ограничить:{' '}
              <code className="text-gray-400 bg-gray-900 px-1 rounded">--player-pools=50</code>.
            </p>
          </div>
        )}

        {/* Champions */}
        {tab === 'champions' && (
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Поиск по имени…"
              value={champSearch}
              onChange={(e) => setChampSearch(e.target.value)}
              className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm w-64 text-white"
            />
            {loading ? (
              <div className="text-gray-500 text-sm">Загрузка…</div>
            ) : filteredChamps.length === 0 ? (
              <div className="text-gray-600 text-sm">Нет данных. Запусти scraper.</div>
            ) : (
              <div className="overflow-x-auto border border-gray-800 rounded-xl">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-800 bg-gray-900/40">
                      {['Champion', 'Picks', 'Bans', 'Wins', 'Losses', 'Win%', 'KDA', 'CSM', 'DPM', 'GPM', 'GD@15'].map((h) => (
                        <th key={h} className="px-3 py-2 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredChamps.map((c) => (
                      <tr key={c.id} className="border-b border-gray-800/50 hover:bg-white/[0.02]">
                        <td className="px-3 py-2 font-medium text-white">{c.champion}</td>
                        <td className="px-3 py-2">{c.picks}</td>
                        <td className="px-3 py-2">{c.bans}</td>
                        <td className="px-3 py-2 text-green-400">{c.wins}</td>
                        <td className="px-3 py-2 text-red-400">{c.losses}</td>
                        <td className={`px-3 py-2 font-medium ${parseFloat(c.winrate) >= 55 ? 'text-green-400' : parseFloat(c.winrate) < 45 ? 'text-red-400' : 'text-gray-300'}`}>
                          {c.winrate}
                        </td>
                        <td className="px-3 py-2 font-mono">{c.kda}</td>
                        <td className="px-3 py-2">{c.csm.toFixed(1)}</td>
                        <td className="px-3 py-2">{Math.round(c.dpm)}</td>
                        <td className="px-3 py-2">{Math.round(c.gpm)}</td>
                        <td className={`px-3 py-2 ${c.gd15 > 0 ? 'text-green-400' : c.gd15 < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                          {c.gd15 > 0 ? '+' : ''}{c.gd15}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Players */}
        {tab === 'players' && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              Строка с gol.gg <span className="text-gray-400">playerId</span>: клик по ▶ — champion pool (Nb games, Win%, KDA). Данные после{' '}
              <code className="text-gray-400 bg-gray-900 px-1 rounded text-[10px]">--player-pools</code>.
            </p>
            <input
              type="text"
              placeholder="Поиск по имени…"
              value={playerSearch}
              onChange={(e) => setPlayerSearch(e.target.value)}
              className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm w-64 text-white"
            />
            {loading ? (
              <div className="text-gray-500 text-sm">Загрузка…</div>
            ) : filteredPlayers.length === 0 ? (
              <div className="text-gray-600 text-sm">Нет данных. Запусти scraper.</div>
            ) : (
              <div className="overflow-x-auto border border-gray-800 rounded-xl">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-800 bg-gray-900/40">
                      {['', 'Player', 'Country', 'Games', 'Win%', 'KDA', 'K', 'D', 'A', 'CSM', 'GPM', 'DPM', 'GD@15'].map((h) => (
                        <th key={h || 'pool'} className="px-3 py-2 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPlayers.map((p) => (
                      <Fragment key={p.id}>
                        <tr
                          className={`border-b border-gray-800/50 hover:bg-white/[0.02] ${
                            p.playerId != null ? 'cursor-pointer' : ''
                          }`}
                          onClick={() => togglePlayerPool(p)}
                        >
                          <td className="px-2 py-2 text-center text-gray-500 w-8">
                            {p.playerId != null ? (poolForPlayerId === p.playerId ? '▼' : '▶') : '—'}
                          </td>
                          <td className="px-3 py-2 font-medium text-white">{p.playerName}</td>
                          <td className="px-3 py-2 text-gray-400">{p.country}</td>
                          <td className="px-3 py-2">{p.games}</td>
                          <td
                            className={`px-3 py-2 ${parseFloat(p.winRate) >= 60 ? 'text-green-400' : parseFloat(p.winRate) < 40 ? 'text-red-400' : 'text-gray-300'}`}
                          >
                            {p.winRate}
                          </td>
                          <td className="px-3 py-2 font-mono">{p.kda}</td>
                          <td className="px-3 py-2 text-green-400">{p.avgKills?.toFixed(1)}</td>
                          <td className="px-3 py-2 text-red-400">{p.avgDeaths?.toFixed(1)}</td>
                          <td className="px-3 py-2">{p.avgAssists?.toFixed(1)}</td>
                          <td className="px-3 py-2">{p.csm?.toFixed(1)}</td>
                          <td className="px-3 py-2">{Math.round(p.gpm)}</td>
                          <td className="px-3 py-2">{Math.round(p.dpm)}</td>
                          <td
                            className={`px-3 py-2 ${p.gd15 > 0 ? 'text-green-400' : p.gd15 < 0 ? 'text-red-400' : 'text-gray-500'}`}
                          >
                            {p.gd15 > 0 ? '+' : ''}
                            {p.gd15}
                          </td>
                        </tr>
                        {poolForPlayerId === p.playerId && p.playerId != null && (
                          <tr className="border-b border-gray-800 bg-gray-950/90">
                            <td colSpan={13} className="px-4 py-3 align-top">
                              <div className="text-[11px] text-gray-400 mb-2">
                                Champion pool — {p.playerName} (gol.gg id {p.playerId}) · {season} / {split}
                              </div>
                              {poolLoading ? (
                                <div className="text-gray-500 text-sm">Загрузка…</div>
                              ) : poolRows.length === 0 ? (
                                <div className="text-gray-600 text-sm">
                                  Нет строк в БД для этого игрока. Запусти{' '}
                                  <code className="text-gray-400">npx tsx scripts/scrape-golgg.ts --player-pools</code>.
                                </div>
                              ) : (
                                <div className="overflow-x-auto max-h-72 overflow-y-auto rounded-lg border border-gray-800">
                                  <table className="w-full text-[11px]">
                                    <thead>
                                      <tr className="text-left text-gray-500 border-b border-gray-800">
                                        <th className="px-2 py-1.5">Champion</th>
                                        <th className="px-2 py-1.5 text-center">Nb games</th>
                                        <th className="px-2 py-1.5 text-center">Win%</th>
                                        <th className="px-2 py-1.5 text-center">KDA</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {poolRows.map((r) => (
                                        <tr key={r.id} className="border-b border-gray-800/40">
                                          <td className="px-2 py-1.5 text-white">{r.champion}</td>
                                          <td className="px-2 py-1.5 text-center">{r.games}</td>
                                          <td
                                            className={`px-2 py-1.5 text-center ${
                                              r.winRate && parseFloat(r.winRate) >= 58
                                                ? 'text-green-400'
                                                : r.winRate && parseFloat(r.winRate) < 42
                                                  ? 'text-red-400'
                                                  : 'text-gray-300'
                                            }`}
                                          >
                                            {r.winRate ?? '—'}
                                          </td>
                                          <td className="px-2 py-1.5 text-center font-mono">{r.kda ?? '—'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Matches */}
        {tab === 'matches' && (
          <div>
            {loading ? (
              <div className="text-gray-500 text-sm">Загрузка…</div>
            ) : matches.length === 0 ? (
              <div className="text-gray-600 text-sm">Нет матчей. Запусти scraper.</div>
            ) : (
              <div className="overflow-x-auto border border-gray-800 rounded-xl">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-800 bg-gray-900/40">
                      {['ID', 'Game', 'Score', 'Stage', 'Patch', 'Date', 'Tournament'].map((h) => (
                        <th key={h} className="px-3 py-2">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matches.map((m) => (
                      <tr key={m.id} className="border-b border-gray-800/50 hover:bg-white/[0.02]">
                        <td className="px-3 py-2">
                          <Link href={`/lol/golgg?gameId=${m.gameId}`} className="text-blue-400 hover:text-blue-300">
                            {m.gameId}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-white">{m.title}</td>
                        <td className="px-3 py-2 font-mono">{m.score}</td>
                        <td className="px-3 py-2 text-gray-400">{m.stage}</td>
                        <td className="px-3 py-2 text-gray-400">{m.patch}</td>
                        <td className="px-3 py-2 text-gray-400">{m.gameDate}</td>
                        <td className="px-3 py-2 text-gray-500 truncate max-w-32">{m.tournamentName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Tournaments */}
        {tab === 'tournaments' && (
          <div>
            {loading ? (
              <div className="text-gray-500 text-sm">Загрузка…</div>
            ) : tournaments.length === 0 ? (
              <div className="text-gray-600 text-sm">Нет турниров. Запусти scraper.</div>
            ) : (
              <div className="overflow-x-auto border border-gray-800 rounded-xl">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-800 bg-gray-900/40">
                      {['Tournament', 'Region', 'Season', 'Games', 'Matches in DB', 'First', 'Last'].map((h) => (
                        <th key={h} className="px-3 py-2">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tournaments.map((t) => (
                      <tr key={t.id} className="border-b border-gray-800/50 hover:bg-white/[0.02]">
                        <td className="px-3 py-2 font-medium text-white">{t.name}</td>
                        <td className="px-3 py-2 text-gray-400">{t.region}</td>
                        <td className="px-3 py-2">{t.season}</td>
                        <td className="px-3 py-2">{t.nbGames}</td>
                        <td className="px-3 py-2 text-green-400">{t._count.matches}</td>
                        <td className="px-3 py-2 text-gray-400">{t.firstGame}</td>
                        <td className="px-3 py-2 text-gray-400">{t.lastGame}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import api from '@/lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

type MatchStatus = 'running' | 'upcoming' | 'finished' | 'not_started' | 'canceled' | 'postponed';
type SeriesType = 'bo1' | 'bo2' | 'bo3' | 'bo5' | 'unknown';
type FilterStatus = 'all' | MatchStatus;
type FilterSeries = 'all' | SeriesType;
type PlayerRole = 'top' | 'jun' | 'mid' | 'adc' | 'sup' | null;

interface Player {
  id: number;
  name: string;
  role: PlayerRole;
  slug: string;
  firstName: string | null;
  lastName: string | null;
  nationality: string | null;
  imageUrl: string | null;
  age: number | null;
  active: boolean;
}

interface Team {
  id: number;
  name: string;
  acronym: string | null;
  location: string | null;
  imageUrl: string | null;
  slug: string;
  score: number;
  isWinner: boolean;
  players: Player[];
}

interface GameInfo {
  position: number;
  status: string;
  finished: boolean;
  durationSec: number | null;
  durationLabel: string | null;
  beginAt: string | null;
  endAt: string | null;
  forfeit: boolean;
  winnerTeamId: number | null;
}

interface Stream {
  url: string;
  embedUrl: string | null;
  language: string;
  main: boolean;
  official: boolean;
}

interface LolMatch {
  id: number;
  name: string;
  slug: string;
  status: MatchStatus;
  beginAt: string | null;
  endAt: string | null;
  scheduledAt: string | null;
  startsInMinutes: number | null;
  seriesType: SeriesType;
  numberOfGames: number;
  forfeit: boolean;
  draw: boolean;
  rescheduled: boolean;
  detailedStats: boolean;
  liveSupported: boolean;
  liveUrl: string | null;
  liveOpensAt: string | null;
  mainStream: { url: string; embedUrl: string; language: string } | null;
  allStreams: Stream[];
  league: string;
  leagueImageUrl: string | null;
  leagueSlug: string;
  serie: string;
  serieYear: number | null;
  serieSeason: string | null;
  tournament: string;
  tournamentType: string;
  tier: string | null;
  region: string | null;
  prizepool: string | null;
  hasBracket: boolean;
  teamA: Team | null;
  teamB: Team | null;
  games: GameInfo[];
  seriesScore: string;
  winner: string | null;
  winnerTeamId: number | null;
}

interface LolResponse {
  summary: { totalMatches: number; running: number; upcoming: number; finished: number; other: number };
  charts: {
    topLeagues: Array<{ name: string; matches: number }>;
    seriesCount: Record<SeriesType, number>;
  };
  matches: LolMatch[];
  generatedAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<MatchStatus, string> = {
  running: 'Live',
  upcoming: 'Upcoming',
  finished: 'Finished',
  not_started: 'Not Started',
  canceled: 'Canceled',
  postponed: 'Postponed',
};

const STATUS_STYLE: Record<MatchStatus, string> = {
  running: 'bg-green-500/20 text-green-400 border-green-500/40',
  upcoming: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  finished: 'bg-gray-700/30 text-gray-400 border-gray-600/30',
  not_started: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  canceled: 'bg-red-500/15 text-red-400 border-red-500/30',
  postponed: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
};

const ROLE_ICON: Record<string, string> = {
  top: 'T', jun: 'J', mid: 'M', adc: 'A', sup: 'S',
};

const ROLE_COLOR: Record<string, string> = {
  top: 'text-red-400 bg-red-500/10 border-red-500/20',
  jun: 'text-green-400 bg-green-500/10 border-green-500/20',
  mid: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  adc: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
  sup: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
};

const TIER_COLOR: Record<string, string> = {
  s: 'text-yellow-300',
  a: 'text-yellow-400',
  b: 'text-green-400',
  c: 'text-gray-400',
  d: 'text-gray-500',
};

const PIE_COLORS = ['#34d399', '#60a5fa', '#9ca3af', '#f59e0b'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatStart(beginAt: string | null): string {
  if (!beginAt) return 'TBD';
  const d = new Date(beginAt);
  return `${d.toLocaleDateString('ru', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function formatStartsIn(mins: number | null): string {
  if (mins === null) return '-';
  if (mins < -120) return `${Math.round(Math.abs(mins) / 60)}h ago`;
  if (mins < 0) return `${Math.abs(mins)}m ago`;
  if (mins < 60) return `in ${mins}m`;
  if (mins < 1440) return `in ${Math.round(mins / 60)}h`;
  return `in ${Math.round(mins / 1440)}d`;
}

function flagEmoji(country: string | null): string {
  if (!country) return '';
  const code = country.toUpperCase();
  if (code.length !== 2) return '';
  return String.fromCodePoint(
    ...code.split('').map(c => 127397 + c.charCodeAt(0)),
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function PlayerRow({ p, isWinner, winnerTeamId, teamId }: {
  p: Player;
  isWinner: boolean;
  winnerTeamId: number | null;
  teamId: number;
}) {
  const roleKey = p.role ?? '';
  const roleClass = ROLE_COLOR[roleKey] ?? 'text-gray-400 bg-gray-700/20 border-gray-600/20';

  return (
    <div className={`flex items-center gap-2 py-1.5 px-2 rounded-lg ${isWinner ? 'bg-green-500/5' : ''}`}>
      {p.imageUrl ? (
        <img src={p.imageUrl} alt={p.name} className="w-7 h-7 rounded-full object-cover bg-gray-800" />
      ) : (
        <div className="w-7 h-7 rounded-full bg-gray-800 flex items-center justify-center text-[10px] text-gray-500">
          {p.name.slice(0, 2).toUpperCase()}
        </div>
      )}
      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${roleClass} w-5 text-center`}>
        {ROLE_ICON[roleKey] ?? '?'}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-white truncate">{p.name}</div>
        <div className="text-[10px] text-gray-500">
          {[p.firstName, p.lastName].filter(Boolean).join(' ') || null}
          {p.nationality ? ` ${flagEmoji(p.nationality)}` : ''}
          {p.age ? ` · ${p.age}y` : ''}
        </div>
      </div>
    </div>
  );
}

function TeamColumn({ team, isLeft, winnerTeamId }: {
  team: Team;
  isLeft: boolean;
  winnerTeamId: number | null;
}) {
  const isWinner = team.id === winnerTeamId;

  return (
    <div className={`flex-1 ${isLeft ? 'pr-3' : 'pl-3'}`}>
      <div className={`flex items-center gap-2 mb-2 ${isLeft ? '' : 'flex-row-reverse'}`}>
        {team.imageUrl ? (
          <img src={team.imageUrl} alt={team.name} className="w-8 h-8 rounded-lg object-contain bg-gray-800 p-0.5" />
        ) : (
          <div className="w-8 h-8 rounded-lg bg-gray-800 flex items-center justify-center text-xs text-gray-400 font-bold">
            {(team.acronym ?? team.name).slice(0, 3)}
          </div>
        )}
        <div className={isLeft ? '' : 'text-right'}>
          <div className="flex items-center gap-1">
            {isWinner && <span className="text-yellow-400 text-xs">★</span>}
            <span className="text-sm font-bold text-white">{team.acronym ?? team.name}</span>
          </div>
          <div className="text-[10px] text-gray-500">{flagEmoji(team.location)} {team.location}</div>
        </div>
      </div>
      <div className="space-y-0.5">
        {team.players.map(p => (
          <PlayerRow key={p.id} p={p} isWinner={isWinner} winnerTeamId={winnerTeamId} teamId={team.id} />
        ))}
        {!team.players.length && (
          <div className="text-[10px] text-gray-600 italic py-2">Roster not available</div>
        )}
      </div>
    </div>
  );
}

function GamesTimeline({ games, teamA, teamB }: { games: GameInfo[]; teamA: Team | null; teamB: Team | null }) {
  if (!games.length) return null;

  return (
    <div className="mt-3 pt-3 border-t border-gray-800">
      <div className="text-[10px] text-gray-500 mb-2">Games</div>
      <div className="flex gap-1.5 flex-wrap">
        {games.map(g => {
          const winner = g.winnerTeamId === teamA?.id ? teamA?.acronym : g.winnerTeamId === teamB?.id ? teamB?.acronym : null;
          const bgColor = g.finished
            ? winner === teamA?.acronym
              ? 'bg-green-500/15 border-green-500/30 text-green-400'
              : winner === teamB?.acronym
                ? 'bg-blue-500/15 border-blue-500/30 text-blue-400'
                : 'bg-gray-700/30 border-gray-600/20 text-gray-500'
            : g.status === 'running'
              ? 'bg-yellow-500/15 border-yellow-500/30 text-yellow-400 animate-pulse'
              : 'bg-gray-800 border-gray-700 text-gray-600';

          return (
            <div key={g.position} className={`flex flex-col items-center px-2 py-1.5 rounded-lg border text-[10px] ${bgColor}`}>
              <div className="font-bold">G{g.position}</div>
              {winner && <div className="font-medium">{winner}</div>}
              {g.durationLabel && <div className="text-gray-500">{g.durationLabel}</div>}
              {g.forfeit && <div>FF</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MatchCard({ match }: { match: LolMatch }) {
  const [expanded, setExpanded] = useState(false);
  const isLive = match.status === 'running';
  const isFinished = match.status === 'finished';

  return (
    <div
      className={`bg-gray-900 border rounded-xl overflow-hidden transition-all ${
        isLive ? 'border-green-500/40' : isFinished ? 'border-gray-700/50' : 'border-gray-800'
      }`}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-950/50 border-b border-gray-800">
        <div className="flex items-center gap-2">
          {match.leagueImageUrl && (
            <img src={match.leagueImageUrl} alt={match.league} className="w-4 h-4 object-contain" />
          )}
          <span className="text-[10px] text-gray-400">{match.league}</span>
          {match.serie && <span className="text-[10px] text-gray-600">· {match.serie}</span>}
          {match.tier && (
            <span className={`text-[10px] font-bold uppercase ${TIER_COLOR[match.tier] ?? 'text-gray-500'}`}>
              T-{match.tier.toUpperCase()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {match.prizepool && <span className="text-[10px] text-yellow-500/70">{match.prizepool}</span>}
          <span className={`text-[10px] px-2 py-0.5 rounded-md border ${STATUS_STYLE[match.status]}`}>
            {isLive && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1 animate-ping" />}
            {STATUS_LABEL[match.status]}
          </span>
        </div>
      </div>

      {/* Match body */}
      <button
        className="w-full text-left px-4 py-3 cursor-pointer hover:bg-gray-800/30 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Score row */}
        <div className="flex items-center justify-between gap-4">
          {/* Team A */}
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {match.teamA?.imageUrl ? (
              <img src={match.teamA.imageUrl} alt={match.teamA.name} className="w-8 h-8 rounded-lg object-contain bg-gray-800 p-0.5 flex-shrink-0" />
            ) : (
              <div className="w-8 h-8 rounded-lg bg-gray-800 flex items-center justify-center text-xs font-bold text-gray-300 flex-shrink-0">
                {(match.teamA?.acronym ?? match.teamA?.name ?? '?').slice(0, 3)}
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1">
                {match.teamA?.isWinner && <span className="text-yellow-400 text-xs">★</span>}
                <span className={`font-bold text-sm truncate ${match.teamA?.isWinner ? 'text-white' : 'text-gray-300'}`}>
                  {match.teamA?.acronym ?? match.teamA?.name ?? 'TBD'}
                </span>
              </div>
              {match.teamA?.location && (
                <div className="text-[10px] text-gray-600">{flagEmoji(match.teamA.location)}</div>
              )}
            </div>
          </div>

          {/* Score / Time */}
          <div className="text-center flex-shrink-0 px-2">
            {isFinished || isLive ? (
              <div className="text-xl font-bold font-mono text-white tracking-widest">
                {match.teamA?.score ?? 0}
                <span className="text-gray-600 mx-1">–</span>
                {match.teamB?.score ?? 0}
              </div>
            ) : (
              <div className="text-sm font-bold text-gray-400">vs</div>
            )}
            <div className="text-[10px] text-gray-500 mt-0.5">{match.seriesType.toUpperCase()}</div>
            {!isFinished && (
              <div className="text-[10px] text-gray-500">{formatStartsIn(match.startsInMinutes)}</div>
            )}
          </div>

          {/* Team B */}
          <div className="flex items-center gap-2 flex-1 min-w-0 flex-row-reverse">
            {match.teamB?.imageUrl ? (
              <img src={match.teamB.imageUrl} alt={match.teamB.name} className="w-8 h-8 rounded-lg object-contain bg-gray-800 p-0.5 flex-shrink-0" />
            ) : (
              <div className="w-8 h-8 rounded-lg bg-gray-800 flex items-center justify-center text-xs font-bold text-gray-300 flex-shrink-0">
                {(match.teamB?.acronym ?? match.teamB?.name ?? '?').slice(0, 3)}
              </div>
            )}
            <div className="min-w-0 text-right">
              <div className="flex items-center gap-1 justify-end">
                <span className={`font-bold text-sm truncate ${match.teamB?.isWinner ? 'text-white' : 'text-gray-300'}`}>
                  {match.teamB?.acronym ?? match.teamB?.name ?? 'TBD'}
                </span>
                {match.teamB?.isWinner && <span className="text-yellow-400 text-xs">★</span>}
              </div>
              {match.teamB?.location && (
                <div className="text-[10px] text-gray-600 text-right">{flagEmoji(match.teamB.location)}</div>
              )}
            </div>
          </div>
        </div>

        {/* Bottom info row */}
        <div className="flex items-center justify-between mt-2 text-[10px] text-gray-500">
          <span>{match.tournament} {match.region ? `· ${match.region}` : ''}</span>
          <div className="flex items-center gap-2">
            {formatStart(match.beginAt)}
            {match.allStreams.length > 0 && (
              <span className="text-purple-400">📺 {match.allStreams.length}</span>
            )}
            {match.liveSupported && <span className="text-green-500">⚡ Live</span>}
            {match.rescheduled && <span className="text-yellow-500">↺ Rescheduled</span>}
            {match.forfeit && <span className="text-red-400">FF</span>}
          </div>
        </div>
      </button>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-4 space-y-4">
          {/* Rosters */}
          {(match.teamA || match.teamB) && (
            <div className="flex gap-0 divide-x divide-gray-800">
              {match.teamA && (
                <TeamColumn team={match.teamA} isLeft={true} winnerTeamId={match.winnerTeamId} />
              )}
              {match.teamB && (
                <TeamColumn team={match.teamB} isLeft={false} winnerTeamId={match.winnerTeamId} />
              )}
            </div>
          )}

          {/* Games timeline */}
          <GamesTimeline games={match.games} teamA={match.teamA} teamB={match.teamB} />

          {/* Streams */}
          {match.allStreams.length > 0 && (
            <div className="pt-2 border-t border-gray-800">
              <div className="text-[10px] text-gray-500 mb-1.5">Streams</div>
              <div className="flex flex-wrap gap-2">
                {match.allStreams.map((s, i) => (
                  <a
                    key={i}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border transition-colors
                      ${s.main ? 'bg-purple-500/15 border-purple-500/30 text-purple-400 hover:bg-purple-500/25'
                               : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'}`}
                  >
                    📺 {s.language.toUpperCase()} {s.official ? '✓' : ''} {s.main ? '(main)' : ''}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Meta */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 pt-2 border-t border-gray-800 text-[10px]">
            {match.prizepool && (
              <div><span className="text-gray-500">Prizepool</span> <span className="text-yellow-400">{match.prizepool}</span></div>
            )}
            {match.tier && (
              <div><span className="text-gray-500">Tier</span> <span className={TIER_COLOR[match.tier] ?? 'text-gray-400'}>{match.tier.toUpperCase()}</span></div>
            )}
            {match.region && (
              <div><span className="text-gray-500">Region</span> <span className="text-gray-300">{match.region}</span></div>
            )}
            {match.tournamentType && (
              <div><span className="text-gray-500">Type</span> <span className="text-gray-300 capitalize">{match.tournamentType}</span></div>
            )}
            <div><span className="text-gray-500">Games</span> <span className="text-gray-300">{match.seriesType.toUpperCase()} ({match.numberOfGames})</span></div>
            {match.endAt && (
              <div><span className="text-gray-500">Ended</span> <span className="text-gray-300">{formatStart(match.endAt)}</span></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LolPandascorePage() {
  const [data, setData] = useState<LolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('all');
  const [seriesFilter, setSeriesFilter] = useState<FilterSeries>('all');
  const [leagueFilter, setLeagueFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.get('/lol/pandascore');
      setData(res.data);
    } catch (e: any) {
      setError(e?.response?.data?.details || e?.response?.data?.error || 'Failed to load PandaScore data');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const leagueOptions = useMemo(() => {
    if (!data) return ['all'];
    const leagues = Array.from(new Set(data.matches.map(m => m.league))).sort();
    return ['all', ...leagues];
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.matches.filter(m => {
      if (statusFilter !== 'all' && m.status !== statusFilter) return false;
      if (seriesFilter !== 'all' && m.seriesType !== seriesFilter) return false;
      if (leagueFilter !== 'all' && m.league !== leagueFilter) return false;
      if (!q) return true;
      const hay = [
        m.name, m.teamA?.name, m.teamA?.acronym, m.teamB?.name, m.teamB?.acronym,
        m.league, m.tournament, m.region, m.winner,
        ...(m.teamA?.players.map(p => p.name) ?? []),
        ...(m.teamB?.players.map(p => p.name) ?? []),
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [data, statusFilter, seriesFilter, leagueFilter, search]);

  const statusPie = useMemo(() => {
    if (!data) return [];
    return [
      { name: 'Running', value: data.summary.running },
      { name: 'Upcoming', value: data.summary.upcoming },
      { name: 'Finished', value: data.summary.finished },
      { name: 'Other', value: data.summary.other },
    ].filter(x => x.value > 0);
  }, [data]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl">🎮</span>
            <h1 className="text-2xl font-bold text-white">PandaScore LoL Live</h1>
          </div>
          <p className="text-sm text-gray-400">
            Live fixtures from PandaScore — команды, ростеры, результаты серий, стримы.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            href="/lol/live"
            className="text-sm text-purple-400 hover:text-purple-300 border border-purple-500/30 rounded-lg px-3 py-2"
          >
            Live Predictor
          </Link>
          <Link
            href="/lol/golgg"
            className="text-sm text-gray-400 hover:text-gray-200 border border-gray-700 rounded-lg px-3 py-2"
          >
            GoL.gg
          </Link>
          <button
            onClick={() => { setLoading(true); load().finally(() => setLoading(false)); }}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/40 rounded-xl px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {/* Stats */}
      {!data && loading ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[1, 2, 3, 4, 5].map(i => <div key={i} className="h-20 bg-gray-900 border border-gray-800 rounded-xl animate-pulse" />)}
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatCard label="Total" value={data.summary.totalMatches} color="text-white" />
            <StatCard label="Running" value={data.summary.running} color="text-green-400" />
            <StatCard label="Upcoming" value={data.summary.upcoming} color="text-blue-400" />
            <StatCard label="Finished" value={data.summary.finished} color="text-gray-300" />
            <StatCard label="Other" value={data.summary.other} color="text-yellow-400" />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="text-sm text-gray-300 mb-3">Top leagues by matches</div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.charts.topLeagues}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="name" stroke="#6b7280" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={40} />
                    <YAxis stroke="#6b7280" tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 11 }} />
                    <Bar dataKey="matches" fill="#60a5fa" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="text-sm text-gray-300 mb-3">Status distribution</div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={statusPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, value }) => `${name} ${value}`} labelLine={false}>
                      {statusPie.map((_, i) => (
                        <Cell key={`c-${i}`} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <div className="text-xs text-gray-500 font-medium uppercase tracking-wide">Filters</div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search teams, players, league, tournament…"
                className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500 placeholder:text-gray-600"
              />
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value as FilterStatus)}
                className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
              >
                <option value="all">All statuses</option>
                <option value="running">Running</option>
                <option value="upcoming">Upcoming</option>
                <option value="not_started">Not started</option>
                <option value="finished">Finished</option>
                <option value="canceled">Canceled</option>
                <option value="postponed">Postponed</option>
              </select>
              <select
                value={seriesFilter}
                onChange={e => setSeriesFilter(e.target.value as FilterSeries)}
                className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
              >
                <option value="all">All series</option>
                <option value="bo1">BO1</option>
                <option value="bo3">BO3</option>
                <option value="bo5">BO5</option>
                <option value="unknown">Unknown</option>
              </select>
              <select
                value={leagueFilter}
                onChange={e => setLeagueFilter(e.target.value)}
                className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
              >
                {leagueOptions.map(l => (
                  <option key={l} value={l}>{l === 'all' ? 'All leagues' : l}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Count */}
          <div className="text-xs text-gray-600">
            {filtered.length} of {data.matches.length} matches · click any card to expand rosters
            {data.generatedAt && ` · updated ${new Date(data.generatedAt).toLocaleTimeString()}`}
          </div>

          {/* Match cards */}
          <div className="space-y-3">
            {filtered.length > 0 ? (
              filtered.map(m => <MatchCard key={m.id} match={m} />)
            ) : (
              <div className="text-center py-16 text-gray-500 text-sm">
                No matches match the current filters
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

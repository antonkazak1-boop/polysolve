import { Router, Request, Response } from 'express';
import axios, { AxiosInstance } from 'axios';

export const lolPandascoreRouter = Router();

const PANDASCORE_BASE_URL = 'https://api.pandascore.co';

// ─── PandaScore raw types ────────────────────────────────────────────────────

type MatchStatus = 'running' | 'upcoming' | 'finished' | 'not_started' | 'canceled' | 'postponed';
type SeriesType = 'bo1' | 'bo2' | 'bo3' | 'bo5' | 'unknown';
type PlayerRole = 'top' | 'jun' | 'mid' | 'adc' | 'sup' | null;

interface PandaPlayer {
  id: number;
  name: string;
  role: PlayerRole;
  slug: string;
  first_name?: string | null;
  last_name?: string | null;
  nationality?: string | null;
  image_url?: string | null;
  age?: number | null;
  birthday?: string | null;
  active?: boolean;
}

interface PandaTeam {
  id: number;
  name: string;
  acronym?: string | null;
  location?: string | null;
  image_url?: string | null;
  dark_mode_image_url?: string | null;
  slug?: string;
  players?: PandaPlayer[];
}

interface PandaLeague {
  id: number;
  name: string;
  image_url?: string | null;
  slug?: string;
  url?: string | null;
}

interface PandaSerie {
  id: number;
  name: string;
  full_name?: string;
  season?: string | null;
  year?: number | null;
  begin_at?: string | null;
  end_at?: string | null;
}

interface PandaGame {
  id: number;
  position: number;
  status: string;
  complete: boolean;
  finished: boolean;
  begin_at: string | null;
  end_at: string | null;
  length: number | null;
  forfeit: boolean;
  detailed_stats: boolean;
  winner?: { id: number | null; type: string } | null;
}

interface PandaStream {
  main: boolean;
  language: string;
  embed_url: string | null;
  raw_url: string | null;
  official: boolean;
}

interface PandaLive {
  supported: boolean;
  url: string | null;
  opens_at: string | null;
}

interface PandaMatch {
  id: number;
  name: string;
  slug: string;
  status: MatchStatus;
  begin_at: string | null;
  end_at: string | null;
  scheduled_at: string | null;
  original_scheduled_at: string | null;
  modified_at: string;
  number_of_games: number | null;
  match_type: string;
  forfeit: boolean;
  draw: boolean;
  rescheduled: boolean;
  game_advantage: number | null;
  detailed_stats: boolean;
  winner_id: number | null;
  winner_type: string;
  winner?: PandaTeam | null;
  opponents?: Array<{ type: string; opponent: PandaTeam }>;
  results?: Array<{ team_id: number; score: number }>;
  games?: PandaGame[];
  league?: PandaLeague;
  serie?: PandaSerie;
  tournament?: {
    id: number;
    name: string;
    type: string;
    tier?: string | null;
    region?: string | null;
    prizepool?: string | null;
    live_supported?: boolean;
    country?: string | null;
    has_bracket?: boolean;
  };
  streams_list?: PandaStream[];
  live?: PandaLive;
}

// ─── Output types ────────────────────────────────────────────────────────────

interface EnrichedPlayer {
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

interface EnrichedTeam {
  id: number;
  name: string;
  acronym: string | null;
  location: string | null;
  imageUrl: string | null;
  slug: string;
  score: number;
  isWinner: boolean;
  players: EnrichedPlayer[];
}

interface EnrichedGame {
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

interface EnrichedMatch {
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
  allStreams: Array<{ url: string; embedUrl: string | null; language: string; main: boolean; official: boolean }>;
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
  teamA: EnrichedTeam | null;
  teamB: EnrichedTeam | null;
  games: EnrichedGame[];
  seriesScore: string;
  winner: string | null;
  winnerTeamId: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toSeriesType(n?: number | null): SeriesType {
  if (!n || n < 1) return 'unknown';
  if (n === 1) return 'bo1';
  if (n === 2) return 'bo2';
  if (n === 3) return 'bo3';
  return 'bo5';
}

function formatDuration(sec: number | null): string | null {
  if (sec === null) return null;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toStatusBucket(s: MatchStatus): 'running' | 'upcoming' | 'finished' | 'other' {
  if (s === 'running') return 'running';
  if (s === 'upcoming' || s === 'not_started') return 'upcoming';
  if (s === 'finished') return 'finished';
  return 'other';
}

function buildTeam(
  raw: PandaTeam,
  results: Array<{ team_id: number; score: number }>,
  winnerId: number | null,
  rosterMap: Map<number, PandaPlayer[]>,
): EnrichedTeam {
  const result = results.find(r => r.team_id === raw.id);
  const players = rosterMap.get(raw.id) ?? raw.players ?? [];
  const roleOrder: Record<string, number> = { top: 0, jun: 1, mid: 2, adc: 3, sup: 4 };

  return {
    id: raw.id,
    name: raw.name,
    acronym: raw.acronym ?? null,
    location: raw.location ?? null,
    imageUrl: raw.image_url ?? null,
    slug: raw.slug ?? '',
    score: result?.score ?? 0,
    isWinner: raw.id === winnerId,
    players: players
      .map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        slug: p.slug,
        firstName: p.first_name ?? null,
        lastName: p.last_name ?? null,
        nationality: p.nationality ?? null,
        imageUrl: p.image_url ?? null,
        age: p.age ?? null,
        active: p.active ?? true,
      }))
      .sort((a, b) => (roleOrder[a.role ?? ''] ?? 5) - (roleOrder[b.role ?? ''] ?? 5)),
  };
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchAllMatches(client: AxiosInstance): Promise<PandaMatch[]> {
  const [runningRes, upcomingRes, pastRes] = await Promise.all([
    client.get<PandaMatch[]>('/lol/matches/running', { params: { page: 1, per_page: 50, sort: '-begin_at' } }),
    client.get<PandaMatch[]>('/lol/matches/upcoming', { params: { page: 1, per_page: 100, sort: 'begin_at' } }),
    client.get<PandaMatch[]>('/lol/matches/past', { params: { page: 1, per_page: 50, sort: '-begin_at' } }),
  ]);

  const seen = new Set<number>();
  const all = [...runningRes.data, ...upcomingRes.data, ...pastRes.data];
  const deduped: PandaMatch[] = [];
  for (const m of all) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    deduped.push(m);
  }
  return deduped;
}

async function fetchRosters(client: AxiosInstance, teamIds: number[]): Promise<Map<number, PandaPlayer[]>> {
  const map = new Map<number, PandaPlayer[]>();
  if (!teamIds.length) return map;

  // PandaScore allows filter[id]=a,b,c on teams endpoint
  const batchSize = 20;
  for (let i = 0; i < teamIds.length; i += batchSize) {
    const batch = teamIds.slice(i, i + batchSize);
    try {
      const res = await client.get<PandaTeam[]>('/lol/teams', {
        params: { 'filter[id]': batch.join(','), per_page: batchSize },
      });
      for (const team of res.data) {
        if (team.players?.length) map.set(team.id, team.players);
      }
    } catch {
      // Partial failure — continue
    }
  }
  return map;
}

// ─── Route ───────────────────────────────────────────────────────────────────

lolPandascoreRouter.get('/pandascore', async (_req: Request, res: Response) => {
  const apiKey = process.env.PANDASCORE_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'PANDASCORE_API_KEY is not configured on backend' });
  }

  const client = axios.create({
    baseURL: PANDASCORE_BASE_URL,
    timeout: 20000,
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  try {
    const rawMatches = await fetchAllMatches(client);

    // Collect unique team IDs to batch-fetch rosters
    const allTeamIds = new Set<number>();
    for (const m of rawMatches) {
      for (const o of m.opponents ?? []) {
        if (o.opponent?.id) allTeamIds.add(o.opponent.id);
      }
    }
    const rosterMap = await fetchRosters(client, [...allTeamIds]);

    const now = Date.now();
    const matches: EnrichedMatch[] = rawMatches.map(m => {
      const opponentA = m.opponents?.[0]?.opponent ?? null;
      const opponentB = m.opponents?.[1]?.opponent ?? null;
      const results = m.results ?? [];
      const winnerId = m.winner_id ?? (m.winner as PandaTeam)?.id ?? null;
      const beginMs = m.begin_at ? new Date(m.begin_at).getTime() : null;
      const startsInMinutes = beginMs ? Math.round((beginMs - now) / 60000) : null;

      const mainStream = m.streams_list?.find(s => s.main) ?? m.streams_list?.[0] ?? null;

      return {
        id: m.id,
        name: m.name,
        slug: m.slug,
        status: m.status,
        beginAt: m.begin_at,
        endAt: m.end_at,
        scheduledAt: m.scheduled_at,
        startsInMinutes,
        seriesType: toSeriesType(m.number_of_games),
        numberOfGames: m.number_of_games ?? 0,
        forfeit: m.forfeit,
        draw: m.draw,
        rescheduled: m.rescheduled,
        detailedStats: m.detailed_stats,
        liveSupported: m.live?.supported ?? false,
        liveUrl: m.live?.url ?? null,
        liveOpensAt: m.live?.opens_at ?? null,
        mainStream: mainStream?.raw_url
          ? { url: mainStream.raw_url, embedUrl: mainStream.embed_url ?? '', language: mainStream.language }
          : null,
        allStreams: (m.streams_list ?? []).map(s => ({
          url: s.raw_url ?? '',
          embedUrl: s.embed_url,
          language: s.language,
          main: s.main,
          official: s.official,
        })),
        league: m.league?.name ?? 'Unknown',
        leagueImageUrl: m.league?.image_url ?? null,
        leagueSlug: m.league?.slug ?? '',
        serie: m.serie?.full_name ?? m.serie?.name ?? '',
        serieYear: m.serie?.year ?? null,
        serieSeason: m.serie?.season ?? null,
        tournament: m.tournament?.name ?? 'Unknown',
        tournamentType: m.tournament?.type ?? '',
        tier: m.tournament?.tier ?? null,
        region: m.tournament?.region ?? null,
        prizepool: m.tournament?.prizepool ?? null,
        hasBracket: m.tournament?.has_bracket ?? false,
        teamA: opponentA ? buildTeam(opponentA, results, winnerId, rosterMap) : null,
        teamB: opponentB ? buildTeam(opponentB, results, winnerId, rosterMap) : null,
        games: (m.games ?? []).map(g => ({
          position: g.position,
          status: g.status,
          finished: g.finished,
          durationSec: g.length,
          durationLabel: formatDuration(g.length),
          beginAt: g.begin_at,
          endAt: g.end_at,
          forfeit: g.forfeit,
          winnerTeamId: g.winner?.id ?? null,
        })),
        seriesScore: opponentA && opponentB
          ? `${results.find(r => r.team_id === opponentA.id)?.score ?? 0}–${results.find(r => r.team_id === opponentB.id)?.score ?? 0}`
          : '–',
        winner: m.winner ? (m.winner as PandaTeam).name ?? null : null,
        winnerTeamId: winnerId,
      };
    });

    // Summary
    const statusCount = matches.reduce(
      (acc, m) => { acc[toStatusBucket(m.status)] += 1; return acc; },
      { running: 0, upcoming: 0, finished: 0, other: 0 },
    );

    const leagueMap = new Map<string, number>();
    const seriesCount: Record<SeriesType, number> = { bo1: 0, bo2: 0, bo3: 0, bo5: 0, unknown: 0 };
    for (const m of matches) {
      leagueMap.set(m.league, (leagueMap.get(m.league) ?? 0) + 1);
      seriesCount[m.seriesType] += 1;
    }
    const topLeagues = [...leagueMap.entries()]
      .map(([name, count]) => ({ name, matches: count }))
      .sort((a, b) => b.matches - a.matches)
      .slice(0, 8);

    res.json({
      summary: { totalMatches: matches.length, ...statusCount },
      charts: { topLeagues, seriesCount },
      matches,
      generatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    const status = error?.response?.status;
    const message = error?.response?.data?.message || error?.message || 'Unknown PandaScore error';
    res.status(status && Number.isFinite(status) ? status : 500).json({
      error: 'Failed to fetch PandaScore LoL data',
      details: message,
    });
  }
});

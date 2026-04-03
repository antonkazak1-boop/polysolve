import prisma from '../config/database';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TeamRating {
  team: string;
  elo: number;
  matches: number;
  wins: number;
  losses: number;
  winRate: number;
  lastPlayed: string;
}

interface MapResult {
  winner: string;
  loser: string;
  date: string;
  tournament: string;
}

// ─── Elo math ────────────────────────────────────────────────────────────────

const K = 32;
const BASE_ELO = 1500;

function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

export function eloWinProbability(ratingA: number, ratingB: number): number {
  return expectedScore(ratingA, ratingB);
}

// ─── Parse match scores into individual map outcomes ─────────────────────────

function parseScore(score: string): [number, number] | null {
  const m = score.match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

function matchToMapResults(match: {
  team1: string | null;
  team2: string | null;
  score: string | null;
  gameDate: string | null;
  tournamentName: string | null;
}): MapResult[] {
  if (!match.team1 || !match.team2 || !match.score) return [];
  const parsed = parseScore(match.score);
  if (!parsed) return [];
  const [s1, s2] = parsed;
  const date = match.gameDate ?? '';
  const tournament = match.tournamentName ?? '';
  const results: MapResult[] = [];

  for (let i = 0; i < s1; i++) {
    results.push({ winner: match.team1, loser: match.team2, date, tournament });
  }
  for (let i = 0; i < s2; i++) {
    results.push({ winner: match.team2, loser: match.team1, date, tournament });
  }
  return results;
}

// ─── Build ratings from match history ────────────────────────────────────────

let cachedRatings: Map<string, TeamRating> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000;

export async function computeTeamRatings(): Promise<Map<string, TeamRating>> {
  const now = Date.now();
  if (cachedRatings && now - cacheTimestamp < CACHE_TTL) return cachedRatings;

  const matches = await prisma.golMatch.findMany({
    orderBy: [{ gameDate: 'asc' }, { gameId: 'asc' }],
    select: { team1: true, team2: true, score: true, gameDate: true, tournamentName: true },
  });

  const elo = new Map<string, number>();
  const stats = new Map<string, { matches: Set<number>; wins: number; losses: number; lastPlayed: string }>();

  const getElo = (t: string) => elo.get(t) ?? BASE_ELO;
  const getStat = (t: string) =>
    stats.get(t) ?? { matches: new Set<number>(), wins: 0, losses: 0, lastPlayed: '' };

  for (let mi = 0; mi < matches.length; mi++) {
    const match = matches[mi];
    const maps = matchToMapResults(match);
    if (maps.length === 0) continue;

    const t1 = match.team1!;
    const t2 = match.team2!;
    const stat1 = getStat(t1);
    const stat2 = getStat(t2);
    stat1.matches.add(mi);
    stat2.matches.add(mi);
    stat1.lastPlayed = match.gameDate ?? stat1.lastPlayed;
    stat2.lastPlayed = match.gameDate ?? stat2.lastPlayed;

    const parsed = parseScore(match.score!);
    if (parsed) {
      const [s1, s2] = parsed;
      if (s1 > s2) { stat1.wins++; stat2.losses++; }
      else if (s2 > s1) { stat2.wins++; stat1.losses++; }
    }
    stats.set(t1, stat1);
    stats.set(t2, stat2);

    for (const map of maps) {
      const rW = getElo(map.winner);
      const rL = getElo(map.loser);
      const eW = expectedScore(rW, rL);
      elo.set(map.winner, rW + K * (1 - eW));
      elo.set(map.loser, rL + K * (0 - (1 - eW)));
    }
  }

  const result = new Map<string, TeamRating>();
  for (const [team, rating] of elo) {
    const s = stats.get(team)!;
    const totalMatches = s.matches.size;
    result.set(team, {
      team,
      elo: Math.round(rating),
      matches: totalMatches,
      wins: s.wins,
      losses: s.losses,
      winRate: totalMatches > 0 ? Math.round((s.wins / totalMatches) * 1000) / 10 : 0,
      lastPlayed: s.lastPlayed,
    });
  }

  cachedRatings = result;
  cacheTimestamp = now;
  return result;
}

export async function getTeamRatings(): Promise<TeamRating[]> {
  const ratings = await computeTeamRatings();
  return [...ratings.values()].sort((a, b) => b.elo - a.elo);
}

export async function getWinProbability(
  teamA: string,
  teamB: string,
): Promise<{ p_a: number; p_b: number; eloA: number; eloB: number }> {
  const ratings = await computeTeamRatings();
  const eloA = ratings.get(teamA)?.elo ?? BASE_ELO;
  const eloB = ratings.get(teamB)?.elo ?? BASE_ELO;
  const p_a = eloWinProbability(eloA, eloB);
  return { p_a, p_b: 1 - p_a, eloA, eloB };
}

export function invalidateEloCache() {
  cachedRatings = null;
  cacheTimestamp = 0;
}

import prisma from '../config/database';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DraftPick {
  player?: string;
  champion: string;
}

export interface MatchHistoryFactor {
  wrA: number;
  wrB: number;
  delta: number;
  mapsA: number;
  mapsB: number;
  seriesA: number;
  seriesB: number;
}

export interface PlayerStatsFactor {
  scoreA: number;
  scoreB: number;
  delta: number;
  playersA: PlayerProfile[];
  playersB: PlayerProfile[];
}

export interface PlayerProfile {
  name: string;
  score: number;
  games: number;
  winRate: number;
  kda: number;
  seasons: string[];
}

export interface DraftPickDetail {
  side: 'blue' | 'red';
  player?: string;
  champion: string;
  championMeta: number;
  playerProficiency: number;
  playerGames: number;
  combined: number;
}

export interface DraftFactor {
  scoreA: number;
  scoreB: number;
  delta: number;
  picks: DraftPickDetail[];
}

export interface FactorBreakdown {
  matchHistory: MatchHistoryFactor;
  playerStats?: PlayerStatsFactor;
  draft?: DraftFactor;
}

export interface TeamStrength {
  team: string;
  wr: number;
  mapWins: number;
  mapLosses: number;
  series: number;
  recentForm: number;
}

export interface CompositePrediction {
  pMap: number;
  factors: FactorBreakdown;
  weights: { matchHistory: number; playerStats: number; draft: number };
  seasonsUsed: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DECAY_DAYS = 120;
const SEASONS_DEFAULT = ['S16', 'S15', 'S14'];
const SEASON_WEIGHT: Record<string, number> = { S16: 1.0, S15: 0.6, S14: 0.3, ALL: 0.2 };

const W_MATCH = 2.5;
const W_PLAYERS = 1.8;
const W_DRAFT = 1.2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function daysBetween(dateStr: string, now: Date): number {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 365;
  return Math.max(0, (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function parseNum(v: string | number | null | undefined): number {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const x = parseFloat(String(v).replace('%', '').replace(',', '.'));
  return isNaN(x) ? 0 : x;
}

// ─── 1. Match History (replaces Elo) ─────────────────────────────────────────

let matchHistoryCache: Map<string, MatchHistoryResult> | null = null;
let matchCacheTs = 0;

interface MatchHistoryResult {
  wr: number;
  mapWins: number;
  mapLosses: number;
  series: number;
  recentForm: number;
}

async function loadAllMatchHistories(): Promise<Map<string, MatchHistoryResult>> {
  const now = Date.now();
  if (matchHistoryCache && now - matchCacheTs < 5 * 60 * 1000) return matchHistoryCache;

  const matches = await prisma.golMatch.findMany({
    where: { score: { not: null } },
    select: { team1: true, team2: true, score: true, gameDate: true },
    orderBy: { gameDate: 'asc' },
  });

  const teamData = new Map<string, {
    weightedWins: number;
    weightedTotal: number;
    mapWins: number;
    mapLosses: number;
    series: number;
    recentWins: number;
    recentTotal: number;
  }>();

  const nowDate = new Date();

  const getTeam = (name: string) => {
    if (!teamData.has(name)) {
      teamData.set(name, { weightedWins: 0, weightedTotal: 0, mapWins: 0, mapLosses: 0, series: 0, recentWins: 0, recentTotal: 0 });
    }
    return teamData.get(name)!;
  };

  for (const m of matches) {
    if (!m.score || !m.team1 || !m.team2) continue;
    const parts = m.score.match(/(\d+)\s*-\s*(\d+)/);
    if (!parts) continue;
    const s1 = Number(parts[1]);
    const s2 = Number(parts[2]);
    const days = daysBetween(m.gameDate ?? '', nowDate);
    const w = Math.exp(-days / DECAY_DAYS);
    const isRecent = days < 45;

    const t1 = getTeam(m.team1);
    const t2 = getTeam(m.team2);
    t1.series++;
    t2.series++;

    for (let i = 0; i < s1; i++) {
      t1.weightedWins += w; t1.weightedTotal += w; t1.mapWins++;
      t2.weightedTotal += w; t2.mapLosses++;
      if (isRecent) { t1.recentWins++; t1.recentTotal++; t2.recentTotal++; }
    }
    for (let i = 0; i < s2; i++) {
      t2.weightedWins += w; t2.weightedTotal += w; t2.mapWins++;
      t1.weightedTotal += w; t1.mapLosses++;
      if (isRecent) { t2.recentWins++; t2.recentTotal++; t1.recentTotal++; }
    }
  }

  const result = new Map<string, MatchHistoryResult>();
  for (const [team, d] of teamData) {
    result.set(team, {
      wr: d.weightedTotal > 0 ? d.weightedWins / d.weightedTotal : 0.5,
      mapWins: d.mapWins,
      mapLosses: d.mapLosses,
      series: d.series,
      recentForm: d.recentTotal > 0 ? d.recentWins / d.recentTotal : 0.5,
    });
  }

  matchHistoryCache = result;
  matchCacheTs = now;
  return result;
}

function getTeamHistory(histories: Map<string, MatchHistoryResult>, team: string): MatchHistoryResult {
  return histories.get(team) ?? { wr: 0.5, mapWins: 0, mapLosses: 0, series: 0, recentForm: 0.5 };
}

// ─── 2. Player Stats ─────────────────────────────────────────────────────────

async function getPlayerProfile(
  playerName: string,
  seasons: string[],
): Promise<PlayerProfile | null> {
  const rows = await prisma.golPlayerStat.findMany({
    where: { playerName, season: { in: seasons } },
  });
  if (rows.length === 0) return null;

  let totalWeight = 0;
  let wWr = 0, wKda = 0, totalGames = 0;
  const foundSeasons: string[] = [];

  for (const r of rows) {
    const sw = SEASON_WEIGHT[r.season] ?? 0.3;
    const games = r.games || 1;
    const w = sw * games;
    wWr += parseNum(r.winRate) * w;
    wKda += parseNum(r.kda) * w;
    totalGames += r.games || 0;
    totalWeight += w;
    if (!foundSeasons.includes(r.season)) foundSeasons.push(r.season);
  }

  if (totalWeight === 0) return null;

  const winRate = wWr / totalWeight;
  const kda = wKda / totalWeight;

  // Score: winrate deviation (50% = neutral), KDA bonus, experience confidence
  const wrDev = (winRate - 50) / 50;                        // -1..+1 range
  const kdaBonus = Math.max(-0.3, Math.min(0.3, (kda - 2.5) / 8));
  const expConf = Math.min(totalGames / 80, 1);             // ramp up over ~80 games

  const score = (wrDev * 0.55 + kdaBonus * 0.45) * expConf;

  return { name: playerName, score, games: totalGames, winRate, kda, seasons: foundSeasons };
}

// ─── 3. Champion Meta ────────────────────────────────────────────────────────

async function getChampionMeta(
  champion: string,
  seasons: string[],
): Promise<{ metaScore: number; picks: number; winrate: number; gd15: number }> {
  const rows = await prisma.golChampionStat.findMany({
    where: { champion, split: 'ALL', tournament: 'ALL', season: { in: seasons } },
  });
  if (rows.length === 0) {
    const lower = champion.toLowerCase();
    const fallback = await prisma.golChampionStat.findMany({
      where: { split: 'ALL', tournament: 'ALL', season: { in: seasons } },
    });
    const matched = fallback.filter(r => r.champion.toLowerCase() === lower);
    if (matched.length === 0) return { metaScore: 0, picks: 0, winrate: 50, gd15: 0 };
    rows.push(...matched);
  }

  let totalWeight = 0;
  let wWr = 0, wGd15 = 0, totalPicks = 0;

  for (const r of rows) {
    const wr = parseNum(r.winrate);
    const gd15 = r.gd15 ?? 0;
    const picks = r.picks ?? 0;
    const sw = SEASON_WEIGHT[r.season] ?? 0.25;
    const w = sw * Math.min(picks / 50, 1);
    wWr += wr * w;
    wGd15 += gd15 * w;
    totalPicks += picks;
    totalWeight += w;
  }

  if (totalWeight === 0) return { metaScore: 0, picks: 0, winrate: 50, gd15: 0 };

  const avgWr = wWr / totalWeight;
  const avgGd15 = wGd15 / totalWeight;
  const wrDev = (avgWr - 50) / 50;
  const gd15Norm = Math.max(-1, Math.min(1, avgGd15 / 500));
  const metaScore = wrDev * 0.55 + gd15Norm * 0.45;

  return { metaScore, picks: totalPicks, winrate: avgWr, gd15: avgGd15 };
}

// ─── 4. Player-Champion Proficiency ──────────────────────────────────────────

async function getPlayerChampionFit(
  playerName: string,
  champion: string,
  seasons: string[],
): Promise<{ proficiency: number; games: number; winRate: number; kda: number }> {
  const rows = await prisma.golPlayerChampionStat.findMany({
    where: { playerName, season: { in: seasons } },
  });
  const matched = rows.filter(r => r.champion.toLowerCase() === champion.toLowerCase());
  if (matched.length === 0) return { proficiency: 0, games: 0, winRate: 50, kda: 0 };

  let totalGames = 0, weightedWr = 0, weightedKda = 0, totalWeight = 0;

  for (const r of matched) {
    const g = r.games ?? 0;
    const wr = parseNum(r.winRate);
    const kda = parseNum(r.kda);
    const sw = SEASON_WEIGHT[r.season] ?? 0.3;
    const w = sw * g;
    weightedWr += wr * w;
    weightedKda += kda * w;
    totalGames += g;
    totalWeight += w;
  }

  if (totalWeight === 0) return { proficiency: 0, games: 0, winRate: 50, kda: 0 };

  const avgWr = weightedWr / totalWeight;
  const avgKda = weightedKda / totalWeight;
  const wrDev = (avgWr - 50) / 50;
  const expConf = Math.min(totalGames / 20, 1);
  const kdaBonus = Math.max(-0.3, Math.min(0.3, (avgKda - 2.5) / 10));
  const proficiency = (wrDev * 0.6 + kdaBonus * 0.4) * expConf;

  return { proficiency, games: totalGames, winRate: avgWr, kda: avgKda };
}

// ─── 5. Draft Evaluation ─────────────────────────────────────────────────────

async function evaluateDraftSide(
  picks: DraftPick[],
  side: 'blue' | 'red',
  seasons: string[],
): Promise<{ score: number; details: DraftPickDetail[] }> {
  const details: DraftPickDetail[] = [];
  let totalScore = 0;

  for (const pick of picks) {
    const meta = await getChampionMeta(pick.champion, seasons);
    let proficiency = 0;
    let playerGames = 0;

    if (pick.player) {
      const fit = await getPlayerChampionFit(pick.player, pick.champion, seasons);
      proficiency = fit.proficiency;
      playerGames = fit.games;
    }

    const hasPlayer = Boolean(pick.player);
    const combined = hasPlayer
      ? meta.metaScore * 0.45 + proficiency * 0.55
      : meta.metaScore;
    totalScore += combined;

    details.push({
      side,
      player: pick.player,
      champion: pick.champion,
      championMeta: Math.round(meta.metaScore * 1000) / 1000,
      playerProficiency: Math.round(proficiency * 1000) / 1000,
      playerGames,
      combined: Math.round(combined * 1000) / 1000,
    });
  }

  return { score: totalScore, details };
}

// ─── 6. Composite Prediction ─────────────────────────────────────────────────

export async function predictMapComposite(config: {
  teamA: string;
  teamB: string;
  playersA?: string[];
  playersB?: string[];
  draftA?: DraftPick[];
  draftB?: DraftPick[];
  seasons?: string[];
}): Promise<CompositePrediction> {
  const seasons = config.seasons ?? SEASONS_DEFAULT;

  // Factor 1: Match History
  const histories = await loadAllMatchHistories();
  const histA = getTeamHistory(histories, config.teamA);
  const histB = getTeamHistory(histories, config.teamB);
  const matchDelta = histA.wr - histB.wr;

  // Factor 2: Player Stats
  const pNamesA = config.playersA
    ?? config.draftA?.map(d => d.player).filter((n): n is string => Boolean(n))
    ?? [];
  const pNamesB = config.playersB
    ?? config.draftB?.map(d => d.player).filter((n): n is string => Boolean(n))
    ?? [];

  let playerDelta = 0;
  let playerFactor: PlayerStatsFactor | undefined;

  if (pNamesA.length >= 3 && pNamesB.length >= 3) {
    const [profilesA, profilesB] = await Promise.all([
      Promise.all(pNamesA.map(n => getPlayerProfile(n, seasons))),
      Promise.all(pNamesB.map(n => getPlayerProfile(n, seasons))),
    ]);
    const validA = profilesA.filter((p): p is PlayerProfile => p !== null);
    const validB = profilesB.filter((p): p is PlayerProfile => p !== null);
    const scoreA = validA.length > 0 ? validA.reduce((s, p) => s + p.score, 0) / validA.length : 0.5;
    const scoreB = validB.length > 0 ? validB.reduce((s, p) => s + p.score, 0) / validB.length : 0.5;
    playerDelta = scoreA - scoreB;

    playerFactor = {
      scoreA: Math.round(scoreA * 1000) / 1000,
      scoreB: Math.round(scoreB * 1000) / 1000,
      delta: Math.round(playerDelta * 1000) / 1000,
      playersA: validA,
      playersB: validB,
    };
  }

  // Factor 3: Draft
  let draftDelta = 0;
  let draftFactor: DraftFactor | undefined;

  if (config.draftA?.length === 5 && config.draftB?.length === 5) {
    const [evalA, evalB] = await Promise.all([
      evaluateDraftSide(config.draftA, 'blue', seasons),
      evaluateDraftSide(config.draftB, 'red', seasons),
    ]);
    draftDelta = evalA.score - evalB.score;
    draftFactor = {
      scoreA: Math.round(evalA.score * 1000) / 1000,
      scoreB: Math.round(evalB.score * 1000) / 1000,
      delta: Math.round(draftDelta * 1000) / 1000,
      picks: [...evalA.details, ...evalB.details],
    };
  }

  // Composite
  const hasPlayers = Boolean(playerFactor);
  const hasDraft = Boolean(draftFactor);
  const wMatch = W_MATCH;
  const wPlayers = hasPlayers ? W_PLAYERS : 0;
  const wDraft = hasDraft ? W_DRAFT : 0;

  const logit = wMatch * matchDelta + wPlayers * playerDelta + wDraft * draftDelta;
  const pMap = Math.max(0.05, Math.min(0.95, sigmoid(logit)));

  return {
    pMap: Math.round(pMap * 10000) / 10000,
    factors: {
      matchHistory: {
        wrA: Math.round(histA.wr * 1000) / 1000,
        wrB: Math.round(histB.wr * 1000) / 1000,
        delta: Math.round(matchDelta * 1000) / 1000,
        mapsA: histA.mapWins,
        mapsB: histB.mapWins,
        seriesA: histA.series,
        seriesB: histB.series,
      },
      playerStats: playerFactor,
      draft: draftFactor,
    },
    weights: { matchHistory: wMatch, playerStats: wPlayers, draft: wDraft },
    seasonsUsed: seasons,
  };
}

// ─── 7. Team Ratings (for UI — replaces Elo table) ───────────────────────────

export async function getCompositeTeamRatings(): Promise<TeamStrength[]> {
  const histories = await loadAllMatchHistories();
  const result: TeamStrength[] = [];
  for (const [team, h] of histories) {
    if (h.series < 2) continue;
    result.push({
      team,
      wr: Math.round(h.wr * 1000) / 10,
      mapWins: h.mapWins,
      mapLosses: h.mapLosses,
      series: h.series,
      recentForm: Math.round(h.recentForm * 1000) / 10,
    });
  }
  return result.sort((a, b) => b.wr - a.wr);
}

// ─── 8. Champion Power List (multi-season) ───────────────────────────────────

export interface ChampionPowerComposite {
  champion: string;
  metaScore: number;
  winrate: number;
  picks: number;
  gd15: number;
}

export async function getChampionPowerListComposite(
  seasons: string[] = SEASONS_DEFAULT,
): Promise<ChampionPowerComposite[]> {
  const rows = await prisma.golChampionStat.findMany({
    where: { split: 'ALL', tournament: 'ALL', season: { in: seasons } },
  });

  const byChamp = new Map<string, { name: string; totalW: number; wWr: number; wGd15: number; totalPicks: number }>();
  for (const r of rows) {
    const key = r.champion.toLowerCase();
    const entry = byChamp.get(key) ?? { name: r.champion, totalW: 0, wWr: 0, wGd15: 0, totalPicks: 0 };
    const wr = parseNum(r.winrate);
    const gd15 = r.gd15 ?? 0;
    const picks = r.picks ?? 0;
    const sw = SEASON_WEIGHT[r.season] ?? 0.25;
    const w = sw * Math.min(picks / 50, 1);
    entry.wWr += wr * w;
    entry.wGd15 += gd15 * w;
    entry.totalPicks += picks;
    entry.totalW += w;
    byChamp.set(key, entry);
  }

  const result: ChampionPowerComposite[] = [];
  for (const [, entry] of byChamp) {
    if (entry.totalW === 0) continue;
    const avgWr = entry.wWr / entry.totalW;
    const avgGd15 = entry.wGd15 / entry.totalW;
    const wrDev = (avgWr - 50) / 50;
    const gd15Norm = Math.max(-1, Math.min(1, avgGd15 / 500));
    result.push({
      champion: entry.name,
      metaScore: Math.round((wrDev * 0.55 + gd15Norm * 0.45) * 1000) / 1000,
      winrate: Math.round(avgWr * 10) / 10,
      picks: entry.totalPicks,
      gd15: Math.round(avgGd15),
    });
  }

  return result.sort((a, b) => b.metaScore - a.metaScore);
}

export function invalidateModelCache() {
  matchHistoryCache = null;
  matchCacheTs = 0;
}

import prisma from '../config/database';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChampionWR {
  champion: string;
  games: number;
  wGames: number; // weighted games
  wins: number;
  winRate: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  avgGD15: number;
  avgDPM: number;
}

/**
 * Empirical scaling profile for a champion, derived from WR in early vs late games.
 *
 * scalingScore ∈ [-1, +1]:
 *   +1 = strong late-game scaler (WR rises significantly in long games)
 *    0 = neutral
 *   -1 = early-game dominant (WR falls sharply in long games)
 *
 * Formula: scalingScore = tanh((wrLate - wrEarly) * 8)
 * Buckets:  early < 27 min, late >= 33 min  (27–33 is mid, excluded to sharpen signal)
 */
export interface ChampionScaling {
  champion: string;
  scalingScore: number;   // tanh-compressed, -1..+1
  wrEarly: number;        // WR in games < 27 min
  wrLate: number;         // WR in games >= 33 min
  gamesEarly: number;
  gamesLate: number;
  tag: 'scaling' | 'early' | 'neutral';
}

export interface SynergyPair {
  champA: string;
  champB: string;
  games: number;
  wins: number;
  winRate: number;
  lift: number;
  /** Multiplier based on role-pair (top+jng, jng+mid, bot+sup get higher weight). */
  roleWeight?: number;
}

export interface MatchupStat {
  champion: string;
  opponent: string;
  position: string;
  /** Position of the opponent ('top','jng',...). Same as position for lane matchups. */
  opponentPosition: string;
  /** 'lane' = same-position head-to-head, 'cross' = different-position influence. */
  kind: 'lane' | 'cross';
  games: number;
  wins: number;
  winRate: number;
  avgGD15: number;
  avgCSD15: number;
  avgXPD15: number;
  scalingTag: 'early' | 'scaling' | 'neutral';
  adjustedAdvantage: number;
}

export interface PlayerChampionMastery {
  player: string;
  champion: string;
  games: number;
  wins: number;
  winRate: number;
  avgKDA: number;
  avgGD15: number;
  avgDPM: number;
  avgCSPM: number;
  wrDelta: number;
  /** 1.0 = player's best champion, lower = less comfortable pick. */
  comfortCoeff: number;
  /** True when there are zero pro games for this player+champion — floor comfort applied. */
  noProData?: boolean;
}

export interface DraftScore {
  teamSide: string;
  championTier: number;
  synergyScore: number;
  matchupScore: number;
  masteryScore: number;
  /** Avg scaling score for this side's champions; -1..+1. Not part of totalScore — informational. */
  scalingScore: number;
  totalScore: number;
  components: {
    champions: ChampionWR[];
    synergies: SynergyPair[];
    matchups: MatchupStat[];
    mastery: PlayerChampionMastery[];
    scaling: ChampionScaling[];
  };
}

/** Relative weights for score mix (any positive scale; normalized to sum 1 on the server). */
export interface DraftScoreMixInput {
  championTier: number;
  synergy: number;
  matchup: number;
  mastery: number;
}

/** Normalized weights for composite totalScore (sum = 1). */
export interface DraftScoreMixNormalized {
  championTier: number;
  synergy: number;
  matchup: number;
  mastery: number;
}

export interface DraftAnalysisResult {
  blue: DraftScore;
  red: DraftScore;
  blueWinProbability: number;
  advantage: 'BLUE' | 'RED' | 'EVEN';
  advantageMargin: number;
  /**
   * Scaling balance = blue.scalingScore - red.scalingScore, clamped to [-1, +1].
   * Positive = Blue has more late-game champions, negative = Red is more early.
   * Shown in UI as a standalone indicator; does not affect totalScore directly.
   */
  scalingBalance: number;
  patchesUsed: string[];
  gamesAnalyzed: number;
  weightsApplied: DraftWeightsConfig;
  /** How much each pillar contributes to totalScore (sums to 100%). */
  scoreMixApplied: DraftScoreMixNormalized;
  dataWindows: {
    championWR: string;
    synergiesMatchups: string;
    playerMastery: string;
  };
}

// ─── League tier & year weighting (configurable) ────────────────────────────

export interface DraftWeightsConfig {
  leagueTier1: number;
  leagueTier2: number;
  leagueTier3: number;
  yearCurrent: number;
  yearPrev: number;
  yearOlder: number;
  /** Seasons >= anchor count as "current"; anchor-1 = yearPrev; older = yearOlder */
  anchorYear: number;
}

export const DEFAULT_DRAFT_WEIGHTS: DraftWeightsConfig = {
  leagueTier1: 10,
  leagueTier2: 1.5,
  leagueTier3: 0.5,
  yearCurrent: 3,
  yearPrev: 1.5,
  yearOlder: 0.7,
  anchorYear: 2026,
};

const TIER1_LEAGUES = new Set([
  'LCK', 'LPL', 'LEC', 'LCS', 'MSI', 'WLDs',
]);
const TIER2_LEAGUES = new Set([
  'PCS', 'VCS', 'CBLOL', 'LJL', 'LLA', 'LAS',
  'LCKC', 'LDL', 'NACL', 'TCL',
]);

function clampWeight(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0.01, n));
}

export function resolveDraftWeights(partial?: Partial<DraftWeightsConfig>): DraftWeightsConfig {
  const d = DEFAULT_DRAFT_WEIGHTS;
  let anchor = typeof partial?.anchorYear === 'number' ? partial.anchorYear : Number(partial?.anchorYear);
  if (!Number.isFinite(anchor)) anchor = d.anchorYear;
  anchor = Math.round(Math.min(2035, Math.max(2020, anchor)));
  return {
    leagueTier1: clampWeight(typeof partial?.leagueTier1 === 'number' ? partial.leagueTier1 : Number(partial?.leagueTier1), d.leagueTier1),
    leagueTier2: clampWeight(typeof partial?.leagueTier2 === 'number' ? partial.leagueTier2 : Number(partial?.leagueTier2), d.leagueTier2),
    leagueTier3: clampWeight(typeof partial?.leagueTier3 === 'number' ? partial.leagueTier3 : Number(partial?.leagueTier3), d.leagueTier3),
    yearCurrent: clampWeight(typeof partial?.yearCurrent === 'number' ? partial.yearCurrent : Number(partial?.yearCurrent), d.yearCurrent),
    yearPrev: clampWeight(typeof partial?.yearPrev === 'number' ? partial.yearPrev : Number(partial?.yearPrev), d.yearPrev),
    yearOlder: clampWeight(typeof partial?.yearOlder === 'number' ? partial.yearOlder : Number(partial?.yearOlder), d.yearOlder),
    anchorYear: anchor,
  };
}

function leagueWeight(league: string, cfg: DraftWeightsConfig): number {
  if (TIER1_LEAGUES.has(league)) return cfg.leagueTier1;
  if (TIER2_LEAGUES.has(league)) return cfg.leagueTier2;
  return cfg.leagueTier3;
}

function yearWeight(year: number, cfg: DraftWeightsConfig): number {
  const age = cfg.anchorYear - year;
  if (age <= 0) return cfg.yearCurrent;
  if (age === 1) return cfg.yearPrev;
  return cfg.yearOlder;
}

function gameWeight(league: string, year: number, cfg: DraftWeightsConfig): number {
  return leagueWeight(league, cfg) * yearWeight(year, cfg);
}

export function formatWeightsSummary(cfg: DraftWeightsConfig): string {
  return `T1 ×${cfg.leagueTier1} T2 ×${cfg.leagueTier2} T3 ×${cfg.leagueTier3} | ${cfg.anchorYear} ×${cfg.yearCurrent} ${cfg.anchorYear - 1} ×${cfg.yearPrev} ≤${cfg.anchorYear - 2} ×${cfg.yearOlder}`;
}

export const DEFAULT_SCORE_MIX: DraftScoreMixInput = {
  championTier: 30,
  synergy: 25,
  matchup: 25,
  mastery: 20,
};

function pickMix(partial: Partial<DraftScoreMixInput> | undefined, key: keyof DraftScoreMixInput, d: DraftScoreMixInput): number {
  const v = partial?.[key];
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return d[key];
  return n;
}

/** Normalize positive relative weights to fractions summing to 1. */
export function resolveScoreMix(partial?: Partial<DraftScoreMixInput>): DraftScoreMixNormalized {
  const d = DEFAULT_SCORE_MIX;
  let ct = pickMix(partial, 'championTier', d);
  let sy = pickMix(partial, 'synergy', d);
  let mu = pickMix(partial, 'matchup', d);
  let ma = pickMix(partial, 'mastery', d);
  const sum = ct + sy + mu + ma;
  if (sum <= 0) {
    ct = d.championTier;
    sy = d.synergy;
    mu = d.matchup;
    ma = d.mastery;
  }
  const s2 = ct + sy + mu + ma;
  return {
    championTier: ct / s2,
    synergy: sy / s2,
    matchup: mu / s2,
    mastery: ma / s2,
  };
}

export function formatScoreMixSummary(m: DraftScoreMixNormalized): string {
  const p = (x: number) => `${(x * 100).toFixed(1)}%`;
  return `Champ ${p(m.championTier)} · Syn ${p(m.synergy)} · Match ${p(m.matchup)} · Mast ${p(m.mastery)}`;
}

// ─── Role-pair synergy weights ────────────────────────────────────────────────
// Pairs that interact more in-game get higher synergy multiplier.

const ROLE_PAIR_WEIGHTS: Record<string, number> = {
  'jng|top': 1.5,
  'jng|mid': 1.5,
  'bot|sup': 1.5,
};

function rolePairWeight(posA: string, posB: string): number {
  const key = [posA, posB].sort().join('|');
  return ROLE_PAIR_WEIGHTS[key] ?? 1.0;
}

// ─── Draft sample confidence tuning ──────────────────────────────────────────
// Centralised constants — tweak after backtests.

/** Games needed for full mastery/comfort reliability on a champion. */
const G_MASTERY_FULL = 15;
/** Min games on a champion to be eligible for "best champ = 1.0" normalization. */
const G_NORM_MIN = 5;
/** Reference game count for synergy pair confidence (ramp 0→1). */
const N_REF_SYNERGY = 15;
/** Reference game count for matchup confidence (ramp 0→1). */
const N_REF_MATCHUP = 10;
/** Weight of a direct-lane (same position) matchup in the composite matchup score. */
const W_LANE = 1.0;
/** Weight of a cross-position matchup (e.g. top vs enemy jungler). */
const W_CROSS = 0.33;

/** Sample confidence: linear ramp 0→1 over `nRef` games, capped at 1. */
function sampleConfidence(games: number, nRef: number): number {
  return Math.min(1, games / nRef);
}

// ─── Player comfort coefficient ──────────────────────────────────────────────

function computeRawComfort(games: number, winRate: number, kda: number, totalPlayerGames: number): number {
  // Share of the player's total games on this champion (relative experience).
  // A player with 10 total games and 5 on Renekton → shareScore ≈ 1.0
  const share = totalPlayerGames > 0 ? games / totalPlayerGames : 0;
  const shareScore = Math.min(share * 2, 1.0);
  const wrScore = Math.max(0, Math.min(1, winRate));
  const kdaScore = Math.min(kda / 5.0, 1.0);
  return shareScore * 0.40 + wrScore * 0.40 + kdaScore * 0.20;
}

/** Comfort when player has no recorded pro games on the drafted champion (counts in mastery average). */
export const DRAFT_MIN_COMFORT_COEFF = 0.05;

// ─── Champion scaling by game length ─────────────────────────────────────────
// Cache (TTL 30 min) since this query scans the full player-game table.

let scalingCache: Map<string, ChampionScaling> | null = null;
let scalingCacheTs = 0;
const SCALING_CACHE_TTL = 30 * 60 * 1000;

// Game-length buckets in seconds: early < 1620 (27 min), late >= 1980 (33 min).
const EARLY_MAX_SEC = 27 * 60;
const LATE_MIN_SEC = 33 * 60;
const SCALING_MIN_GAMES = 10; // min games per bucket to trust the WR

/**
 * For every champion with enough data, compute a continuous scaling score:
 *   scalingScore = tanh((wrLate - wrEarly) * 8)  ∈ [-1, +1]
 *
 * We query OEPlayerGame joined to OEGame.gamelength to bucket games.
 * Result is cached for SCALING_CACHE_TTL.
 */
export async function getChampionScaling(): Promise<Map<string, ChampionScaling>> {
  const now = Date.now();
  if (scalingCache && now - scalingCacheTs < SCALING_CACHE_TTL) return scalingCache;

  const rows = await prisma.oEPlayerGame.findMany({
    select: {
      champion: true,
      result: true,
      game: { select: { gamelength: true } },
    },
    where: { position: { not: 'team' } },
  });

  // Accumulate wins/games per champion per bucket.
  const acc = new Map<string, { earlyW: number; earlyN: number; lateW: number; lateN: number }>();
  for (const r of rows) {
    const sec = r.game.gamelength;
    if (sec == null) continue;
    const key = r.champion.toLowerCase();
    const s = acc.get(key) ?? { earlyW: 0, earlyN: 0, lateW: 0, lateN: 0 };
    if (sec < EARLY_MAX_SEC) {
      s.earlyN++;
      if (r.result === 1) s.earlyW++;
    } else if (sec >= LATE_MIN_SEC) {
      s.lateN++;
      if (r.result === 1) s.lateW++;
    }
    acc.set(key, s);
  }

  const result = new Map<string, ChampionScaling>();
  for (const [champ, s] of acc) {
    if (s.earlyN < SCALING_MIN_GAMES || s.lateN < SCALING_MIN_GAMES) continue;
    const wrEarly = s.earlyW / s.earlyN;
    const wrLate = s.lateW / s.lateN;
    const slope = wrLate - wrEarly;
    const scalingScore = Math.tanh(slope * 8);
    const tag: ChampionScaling['tag'] =
      scalingScore > 0.15 ? 'scaling' :
      scalingScore < -0.15 ? 'early' : 'neutral';
    result.set(champ, {
      champion: champ, scalingScore: Math.round(scalingScore * 1000) / 1000,
      wrEarly: Math.round(wrEarly * 10000) / 10000,
      wrLate: Math.round(wrLate * 10000) / 10000,
      gamesEarly: s.earlyN, gamesLate: s.lateN, tag,
    });
  }

  scalingCache = result;
  scalingCacheTs = now;
  return result;
}

// ─── Patch filter helpers ────────────────────────────────────────────────────

function recentPatches(count: number = 5): Promise<string[]> {
  return prisma.oEGame
    .groupBy({ by: ['patch'], _count: true, orderBy: { patch: 'desc' }, take: count })
    .then((rows) => rows.map((r) => r.patch));
}

// ─── 1. Champion win rates (weighted) ────────────────────────────────────────

export async function getChampionWinRates(
  patches?: string[],
  minGames: number = 10,
  weights?: Partial<DraftWeightsConfig>,
): Promise<Map<string, ChampionWR>> {
  const cfg = resolveDraftWeights(weights);
  const patchFilter = patches ?? (await recentPatches(5));

  const rows = await prisma.oEPlayerGame.findMany({
    where: {
      game: { patch: { in: patchFilter } },
      position: { not: 'team' },
    },
    select: {
      champion: true, result: true,
      kills: true, deaths: true, assists: true,
      golddiffat15: true, dpm: true,
      game: { select: { league: true, year: true } },
    },
  });

  const stats = new Map<string, {
    wWins: number; wGames: number; rawGames: number; rawWins: number;
    kills: number; deaths: number; assists: number;
    gd15: number; gd15Count: number; dpm: number; dpmCount: number;
  }>();

  for (const r of rows) {
    const key = r.champion.toLowerCase();
    const w = gameWeight(r.game.league, r.game.year, cfg);
    const s = stats.get(key) ?? { wWins: 0, wGames: 0, rawGames: 0, rawWins: 0, kills: 0, deaths: 0, assists: 0, gd15: 0, gd15Count: 0, dpm: 0, dpmCount: 0 };
    s.wGames += w;
    s.wWins += r.result * w;
    s.rawGames++;
    s.rawWins += r.result;
    s.kills += r.kills;
    s.deaths += r.deaths;
    s.assists += r.assists;
    if (r.golddiffat15 != null) { s.gd15 += r.golddiffat15 * w; s.gd15Count += w; }
    if (r.dpm != null) { s.dpm += r.dpm * w; s.dpmCount += w; }
    stats.set(key, s);
  }

  const result = new Map<string, ChampionWR>();
  for (const [key, s] of stats) {
    if (s.rawGames < minGames) continue;
    result.set(key, {
      champion: key,
      games: s.rawGames,
      wGames: Math.round(s.wGames),
      wins: s.rawWins,
      winRate: s.wGames > 0 ? s.wWins / s.wGames : 0.5,
      avgKills: s.kills / s.rawGames,
      avgDeaths: s.deaths / s.rawGames,
      avgAssists: s.assists / s.rawGames,
      avgGD15: s.gd15Count > 0 ? s.gd15 / s.gd15Count : 0,
      avgDPM: s.dpmCount > 0 ? s.dpm / s.dpmCount : 0,
    });
  }

  return result;
}

// ─── 2. Champion synergy (weighted) ──────────────────────────────────────────

export async function getChampionSynergies(minGames: number = 2, weights?: Partial<DraftWeightsConfig>): Promise<Map<string, SynergyPair>> {
  const cfg = resolveDraftWeights(weights);
  const games = await prisma.oEGame.findMany({
    select: {
      league: true, year: true, blueResult: true,
      bluePick1: true, bluePick2: true, bluePick3: true, bluePick4: true, bluePick5: true,
      redPick1: true, redPick2: true, redPick3: true, redPick4: true, redPick5: true,
    },
  });

  const pairStats = new Map<string, { wGames: number; wWins: number; rawGames: number; rawWins: number }>();

  for (const g of games) {
    const w = gameWeight(g.league, g.year, cfg);
    const bluePicks = [g.bluePick1, g.bluePick2, g.bluePick3, g.bluePick4, g.bluePick5].filter(Boolean).map((c) => c!.toLowerCase());
    const redPicks = [g.redPick1, g.redPick2, g.redPick3, g.redPick4, g.redPick5].filter(Boolean).map((c) => c!.toLowerCase());

    const addPairs = (picks: string[], won: boolean) => {
      for (let i = 0; i < picks.length; i++) {
        for (let j = i + 1; j < picks.length; j++) {
          const key = [picks[i], picks[j]].sort().join('|');
          const s = pairStats.get(key) ?? { wGames: 0, wWins: 0, rawGames: 0, rawWins: 0 };
          s.wGames += w;
          s.rawGames++;
          if (won) { s.wWins += w; s.rawWins++; }
          pairStats.set(key, s);
        }
      }
    };

    if (bluePicks.length === 5) addPairs(bluePicks, g.blueResult === 1);
    if (redPicks.length === 5) addPairs(redPicks, g.blueResult === 0);
  }

  const result = new Map<string, SynergyPair>();
  for (const [key, s] of pairStats) {
    if (s.rawGames < minGames) continue;
    const [a, b] = key.split('|');
    result.set(key, {
      champA: a, champB: b,
      games: s.rawGames, wins: s.rawWins,
      winRate: s.wGames > 0 ? s.wWins / s.wGames : 0.5,
      lift: 0,
    });
  }

  return result;
}

// ─── 3. Matchups — all 5v5 cross-team pairs (weighted) ───────────────────────
// Key: myChamp|oppChamp|myPosition — includes both same-position (lane) and
// cross-position matchups so scoreSide can weigh them differently.

export async function getLaneMatchups(minGames: number = 1, weights?: Partial<DraftWeightsConfig>): Promise<Map<string, MatchupStat>> {
  const cfg = resolveDraftWeights(weights);
  const LANE_POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup'];

  const playerGames = await prisma.oEPlayerGame.findMany({
    where: { position: { in: LANE_POSITIONS } },
    select: {
      gameId: true, champion: true, position: true, side: true, result: true,
      golddiffat15: true, csdiffat15: true, xpdiffat15: true,
      game: { select: { league: true, year: true } },
    },
  });

  // Group rows by gameId → side so we can pair every player against every opponent.
  type PG = (typeof playerGames)[number];
  const byGame = new Map<string, { blue: PG[]; red: PG[] }>();
  for (const pg of playerGames) {
    const entry = byGame.get(pg.gameId) ?? { blue: [], red: [] };
    if (pg.side === 'Blue') entry.blue.push(pg);
    else entry.red.push(pg);
    byGame.set(pg.gameId, entry);
  }

  const matchupStats = new Map<string, {
    wGames: number; wWins: number; rawGames: number; rawWins: number;
    wGd15: number; wCsd15: number; wXpd15: number; wStatCount: number;
    oppPos: string;
  }>();

  for (const [, sides] of byGame) {
    if (sides.blue.length !== 5 || sides.red.length !== 5) continue;

    const addPairs = (myTeam: PG[], oppTeam: PG[]) => {
      for (const me of myTeam) {
        const w = gameWeight(me.game.league, me.game.year, cfg);
        for (const opp of oppTeam) {
          const key = `${me.champion.toLowerCase()}|${opp.champion.toLowerCase()}|${me.position}|${opp.position}`;
          const s = matchupStats.get(key) ?? { wGames: 0, wWins: 0, rawGames: 0, rawWins: 0, wGd15: 0, wCsd15: 0, wXpd15: 0, wStatCount: 0, oppPos: opp.position };
          s.wGames += w;
          s.rawGames++;
          if (me.result === 1) { s.wWins += w; s.rawWins++; }
          if (me.golddiffat15 != null && me.position === opp.position) {
            s.wGd15 += me.golddiffat15 * w;
            s.wCsd15 += (me.csdiffat15 ?? 0) * w;
            s.wXpd15 += (me.xpdiffat15 ?? 0) * w;
            s.wStatCount += w;
          }
          matchupStats.set(key, s);
        }
      }
    };

    addPairs(sides.blue, sides.red);
    addPairs(sides.red, sides.blue);
  }

  const result = new Map<string, MatchupStat>();
  for (const [key, s] of matchupStats) {
    if (s.rawGames < minGames) continue;
    const [champ, opp, pos, oppPos] = key.split('|');
    const wr = s.wGames > 0 ? s.wWins / s.wGames : 0.5;
    const avgGD15 = s.wStatCount > 0 ? s.wGd15 / s.wStatCount : 0;
    const avgCSD15 = s.wStatCount > 0 ? s.wCsd15 / s.wStatCount : 0;
    const avgXPD15 = s.wStatCount > 0 ? s.wXpd15 / s.wStatCount : 0;
    const isLane = pos === oppPos;

    let scalingTag: 'early' | 'scaling' | 'neutral' = 'neutral';
    if (isLane) {
      if (avgGD15 < -100 && wr > 0.5) scalingTag = 'scaling';
      else if (avgGD15 > 200 && wr < 0.5) scalingTag = 'early';
    }

    const wrComponent = (wr - 0.5) * 0.7;
    const laneComponent = isLane ? (avgGD15 / 500) * 0.05 * 0.3 : 0;
    const adjustedAdvantage = wrComponent + laneComponent;

    result.set(key, {
      champion: champ, opponent: opp, position: pos,
      opponentPosition: oppPos,
      kind: isLane ? 'lane' : 'cross',
      games: s.rawGames, wins: s.rawWins,
      winRate: wr, avgGD15, avgCSD15, avgXPD15,
      scalingTag, adjustedAdvantage,
    });
  }

  return result;
}

// ─── 4. Player champion mastery (weighted) ───────────────────────────────────

export async function getPlayerMastery(playerNames: string[], weights?: Partial<DraftWeightsConfig>): Promise<Map<string, PlayerChampionMastery[]>> {
  const names = [...new Set(playerNames.map((n) => n.trim()).filter(Boolean))];
  if (names.length === 0) return new Map();

  const cfg = resolveDraftWeights(weights);
  const rows = await prisma.oEPlayerGame.findMany({
    where: { playername: { in: names } },
    select: {
      playername: true, champion: true, result: true,
      kills: true, deaths: true, assists: true,
      golddiffat15: true, dpm: true, cspm: true,
      game: { select: { league: true, year: true } },
    },
  });

  const stats = new Map<string, Map<string, {
    wGames: number; wWins: number; rawGames: number; rawWins: number;
    kills: number; deaths: number; assists: number;
    gd15: number; gd15Count: number; dpm: number; dpmCount: number; cspm: number; cspmCount: number;
  }>>();

  for (const r of rows) {
    const w = gameWeight(r.game.league, r.game.year, cfg);
    if (!stats.has(r.playername)) stats.set(r.playername, new Map());
    const playerMap = stats.get(r.playername)!;
    const key = r.champion.toLowerCase();
    const s = playerMap.get(key) ?? { wGames: 0, wWins: 0, rawGames: 0, rawWins: 0, kills: 0, deaths: 0, assists: 0, gd15: 0, gd15Count: 0, dpm: 0, dpmCount: 0, cspm: 0, cspmCount: 0 };
    s.wGames += w;
    s.wWins += r.result * w;
    s.rawGames++;
    s.rawWins += r.result;
    s.kills += r.kills;
    s.deaths += r.deaths;
    s.assists += r.assists;
    if (r.golddiffat15 != null) { s.gd15 += r.golddiffat15; s.gd15Count++; }
    if (r.dpm != null) { s.dpm += r.dpm; s.dpmCount++; }
    if (r.cspm != null) { s.cspm += r.cspm; s.cspmCount++; }
    playerMap.set(key, s);
  }

  const result = new Map<string, PlayerChampionMastery[]>();
  for (const [player, champMap] of stats) {
    // Total games across all champions for this player
    let totalPlayerGames = 0;
    for (const [, s] of champMap) totalPlayerGames += s.rawGames;

    // Player's overall weighted WR — used as baseline for wrDelta (compare within player, not global)
    let playerTotalWGames = 0;
    let playerTotalWWins = 0;
    for (const [, s] of champMap) {
      playerTotalWGames += s.wGames;
      playerTotalWWins += s.wWins;
    }
    const playerAvgWR = playerTotalWGames > 0 ? playerTotalWWins / playerTotalWGames : 0.5;

    const masteries: PlayerChampionMastery[] = [];
    for (const [champ, s] of champMap) {
      if (s.rawGames < 1) continue;
      const avgDeaths = s.deaths / s.rawGames;
      const kda = avgDeaths > 0 ? (s.kills / s.rawGames + s.assists / s.rawGames) / avgDeaths : (s.kills + s.assists) / s.rawGames;
      const wr = s.wGames > 0 ? s.wWins / s.wGames : 0.5;
      const rawWr = s.rawGames > 0 ? s.rawWins / s.rawGames : 0.5;

      const rawComfort = computeRawComfort(s.rawGames, rawWr, kda, totalPlayerGames);
      const conf = sampleConfidence(s.rawGames, G_MASTERY_FULL);
      masteries.push({
        player, champion: champ,
        games: s.rawGames, wins: s.rawWins,
        winRate: wr,
        avgKDA: Math.round(kda * 100) / 100,
        avgGD15: s.gd15Count > 0 ? Math.round(s.gd15 / s.gd15Count) : 0,
        avgDPM: s.dpmCount > 0 ? Math.round(s.dpm / s.dpmCount) : 0,
        avgCSPM: s.cspmCount > 0 ? Math.round((s.cspm / s.cspmCount) * 10) / 10 : 0,
        wrDelta: Math.round((wr - playerAvgWR) * 10000) / 10000,
        comfortCoeff: rawComfort * conf,
      });
    }

    // Always normalize within the player: best champion = 1.0.
    // Comfort is relative — 5/10 games on Renekton is the player's main pick.
    const maxComfort = masteries.reduce((mx, m) => Math.max(mx, m.comfortCoeff), 0);
    if (maxComfort > 0) {
      for (const m of masteries) {
        m.comfortCoeff = Math.round((m.comfortCoeff / maxComfort) * 1000) / 1000;
      }
    }

    masteries.sort((a, b) => b.games - a.games);
    result.set(player, masteries);
  }

  return result;
}

// ─── Picker lists + case-insensitive player resolution (SQLite) ─────────────

/** Map typed nickname → canonical `playername` as stored in OE (case-insensitive). */
export async function resolveOePlayerName(raw: string): Promise<string> {
  const t = raw.trim();
  if (!t) return '';
  const rows = await prisma.$queryRaw<{ playername: string }[]>`
    SELECT playername FROM oe_player_games
    WHERE LOWER(TRIM(playername)) = LOWER(${t})
    GROUP BY playername
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `;
  return rows[0]?.playername ?? t;
}

/** All distinct champions in OE (for draft UI combobox). */
export async function getOeChampionsForPicker(): Promise<{ champion: string; games: number }[]> {
  const rows = await prisma.oEPlayerGame.groupBy({
    by: ['champion'],
    _count: { _all: true },
    orderBy: { champion: 'asc' },
  });
  return rows.map((r) => ({ champion: r.champion, games: r._count._all }));
}

/** Search pro players by substring; `LOWER(playername) LIKE %q%` (case-insensitive). */
export async function searchOePlayersForPicker(q: string, limit: number = 25): Promise<{ name: string; games: number }[]> {
  const t = q.trim();
  if (t.length < 1) return [];
  const pattern = `%${t.toLowerCase()}%`;
  const take = Math.min(Math.max(limit, 1), 50);
  const rows = await prisma.$queryRaw<{ playername: string; cnt: bigint }[]>`
    SELECT playername, COUNT(*) AS cnt
    FROM oe_player_games
    WHERE LOWER(playername) LIKE ${pattern}
    GROUP BY playername
    ORDER BY cnt DESC
    LIMIT ${take}
  `;
  return rows.map((r) => ({ name: r.playername, games: Number(r.cnt) }));
}

// ─── Full draft analysis ─────────────────────────────────────────────────────

interface DraftInput {
  blueChamps: string[];
  redChamps: string[];
  bluePlayers?: string[];
  redPlayers?: string[];
  positions?: string[];
  weights?: Partial<DraftWeightsConfig>;
  /** Relative importance of pillars in composite score (normalized server-side). */
  scoreMix?: Partial<DraftScoreMixInput>;
}

export async function analyzeDraft(input: DraftInput): Promise<DraftAnalysisResult> {
  const positions = input.positions ?? ['top', 'jng', 'mid', 'bot', 'sup'];
  const weights = resolveDraftWeights(input.weights);
  const scoreMix = resolveScoreMix(input.scoreMix);

  let bluePlayers = input.bluePlayers;
  let redPlayers = input.redPlayers;
  if (Array.isArray(bluePlayers) && bluePlayers.length === 5) {
    bluePlayers = await Promise.all(bluePlayers.map((n) => resolveOePlayerName(n ?? '')));
  }
  if (Array.isArray(redPlayers) && redPlayers.length === 5) {
    redPlayers = await Promise.all(redPlayers.map((n) => resolveOePlayerName(n ?? '')));
  }

  const metaPatches = await recentPatches(5);
  const wSummary = formatWeightsSummary(weights);

  const [champWRs, synergies, matchups, blueMastery, redMastery, scalingMap] = await Promise.all([
    getChampionWinRates(metaPatches, 5, weights),
    getChampionSynergies(2, weights),
    getLaneMatchups(1, weights),
    bluePlayers ? getPlayerMastery(bluePlayers, weights) : Promise.resolve(new Map()),
    redPlayers ? getPlayerMastery(redPlayers, weights) : Promise.resolve(new Map()),
    getChampionScaling(),
  ]);

  for (const [, syn] of synergies) {
    const wrA = champWRs.get(syn.champA)?.winRate ?? 0.5;
    const wrB = champWRs.get(syn.champB)?.winRate ?? 0.5;
    syn.lift = syn.winRate - (wrA + wrB) / 2;
  }

  const gamesAnalyzed = await prisma.oEGame.count();

  function scoreSide(
    champs: string[], oppChamps: string[],
    players: string[] | undefined,
    masteryMap: Map<string, PlayerChampionMastery[]>,
    mix: DraftScoreMixNormalized,
  ): Omit<DraftScore, 'teamSide'> {
    const champKeys = champs.map((c) => c.toLowerCase());
    const oppKeys = oppChamps.map((c) => c.toLowerCase());

    const champData: ChampionWR[] = champKeys.map((k) => champWRs.get(k) ?? {
      champion: k, games: 0, wGames: 0, wins: 0, winRate: 0.5, avgKills: 0, avgDeaths: 0, avgAssists: 0, avgGD15: 0, avgDPM: 0,
    });
    const championTier = champData.reduce((s, c) => s + c.winRate, 0) / champData.length;

    // Role-pair weighted synergy with sample confidence
    const synergyPairs: SynergyPair[] = [];
    let weightedLiftSum = 0;
    let totalSynWeight = 0;
    for (let i = 0; i < champKeys.length; i++) {
      for (let j = i + 1; j < champKeys.length; j++) {
        const key = [champKeys[i], champKeys[j]].sort().join('|');
        const syn = synergies.get(key);
        if (syn) {
          const rw = rolePairWeight(positions[i], positions[j]);
          const conf = sampleConfidence(syn.games, N_REF_SYNERGY);
          synergyPairs.push({ ...syn, roleWeight: rw });
          weightedLiftSum += syn.lift * rw * conf;
          totalSynWeight += rw * conf;
        }
      }
    }
    const synergyScore = totalSynWeight > 0
      ? weightedLiftSum / totalSynWeight : 0;

    // Matchups: for each of our 5 slots, consider lane (same-position) and cross
    // opponents, weighted by W_LANE / W_CROSS and sample confidence.
    const matchupList: MatchupStat[] = [];
    let muWeightedSum = 0;
    let muWeightTotal = 0;
    for (let i = 0; i < champKeys.length; i++) {
      for (let j = 0; j < oppKeys.length; j++) {
        const key = `${champKeys[i]}|${oppKeys[j]}|${positions[i]}|${positions[j]}`;
        const mu = matchups.get(key);
        if (!mu) continue;
        matchupList.push(mu);
        const posWeight = mu.kind === 'lane' ? W_LANE : W_CROSS;
        const conf = sampleConfidence(mu.games, N_REF_MATCHUP);
        muWeightedSum += mu.adjustedAdvantage * posWeight * conf;
        muWeightTotal += posWeight * conf;
      }
    }
    const matchupScore = muWeightTotal > 0
      ? muWeightedSum / muWeightTotal : 0;

    const masteryList: PlayerChampionMastery[] = [];
    if (players) {
      for (let i = 0; i < champKeys.length; i++) {
        const pName = players[i]?.trim();
        if (!pName) continue;

        const playerMasteries = masteryMap.get(pName);
        const champMastery = playerMasteries?.find((m) => m.champion === champKeys[i]);
        const globalWR = champWRs.get(champKeys[i])?.winRate ?? 0.5;

        if (champMastery) {
          // wrDelta already computed in getPlayerMastery (vs player's own avg WR)
          masteryList.push(champMastery);
        } else {
          masteryList.push({
            player: pName,
            champion: champKeys[i],
            games: 0,
            wins: 0,
            winRate: globalWR,
            avgKDA: 0,
            avgGD15: 0,
            avgDPM: 0,
            avgCSPM: 0,
            wrDelta: 0,
            comfortCoeff: DRAFT_MIN_COMFORT_COEFF,
            noProData: true,
          });
        }
      }
    }
    // Blend wrDelta + comfort, weighted by sample reliability so low-game picks count less.
    let masteryScore = 0;
    if (masteryList.length > 0) {
      let wSum = 0;
      let wTotal = 0;
      for (const m of masteryList) {
        const rel = sampleConfidence(m.games, G_MASTERY_FULL);
        const contrib = m.wrDelta + (m.comfortCoeff - 0.5) * 0.1;
        wSum += contrib * rel;
        wTotal += rel;
      }
      masteryScore = wTotal > 0 ? wSum / wTotal : 0;
    }

    // Scaling: collect ChampionScaling entries for this side.
    const scalingList: ChampionScaling[] = champKeys.map((k) =>
      scalingMap.get(k) ?? {
        champion: k, scalingScore: 0, wrEarly: 0.5, wrLate: 0.5,
        gamesEarly: 0, gamesLate: 0, tag: 'neutral' as const,
      },
    );
    // Average scaling score for this side (confidence-weighted by min(gamesEarly, gamesLate) / 50).
    let scalingSumW = 0;
    let scalingTotalW = 0;
    for (const sc of scalingList) {
      const conf = Math.min(1, Math.min(sc.gamesEarly, sc.gamesLate) / 50);
      scalingSumW += sc.scalingScore * conf;
      scalingTotalW += conf;
    }
    const scalingScore = scalingTotalW > 0 ? Math.round((scalingSumW / scalingTotalW) * 1000) / 1000 : 0;

    const raw = championTier * mix.championTier
      + (0.5 + synergyScore) * mix.synergy
      + (0.5 + matchupScore) * mix.matchup
      + (0.5 + masteryScore) * mix.mastery;
    const totalScore = Math.round(raw * 10000) / 10000;

    return {
      championTier: Math.round(championTier * 10000) / 10000,
      synergyScore: Math.round(synergyScore * 10000) / 10000,
      matchupScore: Math.round(matchupScore * 10000) / 10000,
      masteryScore: Math.round(masteryScore * 10000) / 10000,
      scalingScore,
      totalScore,
      components: { champions: champData, synergies: synergyPairs, matchups: matchupList, mastery: masteryList, scaling: scalingList },
    };
  }

  const blueRaw = scoreSide(input.blueChamps, input.redChamps, bluePlayers, blueMastery, scoreMix);
  const redRaw = scoreSide(input.redChamps, input.blueChamps, redPlayers, redMastery, scoreMix);
  const blue: DraftScore = { teamSide: 'Blue', ...blueRaw };
  const red: DraftScore = { teamSide: 'Red', ...redRaw };

  const scalingBalance = Math.round(
    Math.max(-1, Math.min(1, blue.scalingScore - red.scalingScore)) * 1000,
  ) / 1000;

  const scoreDiff = blue.totalScore - red.totalScore;
  const blueWinP = 1 / (1 + Math.exp(-scoreDiff * 15));
  const margin = Math.abs(blueWinP - 0.5);
  const advantage = margin < 0.02 ? 'EVEN' : blueWinP > 0.5 ? 'BLUE' : 'RED';

  return {
    blue, red,
    blueWinProbability: Math.round(blueWinP * 10000) / 10000,
    advantage, advantageMargin: Math.round(margin * 10000) / 10000,
    scalingBalance,
    patchesUsed: metaPatches, gamesAnalyzed,
    weightsApplied: weights,
    scoreMixApplied: scoreMix,
    dataWindows: {
      championWR: `${metaPatches.length} patches (${metaPatches[metaPatches.length - 1]}–${metaPatches[0]}) · ${wSummary}`,
      synergiesMatchups: `All ${gamesAnalyzed} games · ${wSummary}`,
      playerMastery: `All games · ${wSummary}`,
    },
  };
}

// ─── Quick lookup endpoints ──────────────────────────────────────────────────

export async function getTopChampions(limit: number = 50): Promise<ChampionWR[]> {
  const wrs = await getChampionWinRates(undefined, 20);
  return [...wrs.values()].sort((a, b) => b.winRate - a.winRate).slice(0, limit);
}

export async function getChampionSynergyList(champion: string, limit: number = 20): Promise<SynergyPair[]> {
  const [synergies, champWRs] = await Promise.all([
    getChampionSynergies(5),
    getChampionWinRates(undefined, 10),
  ]);

  for (const [, syn] of synergies) {
    const wrA = champWRs.get(syn.champA)?.winRate ?? 0.5;
    const wrB = champWRs.get(syn.champB)?.winRate ?? 0.5;
    syn.lift = syn.winRate - (wrA + wrB) / 2;
  }

  const key = champion.toLowerCase();
  return [...synergies.values()]
    .filter((s) => s.champA === key || s.champB === key)
    .sort((a, b) => b.lift - a.lift)
    .slice(0, limit);
}

export async function getChampionMatchupList(champion: string, position: string, limit: number = 20): Promise<MatchupStat[]> {
  const matchups = await getLaneMatchups(1);
  const key = champion.toLowerCase();
  return [...matchups.values()]
    .filter((m) => m.champion === key && m.position === position && m.kind === 'lane')
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, limit);
}

export async function getDataSummary() {
  const [gameCount, playerGameCount, patchGroups, leagueGroups] = await Promise.all([
    prisma.oEGame.count(),
    prisma.oEPlayerGame.count(),
    prisma.oEGame.groupBy({ by: ['patch'], _count: true, orderBy: { patch: 'desc' }, take: 10 }),
    prisma.oEGame.groupBy({ by: ['league'], _count: true, orderBy: { _count: { league: 'desc' } }, take: 15 }),
  ]);

  const recentPatchList = await recentPatches(5);
  const uniqueChamps = await prisma.oEPlayerGame.groupBy({ by: ['champion'], _count: true });
  const uniquePlayers = await prisma.oEPlayerGame.groupBy({ by: ['playername'], _count: true });

  return {
    games: gameCount, playerGameRows: playerGameCount,
    uniqueChampions: uniqueChamps.length, uniquePlayers: uniquePlayers.length,
    topPatches: patchGroups.map((p) => ({ patch: p.patch, games: p._count })),
    topLeagues: leagueGroups.map((l) => ({ league: l.league, games: l._count })),
    recentPatches: recentPatchList,
    weighting: formatWeightsSummary(DEFAULT_DRAFT_WEIGHTS),
    defaultWeights: DEFAULT_DRAFT_WEIGHTS,
    defaultScoreMix: DEFAULT_SCORE_MIX,
  };
}

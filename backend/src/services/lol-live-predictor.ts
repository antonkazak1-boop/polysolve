import prisma from '../config/database';
import { getChampionScaling } from './draft-analysis';

// ─── Types ───────────────────────────────────────────────────────────────────

export type DragonType = 'infernal' | 'mountain' | 'ocean' | 'hextech' | 'chemtech' | 'cloud';

export interface LiveGameState {
  blueChamps: string[];
  redChamps: string[];
  bluePlayers?: string[];
  redPlayers?: string[];

  minute: number;
  goldDiffTotal: number;
  goldDiffByLane?: {
    top?: number;
    jng?: number;
    mid?: number;
    bot?: number;
    sup?: number;
  };

  blueDragons: DragonType[];
  redDragons: DragonType[];
  blueDragonSoul: boolean;
  redDragonSoul: boolean;
  blueElderDragon: number;
  redElderDragon: number;
  blueVoidgrubs: number;
  redVoidgrubs: number;
  blueHerald: number;
  redHerald: number;
  blueBaron: number;
  redBaron: number;
  blueTowersDestroyed: number;
  redTowersDestroyed: number;

  draftPMap?: number;
}

/** How historical gold→win curves were built for this prediction. */
export interface LiveGoldModelMeta {
  source: 'gol.gg' | 'oracle_elixir';
  /** Games used to build the gold model (gol.gg: snapshots with gold+winner; OE: season games). */
  sampleGames: number;
  /** Distinct game minutes with at least one curve point (gol.gg: 0..N; OE: 4 fixed). */
  minutesCovered: number;
}

export interface LivePrediction {
  pBlue: number;
  breakdown: {
    draftBaseline: number;
    goldWR: number;
    goldShift: number;
    /** Share of draft in the gold step blend: pAfterGold = draft*this + goldWR*(1-this). */
    draftAnchorWeight: number;
    /** Minute index used for gold→WR lookup (capped; late game relies on draft not sparse gold curves). */
    goldLookupMinute: number;
    /** 0–1: historical gold→WR muted toward draft (linear 30→40m; 40m+ = 1). */
    goldHistoricalMute: number;
    objectiveShift: number;
    scalingShift: number;
    objectives: ObjectiveBreakdown;
    goldModel: LiveGoldModelMeta;
  };
  minute: number;
}

export interface ObjectiveBreakdown {
  firstDragon: number;
  dragonCount: number;
  dragonSoul: number;
  elder: number;
  firstBaron: number;
  baronCount: number;
  firstHerald: number;
  heraldCount: number;
  grubAdvantage: number;
  towerDiff: number;
}

export interface GoldCurvePoint {
  goldDiffBucket: number;
  blueWinRate: number;
  games: number;
}

export interface GoldCurveData {
  minute: number;
  points: GoldCurvePoint[];
}

export interface ObjectiveStats {
  firstDragon: { games: number; winRate: number; delta: number };
  dragonsByCount: Array<{ count: number; games: number; winRate: number; delta: number }>;
  dragonSoul: { games: number; winRate: number; delta: number };
  soulByType: Record<string, { games: number; winRate: number; delta: number }>;
  elder: { games: number; winRate: number; delta: number };
  firstBaron: { games: number; winRate: number; delta: number };
  baron: { games: number; winRate: number; delta: number };
  firstHerald: { games: number; winRate: number; delta: number };
  heraldsByCount: Array<{ count: number; games: number; winRate: number; delta: number }>;
  grubsByCount: Array<{ count: number; games: number; winRate: number; delta: number }>;
  towerDiffPerTower: { delta: number; games: number };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CURRENT_YEAR = 2026;
const CACHE_TTL = 10 * 60 * 1000;
const OE_GOLD_BUCKETS = [-8000, -5000, -3000, -1500, -500, 500, 1500, 3000, 5000, 8000];
const SCALE_PER_MINUTE = 0.0015;

// ─── Cache ───────────────────────────────────────────────────────────────────

let oeGoldCache: { curves: GoldCurveData[]; sampleGames: number } | null = null;
let oeGoldCacheTs = 0;
let golGgGoldCurvesCache: { curves: GoldCurveData[]; usableGames: number } | null = null;
let golGgGoldCurvesTs = 0;
let objectiveStatsCache: ObjectiveStats | null = null;
let objectiveStatsTs = 0;

// ─── Gold-to-WR Curves ──────────────────────────────────────────────────────

/**
 * Snap goldDiff to the nearest bucket midpoint.
 * E.g. with midpoints [..., -1000, 0, 1000, ...], goldDiff=400 → bucket 0, goldDiff=600 → bucket 1000.
 */
function bucketize(goldDiff: number, midpoints: number[]): number {
  let best = midpoints[0];
  let bestDist = Math.abs(goldDiff - midpoints[0]);
  for (let i = 1; i < midpoints.length; i++) {
    const d = Math.abs(goldDiff - midpoints[i]);
    if (d < bestDist) { best = midpoints[i]; bestDist = d; }
  }
  return best;
}

/** OE-based gold curves (fallback: only 10/15/20/25 min) */
async function buildOEGoldCurves(): Promise<{ curves: GoldCurveData[]; sampleGames: number }> {
  const now = Date.now();
  if (oeGoldCache && now - oeGoldCacheTs < CACHE_TTL) {
    return oeGoldCache;
  }

  const games = await prisma.oEGame.findMany({
    where: { year: CURRENT_YEAR },
    select: {
      blueResult: true,
      blueGoldDiffAt10: true,
      blueGoldDiffAt15: true,
      blueGoldDiffAt20: true,
      blueGoldDiffAt25: true,
    },
  });

  const minuteFields: Array<{ minute: number; field: keyof typeof games[0] }> = [
    { minute: 10, field: 'blueGoldDiffAt10' },
    { minute: 15, field: 'blueGoldDiffAt15' },
    { minute: 20, field: 'blueGoldDiffAt20' },
    { minute: 25, field: 'blueGoldDiffAt25' },
  ];

  const curves: GoldCurveData[] = [];

  for (const { minute, field } of minuteFields) {
    const bMap = new Map<number, { wins: number; total: number }>();

    for (const g of games) {
      const gd = g[field] as number | null;
      if (gd == null) continue;
      const b = bucketize(gd, OE_GOLD_BUCKETS);
      const entry = bMap.get(b) ?? { wins: 0, total: 0 };
      entry.total++;
      if (g.blueResult === 1) entry.wins++;
      bMap.set(b, entry);
    }

    const points: GoldCurvePoint[] = [];
    for (const b of OE_GOLD_BUCKETS) {
      const entry = bMap.get(b);
      if (!entry || entry.total < 3) continue;
      points.push({
        goldDiffBucket: b,
        blueWinRate: entry.wins / entry.total,
        games: entry.total,
      });
    }
    points.sort((a, b) => a.goldDiffBucket - b.goldDiffBucket);
    curves.push({ minute, points });
  }

  oeGoldCache = { curves, sampleGames: games.length };
  oeGoldCacheTs = now;
  return oeGoldCache;
}

/**
 * Build gold-to-WR curves from gol.gg per-minute gold data.
 * Each GolGgGameSnapshot has goldOverTime with per-minute gold lead (blue-red)
 * and winnerSide (blue/red). This gives us real data for EVERY minute.
 */
export async function buildGolGgGoldCurves(): Promise<{ curves: GoldCurveData[]; usableGames: number }> {
  const now = Date.now();
  if (golGgGoldCurvesCache && now - golGgGoldCurvesTs < CACHE_TTL) return golGgGoldCurvesCache;

  const snapshots = await prisma.golGgGameSnapshot.findMany({
    where: { pageSlug: 'page-game' },
    select: { meta: true, charts: true },
  });

  // Midpoint-centered buckets: 0 = goldDiff ≈ 0, 1000 = goldDiff ≈ 500..1500, etc.
  const GOLGG_BUCKETS = [-10000, -6000, -4000, -2500, -1500, -1000, -500, 0, 500, 1000, 1500, 2500, 4000, 6000, 10000];

  // Collect per-minute stats: minute -> bucket -> {wins, total}
  const minuteData = new Map<number, Map<number, { wins: number; total: number }>>();

  let usableGames = 0;

  for (const snap of snapshots) {
    let meta: any, charts: any;
    try {
      meta = JSON.parse(snap.meta as string);
      charts = JSON.parse(snap.charts as string);
    } catch { continue; }

    const winnerSide = meta.winnerSide as string | null;
    if (!winnerSide || (winnerSide !== 'blue' && winnerSide !== 'red')) continue;

    const goldData = charts.goldOverTime?.datasets?.[1]?.data as number[] | undefined;
    if (!goldData || goldData.length < 5) continue;

    const blueWin = winnerSide === 'blue' ? 1 : 0;
    usableGames++;

    for (let minute = 0; minute < goldData.length; minute++) {
      const goldDiff = goldData[minute]; // positive = blue leads
      if (typeof goldDiff !== 'number') continue;

      const b = bucketize(goldDiff, GOLGG_BUCKETS);

      if (!minuteData.has(minute)) minuteData.set(minute, new Map());
      const bMap = minuteData.get(minute)!;
      const entry = bMap.get(b) ?? { wins: 0, total: 0 };
      entry.total++;
      entry.wins += blueWin;
      bMap.set(b, entry);
    }
  }

  const MIN_GAMES = 8;
  // Bayesian smoothing: blend toward 50% for small samples.
  // With PRIOR_WEIGHT=5, a bucket with 5 games at 100% WR → smoothed to ~72%.
  const PRIOR_WEIGHT = 5;

  const curves: GoldCurveData[] = [];

  for (const [minute, bMap] of minuteData) {
    const points: GoldCurvePoint[] = [];
    for (const b of GOLGG_BUCKETS) {
      const entry = bMap.get(b);
      if (!entry || entry.total < MIN_GAMES) continue;
      const smoothedWR = (entry.wins + PRIOR_WEIGHT * 0.5) / (entry.total + PRIOR_WEIGHT);
      points.push({
        goldDiffBucket: b,
        blueWinRate: smoothedWR,
        games: entry.total,
      });
    }
    if (points.length < 2) continue;
    points.sort((a, b) => a.goldDiffBucket - b.goldDiffBucket);
    curves.push({ minute, points });
  }

  curves.sort((a, b) => a.minute - b.minute);
  const payload = { curves, usableGames };
  golGgGoldCurvesCache = payload;
  golGgGoldCurvesTs = now;
  return payload;
}

/** Prefer gol.gg per-minute gold+winner data; fall back to Oracle's Elixir if sample is too thin. */
const GOLGG_MIN_USABLE_GAMES = 200;
const GOLGG_MIN_MINUTE_CURVES = 15;

/**
 * Gold curves + metadata for live predictor and API.
 */
export async function buildGoldCurves(): Promise<{
  curves: GoldCurveData[];
  goldModel: LiveGoldModelMeta;
}> {
  const gol = await buildGolGgGoldCurves();
  const useGolGg =
    gol.usableGames >= GOLGG_MIN_USABLE_GAMES &&
    gol.curves.length >= GOLGG_MIN_MINUTE_CURVES;

  if (useGolGg) {
    return {
      curves: gol.curves,
      goldModel: {
        source: 'gol.gg',
        sampleGames: gol.usableGames,
        minutesCovered: gol.curves.length,
      },
    };
  }

  const oe = await buildOEGoldCurves();
  return {
    curves: oe.curves,
    goldModel: {
      source: 'oracle_elixir',
      sampleGames: oe.sampleGames,
      minutesCovered: oe.curves.length,
    },
  };
}

function interpolateGoldWR(curves: GoldCurveData[], minute: number, goldDiff: number): number {
  if (curves.length === 0) return 0.5;

  const findWR = (curve: GoldCurveData, gd: number): number => {
    const pts = curve.points;
    if (pts.length === 0) return 0.5;
    if (gd <= pts[0].goldDiffBucket) return pts[0].blueWinRate;
    if (gd >= pts[pts.length - 1].goldDiffBucket) return pts[pts.length - 1].blueWinRate;
    for (let i = 0; i < pts.length - 1; i++) {
      if (gd >= pts[i].goldDiffBucket && gd < pts[i + 1].goldDiffBucket) {
        const t = (gd - pts[i].goldDiffBucket) / (pts[i + 1].goldDiffBucket - pts[i].goldDiffBucket);
        return pts[i].blueWinRate + t * (pts[i + 1].blueWinRate - pts[i].blueWinRate);
      }
    }
    return 0.5;
  };

  // gol.gg: one curve per minute; single-minute WR is noisy. Nearest-only still zig-zags (24→25→26).
  // 5-minute centered average of WR at same gold diff smooths per-minute noise without state.
  const densePerMinute = curves.length >= 12;
  if (densePerMinute) {
    const nearestTo = (target: number): GoldCurveData => {
      let best = curves[0];
      let bestDist = Math.abs(curves[0].minute - target);
      for (let i = 1; i < curves.length; i++) {
        const c = curves[i];
        const d = Math.abs(c.minute - target);
        if (d < bestDist || (d === bestDist && c.minute < best.minute)) {
          best = c;
          bestDist = d;
        }
      }
      return best;
    };
    const seen = new Set<number>();
    let sum = 0;
    let n = 0;
    for (const tm of [minute - 2, minute - 1, minute, minute + 1, minute + 2]) {
      if (tm < 0) continue;
      const c = nearestTo(tm);
      if (seen.has(c.minute)) continue;
      seen.add(c.minute);
      sum += findWR(c, goldDiff);
      n++;
    }
    return n > 0 ? sum / n : 0.5;
  }

  // Oracle's Elixir: only 10/15/20/25 — keep linear blend between bracketing minutes.
  let lower: GoldCurveData | null = null;
  let upper: GoldCurveData | null = null;
  for (const c of curves) {
    if (c.minute <= minute && (!lower || c.minute > lower.minute)) lower = c;
    if (c.minute >= minute && (!upper || c.minute < upper.minute)) upper = c;
  }

  if (!lower && !upper) return 0.5;
  if (!lower) return findWR(upper!, goldDiff);
  if (!upper) return findWR(lower!, goldDiff);
  if (lower.minute === upper.minute) return findWR(lower, goldDiff);

  const wrLower = findWR(lower, goldDiff);
  const wrUpper = findWR(upper, goldDiff);
  const t = (minute - lower.minute) / (upper.minute - lower.minute);
  return wrLower + t * (wrUpper - wrLower);
}

// ─── Additive model helpers ──────────────────────────────────────────────────
//
// Architecture: pBlue = base + goldDelta + objectiveDelta + scalingDelta
//   base          = draftPMap, slowly fading toward 50% over the game (but never reaching 50/50)
//   goldDelta     = shift from historical gold curves, fading toward 0 as game goes on
//   objectiveDelta= shift from objectives (dragons, baron, grubs, herald, towers)
//   scalingDelta  = grows with time based on champion scaling profiles

/** Cap gold curve lookup at 35m — per-minute buckets thin out beyond that. */
const GOLD_LOOKUP_MINUTE_CAP = 35;

/**
 * Team strength fade: draft/team baseline slowly fades toward 50% over the game.
 * Even at 60min a 60% favorite is still ~56%, never truly 50/50.
 * Returns a factor 0..1 where 0 = full baseline, 1 = fully at 50%.
 */
function baselineFade(minute: number): number {
  // 0m→0%, 20m→10%, 40m→25%, 60m→35%  (never exceeds ~40%)
  const m = Math.max(0, minute);
  return Math.min(0.40, m * 0.006);
}

/**
 * Gold impact multiplier: how much of the raw gold delta to apply.
 * Full early, fading toward 0 in late game.
 * 0–10m: 100%, 15m: 90%, 25m: 70%, 35m: 45%, 45m: 15%, 55m+: 0%
 */
function goldImpact(minute: number): number {
  const m = Math.max(0, minute);
  if (m <= 10) return 1.0;
  if (m >= 55) return 0.0;
  return 1.0 - (m - 10) / 45;  // linear fade 10→55m
}

// ─── Objective WR Stats ──────────────────────────────────────────────────────

export async function buildObjectiveStats(): Promise<ObjectiveStats> {
  const now = Date.now();
  if (objectiveStatsCache && now - objectiveStatsTs < CACHE_TTL) return objectiveStatsCache;

  const games = await prisma.oEGame.findMany({
    where: { year: CURRENT_YEAR, blueDragons: { not: null } },
    select: {
      blueResult: true,
      blueFirstDragon: true,
      blueDragons: true, redDragons: true,
      blueInfernals: true, blueMountains: true, blueClouds: true, blueOceans: true,
      blueChemtechs: true, blueHextechs: true,
      redInfernals: true, redMountains: true, redClouds: true, redOceans: true,
      redChemtechs: true, redHextechs: true,
      blueElders: true, redElders: true,
      blueFirstHerald: true, blueHeralds: true, redHeralds: true,
      blueVoidGrubs: true, redVoidGrubs: true,
      blueFirstBaron: true, blueBarons: true, redBarons: true,
      blueFirstTower: true, blueTowers: true, redTowers: true,
    },
  });

  const totalGames = games.length;
  const baseWR = totalGames > 0 ? games.filter(g => g.blueResult === 1).length / totalGames : 0.5;

  // First dragon
  const fdGames = games.filter(g => g.blueFirstDragon != null);
  const fdWins = fdGames.filter(g => g.blueFirstDragon === 1 && g.blueResult === 1).length;
  const fdTotal = fdGames.filter(g => g.blueFirstDragon === 1).length;
  const firstDragonWR = fdTotal > 0 ? fdWins / fdTotal : 0.5;

  // Dragons by count differential
  const dragonsByCount: ObjectiveStats['dragonsByCount'] = [];
  for (let diff = -4; diff <= 4; diff++) {
    const matching = games.filter(g =>
      (g.blueDragons ?? 0) - (g.redDragons ?? 0) === diff,
    );
    if (matching.length < 5) continue;
    const wr = matching.filter(g => g.blueResult === 1).length / matching.length;
    dragonsByCount.push({ count: diff, games: matching.length, winRate: wr, delta: wr - baseWR });
  }

  // Dragon soul (>= 4 elemental drakes)
  const soulBlue = games.filter(g => (g.blueDragons ?? 0) >= 4);
  const soulBlueWR = soulBlue.length > 0 ? soulBlue.filter(g => g.blueResult === 1).length / soulBlue.length : 0.5;

  // Soul by type -- which element is dominant
  const soulByType: Record<string, { games: number; winRate: number; delta: number }> = {};
  const soulTypes: Array<{ name: string; blueField: keyof typeof games[0]; redField: keyof typeof games[0] }> = [
    { name: 'infernal', blueField: 'blueInfernals', redField: 'redInfernals' },
    { name: 'mountain', blueField: 'blueMountains', redField: 'redMountains' },
    { name: 'cloud', blueField: 'blueClouds', redField: 'redClouds' },
    { name: 'ocean', blueField: 'blueOceans', redField: 'redOceans' },
    { name: 'chemtech', blueField: 'blueChemtechs', redField: 'redChemtechs' },
    { name: 'hextech', blueField: 'blueHextechs', redField: 'redHextechs' },
  ];
  for (const st of soulTypes) {
    // Blue side soul of this type (has >= 2 of this element and >= 4 total)
    const matching = games.filter(g => {
      const blueTotal = g.blueDragons ?? 0;
      const val = g[st.blueField] as number | null;
      return blueTotal >= 4 && (val ?? 0) >= 2;
    });
    if (matching.length < 3) continue;
    const wr = matching.filter(g => g.blueResult === 1).length / matching.length;
    soulByType[st.name] = { games: matching.length, winRate: wr, delta: wr - baseWR };
  }

  // Elder
  const elderBlue = games.filter(g => (g.blueElders ?? 0) > 0);
  const elderBlueWR = elderBlue.length > 0 ? elderBlue.filter(g => g.blueResult === 1).length / elderBlue.length : 0.5;

  // First baron
  const fbGames = games.filter(g => g.blueFirstBaron != null);
  const fbWins = fbGames.filter(g => g.blueFirstBaron === 1 && g.blueResult === 1).length;
  const fbTotal = fbGames.filter(g => g.blueFirstBaron === 1).length;
  const firstBaronWR = fbTotal > 0 ? fbWins / fbTotal : 0.5;

  // Baron (any)
  const baronBlue = games.filter(g => (g.blueBarons ?? 0) > 0);
  const baronBlueWR = baronBlue.length > 0 ? baronBlue.filter(g => g.blueResult === 1).length / baronBlue.length : 0.5;

  // First herald
  const fhGames = games.filter(g => g.blueFirstHerald != null);
  const fhWins = fhGames.filter(g => g.blueFirstHerald === 1 && g.blueResult === 1).length;
  const fhTotal = fhGames.filter(g => g.blueFirstHerald === 1).length;
  const firstHeraldWR = fhTotal > 0 ? fhWins / fhTotal : 0.5;

  // Heralds by count
  const heraldsByCount: ObjectiveStats['heraldsByCount'] = [];
  for (let diff = -2; diff <= 2; diff++) {
    const matching = games.filter(g =>
      (g.blueHeralds ?? 0) - (g.redHeralds ?? 0) === diff,
    );
    if (matching.length < 5) continue;
    const wr = matching.filter(g => g.blueResult === 1).length / matching.length;
    heraldsByCount.push({ count: diff, games: matching.length, winRate: wr, delta: wr - baseWR });
  }

  // Grubs by count diff
  const grubsByCount: ObjectiveStats['grubsByCount'] = [];
  for (let diff = -6; diff <= 6; diff++) {
    const matching = games.filter(g =>
      (g.blueVoidGrubs ?? 0) - (g.redVoidGrubs ?? 0) === diff,
    );
    if (matching.length < 5) continue;
    const wr = matching.filter(g => g.blueResult === 1).length / matching.length;
    grubsByCount.push({ count: diff, games: matching.length, winRate: wr, delta: wr - baseWR });
  }

  // Tower diff per tower
  const towerDiffs: { diff: number; win: number }[] = [];
  for (const g of games) {
    const diff = (g.blueTowers ?? 0) - (g.redTowers ?? 0);
    towerDiffs.push({ diff, win: g.blueResult });
  }
  let towerSlope = 0;
  if (towerDiffs.length > 10) {
    const meanDiff = towerDiffs.reduce((s, t) => s + t.diff, 0) / towerDiffs.length;
    const meanWin = towerDiffs.reduce((s, t) => s + t.win, 0) / towerDiffs.length;
    let num = 0, den = 0;
    for (const t of towerDiffs) {
      num += (t.diff - meanDiff) * (t.win - meanWin);
      den += (t.diff - meanDiff) ** 2;
    }
    towerSlope = den > 0 ? num / den : 0;
  }

  const stats: ObjectiveStats = {
    firstDragon: { games: fdTotal, winRate: firstDragonWR, delta: firstDragonWR - baseWR },
    dragonsByCount,
    dragonSoul: { games: soulBlue.length, winRate: soulBlueWR, delta: soulBlueWR - baseWR },
    soulByType,
    elder: { games: elderBlue.length, winRate: elderBlueWR, delta: elderBlueWR - baseWR },
    firstBaron: { games: fbTotal, winRate: firstBaronWR, delta: firstBaronWR - baseWR },
    baron: { games: baronBlue.length, winRate: baronBlueWR, delta: baronBlueWR - baseWR },
    firstHerald: { games: fhTotal, winRate: firstHeraldWR, delta: firstHeraldWR - baseWR },
    heraldsByCount,
    grubsByCount,
    towerDiffPerTower: { delta: towerSlope, games: towerDiffs.length },
  };

  objectiveStatsCache = stats;
  objectiveStatsTs = now;
  return stats;
}

// ─── Scaling ─────────────────────────────────────────────────────────────────
// Uses empirical WR-by-game-length from draft-analysis (continuous tanh score).
// scalingScore ∈ [-1, +1]: +1 = strong scaler, -1 = early-game dominant.

async function computeScalingScore(champs: string[]): Promise<number> {
  if (champs.length === 0) return 0;
  const scalingMap = await getChampionScaling();
  let sumW = 0;
  let totalW = 0;
  for (const champ of champs) {
    const sc = scalingMap.get(champ.toLowerCase());
    if (!sc) continue;
    const conf = Math.min(1, Math.min(sc.gamesEarly, sc.gamesLate) / 50);
    sumW += sc.scalingScore * conf;
    totalW += conf;
  }
  return totalW > 0 ? sumW / totalW : 0;
}

// ─── Main Predict ────────────────────────────────────────────────────────────

function lookupObjectiveDelta(
  arr: Array<{ count: number; delta: number }>,
  diff: number,
): number {
  const exact = arr.find(x => x.count === diff);
  if (exact) return exact.delta;
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a.count - b.count);
  if (diff <= sorted[0].count) return sorted[0].delta;
  if (diff >= sorted[sorted.length - 1].count) return sorted[sorted.length - 1].delta;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (diff >= sorted[i].count && diff < sorted[i + 1].count) {
      const t = (diff - sorted[i].count) / (sorted[i + 1].count - sorted[i].count);
      return sorted[i].delta + t * (sorted[i + 1].delta - sorted[i].delta);
    }
  }
  return 0;
}

export async function predictLive(state: LiveGameState): Promise<LivePrediction> {
  const [{ curves, goldModel }, objStats] = await Promise.all([
    buildGoldCurves(),
    buildObjectiveStats(),
  ]);

  const draftBaseline = state.draftPMap != null ? Math.max(0.02, Math.min(0.98, state.draftPMap)) : 0.5;

  // ── 1. BASE: draft + team strength, slowly fading toward 50% ──
  const fade = baselineFade(state.minute);
  const base = draftBaseline + (0.5 - draftBaseline) * fade;

  // ── 2. GOLD DELTA: historical curve shift, fading toward 0 over time ──
  // Raw historical delta is based on average-strength teams. For teams far from 50%,
  // the actual gold impact is somewhat smaller (a strong team losing 500g is less
  // meaningful than a weak team losing 500g). We scale by 0.55 to avoid gold
  // overpowering the baseline. This keeps a 61% favorite at ~57% with -500g at 5m.
  const GOLD_SCALE = 0.55;
  const goldLookupMinute = Math.min(state.minute, GOLD_LOOKUP_MINUTE_CAP);
  const gImpact = goldImpact(state.minute);
  let goldShiftRaw = 0;
  if (state.goldDiffTotal !== 0 || state.minute >= 3) {
    const rawGoldWR = interpolateGoldWR(curves, goldLookupMinute, state.goldDiffTotal);
    const neutralGoldWR = interpolateGoldWR(curves, goldLookupMinute, 0);
    goldShiftRaw = rawGoldWR - neutralGoldWR;
  }
  const goldShift = goldShiftRaw * gImpact * GOLD_SCALE;
  const goldWR = base + goldShift;

  // Objective shifts (all from blue-side perspective)
  const dragonDiff = state.blueDragons.length - state.redDragons.length;
  const dragonCountDelta = dragonDiff !== 0 ? lookupObjectiveDelta(objStats.dragonsByCount, dragonDiff) : 0;

  let firstDragonDelta = 0;
  if (state.blueDragons.length > 0 && state.redDragons.length === 0) {
    firstDragonDelta = objStats.firstDragon.delta;
  } else if (state.redDragons.length > 0 && state.blueDragons.length === 0) {
    firstDragonDelta = -objStats.firstDragon.delta;
  }

  let soulDelta = 0;
  if (state.blueDragonSoul) {
    soulDelta = objStats.dragonSoul.delta;
    // Try type-specific soul boost
    const typeCounts: Record<string, number> = {};
    for (const d of state.blueDragons) typeCounts[d] = (typeCounts[d] || 0) + 1;
    const dominant = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
    if (dominant && objStats.soulByType[dominant[0]]) {
      soulDelta = objStats.soulByType[dominant[0]].delta;
    }
  } else if (state.redDragonSoul) {
    soulDelta = -objStats.dragonSoul.delta;
    const typeCounts: Record<string, number> = {};
    for (const d of state.redDragons) typeCounts[d] = (typeCounts[d] || 0) + 1;
    const dominant = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
    if (dominant && objStats.soulByType[dominant[0]]) {
      soulDelta = -objStats.soulByType[dominant[0]].delta;
    }
  }

  let elderDelta = 0;
  if (state.blueElderDragon > 0) elderDelta = objStats.elder.delta;
  else if (state.redElderDragon > 0) elderDelta = -objStats.elder.delta;

  let firstBaronDelta = 0;
  if (state.blueBaron > 0 && state.redBaron === 0) firstBaronDelta = objStats.firstBaron.delta;
  else if (state.redBaron > 0 && state.blueBaron === 0) firstBaronDelta = -objStats.firstBaron.delta;

  let baronDelta = 0;
  if (state.blueBaron > 0) baronDelta = objStats.baron.delta;
  else if (state.redBaron > 0) baronDelta = -objStats.baron.delta;

  let firstHeraldDelta = 0;
  if (state.blueHerald > 0 && state.redHerald === 0) firstHeraldDelta = objStats.firstHerald.delta;
  else if (state.redHerald > 0 && state.blueHerald === 0) firstHeraldDelta = -objStats.firstHerald.delta;

  const heraldDiff = state.blueHerald - state.redHerald;
  const heraldDelta = heraldDiff !== 0 ? lookupObjectiveDelta(objStats.heraldsByCount, heraldDiff) : 0;

  const grubDiff = state.blueVoidgrubs - state.redVoidgrubs;
  const grubDelta = grubDiff !== 0 ? lookupObjectiveDelta(objStats.grubsByCount, grubDiff) : 0;

  const towerDiff = state.blueTowersDestroyed - state.redTowersDestroyed;
  const towerDelta = towerDiff * objStats.towerDiffPerTower.delta;

  // Scale down overlapping objectives to avoid double-counting with gold diff.
  // Raw objective WR deltas include the gold correlation, so we dampen significantly.
  const OBJ_DAMPEN = 0.35;
  const objectiveShift = OBJ_DAMPEN * (
    firstDragonDelta * 0.3 +
    dragonCountDelta * 0.5 +
    soulDelta * 0.8 +
    elderDelta * 0.9 +
    firstBaronDelta * 0.4 +
    baronDelta * 0.5 +
    firstHeraldDelta * 0.3 +
    heraldDelta * 0.3 +
    grubDelta * 0.4 +
    towerDelta * 0.5
  );

  // Scaling shift
  const [blueScaling, redScaling] = await Promise.all([
    computeScalingScore(state.blueChamps),
    computeScalingScore(state.redChamps),
  ]);
  const netScaling = blueScaling - redScaling;
  const scalingShift = netScaling * state.minute * SCALE_PER_MINUTE;

  // ── FINAL: base + all deltas ──
  const pFinal = Math.max(0.02, Math.min(0.98, base + goldShift + objectiveShift + scalingShift));

  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return {
    pBlue: r4(pFinal),
    breakdown: {
      draftBaseline: r4(draftBaseline),
      goldWR: r4(goldWR),
      goldShift: r4(goldShift),
      draftAnchorWeight: r4(1 - fade),
      goldLookupMinute,
      goldHistoricalMute: r4(1 - gImpact),
      objectiveShift: r4(objectiveShift),
      scalingShift: r4(scalingShift),
      objectives: {
        firstDragon: r4(firstDragonDelta * 0.3),
        dragonCount: r4(dragonCountDelta * 0.5),
        dragonSoul: r4(soulDelta * 0.8),
        elder: r4(elderDelta * 0.9),
        firstBaron: r4(firstBaronDelta * 0.4),
        baronCount: r4(baronDelta * 0.5),
        firstHerald: r4(firstHeraldDelta * 0.3),
        heraldCount: r4(heraldDelta * 0.3),
        grubAdvantage: r4(grubDelta * 0.4),
        towerDiff: r4(towerDelta * 0.5),
      },
      goldModel,
    },
    minute: state.minute,
  };
}

export function invalidateLiveCache() {
  oeGoldCache = null;
  oeGoldCacheTs = 0;
  golGgGoldCurvesCache = null;
  golGgGoldCurvesTs = 0;
  objectiveStatsCache = null;
  objectiveStatsTs = 0;
}

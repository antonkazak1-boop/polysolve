import prisma from '../config/database';

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

export interface LivePrediction {
  pBlue: number;
  breakdown: {
    draftBaseline: number;
    goldWR: number;
    goldShift: number;
    objectiveShift: number;
    scalingShift: number;
    objectives: ObjectiveBreakdown;
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
const GOLD_BUCKETS = [-8000, -5000, -3000, -1500, -500, 500, 1500, 3000, 5000, 8000];
const SCALE_PER_MINUTE = 0.001;

// ─── Cache ───────────────────────────────────────────────────────────────────

let goldCurvesCache: GoldCurveData[] | null = null;
let goldCurvesTs = 0;
let objectiveStatsCache: ObjectiveStats | null = null;
let objectiveStatsTs = 0;

// ─── Gold-to-WR Curves ──────────────────────────────────────────────────────

function bucketize(goldDiff: number): number {
  for (let i = 0; i < GOLD_BUCKETS.length; i++) {
    if (goldDiff < GOLD_BUCKETS[i]) return GOLD_BUCKETS[i];
  }
  return 12000;
}

export async function buildGoldCurves(): Promise<GoldCurveData[]> {
  const now = Date.now();
  if (goldCurvesCache && now - goldCurvesTs < CACHE_TTL) return goldCurvesCache;

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
    const buckets = new Map<number, { wins: number; total: number }>();

    for (const g of games) {
      const gd = g[field] as number | null;
      if (gd == null) continue;
      const bucket = bucketize(gd);
      const entry = buckets.get(bucket) ?? { wins: 0, total: 0 };
      entry.total++;
      if (g.blueResult === 1) entry.wins++;
      buckets.set(bucket, entry);
    }

    const points: GoldCurvePoint[] = [];
    for (const b of [...GOLD_BUCKETS, 12000]) {
      const entry = buckets.get(b);
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

  goldCurvesCache = curves;
  goldCurvesTs = now;
  return curves;
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

  // Find the two nearest minute curves and interpolate
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

function getChampScalingCoeff(champWR: number, champGD15: number): number {
  if (champGD15 < -100 && champWR > 0.5) return 1;   // scaling
  if (champGD15 > 200 && champWR < 0.5) return -1;    // early
  return 0;                                             // neutral
}

async function computeScalingScore(champs: string[]): Promise<number> {
  if (champs.length === 0) return 0;

  const rows = await prisma.oEPlayerGame.groupBy({
    by: ['champion'],
    where: {
      champion: { in: champs },
      game: { year: CURRENT_YEAR },
    },
    _avg: { golddiffat15: true },
    _count: { result: true },
    _sum: { result: true },
  });

  let totalCoeff = 0;
  let found = 0;
  for (const champ of champs) {
    const row = rows.find(r => r.champion.toLowerCase() === champ.toLowerCase());
    if (!row || row._count.result < 5) continue;
    const wr = (row._sum.result ?? 0) / row._count.result;
    const gd15 = row._avg.golddiffat15 ?? 0;
    totalCoeff += getChampScalingCoeff(wr, gd15);
    found++;
  }

  return found > 0 ? totalCoeff / found : 0;
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
  const [curves, objStats] = await Promise.all([
    buildGoldCurves(),
    buildObjectiveStats(),
  ]);

  const draftBaseline = state.draftPMap != null ? Math.max(0.02, Math.min(0.98, state.draftPMap)) : 0.5;

  // Gold WR from historical curves
  // Before minute 3 (no meaningful gold diff), rely on draft baseline
  let goldWR: number;
  let pAfterGold: number;
  if (state.minute < 3 && Math.abs(state.goldDiffTotal) < 200) {
    goldWR = draftBaseline;
    pAfterGold = draftBaseline;
  } else {
    goldWR = interpolateGoldWR(curves, state.minute, state.goldDiffTotal);
    const draftWeight = Math.max(0.1, 0.6 - state.minute * 0.012);
    pAfterGold = draftBaseline * draftWeight + goldWR * (1 - draftWeight);
  }
  const goldShift = pAfterGold - draftBaseline;

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

  const pFinal = Math.max(0.02, Math.min(0.98, pAfterGold + objectiveShift + scalingShift));

  return {
    pBlue: Math.round(pFinal * 10000) / 10000,
    breakdown: {
      draftBaseline,
      goldWR: Math.round(goldWR * 10000) / 10000,
      goldShift: Math.round(goldShift * 10000) / 10000,
      objectiveShift: Math.round(objectiveShift * 10000) / 10000,
      scalingShift: Math.round(scalingShift * 10000) / 10000,
      objectives: {
        firstDragon: Math.round(firstDragonDelta * 0.3 * 10000) / 10000,
        dragonCount: Math.round(dragonCountDelta * 0.5 * 10000) / 10000,
        dragonSoul: Math.round(soulDelta * 0.8 * 10000) / 10000,
        elder: Math.round(elderDelta * 0.9 * 10000) / 10000,
        firstBaron: Math.round(firstBaronDelta * 0.4 * 10000) / 10000,
        baronCount: Math.round(baronDelta * 0.5 * 10000) / 10000,
        firstHerald: Math.round(firstHeraldDelta * 0.3 * 10000) / 10000,
        heraldCount: Math.round(heraldDelta * 0.3 * 10000) / 10000,
        grubAdvantage: Math.round(grubDelta * 0.4 * 10000) / 10000,
        towerDiff: Math.round(towerDelta * 0.5 * 10000) / 10000,
      },
    },
    minute: state.minute,
  };
}

export function invalidateLiveCache() {
  goldCurvesCache = null;
  goldCurvesTs = 0;
  objectiveStatsCache = null;
  objectiveStatsTs = 0;
}

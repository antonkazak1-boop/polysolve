// ─── Types ───────────────────────────────────────────────────────────────────

export type SeriesFormat = 'BO1' | 'BO3' | 'BO5';

export interface MCResult {
  teamA: string;
  teamB: string;
  format: SeriesFormat;
  nSims: number;
  /** Per-map win prob for map 1 (draft-adjusted). */
  pMap: number;
  /** Per-map win prob for maps 2+ (no draft info → prior or 0.5). */
  pMapRest: number;
  pSeriesWin: number;        // P(teamA wins the series)
  scoreDistribution: Record<string, number>; // e.g. "2-0": 0.35, "2-1": 0.25
  pOver: Record<string, number>;   // e.g. "2.5": 0.45 (probability total maps > threshold)
  pHandicap: Record<string, number>; // e.g. "-1.5": 0.35 (teamA wins by >= 2 maps)
  avgMaps: number;
  elapsedMs: number;
}

// ─── Simulation ──────────────────────────────────────────────────────────────

const WINS_NEEDED: Record<SeriesFormat, number> = { BO1: 1, BO3: 2, BO5: 3 };
const BLUE_SIDE_BONUS = 0.01; // ~1% blue side advantage in pro play

/**
 * pMap1  — map 1 win prob (draft-adjusted)
 * pMapRest — maps 2+ win prob (no draft known, defaults to pMap1 for backwards compat)
 * startA / startB — maps already won (partial score, e.g. 1-0 in a BO5)
 */
function simulateSeries(
  pMap1: number,
  format: SeriesFormat,
  pMapRest: number,
  startA: number = 0,
  startB: number = 0,
): [number, number] {
  const target = WINS_NEEDED[format];
  let winsA = startA;
  let winsB = startB;
  const mapsPlayed = startA + startB;

  while (winsA < target && winsB < target) {
    const mapIndex = (winsA - startA) + (winsB - startB);
    const totalMap = mapsPlayed + mapIndex;
    // First remaining map uses draft-adjusted pMap; subsequent use pMapRest
    const baseP = mapIndex === 0 ? pMap1 : pMapRest;
    const blueSideForA = totalMap % 2 === 0;
    const pThisMap = blueSideForA ? baseP + BLUE_SIDE_BONUS : baseP - BLUE_SIDE_BONUS;
    const clamped = Math.max(0.01, Math.min(0.99, pThisMap));

    if (Math.random() < clamped) winsA++;
    else winsB++;
  }

  return [winsA, winsB];
}

export function runMonteCarlo(
  teamA: string,
  teamB: string,
  pMap: number,
  format: SeriesFormat = 'BO3',
  nSims: number = 3000,
  /** Win prob for maps 2+ (unknown draft). Defaults to pMap (old behaviour). */
  pMapRest: number = pMap,
  /** Maps already won by teamA (partial score, e.g. 1 if Blue leads 1-0). */
  startA: number = 0,
  /** Maps already won by teamB. */
  startB: number = 0,
): MCResult {
  const start = performance.now();
  const scoreCounts = new Map<string, number>();
  let teamAWins = 0;
  let totalMaps = 0;

  for (let i = 0; i < nSims; i++) {
    const [wA, wB] = simulateSeries(pMap, format, pMapRest, startA, startB);
    const key = `${wA}-${wB}`;
    scoreCounts.set(key, (scoreCounts.get(key) ?? 0) + 1);
    if (wA > wB) teamAWins++;
    totalMaps += wA + wB;
  }

  const scoreDistribution: Record<string, number> = {};
  for (const [score, count] of scoreCounts) {
    scoreDistribution[score] = Math.round((count / nSims) * 10000) / 10000;
  }

  // Over/Under thresholds
  const pOver: Record<string, number> = {};
  const maxMaps = format === 'BO5' ? 5 : format === 'BO3' ? 3 : 1;
  for (let t = 1.5; t < maxMaps; t += 1) {
    const threshold = t;
    let overCount = 0;
    for (const [score, count] of scoreCounts) {
      const [a, b] = score.split('-').map(Number);
      if (a + b > threshold) overCount += count;
    }
    pOver[threshold.toFixed(1)] = Math.round((overCount / nSims) * 10000) / 10000;
  }

  // Handicap: teamA winning margin >= threshold
  const pHandicap: Record<string, number> = {};
  for (const margin of [1.5, 2.5]) {
    let count = 0;
    for (const [score, cnt] of scoreCounts) {
      const [a, b] = score.split('-').map(Number);
      if (a - b >= margin) count += cnt;
    }
    pHandicap[`-${margin}`] = Math.round((count / nSims) * 10000) / 10000;
  }

  return {
    teamA,
    teamB,
    format,
    nSims,
    pMap: Math.round(pMap * 10000) / 10000,
    pMapRest: Math.round(pMapRest * 10000) / 10000,
    pSeriesWin: Math.round((teamAWins / nSims) * 10000) / 10000,
    scoreDistribution,
    pOver,
    pHandicap,
    avgMaps: Math.round((totalMaps / nSims) * 100) / 100,
    elapsedMs: Math.round(performance.now() - start),
  };
}

import prisma from '../config/database';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChampionPower {
  champion: string;
  winrate: number;
  picks: number;
  gd15: number;
  powerScore: number;
}

export interface DraftResult {
  bluePower: number;
  redPower: number;
  delta: number;
  adjustment: number; // probability shift (-0.08 to +0.08)
  blueChampions: ChampionPower[];
  redChampions: ChampionPower[];
}

// ─── Champion power cache ────────────────────────────────────────────────────

let powerCache: Map<string, ChampionPower> | null = null;
let cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function loadChampionPower(): Promise<Map<string, ChampionPower>> {
  const now = Date.now();
  if (powerCache && now - cacheTs < CACHE_TTL) return powerCache;

  const champs = await prisma.golChampionStat.findMany({
    where: { season: 'S16', split: 'ALL', tournament: 'ALL' },
    select: { champion: true, winrate: true, picks: true, gd15: true, kda: true, dpm: true },
  });

  const map = new Map<string, ChampionPower>();
  for (const c of champs) {
    const wr = parseFloat(String(c.winrate).replace('%', '')) || 50;
    const picks = c.picks ?? 0;
    const gd15 = c.gd15 ?? 0;

    // Power score: winrate deviation from 50% weighted by sample size + normalized GD@15
    const wrDev = (wr - 50) / 100; // e.g. 55% → 0.05
    const sampleWeight = Math.min(picks / 100, 1); // cap at 100 picks for full weight
    const gd15Norm = gd15 / 500; // normalize: 500 gold @ 15 → 1.0

    const powerScore = (wrDev * 0.6 + gd15Norm * 0.4) * sampleWeight;

    map.set(c.champion.toLowerCase(), { champion: c.champion, winrate: wr, picks, gd15, powerScore });
  }

  powerCache = map;
  cacheTs = now;
  return map;
}

// ─── Sigmoid ─────────────────────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ─── Draft adjustment ────────────────────────────────────────────────────────

const MAX_ADJUSTMENT = 0.08; // +/- 8% probability shift
const SENSITIVITY = 15; // sigmoid steepness

export async function getDraftAdjustment(
  blueChampions: string[],
  redChampions: string[],
): Promise<DraftResult> {
  const powers = await loadChampionPower();

  const lookupChamps = (names: string[]): ChampionPower[] =>
    names.map((name) => {
      const key = name.toLowerCase();
      return powers.get(key) ?? { champion: name, winrate: 50, picks: 0, gd15: 0, powerScore: 0 };
    });

  const blueChamps = lookupChamps(blueChampions);
  const redChamps = lookupChamps(redChampions);

  const bluePower = blueChamps.reduce((s, c) => s + c.powerScore, 0);
  const redPower = redChamps.reduce((s, c) => s + c.powerScore, 0);
  const delta = bluePower - redPower;

  // Map delta through sigmoid scaled to MAX_ADJUSTMENT
  const adjustment = (sigmoid(delta * SENSITIVITY) - 0.5) * 2 * MAX_ADJUSTMENT;

  return { bluePower, redPower, delta, adjustment, blueChampions: blueChamps, redChampions: redChamps };
}

export async function getChampionPowerList(): Promise<ChampionPower[]> {
  const powers = await loadChampionPower();
  return [...powers.values()].sort((a, b) => b.powerScore - a.powerScore);
}

export function invalidateDraftCache() {
  powerCache = null;
  cacheTs = 0;
}

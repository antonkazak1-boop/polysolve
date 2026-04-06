import { predictMapComposite, CompositePrediction, DraftPick } from './lol-model';
import { runMonteCarlo, MCResult, SeriesFormat } from './lol-montecarlo';
import { scanLoLMarkets, LoLMarket } from './lol-market-scanner';
import { getCompositeTeamRatings } from './lol-model';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EdgeResult {
  market: LoLMarket;
  teamA: string;
  teamB: string;
  pModel: number;
  pMarket: number;
  edge: number;
  edgePct: string;
  confidence: 'high' | 'medium' | 'low';
  kellyStake: number;
  simulation: MCResult;
  draftApplied: boolean;
}

export interface PredictionResult {
  teamA: string;
  teamB: string;
  format: SeriesFormat;
  pMap: number;
  pModel: number;
  simulation: MCResult;
  draftApplied: boolean;
  composite: CompositePrediction;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function kellyFraction(edge: number, pModel: number): number {
  if (edge <= 0 || pModel <= 0 || pModel >= 1) return 0;
  const fullKelly = edge / (1 - pModel);
  return Math.round(Math.max(0, fullKelly * 0.25) * 10000) / 10000;
}

function confidence(edge: number, volume: number): 'high' | 'medium' | 'low' {
  if (Math.abs(edge) >= 0.08 && volume >= 1000) return 'high';
  if (Math.abs(edge) >= 0.04) return 'medium';
  return 'low';
}

const TEAM_ALIASES: Record<string, string[]> = {
  'BLG': ['Bilibili Gaming', 'BLG', 'Bilibili'],
  'Gen.G': ['Gen.G', 'GenG', 'Gen.G Esports'],
  'T1': ['T1', 'SK Telecom', 'SKT'],
  'JD Gaming': ['JDG', 'JD Gaming'],
  'Top Esports': ['TES', 'Top Esports'],
  'G2 Esports': ['G2', 'G2 Esports'],
  'Fnatic': ['FNC', 'Fnatic'],
  'BNK FearX': ['BNK FearX', 'BNK', 'FearX', 'KT Rolster'],
  'Hanwha Life Esports': ['HLE', 'Hanwha Life', 'Hanwha Life Esports'],
  'Dplus KIA': ['DK', 'Dplus KIA', 'Dplus', 'DWG KIA'],
  'Weibo Gaming': ['WBG', 'Weibo Gaming'],
  'LOUD': ['LOUD'],
  'LYON': ['LYON', 'LYON Gaming'],
  'DRX': ['DRX'],
};

async function resolveTeamName(marketName: string): Promise<string | null> {
  const ratings = await getCompositeTeamRatings();
  const teamNames = new Set(ratings.map(r => r.team));
  const lower = marketName.toLowerCase().trim();

  if (teamNames.has(marketName)) return marketName;

  for (const t of teamNames) {
    if (t.toLowerCase() === lower) return t;
  }

  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    if (aliases.some(a => a.toLowerCase() === lower)) {
      if (teamNames.has(canonical)) return canonical;
    }
  }

  for (const t of teamNames) {
    if (t.toLowerCase().includes(lower) || lower.includes(t.toLowerCase())) {
      return t;
    }
  }

  return null;
}

// ─── Core prediction ─────────────────────────────────────────────────────────

export async function predictMatch(
  teamA: string,
  teamB: string,
  format: SeriesFormat = 'BO3',
  nSims: number = 3000,
  draftA?: DraftPick[],
  draftB?: DraftPick[],
  playersA?: string[],
  playersB?: string[],
  seasons?: string[],
): Promise<PredictionResult> {
  const composite = await predictMapComposite({
    teamA,
    teamB,
    draftA,
    draftB,
    playersA,
    playersB,
    seasons,
  });

  const simulation = runMonteCarlo(teamA, teamB, composite.pMap, format, nSims);

  return {
    teamA,
    teamB,
    format,
    pMap: composite.pMap,
    pModel: simulation.pSeriesWin,
    simulation,
    draftApplied: Boolean(draftA?.length === 5 && draftB?.length === 5),
    composite,
  };
}

// ─── Market edge scan ────────────────────────────────────────────────────────

export async function scanEdges(nSims: number = 3000): Promise<EdgeResult[]> {
  const markets = await scanLoLMarkets();
  const results: EdgeResult[] = [];

  for (const market of markets) {
    if (market.type !== 'match_winner') continue;
    if (market.teams.length < 2) continue;

    const teamA = await resolveTeamName(market.teams[0]);
    const teamB = await resolveTeamName(market.teams[1]);
    if (!teamA || !teamB) continue;

    const format: SeriesFormat =
      market.format !== 'unknown' ? market.format : 'BO3';

    const prediction = await predictMatch(teamA, teamB, format, nSims);
    const pMarket = market.pMarketYes;
    const edge = prediction.pModel - pMarket;

    results.push({
      market,
      teamA,
      teamB,
      pModel: prediction.pModel,
      pMarket,
      edge: Math.round(edge * 10000) / 10000,
      edgePct: `${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)}%`,
      confidence: confidence(edge, market.volume),
      kellyStake: kellyFraction(edge, prediction.pModel),
      simulation: prediction.simulation,
      draftApplied: false,
    });
  }

  return results.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
}

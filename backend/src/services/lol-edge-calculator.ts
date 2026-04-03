import { getWinProbability, computeTeamRatings } from './lol-elo';
import { getDraftAdjustment, DraftResult } from './lol-draft';
import { runMonteCarlo, MCResult, SeriesFormat } from './lol-montecarlo';
import { scanLoLMarkets, LoLMarket } from './lol-market-scanner';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EdgeResult {
  market: LoLMarket;
  teamA: string;
  teamB: string;
  eloA: number;
  eloB: number;
  pModel: number;
  pMarket: number;
  edge: number;
  edgePct: string;
  confidence: 'high' | 'medium' | 'low';
  kellyStake: number;
  simulation: MCResult;
  draftApplied: boolean;
  draft?: DraftResult;
}

export interface PredictionResult {
  teamA: string;
  teamB: string;
  format: SeriesFormat;
  eloA: number;
  eloB: number;
  pMap: number;
  pModel: number;
  simulation: MCResult;
  draftApplied: boolean;
  draft?: DraftResult;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function kellyFraction(edge: number, pModel: number): number {
  if (edge <= 0 || pModel <= 0 || pModel >= 1) return 0;
  // Fractional Kelly (0.25x) for conservative sizing
  const fullKelly = edge / (1 - pModel);
  return Math.round(Math.max(0, fullKelly * 0.25) * 10000) / 10000;
}

function confidence(edge: number, volume: number): 'high' | 'medium' | 'low' {
  if (Math.abs(edge) >= 0.08 && volume >= 1000) return 'high';
  if (Math.abs(edge) >= 0.04) return 'medium';
  return 'low';
}

/**
 * Fuzzy match a market team name against our Elo DB.
 * Handles cases like "Bilibili Gaming" in Polymarket vs "BLG" in gol.gg.
 */
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
  const ratings = await computeTeamRatings();
  const lower = marketName.toLowerCase().trim();

  // Direct match
  if (ratings.has(marketName)) return marketName;

  // Case-insensitive match
  for (const [team] of ratings) {
    if (team.toLowerCase() === lower) return team;
  }

  // Alias match
  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    if (aliases.some((a) => a.toLowerCase() === lower)) {
      if (ratings.has(canonical)) return canonical;
    }
  }

  // Substring match (last resort)
  for (const [team] of ratings) {
    if (team.toLowerCase().includes(lower) || lower.includes(team.toLowerCase())) {
      return team;
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
  blueDraft?: string[],
  redDraft?: string[],
): Promise<PredictionResult> {
  const { p_a, eloA, eloB } = await getWinProbability(teamA, teamB);

  let pMap = p_a;
  let draftApplied = false;
  let draft: DraftResult | undefined;

  if (blueDraft?.length === 5 && redDraft?.length === 5) {
    draft = await getDraftAdjustment(blueDraft, redDraft);
    pMap = Math.max(0.05, Math.min(0.95, pMap + draft.adjustment));
    draftApplied = true;
  }

  const simulation = runMonteCarlo(teamA, teamB, pMap, format, nSims);

  return {
    teamA,
    teamB,
    format,
    eloA,
    eloB,
    pMap: Math.round(pMap * 10000) / 10000,
    pModel: simulation.pSeriesWin,
    simulation,
    draftApplied,
    draft,
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
      eloA: prediction.eloA,
      eloB: prediction.eloB,
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

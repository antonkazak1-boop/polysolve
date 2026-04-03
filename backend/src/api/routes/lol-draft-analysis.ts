import { Router, Request, Response } from 'express';
import {
  analyzeDraft,
  getTopChampions,
  getChampionSynergyList,
  getChampionMatchupList,
  getChampionWinRates,
  getPlayerMastery,
  getDataSummary,
  type DraftWeightsConfig,
  type DraftScoreMixInput,
} from '../../services/draft-analysis';

function parseBodyScoreMix(raw: unknown): Partial<DraftScoreMixInput> | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const w = raw as Record<string, unknown>;
  const pick = (key: keyof DraftScoreMixInput): number | undefined => {
    const v = w[key];
    if (v === undefined || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const out: Partial<DraftScoreMixInput> = {};
  const ct = pick('championTier');
  const sy = pick('synergy');
  const mu = pick('matchup');
  const ma = pick('mastery');
  if (ct !== undefined) out.championTier = ct;
  if (sy !== undefined) out.synergy = sy;
  if (mu !== undefined) out.matchup = mu;
  if (ma !== undefined) out.mastery = ma;
  return Object.keys(out).length ? out : undefined;
}

function parseBodyWeights(raw: unknown): Partial<DraftWeightsConfig> | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const w = raw as Record<string, unknown>;
  const pick = (key: keyof DraftWeightsConfig): number | undefined => {
    const v = w[key];
    if (v === undefined || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const out: Partial<DraftWeightsConfig> = {};
  const t1 = pick('leagueTier1');
  const t2 = pick('leagueTier2');
  const t3 = pick('leagueTier3');
  const yc = pick('yearCurrent');
  const yp = pick('yearPrev');
  const yo = pick('yearOlder');
  const ay = pick('anchorYear');
  if (t1 !== undefined) out.leagueTier1 = t1;
  if (t2 !== undefined) out.leagueTier2 = t2;
  if (t3 !== undefined) out.leagueTier3 = t3;
  if (yc !== undefined) out.yearCurrent = yc;
  if (yp !== undefined) out.yearPrev = yp;
  if (yo !== undefined) out.yearOlder = yo;
  if (ay !== undefined) out.anchorYear = ay;
  return Object.keys(out).length ? out : undefined;
}

export const lolDraftRouter = Router();

// Summary of imported OE data
lolDraftRouter.get('/lol/draft/summary', async (_req: Request, res: Response) => {
  const summary = await getDataSummary();
  res.json(summary);
});

// Top champions by WR on recent patches
lolDraftRouter.get('/lol/draft/champions', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const champions = await getTopChampions(limit);
  res.json({ count: champions.length, champions });
});

// Synergies for a specific champion
lolDraftRouter.get('/lol/draft/synergy/:champion', async (req: Request, res: Response) => {
  const champion = req.params.champion;
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const synergies = await getChampionSynergyList(champion, limit);
  res.json({ champion, count: synergies.length, synergies });
});

// Matchups for champion in specific position
lolDraftRouter.get('/lol/draft/matchups/:champion/:position', async (req: Request, res: Response) => {
  const { champion, position } = req.params;
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const matchups = await getChampionMatchupList(champion, position, limit);
  res.json({ champion, position, count: matchups.length, matchups });
});

// Player mastery lookup
lolDraftRouter.get('/lol/draft/mastery/:player', async (req: Request, res: Response) => {
  const player = req.params.player;
  const [mastery, champWRs] = await Promise.all([
    getPlayerMastery([player]),
    getChampionWinRates(),
  ]);
  const data = mastery.get(player) ?? [];
  for (const m of data) {
    const globalWR = champWRs.get(m.champion)?.winRate ?? 0.5;
    m.wrDelta = Math.round((m.winRate - globalWR) * 10000) / 10000;
  }
  res.json({ player, count: data.length, champions: data });
});

// Full draft analysis
lolDraftRouter.post('/lol/draft/analyze', async (req: Request, res: Response) => {
  const { blueChamps, redChamps, bluePlayers, redPlayers, positions, weights, scoreMix } = req.body;
  const weightOverrides = parseBodyWeights(weights);
  const scoreMixOverrides = parseBodyScoreMix(scoreMix);

  if (!Array.isArray(blueChamps) || !Array.isArray(redChamps)) {
    res.status(400).json({ error: 'blueChamps and redChamps arrays required' });
    return;
  }
  if (blueChamps.length !== 5 || redChamps.length !== 5) {
    res.status(400).json({ error: 'Exactly 5 champions per side required' });
    return;
  }

  try {
    const result = await analyzeDraft({
      blueChamps,
      redChamps,
      bluePlayers: Array.isArray(bluePlayers) && bluePlayers.length === 5 ? bluePlayers : undefined,
      redPlayers: Array.isArray(redPlayers) && redPlayers.length === 5 ? redPlayers : undefined,
      positions: Array.isArray(positions) && positions.length === 5 ? positions : undefined,
      weights: weightOverrides,
      scoreMix: scoreMixOverrides,
    });
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[draft-analyze] ERROR:', msg);
    if (!res.headersSent) {
      res.status(500).json({ error: `Draft analysis failed: ${msg}` });
    }
  }
});

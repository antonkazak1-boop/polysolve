import { Router, Request, Response } from 'express';
import axios from 'axios';
import prisma from '../../config/database';
import { buildGolGgUrl, parseGolGgHtml } from '../../services/golgg-parser';
import { runMonteCarlo, SeriesFormat } from '../../services/lol-montecarlo';
import { scanLoLMarkets } from '../../services/lol-market-scanner';
import { predictMatch, scanEdges } from '../../services/lol-edge-calculator';
import { getCompositeTeamRatings, getChampionPowerListComposite, predictMapComposite, DraftPick } from '../../services/lol-model';

export const lolGolggRouter = Router();

function parseSnapshotStrings<T extends { meta: string; charts: string; timeline: string; plates: string | null; players: string | null }>(
  row: T,
) {
  return {
    ...row,
    meta: JSON.parse(row.meta || '{}') as unknown,
    charts: JSON.parse(row.charts || '{}') as unknown,
    timeline: JSON.parse(row.timeline || '[]') as unknown,
    plates: row.plates ? (JSON.parse(row.plates) as unknown) : null,
    players: row.players ? (JSON.parse(row.players) as unknown) : null,
  };
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchGolHtml(url: string): Promise<string> {
  const { data } = await axios.get<string>(url, {
    timeout: 45000,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return typeof data === 'string' ? data : String(data);
}

/** GET /golgg/fetch?gameId=75588&page=page-game — fetch gol.gg, parse, upsert SQLite */
function normalizePageSlug(raw: unknown): string {
  const s = String(raw || 'page-game').replace(/^\/+|\/+$/g, '');
  return s || 'page-game';
}

lolGolggRouter.get('/golgg/fetch', async (req: Request, res: Response) => {
  const gameId = Number(req.query.gameId);
  const pageSlug = normalizePageSlug(req.query.page);
  if (!Number.isFinite(gameId) || gameId <= 0) {
    res.status(400).json({ error: 'Invalid gameId' });
    return;
  }
  const url = buildGolGgUrl(gameId, pageSlug);
  try {
    const html = await fetchGolHtml(url);
    const parsed = parseGolGgHtml(html, gameId, pageSlug);

    const row = await prisma.golGgGameSnapshot.upsert({
      where: { gameId_pageSlug: { gameId, pageSlug } },
      create: {
        gameId,
        pageSlug,
        sourceUrl: parsed.sourceUrl,
        title: parsed.title,
        meta: JSON.stringify(parsed.meta),
        charts: JSON.stringify(parsed.charts),
        timeline: JSON.stringify(parsed.timeline),
        plates: parsed.plates ? JSON.stringify(parsed.plates) : null,
        players: parsed.players ? JSON.stringify(parsed.players) : null,
      },
      update: {
        sourceUrl: parsed.sourceUrl,
        title: parsed.title,
        meta: JSON.stringify(parsed.meta),
        charts: JSON.stringify(parsed.charts),
        timeline: JSON.stringify(parsed.timeline),
        plates: parsed.plates ? JSON.stringify(parsed.plates) : null,
        players: parsed.players ? JSON.stringify(parsed.players) : null,
        fetchedAt: new Date(),
      },
    });

    res.json({
      ok: true,
      snapshot: parseSnapshotStrings(row),
      rawHtmlHash: parsed.rawHtmlHash,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[golgg/fetch]', msg);
    res.status(502).json({ ok: false, error: msg, url });
  }
});

/** GET /golgg/latest?gameId=75588&page=page-game — last snapshot from DB */
lolGolggRouter.get('/golgg/latest', async (req: Request, res: Response) => {
  const gameId = Number(req.query.gameId);
  const pageSlug = normalizePageSlug(req.query.page);
  if (!Number.isFinite(gameId) || gameId <= 0) {
    res.status(400).json({ error: 'Invalid gameId' });
    return;
  }
  const row = await prisma.golGgGameSnapshot.findUnique({
    where: { gameId_pageSlug: { gameId, pageSlug } },
  });
  if (!row) {
    res.status(404).json({ error: 'No snapshot; call /api/lol/golgg/fetch first' });
    return;
  }
  res.json(parseSnapshotStrings(row));
});

/** GET /golgg/list — recent snapshots */
lolGolggRouter.get('/golgg/list', async (_req: Request, res: Response) => {
  const rows = await prisma.golGgGameSnapshot.findMany({
    orderBy: { fetchedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      gameId: true,
      pageSlug: true,
      title: true,
      sourceUrl: true,
      fetchedAt: true,
    },
  });
  res.json({ snapshots: rows });
});

// ─── Stats endpoints ─────────────────────────────────────────────────────────

/** GET /golgg/stats/champions?season=S16&split=ALL */
lolGolggRouter.get('/golgg/stats/champions', async (req: Request, res: Response) => {
  const season = (req.query.season as string) || 'S16';
  const split = (req.query.split as string) || 'ALL';
  const tournament = (req.query.tournament as string) || 'ALL';
  const rows = await prisma.golChampionStat.findMany({
    where: { season, split, tournament },
    orderBy: { picks: 'desc' },
  });
  res.json({ count: rows.length, rows });
});

/** GET /golgg/stats/players?season=S16&split=ALL */
lolGolggRouter.get('/golgg/stats/players', async (req: Request, res: Response) => {
  const season = (req.query.season as string) || 'S16';
  const split = (req.query.split as string) || 'ALL';
  const tournament = (req.query.tournament as string) || 'ALL';
  const rows = await prisma.golPlayerStat.findMany({
    where: { season, split, tournament },
    orderBy: { games: 'desc' },
  });
  res.json({ count: rows.length, rows });
});

/** GET /golgg/stats/player-champions?playerId=1931&season=S16&split=ALL&tournament=ALL */
lolGolggRouter.get('/golgg/stats/player-champions', async (req: Request, res: Response) => {
  const playerId = Number(req.query.playerId);
  const season = (req.query.season as string) || 'S16';
  const split = (req.query.split as string) || 'ALL';
  const tournament = (req.query.tournament as string) || 'ALL';
  if (!Number.isFinite(playerId) || playerId <= 0) {
    res.status(400).json({ error: 'Invalid playerId' });
    return;
  }
  const rows = await prisma.golPlayerChampionStat.findMany({
    where: { playerId, season, split, tournament },
    orderBy: { games: 'desc' },
  });
  res.json({ count: rows.length, playerId, season, split, tournament, rows });
});

/** GET /golgg/stats/tournaments — list of scraped tournaments */
lolGolggRouter.get('/golgg/stats/tournaments', async (_req: Request, res: Response) => {
  const rows = await prisma.golTournament.findMany({
    orderBy: { lastGame: 'desc' },
    include: { _count: { select: { matches: true } } },
  });
  res.json({ count: rows.length, rows });
});

/** GET /golgg/stats/matches?tournamentName=2026+First+Stand */
lolGolggRouter.get('/golgg/stats/matches', async (req: Request, res: Response) => {
  const tournamentName = req.query.tournamentName as string | undefined;
  const rows = await prisma.golMatch.findMany({
    where: tournamentName ? { tournamentName } : {},
    orderBy: [{ gameDate: 'desc' }, { gameId: 'desc' }],
    take: 200,
  });
  res.json({ count: rows.length, rows });
});

/** GET /golgg/stats/summary — quick counts for UI */
lolGolggRouter.get('/golgg/stats/summary', async (_req: Request, res: Response) => {
  const [tournaments, matches, champions, players, playerChampionRows, snapshots] = await Promise.all([
    prisma.golTournament.count(),
    prisma.golMatch.count(),
    prisma.golChampionStat.count(),
    prisma.golPlayerStat.count(),
    prisma.golPlayerChampionStat.count(),
    prisma.golGgGameSnapshot.count(),
  ]);
  const lastScrape = await prisma.golChampionStat.findFirst({
    orderBy: { scrapedAt: 'desc' },
    select: { scrapedAt: true },
  });
  res.json({
    tournaments,
    matches,
    champions,
    players,
    playerChampionRows,
    snapshots,
    lastScrapeAt: lastScrape?.scrapedAt ?? null,
  });
});

// ─── Predictor endpoints ─────────────────────────────────────────────────────

/** GET /golgg/predictor/ratings — team strength from match history (replaces Elo) */
lolGolggRouter.get('/golgg/predictor/ratings', async (_req: Request, res: Response) => {
  try {
    const ratings = await getCompositeTeamRatings();
    res.json({ count: ratings.length, ratings });
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /golgg/predictor/champions — champion meta power scores (multi-season) */
lolGolggRouter.get('/golgg/predictor/champions', async (req: Request, res: Response) => {
  try {
    const seasonsRaw = req.query.seasons as string | undefined;
    const seasons = seasonsRaw ? seasonsRaw.split(',') : undefined;
    const champions = await getChampionPowerListComposite(seasons);
    res.json({ count: champions.length, champions });
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /golgg/predictor/markets — scan Polymarket for active LoL markets */
lolGolggRouter.get('/golgg/predictor/markets', async (_req: Request, res: Response) => {
  try {
    const markets = await scanLoLMarkets();
    res.json({ count: markets.length, markets });
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /golgg/predictor/edges — scan markets + compute model edges */
lolGolggRouter.get('/golgg/predictor/edges', async (req: Request, res: Response) => {
  try {
    const nSims = Number(req.query.nSims) || 3000;
    const edges = await scanEdges(nSims);
    res.json({ count: edges.length, edges });
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /golgg/predictor/edge?teamA=&teamB=&format=BO3 — single match prediction */
lolGolggRouter.get('/golgg/predictor/edge', async (req: Request, res: Response) => {
  try {
    const teamA = req.query.teamA as string;
    const teamB = req.query.teamB as string;
    const format = (req.query.format as SeriesFormat) || 'BO3';
    const nSims = Number(req.query.nSims) || 3000;

    if (!teamA || !teamB) {
      res.status(400).json({ error: 'teamA and teamB required' });
      return;
    }

    const prediction = await predictMatch(teamA, teamB, format, nSims);

    let pMarket: number | null = null;
    let edge: number | null = null;
    try {
      const markets = await scanLoLMarkets();
      const matching = markets.find((m) => {
        const title = (m.eventTitle + ' ' + m.question).toLowerCase();
        return (
          m.type === 'match_winner' &&
          title.includes(teamA.toLowerCase().split(' ')[0]) &&
          title.includes(teamB.toLowerCase().split(' ')[0])
        );
      });
      pMarket = matching?.pMarketYes ?? null;
      edge = pMarket !== null ? prediction.pModel - pMarket : null;
    } catch { /* market scan optional */ }

    res.json({
      ...prediction,
      pMarket,
      edge: edge !== null ? Math.round(edge * 10000) / 10000 : null,
      edgePct: edge !== null ? `${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)}%` : null,
    });
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * POST /golgg/predictor/draft — full prediction with draft + player names
 *
 * Body: {
 *   teamA, teamB, format, nSims,
 *   blueDraft: [{champion, player?}, ...],  // 5 picks
 *   redDraft:  [{champion, player?}, ...],  // 5 picks
 *   seasons?: ["S16","S15","S14"]
 * }
 *
 * Also accepts legacy format: blueDraft: ["Rumble","Trundle",...], redDraft: [...]
 */
lolGolggRouter.post('/golgg/predictor/draft', async (req: Request, res: Response) => {
  try {
    const { teamA, teamB, format, blueDraft, redDraft, nSims, seasons } = req.body ?? {};

    if (!teamA || !teamB) {
      res.status(400).json({ error: 'teamA and teamB required' });
      return;
    }
    if (!Array.isArray(blueDraft) || !Array.isArray(redDraft)) {
      res.status(400).json({ error: 'blueDraft and redDraft arrays required (5 picks each)' });
      return;
    }

    const toDraftPicks = (arr: unknown[]): DraftPick[] =>
      arr.map(item => {
        if (typeof item === 'string') return { champion: item };
        const obj = item as { champion?: string; player?: string };
        return { champion: obj.champion ?? '', player: obj.player };
      });

    const draftA = toDraftPicks(blueDraft);
    const draftB = toDraftPicks(redDraft);
    const seasonsArr = Array.isArray(seasons) ? seasons as string[] : undefined;

    const prediction = await predictMatch(
      teamA,
      teamB,
      format || 'BO3',
      nSims || 3000,
      draftA,
      draftB,
      undefined,
      undefined,
      seasonsArr,
    );

    res.json(prediction);
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /golgg/predictor/simulate — raw MC simulation */
lolGolggRouter.post('/golgg/predictor/simulate', async (req: Request, res: Response) => {
  try {
    const { teamA, teamB, format, pMap, pMapRest, nSims, startA, startB } = req.body ?? {};

    let resolvedPMap = Number(pMap);
    if (!resolvedPMap || resolvedPMap <= 0 || resolvedPMap >= 1) {
      if (teamA && teamB) {
        const comp = await predictMapComposite({ teamA, teamB });
        resolvedPMap = comp.pMap;
      } else {
        resolvedPMap = 0.5;
      }
    }

    const resolvedPMapRest = (Number(pMapRest) > 0 && Number(pMapRest) < 1)
      ? Number(pMapRest)
      : resolvedPMap;

    const sA = Math.max(0, Math.min(Number(startA) || 0, 4));
    const sB = Math.max(0, Math.min(Number(startB) || 0, 4));

    const result = runMonteCarlo(
      teamA || 'Team A',
      teamB || 'Team B',
      resolvedPMap,
      format || 'BO3',
      Math.min(Math.max(Number(nSims) || 3000, 1), 200_000),
      resolvedPMapRest,
      sA,
      sB,
    );

    res.json(result);
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /golgg/predictor/players?q=search — search player names for autocomplete */
lolGolggRouter.get('/golgg/predictor/players', async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || '').trim();
    const seasonsRaw = req.query.seasons as string | undefined;
    const seasons = seasonsRaw ? seasonsRaw.split(',') : ['S16', 'S15', 'S14'];
    if (!q || q.length < 2) {
      res.json({ players: [] });
      return;
    }
    const players = await prisma.golPlayerStat.findMany({
      where: { playerName: { contains: q }, season: { in: seasons } },
      select: { playerName: true, season: true, games: true },
      orderBy: { games: 'desc' },
      take: 50,
    });
    const unique = new Map<string, { name: string; games: number; seasons: string[] }>();
    for (const p of players) {
      const existing = unique.get(p.playerName);
      if (existing) {
        existing.games += p.games || 0;
        if (!existing.seasons.includes(p.season)) existing.seasons.push(p.season);
      } else {
        unique.set(p.playerName, { name: p.playerName, games: p.games || 0, seasons: [p.season] });
      }
    }
    res.json({ players: [...unique.values()].sort((a, b) => b.games - a.games).slice(0, 20) });
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

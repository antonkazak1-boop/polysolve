/**
 * Full gol.gg scraper
 * Fetches all S16 top-league tournaments, match lists, champion stats, player stats.
 * Run once:              npx tsx scripts/scrape-golgg.ts
 * Incremental update:    npx tsx scripts/scrape-golgg.ts --update
 * Champion pool (all seasons in DB):
 *                        npx tsx scripts/scrape-golgg.ts --player-pools
 *   Limit HTTP calls:    --player-pools=30
 * Extra player seasons:  npx tsx scripts/scrape-golgg.ts --extra-seasons=S14,S15,ALL
 *   Also include pools:  --extra-seasons=S14,S15,ALL --player-pools
 * Full multi-season:     npx tsx scripts/scrape-golgg.ts --seasons=S14,S15
 *   Also include pools:  npx tsx scripts/scrape-golgg.ts --seasons=S14,S15 --player-pools
 * Pools only for seasons (players already in DB):
 *                        npx tsx scripts/scrape-golgg.ts --pools-only=S14,S15
 */
import axios from 'axios';
import prisma from '../src/config/database';

const BASE = 'https://gol.gg';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Rate-limit: wait N ms between requests to avoid banning
const DELAY_MS = 800;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url: string): Promise<string> {
  const { data } = await axios.get<string>(url, {
    timeout: 60_000,
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    responseType: 'text',
  });
  return data;
}

function cleanText(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Tournament list (via AJAX) ─────────────────────────────────────────────

interface TourRow {
  trname: string;
  region: string;
  nbgames: number;
  avgtime: number;
  firstgame: string;
  lastgame: string;
}

/**
 * Fetch tournament list from the champion-list page's cbtournament dropdown.
 * The AJAX endpoint at /tournament/list/ajax.trlist.php is broken (404) for external clients,
 * so we scrape the filter options from the champion list page instead.
 */
async function fetchTournamentList(season = 'S16'): Promise<TourRow[]> {
  const url = `${BASE}/champion/list/season-${season}/split-ALL/tournament-ALL/`;
  const html = await fetchHtml(url);
  const selectMatch = html.match(/id='cbtournament'[^>]*>([\s\S]*?)<\/select>/);
  if (!selectMatch) return [];
  const opts = [...selectMatch[1].matchAll(/<option value='([^']+)'/g)].map((m) => m[1]);
  return opts
    .filter((t) => t !== 'ALL')
    .map((name) => ({
      trname: name,
      region: inferRegion(name),
      nbgames: 0,
      avgtime: 0,
      firstgame: '',
      lastgame: '',
    }));
}

function inferRegion(name: string): string {
  if (/LCK|Korea/i.test(name)) return 'KR';
  if (/LPL|China/i.test(name)) return 'CN';
  if (/LEC|EMEA/i.test(name)) return 'EU';
  if (/LCS|NA/i.test(name)) return 'NA';
  if (/First Stand|MSI|Worlds/i.test(name)) return 'WR';
  if (/VCS|Vietnam/i.test(name)) return 'VN';
  if (/LJL|Japan/i.test(name)) return 'JP';
  if (/CBLOL|Brazil/i.test(name)) return 'BR';
  if (/LLA|Latin/i.test(name)) return 'LLA';
  if (/LCP/i.test(name)) return 'LCP';
  return 'INT';
}

// ─── Match list per tournament ───────────────────────────────────────────────

interface MatchRow {
  gameId: number;
  title: string;
  team1: string;
  score: string;
  team2: string;
  winner: string;
  stage: string;
  patch: string;
  gameDate: string;
}

function parseMatchList(html: string): MatchRow[] {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const matches: MatchRow[] = [];
  for (const r of rows) {
    const idM = r[1].match(/game\/stats\/(\d+)/);
    if (!idM) continue;
    const gameId = Number(idM[1]);
    const cols = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      cleanText(m[1]),
    );
    if (cols.length < 6) continue;
    // cols: [title, team1, score, team2, stage, patch, date?]
    matches.push({
      gameId,
      title: cols[0] || '',
      team1: cols[1] || '',
      score: cols[2] || '',
      team2: cols[3] || '',
      winner: '', // winner is team that appears alone
      stage: cols[4] || '',
      patch: cols[5] || '',
      gameDate: cols[6] || '',
    });
  }
  return matches;
}

// ─── Champion stats ──────────────────────────────────────────────────────────

interface ChampRow {
  champion: string;
  picks: number;
  bans: number;
  prioScore: string;
  wins: number;
  losses: number;
  winrate: string;
  kda: string;
  avgBt: string;
  avgRp: string;
  bpPct: string;
  avgGt: string;
  csm: number;
  dpm: number;
  gpm: number;
  csd15: number;
  gd15: number;
  xpd15: number;
}

function parseChampionList(html: string): ChampRow[] {
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)];
  const results: ChampRow[] = [];
  for (const r of rows) {
    if (!r[1].includes('champion-stats')) continue;
    const cols = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      cleanText(m[1]),
    );
    if (cols.length < 10) continue;
    const n = (v: string) => {
      const x = parseFloat(v.replace('%', '').replace(',', '.'));
      return isNaN(x) ? null : x;
    };
    results.push({
      champion: cols[0],
      picks: Number(cols[1]) || 0,
      bans: Number(cols[2]) || 0,
      prioScore: cols[3],
      wins: Number(cols[4]) || 0,
      losses: Number(cols[5]) || 0,
      winrate: cols[6],
      kda: cols[7],
      avgBt: cols[8],
      avgRp: cols[9],
      bpPct: cols[10] || '',
      avgGt: cols[11] || '',
      csm: n(cols[12]) ?? 0,
      dpm: n(cols[13]) ?? 0,
      gpm: n(cols[14]) ?? 0,
      csd15: n(cols[15]) ?? 0,
      gd15: n(cols[16]) ?? 0,
      xpd15: n(cols[17]) ?? 0,
    });
  }
  return results;
}

// ─── Player stats ────────────────────────────────────────────────────────────

interface PlayerRow {
  playerId: number | null;
  playerName: string;
  country: string;
  games: number;
  winRate: string;
  kda: string;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  csm: number;
  gpm: number;
  kpPct: string;
  dmgPct: string;
  goldPct: string;
  vsPct: string;
  dpm: number;
  vspm: number;
  avgWpm: number;
  avgWcpm: number;
  avgVwpm: number;
  gd15: number;
  csd15: number;
  xpd15: number;
  fbPct: string;
  fbVictim: string;
  pentaKills: number;
}

function parsePlayerList(html: string): PlayerRow[] {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const results: PlayerRow[] = [];
  for (const r of rows) {
    if (!r[1].includes('player-stats')) continue;
    const idM = r[1].match(/player-stats\/(\d+)\//);
    const cols = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      cleanText(m[1]).replace(/&nbsp;/g, '').trim(),
    );
    if (cols.length < 10) continue;
    const n = (v: string) => {
      const x = parseFloat(v.replace('%', '').replace(',', '.'));
      return isNaN(x) ? 0 : x;
    };
    results.push({
      playerId: idM ? Number(idM[1]) : null,
      playerName: cols[0],
      country: cols[1],
      games: Number(cols[2]) || 0,
      winRate: cols[3],
      kda: cols[4],
      avgKills: n(cols[5]),
      avgDeaths: n(cols[6]),
      avgAssists: n(cols[7]),
      csm: n(cols[8]),
      gpm: n(cols[9]),
      kpPct: cols[10],
      dmgPct: cols[11],
      goldPct: cols[12],
      vsPct: cols[13],
      dpm: n(cols[14]),
      vspm: n(cols[15]),
      avgWpm: n(cols[16]),
      avgWcpm: n(cols[17]),
      avgVwpm: n(cols[18]),
      gd15: n(cols[19]),
      csd15: n(cols[20]),
      xpd15: n(cols[21]),
      fbPct: cols[22] || '',
      fbVictim: cols[23] || '',
      pentaKills: Number(cols[24]) || 0,
    });
  }
  return results;
}

/** Champion pool table on player-stats page (caption "… champion pool.") */
export interface PlayerChampionPoolRow {
  championId: number;
  champion: string;
  games: number;
  winRate: string | null;
  kda: string;
}

/**
 * Parses the "champion pool" table from a gol.gg player-stats page.
 *
 * BUG NOTE: the win-rate cell contains a nested <table class='tablebarg'><tr>…</tr></table>
 * so simple lazy /<tr>…<\/tr>/ regexes break on it. Instead we split by the champion-stats
 * anchor to isolate each row chunk, then extract fields with targeted patterns.
 */
export function parsePlayerChampionPool(html: string): PlayerChampionPoolRow[] {
  const cap = html.match(/<caption>[^<]*champion pool\.?<\/caption>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i);
  if (!cap) return [];
  const body = cap[1];

  // Each champion row starts right after the "champion pool" anchor pattern.
  // Split on the start of each champion cell to isolate per-row content.
  const parts = body.split(/<tr><td class='align-middle'>/);
  const out: PlayerChampionPoolRow[] = [];

  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];

    const idM = chunk.match(/champion-stats\/(\d+)\//);
    const altM = chunk.match(/alt='([^']+)'/);
    if (!idM || !altM) continue;

    // Games: plain number in its own TD (no nested HTML)
    const gamesM = chunk.match(/<td\s+[^>]*class='text-center align-middle'>(\d+)<\/td>/);
    if (!gamesM) continue;
    const games = Number(gamesM[1]);
    if (!Number.isFinite(games) || games <= 0) continue;

    // Win rate: lives in a position-absolute div AFTER the nested tablebarg </tr>
    const wrM = chunk.match(/position-absolute[^>]*>([\d.]+)%</);
    const winRate = wrM ? `${wrM[1]}%` : null;

    // KDA: last plain decimal number in its own TD within this row chunk
    const kdaMatches = [...chunk.matchAll(/<td\s+[^>]*class='text-center align-middle'>([\d.]+)<\/td>/g)];
    // First match = games (already captured), last = KDA
    const kda = kdaMatches.length >= 2 ? kdaMatches[kdaMatches.length - 1][1] : null;

    out.push({
      championId: Number(idM[1]),
      champion: altM[1],
      games,
      winRate,
      kda,
    });
  }
  return out;
}

function buildPlayerStatsUrl(
  playerId: number,
  season: string,
  split: string,
  tournament: string,
): string {
  const s = season.startsWith('S') ? season : `S${season}`;
  return `${BASE}/players/player-stats/${playerId}/season-${encodeURIComponent(s)}/split-${encodeURIComponent(split)}/tournament-${encodeURIComponent(tournament)}/`;
}

// ─── Upsert helpers ──────────────────────────────────────────────────────────

async function upsertTournament(t: TourRow, season = 'S16'): Promise<string> {
  const row = await prisma.golTournament.upsert({
    where: { name: t.trname },
    create: {
      name: t.trname,
      region: t.region,
      season,
      nbGames: t.nbgames,
      firstGame: t.firstgame,
      lastGame: t.lastgame,
    },
    update: {
      region: t.region,
      season,
      nbGames: t.nbgames,
      firstGame: t.firstgame,
      lastGame: t.lastgame,
      updatedAt: new Date(),
    },
  });
  return row.id;
}

async function upsertMatches(matches: MatchRow[], tourId: string, tourName: string) {
  for (const m of matches) {
    await prisma.golMatch.upsert({
      where: { gameId: m.gameId },
      create: {
        gameId: m.gameId,
        tournamentId: tourId,
        tournamentName: tourName,
        title: m.title,
        team1: m.team1,
        team2: m.team2,
        score: m.score,
        stage: m.stage,
        patch: m.patch,
        gameDate: m.gameDate,
      },
      update: {
        tournamentId: tourId,
        tournamentName: tourName,
        title: m.title,
        team1: m.team1,
        team2: m.team2,
        score: m.score,
        stage: m.stage,
        patch: m.patch,
        gameDate: m.gameDate,
        updatedAt: new Date(),
      },
    });
  }
}

async function upsertChampions(rows: ChampRow[], season: string, split: string, tournament: string) {
  for (const c of rows) {
    await prisma.golChampionStat.upsert({
      where: { season_split_tournament_champion: { season, split, tournament, champion: c.champion } },
      create: { season, split, tournament, ...c },
      update: { ...c, updatedAt: new Date() },
    });
  }
}

async function upsertPlayers(rows: PlayerRow[], season: string, split: string, tournament: string) {
  for (const p of rows) {
    await prisma.golPlayerStat.upsert({
      where: { season_split_tournament_playerName: { season, split, tournament, playerName: p.playerName } },
      create: { season, split, tournament, ...p },
      update: { ...p, updatedAt: new Date() },
    });
  }
}

async function upsertPlayerChampionPool(
  rows: PlayerChampionPoolRow[],
  season: string,
  split: string,
  tournament: string,
  playerId: number,
  playerName: string | null,
) {
  for (const c of rows) {
    await prisma.golPlayerChampionStat.upsert({
      where: {
        season_split_tournament_playerId_championId: {
          season,
          split,
          tournament,
          playerId,
          championId: c.championId,
        },
      },
      create: {
        season,
        split,
        tournament,
        playerId,
        playerName,
        championId: c.championId,
        champion: c.champion,
        games: c.games,
        winRate: c.winRate,
        kda: c.kda,
      },
      update: {
        playerName,
        champion: c.champion,
        games: c.games,
        winRate: c.winRate,
        kda: c.kda,
        updatedAt: new Date(),
      },
    });
  }
}

// ─── Full season scrape ──────────────────────────────────────────────────────

const TOP_REGIONS = new Set(['WR', 'CN', 'KR', 'EU', 'NA', 'WC', 'ERL', 'VN', 'JP', 'BR', 'LLA', 'LCP']);

async function scrapeFullSeason(season: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🏆 Season: ${season}`);
  console.log(`${'─'.repeat(60)}`);

  // Step 1: Tournament list
  console.log('\n📋 Fetching tournament list...');
  let tournaments: TourRow[] = [];
  try {
    tournaments = await fetchTournamentList(season);
    console.log(`  Found ${tournaments.length} tournaments`);
  } catch (e) {
    console.error('  ❌ Tournament list fetch failed:', (e as Error).message);
  }

  const topTours = tournaments.filter((t) => TOP_REGIONS.has(t.region));
  console.log(`  Top-league tournaments: ${topTours.length}`);

  // Step 2: Match lists
  for (const tour of topTours) {
    console.log(`\n🏟  Tournament: ${tour.trname} (${tour.region})`);
    const tourId = await upsertTournament(tour, season);
    const matchUrl = `${BASE}/tournament/tournament-matchlist/${encodeURIComponent(tour.trname)}/`;
    try {
      await sleep(DELAY_MS);
      const html = await fetchHtml(matchUrl);
      const matches = parseMatchList(html);
      console.log(`   → ${matches.length} matches`);
      await upsertMatches(matches, tourId, tour.trname);
    } catch (e) {
      console.warn(`   ⚠ matchlist failed: ${(e as Error).message}`);
    }
  }

  // Step 3: Champion stats
  console.log(`\n⚔  Fetching champion stats ${season}...`);
  for (const split of ['ALL'] as const) {
    await sleep(DELAY_MS);
    const url = `${BASE}/champion/list/season-${season}/split-${split}/tournament-ALL/`;
    try {
      const html = await fetchHtml(url);
      const rows = parseChampionList(html);
      console.log(`   split=${split}: ${rows.length} champions`);
      await upsertChampions(rows, season, split, 'ALL');
    } catch (e) {
      console.warn(`   ⚠ champion list split=${split} failed: ${(e as Error).message}`);
    }
  }

  // Step 4: Player stats
  console.log(`\n👤 Fetching player stats ${season}...`);
  for (const split of ['ALL'] as const) {
    await sleep(DELAY_MS);
    const url = `${BASE}/players/list/season-${season}/split-${split}/tournament-ALL/`;
    try {
      const html = await fetchHtml(url);
      const rows = parsePlayerList(html);
      console.log(`   split=${split}: ${rows.length} players`);
      await upsertPlayers(rows, season, split, 'ALL');
    } catch (e) {
      console.warn(`   ⚠ player list split=${split} failed: ${(e as Error).message}`);
    }
  }
}

async function scrapePlayerPoolBatch(
  targets: Array<{ playerId: number | null; playerName: string; season: string; split: string; tournament: string }>,
  limit: number | null,
) {
  const seen = new Set<string>();
  const unique = targets.filter((t) => {
    const k = `${t.playerId}-${t.season}-${t.split}-${t.tournament}`;
    if (!t.playerId || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const slice = limit ? unique.slice(0, limit) : unique;
  console.log(`👤 Champion pools: ${slice.length} player×split rows (limit ${limit ?? 'none'})…\n`);
  let ok = 0;
  let fail = 0;
  for (const t of slice) {
    const pid = t.playerId as number;
    const url = buildPlayerStatsUrl(pid, t.season, t.split, t.tournament || 'ALL');
    try {
      await sleep(DELAY_MS);
      const html = await fetchHtml(url);
      const rows = parsePlayerChampionPool(html);
      if (!rows.length) {
        console.warn(`   ⚠ no pool rows: ${t.playerName} (${pid}) ${t.season}/${t.split}`);
        fail++;
        continue;
      }
      await upsertPlayerChampionPool(rows, t.season, t.split, t.tournament || 'ALL', pid, t.playerName);
      console.log(`   ✓ ${t.playerName} (${pid}) ${t.season}/${t.split}: ${rows.length} champs`);
      ok++;
    } catch (e) {
      console.warn(`   ⚠ ${url} — ${(e as Error).message}`);
      fail++;
    }
  }
  console.log(`\n✅ Player pools done: ${ok} ok, ${fail} failed / empty`);
}

async function main() {
  const updateOnly = process.argv.includes('--update');
  const poolsArg = process.argv.find((a) => a.startsWith('--player-pools'));
  const playerPoolsOnly = Boolean(poolsArg);
  const poolLimitM = poolsArg?.match(/^--player-pools(?:=(\d+))?$/);
  const playerPoolLimit = poolLimitM?.[1] ? Number(poolLimitM[1]) : null;

  const extraSeasonsArg = process.argv.find((a) => a.startsWith('--extra-seasons'));
  const extraSeasons = extraSeasonsArg
    ? extraSeasonsArg.replace(/^--extra-seasons=/, '').split(',').map((s) => s.trim())
    : [];

  const seasonsArg = process.argv.find((a) => a.startsWith('--seasons='));
  const multiSeasons = seasonsArg
    ? seasonsArg.replace(/^--seasons=/, '').split(',').map((s) => s.trim().toUpperCase().startsWith('S') ? s.trim().toUpperCase() : `S${s.trim()}`)
    : [];

  const poolsOnlyArg = process.argv.find((a) => a.startsWith('--pools-only='));
  const poolsOnlySeasons = poolsOnlyArg
    ? poolsOnlyArg.replace(/^--pools-only=/, '').split(',').map((s) => s.trim().toUpperCase().startsWith('S') ? s.trim().toUpperCase() : `S${s.trim()}`)
    : [];

  console.log(`\n🏆 gol.gg scraper${poolsOnlySeasons.length ? ` — pools-only: ${poolsOnlySeasons.join(',')}` : multiSeasons.length ? ` — seasons: ${multiSeasons.join(',')}` : extraSeasons.length ? ` — extra seasons: ${extraSeasons.join(',')}` : ' — S16'}${playerPoolsOnly ? ' + champion pools' : ''}\n`);

  // ── Mode: pools-only for specified seasons (players already in DB) ───────
  if (poolsOnlySeasons.length) {
    const targets = await prisma.golPlayerStat.findMany({
      where: { playerId: { not: null }, season: { in: poolsOnlySeasons } },
      select: { playerId: true, playerName: true, season: true, split: true, tournament: true },
    });
    console.log(`👤 Found ${targets.length} player×season rows for ${poolsOnlySeasons.join(',')}`);
    await scrapePlayerPoolBatch(targets, playerPoolLimit);
    const poolCount = await prisma.golPlayerChampionStat.count({ where: { season: { in: poolsOnlySeasons } } });
    console.log(`\n✅ Done! Player×champ rows for ${poolsOnlySeasons.join(',')}: ${poolCount}`);
    await prisma.$disconnect();
    return;
  }

  // ── Mode: full multi-season scrape ───────────────────────────────────────
  if (multiSeasons.length) {
    for (const season of multiSeasons) {
      await scrapeFullSeason(season);
    }

    if (playerPoolsOnly) {
      const targets = await prisma.golPlayerStat.findMany({
        where: { playerId: { not: null }, season: { in: multiSeasons } },
        select: { playerId: true, playerName: true, season: true, split: true, tournament: true },
      });
      await scrapePlayerPoolBatch(targets, playerPoolLimit);
    }

    const [tourCount, matchCount, champCount, playerCount] = await Promise.all([
      prisma.golTournament.count(),
      prisma.golMatch.count(),
      prisma.golChampionStat.count(),
      prisma.golPlayerStat.count(),
    ]);
    console.log('\n✅ Done!');
    console.log(`   Tournaments: ${tourCount} | Matches: ${matchCount} | Champions: ${champCount} | Players: ${playerCount}`);
    await prisma.$disconnect();
    return;
  }

  // ── Mode: extra player seasons ───────────────────────────────────────────
  if (extraSeasons.length) {
    for (const season of extraSeasons) {
      // gol.gg uses "ALL" as-is, seasons like S15 → season-S15
      const seasonParam = season === 'ALL' ? 'ALL' : (season.startsWith('S') ? season : `S${season}`);
      for (const split of ['ALL'] as const) {
        const url = `${BASE}/players/list/season-${seasonParam}/split-${split}/tournament-ALL/`;
        console.log(`\n👤 Players season=${seasonParam} split=${split}…`);
        try {
          await sleep(DELAY_MS);
          const html = await fetchHtml(url);
          const rows = parsePlayerList(html);
          console.log(`   → ${rows.length} players`);
          await upsertPlayers(rows, seasonParam, split, 'ALL');
        } catch (e) {
          console.warn(`   ⚠ failed: ${(e as Error).message}`);
        }
      }
    }

    if (playerPoolsOnly) {
      // After scraping player lists, run champion pools for the new seasons
      const targets = await prisma.golPlayerStat.findMany({
        where: { playerId: { not: null }, season: { in: extraSeasons.map((s) => s.startsWith('S') ? s : `S${s}`) } },
        select: { playerId: true, playerName: true, season: true, split: true, tournament: true },
      });
      await scrapePlayerPoolBatch(targets, playerPoolLimit);
    }

    const [playerCount, poolRowCount] = await Promise.all([
      prisma.golPlayerStat.count(),
      prisma.golPlayerChampionStat.count(),
    ]);
    console.log(`\n✅ Done! Players in DB: ${playerCount} | Player×champ rows: ${poolRowCount}`);
    await prisma.$disconnect();
    return;
  }

  // ── Mode: champion pools only (all seasons in DB) ────────────────────────
  if (playerPoolsOnly) {
    const targets = await prisma.golPlayerStat.findMany({
      where: { playerId: { not: null } },
      select: { playerId: true, playerName: true, season: true, split: true, tournament: true },
    });
    await scrapePlayerPoolBatch(targets, playerPoolLimit);
    await prisma.$disconnect();
    return;
  }

  // ── Step 1: Tournament list ──────────────────────────────────────────────
  console.log('📋 Fetching tournament list...');
  let tournaments: TourRow[] = [];
  try {
    tournaments = await fetchTournamentList('S16');
    console.log(`  Found ${tournaments.length} tournaments`);
  } catch (e) {
    console.error('  ❌ Tournament list fetch failed:', (e as Error).message);
    tournaments = [];
  }

  // Filter to top leagues only (WR = World / International + major regions)
  const topTours = tournaments.filter((t) => TOP_REGIONS.has(t.region));
  console.log(`  Top-league tournaments: ${topTours.length}`);

  // ── Step 2: Scrape each tournament's match list ─────────────────────────
  for (const tour of topTours) {
    console.log(`\n🏟  Tournament: ${tour.trname} (${tour.region}, ${tour.nbgames} games)`);
    const tourId = await upsertTournament(tour, 'S16');

    const matchUrl = `${BASE}/tournament/tournament-matchlist/${encodeURIComponent(tour.trname)}/`;
    try {
      await sleep(DELAY_MS);
      const html = await fetchHtml(matchUrl);
      const matches = parseMatchList(html);
      console.log(`   → ${matches.length} matches`);
      await upsertMatches(matches, tourId, tour.trname);
    } catch (e) {
      console.warn(`   ⚠ matchlist failed: ${(e as Error).message}`);
    }
  }

  // ── Step 3: Champion stats (S16 ALL splits, ALL tournaments) ────────────
  console.log('\n⚔  Fetching champion stats S16...');
  for (const split of ['ALL', 'Winter'] as const) {
    await sleep(DELAY_MS);
    const url = `${BASE}/champion/list/season-S16/split-${split}/tournament-ALL/`;
    try {
      const html = await fetchHtml(url);
      const rows = parseChampionList(html);
      console.log(`   split=${split}: ${rows.length} champions`);
      await upsertChampions(rows, 'S16', split, 'ALL');
    } catch (e) {
      console.warn(`   ⚠ champion list split=${split} failed: ${(e as Error).message}`);
    }
  }

  // ── Step 4: Player stats (S16, multiple splits) ─────────────────────────
  console.log('\n👤 Fetching player stats S16...');
  for (const split of ['ALL', 'Winter'] as const) {
    await sleep(DELAY_MS);
    const url = `${BASE}/players/list/season-S16/split-${split}/tournament-ALL/`;
    try {
      const html = await fetchHtml(url);
      const rows = parsePlayerList(html);
      console.log(`   split=${split}: ${rows.length} players`);
      await upsertPlayers(rows, 'S16', split, 'ALL');
    } catch (e) {
      console.warn(`   ⚠ player list split=${split} failed: ${(e as Error).message}`);
    }
  }

  // ── Step 5: Summary ──────────────────────────────────────────────────────
  const [tourCount, matchCount, champCount, playerCount, poolRowCount] = await Promise.all([
    prisma.golTournament.count(),
    prisma.golMatch.count(),
    prisma.golChampionStat.count(),
    prisma.golPlayerStat.count(),
    prisma.golPlayerChampionStat.count(),
  ]);

  console.log('\n✅ Done!');
  console.log(`   Tournaments: ${tourCount}`);
  console.log(`   Matches:     ${matchCount}`);
  console.log(`   Champions:   ${champCount}`);
  console.log(`   Players:     ${playerCount}`);
  console.log(`   Player×champ rows: ${poolRowCount}  (run with --player-pools to fill)`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

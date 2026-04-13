/**
 * Scrape gol.gg game pages (page-game) for gold-over-time charts + winner.
 *
 * Usage:
 *   npx tsx scripts/scrape-golgg-games.ts              # scrape all missing
 *   npx tsx scripts/scrape-golgg-games.ts --limit=100  # scrape up to 100
 *   npx tsx scripts/scrape-golgg-games.ts --delay=1200 # ms between requests
 *   npx tsx scripts/scrape-golgg-games.ts --rescrape   # re-fetch ALL existing snapshots (updates meta/winner)
 */

import axios from 'axios';
import prisma from '../src/config/database';
import { parseGolGgHtml, buildGolGgUrl } from '../src/services/golgg-parser';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SLUG = 'page-game';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseArg(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? Number(arg.split('=')[1]) || fallback : fallback;
}
function hasFlag(name: string): boolean {
  return process.argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

async function fetchHtml(url: string): Promise<string> {
  const { data } = await axios.get<string>(url, {
    timeout: 45_000,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return typeof data === 'string' ? data : String(data);
}

interface ScrapeTarget {
  gameId: number;
  title: string;
}

async function scrapeList(targets: ScrapeTarget[], delayMs: number, label: string) {
  console.log(`\n📊 ${label}`);
  console.log(`   Will process: ${targets.length} (delay: ${delayMs}ms)\n`);

  let ok = 0;
  let noGold = 0;
  let fail = 0;

  for (let i = 0; i < targets.length; i++) {
    const m = targets[i];
    const progress = `[${i + 1}/${targets.length}]`;

    try {
      const html = await fetchHtml(buildGolGgUrl(m.gameId, PAGE_SLUG));
      const parsed = parseGolGgHtml(html, m.gameId, PAGE_SLUG);

      await prisma.golGgGameSnapshot.upsert({
        where: { gameId_pageSlug: { gameId: m.gameId, pageSlug: PAGE_SLUG } },
        create: {
          gameId: m.gameId,
          pageSlug: PAGE_SLUG,
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

      const charts = parsed.charts as Record<string, any>;
      const meta = parsed.meta as Record<string, any>;
      const hasGold = charts.goldOverTime?.datasets?.[1]?.data?.length > 3;
      const winner = meta.winnerSide
        ? `${meta.winnerSide} win (${meta.winnerHint})`
        : meta.winnerHint || 'no winner';

      if (hasGold) {
        ok++;
        console.log(`${progress} ✓ ${m.gameId} ${m.title} | ${winner} | gold: ${charts.goldOverTime.datasets[1].data.length} pts`);
      } else {
        noGold++;
        console.log(`${progress} ○ ${m.gameId} ${m.title} | ${winner} | no gold data`);
      }
    } catch (e: any) {
      fail++;
      const status = e?.response?.status;
      console.warn(`${progress} ✗ ${m.gameId} ${m.title} — ${status || e.message}`);
      if (status === 429) {
        console.warn('   Rate limited! Waiting 30s...');
        await sleep(30_000);
      }
    }

    if (i < targets.length - 1) await sleep(delayMs);
  }

  console.log(`\n✅ Done!`);
  console.log(`   Success (with gold): ${ok}`);
  console.log(`   Success (no gold data): ${noGold}`);
  console.log(`   Failed: ${fail}`);
  console.log(`   Total snapshots now: ${await prisma.golGgGameSnapshot.count()}`);
}

async function main() {
  const limit = parseArg('limit', 999_999);
  const delayMs = parseArg('delay', 900);
  const rescrape = hasFlag('rescrape');

  if (rescrape) {
    // Re-fetch existing snapshots to update meta (winner, etc.)
    const existing = await prisma.golGgGameSnapshot.findMany({
      where: { pageSlug: PAGE_SLUG },
      select: { gameId: true, title: true },
      orderBy: { gameId: 'desc' },
    });
    const targets = existing.slice(0, limit).map((r) => ({
      gameId: r.gameId,
      title: r.title || `game ${r.gameId}`,
    }));
    await scrapeList(targets, delayMs, `Re-scraping ${targets.length} existing snapshots`);
  } else {
    // Scrape missing
    const allMatches = await prisma.golMatch.findMany({
      select: { gameId: true, title: true },
      orderBy: { gameId: 'desc' },
    });
    const existingIds = new Set(
      (
        await prisma.golGgGameSnapshot.findMany({
          where: { pageSlug: PAGE_SLUG },
          select: { gameId: true },
        })
      ).map((s) => s.gameId),
    );
    const missing = allMatches.filter((m) => !existingIds.has(m.gameId));
    const targets = missing.slice(0, limit);

    console.log(`   Total GolMatch: ${allMatches.length}`);
    console.log(`   Already scraped: ${existingIds.size}`);
    console.log(`   Missing: ${missing.length}`);

    await scrapeList(targets, delayMs, `Scraping ${targets.length} new games`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

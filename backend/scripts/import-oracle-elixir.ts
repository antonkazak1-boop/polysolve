import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

// OE CSV has 12 rows per game: 5 blue players, 5 red players, 1 blue team, 1 red team
// Column indices (0-based) from header
const COL = {
  gameid: 0,
  datacompleteness: 1,
  league: 3,
  year: 4,
  split: 5,
  playoffs: 6,
  date: 7,
  game: 8,
  patch: 9,
  participantid: 10,
  side: 11,
  position: 12,
  playername: 13,
  playerid: 14,
  teamname: 15,
  teamid: 16,
  firstPick: 17,
  champion: 18,
  ban1: 19,
  ban2: 20,
  ban3: 21,
  ban4: 22,
  ban5: 23,
  pick1: 24,
  pick2: 25,
  pick3: 26,
  pick4: 27,
  pick5: 28,
  gamelength: 29,
  result: 30,
  kills: 31,
  deaths: 32,
  assists: 33,
  dpm: 80,
  damageshare: 81,
  cspm: 104,
  golddiffat15: 126,
  xpdiffat15: 127,
  csdiffat15: 128,
  earnedgoldshare: 95,
  totalgold: 92,
  earnedgpm: 94,
  vspm: 91,
};

function parseFloat_(v: string): number | null {
  if (!v || v === '' || v === 'undefined') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function parseInt_(v: string): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

interface RawRow {
  cols: string[];
}

// Parse CSV correctly handling quoted fields with commas
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

interface GameBundle {
  gameId: string;
  rows: RawRow[];
}

async function importFile(filePath: string) {
  const fileName = path.basename(filePath);
  console.log(`\n📂 Importing ${fileName}...`);

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  // Skip header
  const header = parseCSVLine(lines[0]);
  console.log(`  Columns: ${header.length}, Rows: ${lines.length - 1}`);

  // Verify key columns
  if (header[COL.gameid] !== 'gameid' || header[COL.position] !== 'position') {
    console.error('  ❌ Unexpected header format! gameid col:', header[COL.gameid], 'position col:', header[COL.position]);
    return;
  }

  // Group rows by gameId
  const games = new Map<string, RawRow[]>();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const gid = cols[COL.gameid];
    if (!gid) continue;
    if (!games.has(gid)) games.set(gid, []);
    games.get(gid)!.push({ cols });
  }

  console.log(`  Games found: ${games.size}`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  const batchSize = 200;
  const entries = [...games.entries()];

  for (let batch = 0; batch < entries.length; batch += batchSize) {
    const slice = entries.slice(batch, batch + batchSize);

    await prisma.$transaction(
      async (tx) => {
        for (const [gameId, rows] of slice) {
          try {
            // Find team rows (position=team)
            const teamRows = rows.filter((r) => r.cols[COL.position] === 'team');
            const playerRows = rows.filter((r) => r.cols[COL.position] !== 'team');

            if (teamRows.length < 2 || playerRows.length < 10) {
              skipped++;
              continue;
            }

            const blueTeamRow = teamRows.find((r) => r.cols[COL.side] === 'Blue');
            const redTeamRow = teamRows.find((r) => r.cols[COL.side] === 'Red');
            if (!blueTeamRow || !redTeamRow) {
              skipped++;
              continue;
            }

            const bt = blueTeamRow.cols;
            const rt = redTeamRow.cols;

            const dateStr = bt[COL.date];
            let parsedDate: Date;
            try {
              parsedDate = new Date(dateStr);
              if (isNaN(parsedDate.getTime())) parsedDate = new Date();
            } catch {
              parsedDate = new Date();
            }

            await tx.oEGame.upsert({
              where: { gameId },
              update: {},
              create: {
                gameId,
                league: bt[COL.league] || 'Unknown',
                year: parseInt_(bt[COL.year]) || 2026,
                split: bt[COL.split] || 'Unknown',
                playoffs: bt[COL.playoffs] === '1',
                date: parsedDate,
                patch: bt[COL.patch] || '',
                gamelength: parseInt_(bt[COL.gamelength]),
                blueTeam: bt[COL.teamname] || 'Unknown',
                redTeam: rt[COL.teamname] || 'Unknown',
                blueTeamId: bt[COL.teamid] || null,
                redTeamId: rt[COL.teamid] || null,
                blueResult: parseInt_(bt[COL.result]),
                bluePick1: bt[COL.pick1] || null,
                bluePick2: bt[COL.pick2] || null,
                bluePick3: bt[COL.pick3] || null,
                bluePick4: bt[COL.pick4] || null,
                bluePick5: bt[COL.pick5] || null,
                redPick1: rt[COL.pick1] || null,
                redPick2: rt[COL.pick2] || null,
                redPick3: rt[COL.pick3] || null,
                redPick4: rt[COL.pick4] || null,
                redPick5: rt[COL.pick5] || null,
                blueBan1: bt[COL.ban1] || null,
                blueBan2: bt[COL.ban2] || null,
                blueBan3: bt[COL.ban3] || null,
                blueBan4: bt[COL.ban4] || null,
                blueBan5: bt[COL.ban5] || null,
                redBan1: rt[COL.ban1] || null,
                redBan2: rt[COL.ban2] || null,
                redBan3: rt[COL.ban3] || null,
                redBan4: rt[COL.ban4] || null,
                redBan5: rt[COL.ban5] || null,
                blueFirstPick: bt[COL.firstPick] === '1',
              },
            });

            // Player rows
            for (const pr of playerRows) {
              const c = pr.cols;
              const champion = c[COL.champion];
              if (!champion) continue;

              await tx.oEPlayerGame.create({
                data: {
                  gameId,
                  playername: c[COL.playername] || 'Unknown',
                  playerid: c[COL.playerid] || null,
                  teamname: c[COL.teamname] || 'Unknown',
                  teamid: c[COL.teamid] || null,
                  side: c[COL.side] || 'Blue',
                  position: c[COL.position] || 'unknown',
                  champion,
                  result: parseInt_(c[COL.result]),
                  kills: parseInt_(c[COL.kills]),
                  deaths: parseInt_(c[COL.deaths]),
                  assists: parseInt_(c[COL.assists]),
                  dpm: parseFloat_(c[COL.dpm]),
                  cspm: parseFloat_(c[COL.cspm]),
                  gpm: parseFloat_(c[COL.earnedgpm]),
                  vspm: parseFloat_(c[COL.vspm]),
                  golddiffat15: parseFloat_(c[COL.golddiffat15]),
                  xpdiffat15: parseFloat_(c[COL.xpdiffat15]),
                  csdiffat15: parseFloat_(c[COL.csdiffat15]),
                  damageshare: parseFloat_(c[COL.damageshare]),
                  earnedgoldshare: parseFloat_(c[COL.earnedgoldshare]),
                },
              });
            }

            imported++;
          } catch (e: any) {
            if (e.code === 'P2002') {
              skipped++;
            } else {
              errors++;
              if (errors <= 5) console.error(`  ⚠ ${gameId}: ${e.message}`);
            }
          }
        }
      },
      { timeout: 60000 },
    );

    const pct = Math.round(((batch + slice.length) / entries.length) * 100);
    process.stdout.write(`\r  Progress: ${pct}% (${imported} imported, ${skipped} skipped, ${errors} errors)`);
  }

  console.log(`\n  ✅ Done: ${imported} games imported, ${skipped} skipped, ${errors} errors`);
}

async function main() {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    const defaultFiles = [
      '/Users/tony/Downloads/2024_LoL_esports_match_data_from_OraclesElixir.csv',
      '/Users/tony/Downloads/2025_LoL_esports_match_data_from_OraclesElixir.csv',
      '/Users/tony/Downloads/2026_LoL_esports_match_data_from_OraclesElixir.csv',
    ].filter((f) => fs.existsSync(f));

    if (defaultFiles.length === 0) {
      console.error('No CSV files found. Pass paths as arguments or place them in ~/Downloads/');
      process.exit(1);
    }
    files.push(...defaultFiles);
  }

  console.log(`\n🏆 Oracle's Elixir Import — ${files.length} file(s)\n`);

  const existingCount = await prisma.oEGame.count();
  console.log(`  Existing games in DB: ${existingCount}`);

  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`  ❌ File not found: ${f}`);
      continue;
    }
    await importFile(f);
  }

  const finalCount = await prisma.oEGame.count();
  const playerCount = await prisma.oEPlayerGame.count();
  console.log(`\n📊 Final DB state: ${finalCount} games, ${playerCount} player-game rows`);

  // Quick stats
  const patches = await prisma.oEGame.groupBy({
    by: ['patch'],
    _count: true,
    orderBy: { patch: 'desc' },
    take: 10,
  });
  console.log('\n  Top patches:');
  for (const p of patches) {
    console.log(`    ${p.patch}: ${p._count} games`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

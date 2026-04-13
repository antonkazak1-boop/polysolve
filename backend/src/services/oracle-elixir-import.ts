import * as fs from 'fs';
import * as path from 'path';
import prisma from '../config/database';

export interface OracleElixirImportResult {
  imported: number;
  skipped: number;
  errors: number;
}

// OE CSV has 12 rows per game: 5 blue players, 5 red players, 1 blue team, 1 red team
// Column indices (0-based) from header
const COL = {
  gameid: 0,
  datacompleteness: 1,
  // url: 2 (skipped)
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
  // Objectives (team rows only) — 0-indexed from header
  firstdragon: 46,
  dragons: 47,
  opp_dragons: 48,
  elementaldrakes: 49,
  opp_elementaldrakes: 50,
  infernals: 51,
  mountains: 52,
  clouds: 53,
  oceans: 54,
  chemtechs: 55,
  hextechs: 56,
  elders: 58,
  opp_elders: 59,
  firstherald: 60,
  heralds: 61,
  opp_heralds: 62,
  void_grubs: 63,
  opp_void_grubs: 64,
  firstbaron: 65,
  barons: 66,
  opp_barons: 67,
  atakhans: 68,
  opp_atakhans: 69,
  firsttower: 70,
  towers: 71,
  opp_towers: 72,
  turretplates: 75,
  opp_turretplates: 76,
  inhibitors: 77,
  opp_inhibitors: 78,
  dpm: 80,
  damageshare: 81,
  cspm: 104,
  vspm: 91,
  totalgold: 92,
  earnedgpm: 94,
  earnedgoldshare: 95,
  golddiffat10: 111,
  golddiffat15: 126,
  xpdiffat15: 127,
  csdiffat15: 128,
  golddiffat20: 141,
  golddiffat25: 156,
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

export async function importOracleElixirFile(filePath: string): Promise<OracleElixirImportResult> {
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
    return { imported: 0, skipped: 0, errors: 0 };
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

            const objectiveData = {
              blueFirstDragon: parseInt_(bt[COL.firstdragon]) || null,
              blueDragons: parseInt_(bt[COL.dragons]) || null,
              blueInfernals: parseInt_(bt[COL.infernals]) || null,
              blueMountains: parseInt_(bt[COL.mountains]) || null,
              blueClouds: parseInt_(bt[COL.clouds]) || null,
              blueOceans: parseInt_(bt[COL.oceans]) || null,
              blueChemtechs: parseInt_(bt[COL.chemtechs]) || null,
              blueHextechs: parseInt_(bt[COL.hextechs]) || null,
              blueElders: parseInt_(bt[COL.elders]) || null,
              blueFirstHerald: parseInt_(bt[COL.firstherald]) || null,
              blueHeralds: parseInt_(bt[COL.heralds]) || null,
              blueVoidGrubs: parseInt_(bt[COL.void_grubs]) || null,
              blueFirstBaron: parseInt_(bt[COL.firstbaron]) || null,
              blueBarons: parseInt_(bt[COL.barons]) || null,
              blueAtakhans: parseInt_(bt[COL.atakhans]) || null,
              blueFirstTower: parseInt_(bt[COL.firsttower]) || null,
              blueTowers: parseInt_(bt[COL.towers]) || null,
              blueTurretPlates: parseInt_(bt[COL.turretplates]) || null,
              blueInhibitors: parseInt_(bt[COL.inhibitors]) || null,
              redDragons: parseInt_(rt[COL.dragons]) || null,
              redInfernals: parseInt_(rt[COL.infernals]) || null,
              redMountains: parseInt_(rt[COL.mountains]) || null,
              redClouds: parseInt_(rt[COL.clouds]) || null,
              redOceans: parseInt_(rt[COL.oceans]) || null,
              redChemtechs: parseInt_(rt[COL.chemtechs]) || null,
              redHextechs: parseInt_(rt[COL.hextechs]) || null,
              redElders: parseInt_(rt[COL.elders]) || null,
              redHeralds: parseInt_(rt[COL.heralds]) || null,
              redVoidGrubs: parseInt_(rt[COL.void_grubs]) || null,
              redBarons: parseInt_(rt[COL.barons]) || null,
              redAtakhans: parseInt_(rt[COL.atakhans]) || null,
              redTowers: parseInt_(rt[COL.towers]) || null,
              redTurretPlates: parseInt_(rt[COL.turretplates]) || null,
              redInhibitors: parseInt_(rt[COL.inhibitors]) || null,
              blueGoldDiffAt10: parseFloat_(bt[COL.golddiffat10]),
              blueGoldDiffAt15: parseFloat_(bt[COL.golddiffat15]),
              blueGoldDiffAt20: parseFloat_(bt[COL.golddiffat20]),
              blueGoldDiffAt25: parseFloat_(bt[COL.golddiffat25]),
            };

            const gamePayload = {
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
              ...objectiveData,
            };

            await tx.oEGame.upsert({
              where: { gameId },
              update: gamePayload,
              create: { gameId, ...gamePayload },
            });

            // Replace player rows (no unique constraint — re-import would duplicate otherwise)
            await tx.oEPlayerGame.deleteMany({ where: { gameId } });

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
  return { imported, skipped, errors };
}

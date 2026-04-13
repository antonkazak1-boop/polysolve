/**
 * CLI: import Oracle's Elixir CSV into SQLite (OEGame / OEPlayerGame).
 * Usage: npx tsx scripts/import-oracle-elixir.ts [path/to.csv ...]
 */
import prisma from '../src/config/database';
import { importOracleElixirFile } from '../src/services/oracle-elixir-import';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    const defaultFiles = [
      path.join(process.env.HOME || '', 'Downloads/2024_LoL_esports_match_data_from_OraclesElixir.csv'),
      path.join(process.env.HOME || '', 'Downloads/2025_LoL_esports_match_data_from_OraclesElixir.csv'),
      path.join(process.env.HOME || '', 'Downloads/2026_LoL_esports_match_data_from_OraclesElixir.csv'),
      path.join(process.env.HOME || '', 'Downloads/2026_LoL_esports_match_data_from_OraclesElixir-2.csv'),
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
    await importOracleElixirFile(f);
  }

  const finalCount = await prisma.oEGame.count();
  const playerCount = await prisma.oEPlayerGame.count();
  console.log(`\n📊 Final DB state: ${finalCount} games, ${playerCount} player-game rows`);

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

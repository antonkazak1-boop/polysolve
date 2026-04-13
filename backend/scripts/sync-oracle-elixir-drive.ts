/**
 * One-shot: download 2026 Oracle's Elixir CSV from Drive + import.
 * Достаточно запуска из backend/; id файла зашит в oracle-elixir-sync (переопределение: ORACLE_ELIXIR_2026_DRIVE_FILE_ID).
 */
import prisma from '../src/config/database';
import { syncOracleElixir2026FromDrive } from '../src/services/oracle-elixir-sync';

async function main() {
  console.log('\n☁️  Oracle Elixir Drive sync (manual)\n');
  const r = await syncOracleElixir2026FromDrive();
  if (r.error) console.error('❌', r.error);
  else {
    console.log('📁', r.destPath);
    if (r.fileId) console.log('🆔 fileId', r.fileId);
    if (r.importResult) console.log('📊 import', r.importResult);
    console.log(r.ok ? '✅ OK' : '⚠️ partial');
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

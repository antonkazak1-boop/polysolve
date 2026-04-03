/**
 * Smoke run for draft analyzer presets (T1 league weight = 10 by default in service).
 * Usage: npx tsx scripts/draft-presets-smoke.ts
 */
import { analyzeDraft, formatWeightsSummary, type DraftWeightsConfig } from '../src/services/draft-analysis';
import prisma from '../src/config/database';

const weights: DraftWeightsConfig = {
  leagueTier1: 10,
  leagueTier2: 1.5,
  leagueTier3: 0.5,
  yearCurrent: 3,
  yearPrev: 1.5,
  yearOlder: 0.7,
  anchorYear: 2026,
};

const presets = [
  { name: 'LCK: Orianna vs Azir', blueChamps: ['Kennen', 'Viego', 'Orianna', 'Corki', 'Braum'], redChamps: ['Renekton', 'Lee Sin', 'Azir', 'Jinx', 'Nautilus'], bluePlayers: ['Zeus', 'Oner', 'Faker', 'Gumayusi', 'Keria'], redPlayers: ['Kiin', 'Canyon', 'Chovy', 'Peyz', 'Lehends'] },
  { name: 'LPL: scaling vs dive', blueChamps: ["K'Sante", 'Sejuani', 'Azir', 'Ezreal', 'Karma'], redChamps: ['Jax', 'Vi', 'Orianna', 'Jhin', 'Leona'], bluePlayers: ['369', 'Kanavi', 'Knight', 'JackeyLove', 'MISSING'], redPlayers: ['Bin', 'Xun', 'Rookie', 'Elk', 'ON'] },
  { name: 'LEC: blind picks', blueChamps: ['Rumble', 'Maokai', 'Sylas', 'Varus', 'Rell'], redChamps: ['Gnar', 'Trundle', 'Yone', 'Kalista', 'Nautilus'], bluePlayers: ['Oscarinin', 'Razork', 'Humanoid', 'Upset', 'Kaiser'], redPlayers: ['Wunder', 'Yike', 'Caps', 'Hans Sama', 'Mikyx'] },
  { name: 'Late-game bot lane', blueChamps: ['Ornn', 'Xin Zhao', 'Taliyah', 'Aphelios', 'Lulu'], redChamps: ['Gwen', 'Viego', 'Azir', 'Senna', 'Tahm Kench'], bluePlayers: ['Zeus', 'Oner', 'Faker', 'Gumayusi', 'Keria'], redPlayers: ['Kiin', 'Canyon', 'Chovy', 'Peyz', 'Lehends'] },
];

async function main() {
  console.log(formatWeightsSummary(weights));
  for (const preset of presets) {
    const { name, ...input } = preset;
    const d = await analyzeDraft({ ...input, weights });
    const ori = d.blue.components.champions.find((c) => c.champion === 'orianna');
    const midMu = d.blue.components.matchups.find((m) => m.position === 'mid');
    console.log(
      `${name.padEnd(26)} Blue ${(d.blueWinProbability * 100).toFixed(1)}%  ${d.advantage}  | champ Ori WR ${ori ? (ori.winRate * 100).toFixed(1) : '—'}%` +
        (midMu ? ` | mid mu ${midMu.champion} vs ${midMu.opponent} ${(midMu.winRate * 100).toFixed(1)}%` : ''),
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

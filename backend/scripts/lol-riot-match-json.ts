/**
 * Fetch one LoL match from Riot Match-V5 and print JSON to stdout.
 *
 *   cd backend && RIOT_API_KEY=... npx tsx scripts/lol-riot-match-json.ts EUW1_1234567890
 *   RIOT_REGION=europe npx tsx scripts/lol-riot-match-json.ts EUW1_1234567890
 */

import 'dotenv/config';
import { fetchMatchV5, guessRegionalRouteFromMatchId, type LolRegionalRoute } from '../src/integrations/riot-lol/riot-lol-client';

const matchId = process.argv[2];
if (!matchId) {
  console.error('Usage: npx tsx scripts/lol-riot-match-json.ts <matchId>');
  process.exit(1);
}

const region = (process.env.RIOT_REGION as LolRegionalRoute) || guessRegionalRouteFromMatchId(matchId);

fetchMatchV5(region, matchId)
  .then(data => {
    console.log(JSON.stringify(data, null, 2));
  })
  .catch(e => {
    console.error(e.response?.data || e.message);
    process.exit(1);
  });

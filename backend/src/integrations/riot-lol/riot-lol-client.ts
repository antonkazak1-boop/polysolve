/**
 * Minimal Riot League of Legends client (Match-V5).
 * Use when you already have a matchId (e.g. EUW1_1234567890).
 *
 * Env: RIOT_API_KEY
 * Docs: https://developer.riotgames.com/apis#match-v5
 *
 * Regional hosts for match-v5: americas | europe | sea | asia
 */

import axios, { AxiosInstance } from 'axios';

const REGIONAL_HOSTS: Record<string, string> = {
  americas: 'https://americas.api.riotgames.com',
  europe: 'https://europe.api.riotgames.com',
  sea: 'https://sea.api.riotgames.com',
  asia: 'https://asia.api.riotgames.com',
};

export type LolRegionalRoute = keyof typeof REGIONAL_HOSTS;

function createClient(baseURL: string, apiKey: string): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: 15_000,
    headers: { 'X-Riot-Token': apiKey },
  });
}

/** Match-V5 payload (partial — extend as needed). */
export type LolMatchV5 = Record<string, unknown>;

export async function fetchMatchV5(
  regionalRoute: LolRegionalRoute,
  matchId: string,
): Promise<LolMatchV5> {
  const key = process.env.RIOT_API_KEY?.trim();
  if (!key) throw new Error('RIOT_API_KEY is not set');

  const base = REGIONAL_HOSTS[regionalRoute];
  if (!base) throw new Error(`Unknown regional route: ${regionalRoute}`);

  const http = createClient(base, key);
  const { data } = await http.get<LolMatchV5>(`/lol/match/v5/matches/${encodeURIComponent(matchId)}`);
  return data;
}

/**
 * Infer regional route from matchId prefix (first segment before underscore).
 * Heuristic only — verify against Riot routing table for your use case.
 */
export function guessRegionalRouteFromMatchId(matchId: string): LolRegionalRoute {
  const platform = matchId.split('_')[0]?.toUpperCase() || '';
  const euw = ['EUW1', 'EUN1', 'TR1', 'RU'];
  const na = ['NA1', 'BR1', 'LA1', 'LA2'];
  const kr = ['KR'];
  const oce = ['OC1'];
  const seaPlatforms = ['SG2', 'TW2', 'VN2'];
  if (euw.includes(platform)) return 'europe';
  if (na.includes(platform)) return 'americas';
  if (kr.includes(platform) || oce.includes(platform)) return 'asia';
  if (seaPlatforms.includes(platform)) return 'sea';
  return 'europe';
}

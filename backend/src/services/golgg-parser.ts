import crypto from 'crypto';

const GOL_BASE = 'https://gol.gg';

export interface GolGgTimelineEvent {
  side: 'blue' | 'red' | 'unknown';
  gameTime: string;
  label: string;
  iconFile: string | null;
}

export interface GolGgParsed {
  gameId: number;
  pageSlug: string;
  sourceUrl: string;
  title: string | null;
  meta: Record<string, unknown>;
  charts: Record<string, unknown>;
  timeline: GolGgTimelineEvent[];
  plates: Record<string, unknown> | null;
  players: unknown[] | null;
  rawHtmlHash: string;
}

/** Safer: replace single-quoted keys/strings for JSON.parse */
function jsObjectToJsonString(raw: string): string {
  return raw
    .replace(/'/g, '"')
    .replace(/,\s*]/g, ']')
    .replace(/,\s*}/g, '}');
}

function extractJsObjectLoose(html: string, varName: string): unknown | null {
  const re = new RegExp(`var\\s+${varName}\\s*=\\s*`, 'm');
  const m = html.match(re);
  if (!m || m.index === undefined) return null;
  let i = m.index + m[0].length;
  const start = i;
  const open = html[i];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        try {
          return JSON.parse(jsObjectToJsonString(raw));
        } catch {
          try {
            // eslint-disable-next-line no-new-func
            return new Function(`return (${raw});`)();
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

function parseTimeline(html: string): GolGgTimelineEvent[] {
  const start = html.indexOf('title_blue');
  if (start < 0) return [];
  const end = html.indexOf('<th>Plates', start);
  if (end < 0) return [];
  const chunk = html.slice(start, end);
  const events: GolGgTimelineEvent[] = [];
  const spanRe = /<span class='(blue_action|red_action)'>([\s\S]*?)<\/span>/g;
  let sm: RegExpExecArray | null;
  while ((sm = spanRe.exec(chunk)) !== null) {
    const side: GolGgTimelineEvent['side'] = sm[1] === 'blue_action' ? 'blue' : 'red';
    const inner = sm[2];
    const img = inner.match(/<img[^>]+src='([^']+)'[^>]*alt='([^']*)'/);
    const iconFile = img ? img[1].split('/').pop() || null : null;
    const label = img ? img[2] : '';
    const trimmed = inner.replace(/^\s+/, '');
    let gameTime: string | null = null;
    if (/^\d+:\d+/.test(trimmed)) {
      const tm = trimmed.match(/^(\d+:\d+)/);
      gameTime = tm ? tm[1] : null;
    } else {
      const times = inner.match(/(\d+:\d+)/g);
      gameTime = times && times.length ? times[times.length - 1] : null;
    }
    if (gameTime && (label || iconFile)) {
      events.push({ side, gameTime, label: label || iconFile || 'event', iconFile });
    }
  }
  return events;
}

function parsePlates(html: string): Record<string, unknown> | null {
  const start = html.indexOf('<th>Plates');
  if (start < 0) return null;
  const end = html.indexOf('<th>Gold distribution', start);
  const slice = end > start ? html.slice(start, end) : html.slice(start, start + 4000);
  const text = slice.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const voidm = text.match(/Voidgrubs\s+(\d+)\s+(\d+)/i);
  const platm = text.match(/Plates\s+(\d+)\s+(\d+)/i);
  const topm = text.match(/Plates TOP\s+(\d+)\s+(\d+)/i);
  const midm = text.match(/Plates MID\s+(\d+)\s+(\d+)/i);
  const botm = text.match(/Plates BOT\s+(\d+)\s+(\d+)/i);
  return {
    raw: text.slice(0, 500),
    voidgrubs: voidm ? { blue: Number(voidm[1]), red: Number(voidm[2]) } : undefined,
    platesTotal: platm ? { blue: Number(platm[1]), red: Number(platm[2]) } : undefined,
    platesByLane: {
      top: topm ? { blue: Number(topm[1]), red: Number(topm[2]) } : undefined,
      mid: midm ? { blue: Number(midm[1]), red: Number(midm[2]) } : undefined,
      bot: botm ? { blue: Number(botm[1]), red: Number(botm[2]) } : undefined,
    },
  };
}

function parseTitle(html: string): string | null {
  const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
  if (og) return og[1];
  const t = html.match(/<title>([^<]+)<\/title>/i);
  return t ? t[1].trim() : null;
}

function parsePlayers(html: string): unknown[] | null {
  // Each player row has: champion_icon with alt=ChampionName, followed (within ~4000 chars)
  // by a link-blanc with the player name, and then later KDA/CS tds.
  // The champion icon and KDA/CS may be far apart (runes/items in between),
  // so we match all icons and all KDA cells globally, then zip them by position order.

  const iconRe = /<img class='champion_icon rounded-circle' alt='([^']+)'/g;
  const playerRe = /<a class='link-blanc'[^>]+>([^<]+)<\/a>/g;
  const kdaRe = /<td style='text-align:center'>(\d+)\/(\d+)\/(\d+)<\/td><td style='text-align:center;'>\s*(\d+)/g;

  type IconEntry = { pos: number; champion: string };
  type PlayerEntry = { pos: number; name: string };
  type KdaEntry = { pos: number; k: number; d: number; a: number; cs: number };

  const icons: IconEntry[] = [];
  const players: PlayerEntry[] = [];
  const kdas: KdaEntry[] = [];

  let m: RegExpExecArray | null;
  while ((m = iconRe.exec(html)) !== null) icons.push({ pos: m.index, champion: m[1] });
  while ((m = playerRe.exec(html)) !== null) players.push({ pos: m.index, name: m[1].trim() });
  while ((m = kdaRe.exec(html)) !== null) kdas.push({ pos: m.index, k: +m[1], d: +m[2], a: +m[3], cs: +m[4] });

  if (icons.length === 0 || kdas.length === 0) return null;

  // Determine side boundaries from blue/red headers
  const bluePos = html.search(/class="blue-line-header"/);
  const redPos = html.search(/class="red-line-header"/);

  const getSide = (pos: number): 'blue' | 'red' => {
    if (bluePos < 0 && redPos < 0) return 'blue';
    if (redPos < 0) return 'blue';
    if (bluePos < 0) return 'red';
    // If blue header comes first: blue section is from bluePos to redPos, red is after
    const blueFirst = bluePos < redPos;
    if (blueFirst) return pos >= redPos ? 'red' : 'blue';
    return pos >= bluePos ? 'blue' : 'red';
  };

  // For each icon, find the nearest player name and KDA that come AFTER it
  // (before the next icon, or within 6000 chars)
  const rows: unknown[] = [];
  for (let i = 0; i < icons.length; i++) {
    const icon = icons[i];
    const nextIconPos = icons[i + 1]?.pos ?? icon.pos + 6000;

    const playerEntry = players.find((p) => p.pos > icon.pos && p.pos < nextIconPos);
    const kdaEntry = kdas.find((k) => k.pos > icon.pos && k.pos < nextIconPos + 2000);

    if (!kdaEntry) continue;

    rows.push({
      side: getSide(icon.pos),
      champion: icon.champion,
      player: playerEntry?.name ?? null,
      kda: `${kdaEntry.k}/${kdaEntry.d}/${kdaEntry.a}`,
      kills: kdaEntry.k,
      deaths: kdaEntry.d,
      assists: kdaEntry.a,
      cs: kdaEntry.cs,
    });
  }

  return rows.length ? rows : null;
}

function parseSummaryPlayers(html: string): unknown[] | null {
  const tables = html.match(/<table class='table_list trhover'>[\s\S]*?<\/table>/gi) ?? [];
  const out: unknown[] = [];
  for (let i = 0; i < tables.length; i++) {
    const side: 'blue' | 'red' = i === 0 ? 'blue' : 'red';
    const rows = tables[i].match(/<tr>([\s\S]*?)<\/tr>/gi) ?? [];
    for (const row of rows) {
      if (row.includes('<th>Player</th>')) continue;
      const cols = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
        m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
      );
      if (cols.length < 5) continue;
      out.push({
        side,
        player: cols[0] || null,
        kda: cols[1] || null,
        csm: cols[2] ? Number(cols[2]) : null,
        dpm: cols[3] ? Number(cols[3]) : null,
        wpm: cols[4] ? Number(cols[4]) : null,
      });
    }
  }
  return out.length ? out : null;
}

function parseSummaryTeamTotals(html: string): Record<string, unknown>[] | null {
  const cards = [...html.matchAll(/<div class="col-cadre">[\s\S]*?<h1>([^<]+)<\/h1>[\s\S]*?<\/div>\s*<\/div>/gi)];
  const teams: Record<string, unknown>[] = [];
  for (const c of cards) {
    const chunk = c[0];
    const name = c[1].trim();
    const stats: Record<string, number> = {};
    const sm = [...chunk.matchAll(/alt='([^']+)'\/>\s*(\d+)/g)];
    for (const s of sm) {
      stats[s[1].toLowerCase()] = Number(s[2]);
    }
    if (Object.keys(stats).length) {
      teams.push({ team: name, ...stats });
    }
  }
  return teams.length ? teams : null;
}

function parseMetaExtra(html: string): Record<string, unknown> {
  const gameTime = html.match(/Game Time[\s\S]{0,80}?<h1>(\d+:\d+)<\/h1>/i);
  const patch = html.match(/Game Time[\s\S]{0,200}?\b(v\d+\.\d+)\b/i);
  const winner = html.match(/([\w\s]+)\s*-\s*WIN/i);
  return {
    gameTimeLabel: gameTime ? gameTime[1] : null,
    patch: gameTime && patch ? patch[1] : null,
    winnerHint: winner ? winner[1].trim() : null,
  };
}

export function parseGolGgHtml(html: string, gameId: number, pageSlug: string): GolGgParsed {
  const sourceUrl = `${GOL_BASE}/game/stats/${gameId}/${pageSlug}/`;
  const title = parseTitle(html);

  const golddatas = extractJsObjectLoose(html, 'golddatas');
  const blueGoldData = extractJsObjectLoose(html, 'blueGoldData');
  const blueDmgData = extractJsObjectLoose(html, 'blueDmgData');
  const visionData = extractJsObjectLoose(html, 'visionData');
  const counterData = extractJsObjectLoose(html, 'counterData');

  const charts: Record<string, unknown> = {
    goldOverTime: golddatas,
    goldByRole: blueGoldData,
    damageByRole: blueDmgData,
    vision: visionData,
    jungleShare: counterData,
  };

  const timeline = parseTimeline(html);
  const plates = parsePlates(html);
  const players = pageSlug === 'page-summary' ? parseSummaryPlayers(html) : parsePlayers(html);
  const summaryTeams = pageSlug === 'page-summary' ? parseSummaryTeamTotals(html) : null;

  const meta: Record<string, unknown> = {
    title,
    gameId,
    pageSlug,
    hasGameCharts: Boolean(golddatas || blueGoldData || blueDmgData),
    hasSummaryTables: pageSlug === 'page-summary',
    ...parseMetaExtra(html),
  };
  if (pageSlug === 'page-summary') {
    meta.patch = null;
  }
  if (summaryTeams) meta.summaryTeams = summaryTeams;

  const rawHtmlHash = crypto.createHash('sha256').update(html).digest('hex');

  return {
    gameId,
    pageSlug,
    sourceUrl,
    title,
    meta,
    charts,
    timeline,
    plates,
    players,
    rawHtmlHash,
  };
}

export function buildGolGgUrl(gameId: number, pageSlug: string): string {
  return `${GOL_BASE}/game/stats/${gameId}/${pageSlug}/`;
}

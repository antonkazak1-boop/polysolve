'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import api from '@/lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChampionWR {
  champion: string;
  games: number;
  wGames: number;
  wins: number;
  winRate: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  avgGD15: number;
  avgDPM: number;
}

interface SynergyPair {
  champA: string;
  champB: string;
  games: number;
  wins: number;
  winRate: number;
  lift: number;
  roleWeight?: number;
}

interface MatchupStat {
  champion: string;
  opponent: string;
  position: string;
  games: number;
  wins: number;
  winRate: number;
  avgGD15: number;
  avgCSD15: number;
  avgXPD15: number;
  scalingTag: 'early' | 'scaling' | 'neutral';
  adjustedAdvantage: number;
}

interface PlayerMastery {
  player: string;
  champion: string;
  games: number;
  wins: number;
  winRate: number;
  avgKDA: number;
  avgGD15: number;
  avgDPM: number;
  avgCSPM: number;
  wrDelta: number;
  comfortCoeff: number;
  /** No pro games on this champ — minimum comfort floor used in score */
  noProData?: boolean;
}

interface DraftScore {
  teamSide: string;
  championTier: number;
  synergyScore: number;
  matchupScore: number;
  masteryScore: number;
  totalScore: number;
  components: {
    champions: ChampionWR[];
    synergies: SynergyPair[];
    matchups: MatchupStat[];
    mastery: PlayerMastery[];
  };
}

interface DraftWeightsConfig {
  leagueTier1: number;
  leagueTier2: number;
  leagueTier3: number;
  yearCurrent: number;
  yearPrev: number;
  yearOlder: number;
  anchorYear: number;
}

/** Relative weights sent to API (any scale; server normalizes to 100%). */
interface DraftScoreMixInput {
  championTier: number;
  synergy: number;
  matchup: number;
  mastery: number;
}

/** Normalized mix returned from API (sums to 1). */
type DraftScoreMixNormalized = DraftScoreMixInput;

interface DraftResult {
  blue: DraftScore;
  red: DraftScore;
  blueWinProbability: number;
  advantage: 'BLUE' | 'RED' | 'EVEN';
  advantageMargin: number;
  patchesUsed: string[];
  gamesAnalyzed: number;
  weightsApplied?: DraftWeightsConfig;
  scoreMixApplied?: DraftScoreMixNormalized;
  dataWindows?: {
    championWR: string;
    synergiesMatchups: string;
    playerMastery: string;
  };
}

interface MCResult {
  pSeriesWin: number;
  pMap: number;
  pMapRest: number;
  scoreDistribution: Record<string, number>;
  pOver: Record<string, number>;
  pHandicap: Record<string, number>;
  avgMaps: number;
  nSims: number;
  elapsedMs: number;
}

interface Summary {
  games: number;
  playerGameRows: number;
  uniqueChampions: number;
  uniquePlayers: number;
  recentPatches: string[];
  topPatches: Array<{ patch: string; games: number }>;
  topLeagues: Array<{ league: string; games: number }>;
  weighting?: string;
  defaultWeights?: DraftWeightsConfig;
  defaultScoreMix?: DraftScoreMixInput;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup'] as const;
const POS_LABELS: Record<string, string> = { top: 'TOP', jng: 'JNG', mid: 'MID', bot: 'ADC', sup: 'SUP' };
const POS_COLORS: Record<string, string> = {
  top: 'text-red-400 bg-red-500/10 border-red-500/20',
  jng: 'text-green-400 bg-green-500/10 border-green-500/20',
  mid: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  bot: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
  sup: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
};

const FALLBACK_WEIGHTS: DraftWeightsConfig = {
  leagueTier1: 10,
  leagueTier2: 1.5,
  leagueTier3: 0.5,
  yearCurrent: 3,
  yearPrev: 1.5,
  yearOlder: 0.7,
  anchorYear: 2026,
};

const FALLBACK_SCORE_MIX: DraftScoreMixInput = {
  championTier: 30,
  synergy: 25,
  matchup: 25,
  mastery: 20,
};

/**
 * Prior win probability for Blue team BEFORE the draft (based on team strength/form/standings).
 * After analyzing the draft we show how much the draft shifted this prior.
 *
 * priorBlue: 0.01–0.99, default 0.5 (equal teams)
 * draftWeight: 0–1 — how strongly the draft can shift the prior.
 *   0 = draft has no impact, prior is final result
 *   1 = only draft matters, prior is ignored
 *   0.4 (default) = prior carries 60%, draft shifts up to ±40%
 */
interface TeamStrengthConfig {
  priorBlue: number;   // pre-draft win probability for Blue, 0.01–0.99
  draftWeight: number; // how much draft can shift the prior, 0–1
}

type DraftPreset = {
  name: string;
  blueChamps: string[];
  redChamps: string[];
  bluePlayers: string[];
  redPlayers: string[];
};

/** Example drafts — run Analyze after loading; uses your weight panel (default T1 ×10). */
const DRAFT_PRESETS: DraftPreset[] = [
  {
    name: 'LCK: Orianna vs Azir',
    blueChamps: ['Kennen', 'Viego', 'Orianna', 'Corki', 'Braum'],
    redChamps: ['Renekton', 'Lee Sin', 'Azir', 'Jinx', 'Nautilus'],
    bluePlayers: ['Zeus', 'Oner', 'Faker', 'Gumayusi', 'Keria'],
    redPlayers: ['Kiin', 'Canyon', 'Chovy', 'Peyz', 'Lehends'],
  },
  {
    name: 'LPL: scaling vs dive',
    blueChamps: ["K'Sante", 'Sejuani', 'Azir', 'Ezreal', 'Karma'],
    redChamps: ['Jax', 'Vi', 'Orianna', 'Jhin', 'Leona'],
    bluePlayers: ['369', 'Kanavi', 'Knight', 'JackeyLove', 'MISSING'],
    redPlayers: ['Bin', 'Xun', 'Rookie', 'Elk', 'ON'],
  },
  {
    name: 'LEC: blind picks',
    blueChamps: ['Rumble', 'Maokai', 'Sylas', 'Varus', 'Rell'],
    redChamps: ['Gnar', 'Trundle', 'Yone', 'Kalista', 'Nautilus'],
    bluePlayers: ['Oscarinin', 'Razork', 'Humanoid', 'Upset', 'Kaiser'],
    redPlayers: ['Wunder', 'Yike', 'Caps', 'Hans Sama', 'Mikyx'],
  },
  {
    name: 'Late-game bot lane',
    blueChamps: ['Ornn', 'Xin Zhao', 'Taliyah', 'Aphelios', 'Lulu'],
    redChamps: ['Gwen', 'Viego', 'Azir', 'Senna', 'Tahm Kench'],
    bluePlayers: ['Zeus', 'Oner', 'Faker', 'Gumayusi', 'Keria'],
    redPlayers: ['Kiin', 'Canyon', 'Chovy', 'Peyz', 'Lehends'],
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}

function signedPct(v: number) {
  const s = (v * 100).toFixed(1);
  return v >= 0 ? `+${s}%` : `${s}%`;
}

function scalingBadge(tag: string) {
  if (tag === 'scaling') return <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">SCALING</span>;
  if (tag === 'early') return <span className="text-[9px] px-1 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/30">EARLY</span>;
  return null;
}

function wrColor(wr: number) {
  if (wr >= 0.55) return 'text-green-400';
  if (wr >= 0.50) return 'text-green-300/70';
  if (wr >= 0.45) return 'text-yellow-400';
  return 'text-red-400';
}

function deltaColor(v: number) {
  if (v > 0.05) return 'text-green-400';
  if (v > 0) return 'text-green-300/70';
  if (v > -0.05) return 'text-yellow-400';
  return 'text-red-400';
}

// ─── Score bar ───────────────────────────────────────────────────────────────

function ScoreBar({
  label,
  blue,
  red,
  description,
  mixShare,
}: {
  label: string;
  blue: number;
  red: number;
  description: string;
  /** Share of composite score (0–1), shown as % of total score. */
  mixShare?: number;
}) {
  const diff = blue - red;
  const barWidth = Math.min(Math.abs(diff) * 500, 50);
  const favors = diff > 0.001 ? 'blue' : diff < -0.001 ? 'red' : 'even';
  const shareLabel = mixShare != null && Number.isFinite(mixShare)
    ? `${(mixShare * 100).toFixed(1)}% of score`
    : null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs gap-2">
        <span className="text-gray-400 font-medium shrink-0">
          {label}
          {shareLabel && (
            <span className="ml-1.5 text-[10px] font-normal text-cyan-500/90">({shareLabel})</span>
          )}
        </span>
        <span className="text-gray-600 text-[10px] text-right min-w-0 break-words">{description}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`text-xs font-mono w-14 text-right ${favors === 'blue' ? 'text-blue-400' : 'text-gray-500'}`}>
          {signedPct(blue)}
        </span>
        <div className="flex-1 h-3 bg-gray-800 rounded-full relative overflow-hidden">
          <div className="absolute inset-0 flex">
            <div className="w-1/2 flex justify-end">
              {favors === 'blue' && (
                <div className="h-full bg-blue-500/60 rounded-l-full" style={{ width: `${barWidth}%` }} />
              )}
            </div>
            <div className="w-px bg-gray-600" />
            <div className="w-1/2">
              {favors === 'red' && (
                <div className="h-full bg-red-500/60 rounded-r-full" style={{ width: `${barWidth}%` }} />
              )}
            </div>
          </div>
        </div>
        <span className={`text-xs font-mono w-14 ${favors === 'red' ? 'text-red-400' : 'text-gray-500'}`}>
          {signedPct(red)}
        </span>
      </div>
    </div>
  );
}

// ─── Component: Champion input row ───────────────────────────────────────────

function WeightsForm({
  weights,
  onChange,
  onReset,
}: {
  weights: DraftWeightsConfig;
  onChange: (w: DraftWeightsConfig) => void;
  onReset: () => void;
}) {
  const set = (key: keyof DraftWeightsConfig, value: number) => {
    onChange({ ...weights, [key]: value });
  };

  const num = (key: keyof DraftWeightsConfig, label: string, step: string) => (
    <div className="flex flex-col gap-0.5 min-w-0">
      <label className="text-[10px] text-gray-500 truncate">{label}</label>
      <input
        type="number"
        step={step}
        min={0.01}
        max={100}
        value={weights[key]}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) set(key, v);
        }}
        className="bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-xs text-white font-mono w-full"
      />
    </div>
  );

  const y1 = weights.anchorYear;
  const y2 = weights.anchorYear - 1;
  const y3 = weights.anchorYear - 2;

  return (
    <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-gray-200">Data weights</div>
          <p className="text-[10px] text-gray-500 mt-0.5 max-w-xl">
            Each game is weighted by league tier × season. Raise T1 to emphasize top-league pro play (default 10).
          </p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-800 shrink-0"
        >
          Reset to server default
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
        {num('leagueTier1', 'T1 leagues (LCK/LPL/…)', '0.5')}
        {num('leagueTier2', 'T2 (PCS, VCS, …)', '0.5')}
        {num('leagueTier3', 'Minor regions', '0.5')}
        {num('yearCurrent', `Season ${y1} (current)`, '0.5')}
        {num('yearPrev', `Season ${y2}`, '0.5')}
        {num('yearOlder', `≤ season ${y3}`, '0.5')}
        {num('anchorYear', 'Anchor year', '1')}
      </div>
    </div>
  );
}

function ScoreMixForm({
  mix,
  onChange,
  onReset,
}: {
  mix: DraftScoreMixInput;
  onChange: (m: DraftScoreMixInput) => void;
  onReset: () => void;
}) {
  const set = (key: keyof DraftScoreMixInput, value: number) => {
    onChange({ ...mix, [key]: Math.max(0, value) });
  };

  const num = (key: keyof DraftScoreMixInput, label: string) => (
    <div className="flex flex-col gap-0.5 min-w-0">
      <label className="text-[10px] text-gray-500 truncate">{label}</label>
      <input
        type="number"
        step={1}
        min={0}
        value={mix[key]}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) set(key, v);
        }}
        className="bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-xs text-white font-mono w-full"
      />
    </div>
  );

  const sum = mix.championTier + mix.synergy + mix.matchup + mix.mastery;
  const safe = sum > 0 ? sum : 1;
  const preview = (x: number) => `${((x / safe) * 100).toFixed(1)}%`;

  return (
    <div className="bg-gray-900/80 border border-cyan-900/40 rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-gray-200">Composite score mix</div>
          <p className="text-[10px] text-gray-500 mt-0.5 max-w-2xl">
            Relative importance of the four pillars in the final Blue vs Red score (win probability). Any positive scale — values are normalized to 100% when you analyze.
          </p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-800 shrink-0"
        >
          Reset to default mix
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {num('championTier', 'Champion tier')}
        {num('synergy', 'Synergy')}
        {num('matchup', 'Lane matchups')}
        {num('mastery', 'Player mastery')}
      </div>
      <div className="text-[10px] text-cyan-600/90 font-mono">
        Preview → Champ {preview(mix.championTier)} · Syn {preview(mix.synergy)} · Match {preview(mix.matchup)} · Mast {preview(mix.mastery)}
        {sum <= 0 && <span className="text-red-400 ml-2">(need positive sum)</span>}
      </div>
    </div>
  );
}

function TeamStrengthForm({
  cfg,
  onChange,
  blueName,
  redName,
}: {
  cfg: TeamStrengthConfig;
  onChange: (c: TeamStrengthConfig) => void;
  blueName?: string;
  redName?: string;
}) {
  const blue = cfg.priorBlue;
  const red = 1 - blue;
  const priorLabel =
    Math.abs(blue - 0.5) < 0.01 ? 'Equal teams' :
    blue > 0.5 ? `${blueName || 'Blue'} favored` :
    `${redName || 'Red'} favored`;

  return (
    <div className="bg-gray-900/80 border border-violet-900/40 rounded-xl p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-gray-200">Pre-draft team strength</div>
          <p className="text-[10px] text-gray-500 mt-0.5 max-w-2xl">
            Set win probability based on team form, standings, Bo-series history — before the draft.
            After analysis you&apos;ll see how the draft shifts this prior.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange({ ...cfg, priorBlue: 0.5 })}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-800 shrink-0"
        >
          Reset 50/50
        </button>
      </div>

      {/* Prior slider */}
      <div className="space-y-2">
        <div className="flex items-end justify-between">
          <div className="text-center">
            <div className="text-[10px] text-red-400 mb-0.5">{redName || 'Red'}</div>
            <div className={`text-2xl font-bold ${red > blue ? 'text-red-400' : 'text-gray-500'}`}>{pct(red)}</div>
          </div>
          <div className="text-center flex-1 px-4">
            <div className={`text-[10px] font-medium mb-1 ${Math.abs(blue - 0.5) < 0.01 ? 'text-gray-500' : blue > 0.5 ? 'text-blue-400' : 'text-red-400'}`}>
              {priorLabel}
            </div>
            <div className="text-[10px] text-gray-600">pre-draft win probability</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-blue-400 mb-0.5">{blueName || 'Blue'}</div>
            <div className={`text-2xl font-bold ${blue > red ? 'text-blue-400' : 'text-gray-500'}`}>{pct(blue)}</div>
          </div>
        </div>
        <input
          type="range"
          min={1}
          max={99}
          step={1}
          value={Math.round(cfg.priorBlue * 100)}
          onChange={(e) => onChange({ ...cfg, priorBlue: Number(e.target.value) / 100 })}
          className="w-full accent-violet-500"
        />
        <div className="flex justify-between text-[10px] text-gray-700 font-mono">
          <span>Red 99%</span>
          <span>50/50</span>
          <span>Blue 99%</span>
        </div>
      </div>

      {/* Draft impact weight */}
      <div className="space-y-1.5 pt-1 border-t border-gray-800">
        <div className="flex items-center justify-between">
          <label className="text-[10px] text-gray-500">
            Draft impact — how much draft can shift the prior
          </label>
          <span className="text-[10px] font-mono text-violet-300">
            up to ±{pct(cfg.draftWeight / 2)} shift
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={cfg.draftWeight}
          onChange={(e) => onChange({ ...cfg, draftWeight: Number(e.target.value) })}
          className="w-full accent-violet-500"
        />
        <div className="flex justify-between text-[10px] text-gray-700 font-mono">
          <span>draft = 0% (prior only)</span>
          <span>draft = 40% (default)</span>
          <span>draft = 100% (ignores prior)</span>
        </div>
      </div>
    </div>
  );
}

function ChampInput({ pos, value, onChange, player, onPlayerChange, side }:
  { pos: string; value: string; onChange: (v: string) => void; player: string; onPlayerChange: (v: string) => void; side: 'blue' | 'red' }) {
  const borderColor = side === 'blue' ? 'border-blue-500/30 focus:border-blue-400' : 'border-red-500/30 focus:border-red-400';
  return (
    <div className="flex items-center gap-2">
      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border w-8 text-center ${POS_COLORS[pos]}`}>
        {POS_LABELS[pos]}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Champion"
        className={`bg-gray-950 border rounded-lg px-2.5 py-1.5 text-sm text-white w-32 focus:outline-none ${borderColor}`}
      />
      <input
        value={player}
        onChange={(e) => onPlayerChange(e.target.value)}
        placeholder="Player (optional)"
        className={`bg-gray-950 border border-gray-700 rounded-lg px-2.5 py-1.5 text-sm text-gray-300 w-36 focus:outline-none focus:border-gray-500`}
      />
    </div>
  );
}

// ─── Component: Detail tables ────────────────────────────────────────────────

function ChampTable({ champs, side }: { champs: ChampionWR[]; side: 'blue' | 'red' }) {
  const headerColor = side === 'blue' ? 'text-blue-400/70 border-blue-500/20' : 'text-red-400/70 border-red-500/20';
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className={`text-left border-b ${headerColor}`}>
          <th className="px-3 py-1.5 font-medium">Champion</th>
          <th className="px-3 py-1.5 font-medium text-right">Games</th>
          <th className="px-3 py-1.5 font-medium text-right" title="Effective weighted games (T1 leagues & 2026 weighted higher)">wGames</th>
          <th className="px-3 py-1.5 font-medium text-right" title="Weighted win rate">WR</th>
          <th className="px-3 py-1.5 font-medium text-right">KDA</th>
          <th className="px-3 py-1.5 font-medium text-right">GD@15</th>
          <th className="px-3 py-1.5 font-medium text-right">DPM</th>
        </tr>
      </thead>
      <tbody>
        {champs.map((c) => (
          <tr key={c.champion} className="border-b border-gray-800/40 hover:bg-white/[0.02]">
            <td className="px-3 py-1.5 font-medium text-white capitalize">{c.champion}</td>
            <td className="px-3 py-1.5 text-right text-gray-500">{c.games}</td>
            <td className="px-3 py-1.5 text-right text-gray-400 font-mono">{c.wGames || c.games}</td>
            <td className={`px-3 py-1.5 text-right font-mono ${wrColor(c.winRate)}`}>{pct(c.winRate)}</td>
            <td className="px-3 py-1.5 text-right text-gray-300 font-mono">
              {c.avgKills.toFixed(1)}/{c.avgDeaths.toFixed(1)}/{c.avgAssists.toFixed(1)}
            </td>
            <td className={`px-3 py-1.5 text-right font-mono ${c.avgGD15 >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {c.avgGD15 >= 0 ? '+' : ''}{Math.round(c.avgGD15)}
            </td>
            <td className="px-3 py-1.5 text-right text-gray-400 font-mono">{Math.round(c.avgDPM)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MatchupTable({ matchups }: { matchups: MatchupStat[] }) {
  if (!matchups.length) return <div className="text-xs text-gray-600 px-3 py-2">No matchup data for these picks</div>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left border-b border-gray-700/50 text-gray-500">
          <th className="px-3 py-1.5 font-medium">Lane</th>
          <th className="px-3 py-1.5 font-medium">Champ</th>
          <th className="px-3 py-1.5 font-medium">vs</th>
          <th className="px-3 py-1.5 font-medium text-right">Games</th>
          <th className="px-3 py-1.5 font-medium text-right">WR</th>
          <th className="px-3 py-1.5 font-medium text-right">GD@15</th>
          <th className="px-3 py-1.5 font-medium text-right">Type</th>
          <th className="px-3 py-1.5 font-medium text-right">Adj</th>
        </tr>
      </thead>
      <tbody>
        {matchups.map((m) => (
          <tr key={`${m.champion}-${m.opponent}-${m.position}`} className="border-b border-gray-800/40 hover:bg-white/[0.02]">
            <td className="px-3 py-1.5">
              <span className={`text-[10px] font-bold px-1 py-0.5 rounded border ${POS_COLORS[m.position]}`}>
                {POS_LABELS[m.position]}
              </span>
            </td>
            <td className="px-3 py-1.5 font-medium text-white capitalize">{m.champion}</td>
            <td className="px-3 py-1.5 text-gray-400 capitalize">{m.opponent}</td>
            <td className="px-3 py-1.5 text-right text-gray-400">{m.games}</td>
            <td className={`px-3 py-1.5 text-right font-mono ${wrColor(m.winRate)}`}>{pct(m.winRate)}</td>
            <td className={`px-3 py-1.5 text-right font-mono ${m.avgGD15 >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {m.avgGD15 >= 0 ? '+' : ''}{Math.round(m.avgGD15)}
            </td>
            <td className="px-3 py-1.5 text-right">{scalingBadge(m.scalingTag)}</td>
            <td className={`px-3 py-1.5 text-right font-mono ${deltaColor(m.adjustedAdvantage)}`}>
              {signedPct(m.adjustedAdvantage)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function roleBadge(rw: number | undefined) {
  if (!rw || rw <= 1) return null;
  return <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 ml-1">×{rw}</span>;
}

function SynergyTable({ synergies }: { synergies: SynergyPair[] }) {
  if (!synergies.length) return <div className="text-xs text-gray-600 px-3 py-2">No synergy data for these picks</div>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left border-b border-gray-700/50 text-gray-500">
          <th className="px-3 py-1.5 font-medium">Pair</th>
          <th className="px-3 py-1.5 font-medium text-right">Games</th>
          <th className="px-3 py-1.5 font-medium text-right">WR together</th>
          <th className="px-3 py-1.5 font-medium text-right">Lift</th>
          <th className="px-3 py-1.5 font-medium text-right" title="Role-pair weight (top+jng, jng+mid, bot+sup = 1.5×)">Role</th>
        </tr>
      </thead>
      <tbody>
        {synergies.sort((a, b) => (b.lift * (b.roleWeight ?? 1)) - (a.lift * (a.roleWeight ?? 1))).map((s) => (
          <tr key={`${s.champA}-${s.champB}`} className="border-b border-gray-800/40 hover:bg-white/[0.02]">
            <td className="px-3 py-1.5 font-medium text-white capitalize">{s.champA} + {s.champB}</td>
            <td className="px-3 py-1.5 text-right text-gray-400">{s.games}</td>
            <td className={`px-3 py-1.5 text-right font-mono ${wrColor(s.winRate)}`}>{pct(s.winRate)}</td>
            <td className={`px-3 py-1.5 text-right font-mono ${deltaColor(s.lift)}`}>{signedPct(s.lift)}</td>
            <td className="px-3 py-1.5 text-right">{roleBadge(s.roleWeight)}{!s.roleWeight || s.roleWeight <= 1 ? <span className="text-gray-600">1.0</span> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function comfortColor(c: number) {
  if (c >= 0.9) return 'text-green-400';
  if (c >= 0.7) return 'text-green-300/70';
  if (c >= 0.5) return 'text-yellow-400';
  return 'text-red-400';
}

function MasteryTable({ mastery }: { mastery: PlayerMastery[] }) {
  if (!mastery.length) return <div className="text-xs text-gray-600 px-3 py-2">No player mastery data (enter player names above)</div>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left border-b border-gray-700/50 text-gray-500">
          <th className="px-3 py-1.5 font-medium">Player</th>
          <th className="px-3 py-1.5 font-medium">Champion</th>
          <th className="px-3 py-1.5 font-medium text-right">Games</th>
          <th className="px-3 py-1.5 font-medium text-right">WR</th>
          <th className="px-3 py-1.5 font-medium text-right">KDA</th>
          <th className="px-3 py-1.5 font-medium text-right" title="1.0 = player's best champion, lower = less comfortable">Comfort</th>
          <th className="px-3 py-1.5 font-medium text-right">vs Global WR</th>
        </tr>
      </thead>
      <tbody>
        {mastery.map((m) => (
          <tr key={`${m.player}-${m.champion}`} className="border-b border-gray-800/40 hover:bg-white/[0.02]">
            <td className="px-3 py-1.5 text-gray-300">
              {m.player}
              {m.noProData && (
                <span className="block text-[9px] text-orange-400/90 mt-0.5">no pro data</span>
              )}
            </td>
            <td className="px-3 py-1.5 font-medium text-white capitalize">{m.champion}</td>
            <td className="px-3 py-1.5 text-right text-gray-400">{m.games || '—'}</td>
            <td className={`px-3 py-1.5 text-right font-mono ${wrColor(m.winRate)}`}>{pct(m.winRate)}</td>
            <td className="px-3 py-1.5 text-right text-gray-300 font-mono">{m.noProData ? '—' : m.avgKDA}</td>
            <td className={`px-3 py-1.5 text-right font-mono ${comfortColor(m.comfortCoeff)}`}>
              {m.comfortCoeff != null ? m.comfortCoeff.toFixed(2) : '—'}
              {m.comfortCoeff >= 0.98 && <span className="text-[9px] ml-1 text-green-400">★</span>}
            </td>
            <td className={`px-3 py-1.5 text-right font-mono ${m.noProData ? 'text-gray-600' : deltaColor(m.wrDelta)}`}>
              {m.noProData ? '—' : signedPct(m.wrDelta)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function DraftAnalyzerPage() {
  const [blueChamps, setBlueChamps] = useState(['', '', '', '', '']);
  const [redChamps, setRedChamps] = useState(['', '', '', '', '']);
  const [bluePlayers, setBluePlayers] = useState(['', '', '', '', '']);
  const [redPlayers, setRedPlayers] = useState(['', '', '', '', '']);
  const [weights, setWeights] = useState<DraftWeightsConfig>({ ...FALLBACK_WEIGHTS });
  const [scoreMix, setScoreMix] = useState<DraftScoreMixInput>({ ...FALLBACK_SCORE_MIX });
  const [teamStrength, setTeamStrength] = useState<TeamStrengthConfig>({ priorBlue: 0.5, draftWeight: 0.4 });
  const [settingsSynced, setSettingsSynced] = useState(false);
  /** Raw server response — contains per-pillar scores before mix is applied. */
  const [rawResult, setRawResult] = useState<DraftResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'matchups' | 'synergy' | 'mastery'>('overview');
  /** Cancel in-flight analyze requests when a new one starts. */
  const abortRef = useRef<AbortController | null>(null);

  // Monte Carlo state
  const [mcFormat, setMcFormat] = useState<'BO1' | 'BO3' | 'BO5'>('BO3');
  const [mcNSims, setMcNSims] = useState(120_000);
  const [mcResult, setMcResult] = useState<MCResult | null>(null);
  const [mcLoading, setMcLoading] = useState(false);

  useEffect(() => {
    api.get('/lol/draft/summary').then((r) => setSummary(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!summary || settingsSynced) return;
    if (summary.defaultWeights) setWeights({ ...summary.defaultWeights });
    if (summary.defaultScoreMix) setScoreMix({ ...summary.defaultScoreMix });
    setSettingsSynced(true);
  }, [summary, settingsSynced]);

  /**
   * Recompute scores from rawResult purely in JS whenever scoreMix or teamStrength changes.
   * Final win probability = blend of draft probability and manual team-strength bias.
   */
  const result = useMemo<DraftResult & { draftWinProbability: number; finalWinProbability: number } | null>(() => {
    if (!rawResult) return null;
    const sum = scoreMix.championTier + scoreMix.synergy + scoreMix.matchup + scoreMix.mastery;
    const mix = sum > 0 ? {
      championTier: scoreMix.championTier / sum,
      synergy: scoreMix.synergy / sum,
      matchup: scoreMix.matchup / sum,
      mastery: scoreMix.mastery / sum,
    } : { championTier: 0.3, synergy: 0.25, matchup: 0.25, mastery: 0.2 };

    function recompute(side: DraftResult['blue']): DraftResult['blue'] {
      const total =
        side.championTier * mix.championTier +
        (0.5 + side.synergyScore) * mix.synergy +
        (0.5 + side.matchupScore) * mix.matchup +
        (0.5 + side.masteryScore) * mix.mastery;
      return { ...side, totalScore: Math.round(total * 10000) / 10000 };
    }

    const blue = recompute(rawResult.blue);
    const red = recompute(rawResult.red);
    const diff = blue.totalScore - red.totalScore;
    const draftWinP = 1 / (1 + Math.exp(-diff * 15));

    // Final probability: start from prior, shift it by how much the draft deviates from 50/50
    // draftDelta = how much the draft alone moves the needle from neutral (positive = blue advantage)
    // finalP = prior + draftDelta * draftWeight
    const prior = Math.max(0.01, Math.min(0.99, teamStrength.priorBlue));
    const draftDelta = draftWinP - 0.5; // draft edge relative to neutral
    const w = Math.max(0, Math.min(1, teamStrength.draftWeight));
    const finalP = Math.max(0.01, Math.min(0.99, prior + draftDelta * w));

    const margin = Math.abs(finalP - 0.5);
    return {
      ...rawResult,
      blue,
      red,
      blueWinProbability: Math.round(finalP * 10000) / 10000,
      advantageMargin: Math.round(margin * 10000) / 10000,
      advantage: margin < 0.02 ? 'EVEN' : finalP > 0.5 ? 'BLUE' : 'RED',
      scoreMixApplied: mix,
      draftWinProbability: Math.round(draftWinP * 10000) / 10000,
      finalWinProbability: Math.round(finalP * 10000) / 10000,
    };
  }, [rawResult, scoreMix, teamStrength]);

  const updateChamp = (side: 'blue' | 'red', idx: number, val: string) => {
    const setter = side === 'blue' ? setBlueChamps : setRedChamps;
    setter((prev) => { const n = [...prev]; n[idx] = val; return n; });
  };

  const updatePlayer = (side: 'blue' | 'red', idx: number, val: string) => {
    const setter = side === 'blue' ? setBluePlayers : setRedPlayers;
    setter((prev) => { const n = [...prev]; n[idx] = val; return n; });
  };

  const analyze = useCallback(async () => {
    const bc = blueChamps.map((c) => c.trim()).filter(Boolean);
    const rc = redChamps.map((c) => c.trim()).filter(Boolean);
    if (bc.length !== 5 || rc.length !== 5) {
      setError('Enter 5 champions per side');
      return;
    }
    setError('');
    // Cancel any previous in-flight request before starting a new one
    const prevCtrl = abortRef.current;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    prevCtrl?.abort();

    setLoading(true);
    try {
      const bp = bluePlayers.map((p) => p.trim());
      const rp = redPlayers.map((p) => p.trim());
      // Always send default scoreMix — actual mix is applied client-side in useMemo
      const body: Record<string, unknown> = {
        blueChamps: bc, redChamps: rc, weights,
        scoreMix: FALLBACK_SCORE_MIX,
      };
      if (bp.some(Boolean)) body.bluePlayers = bp;
      if (rp.some(Boolean)) body.redPlayers = rp;
      const { data } = await api.post('/lol/draft/analyze', body, {
        signal: ctrl.signal,
        timeout: 120_000, // 2 min — analysis can be slow with heavy weights
      });
      if (!ctrl.signal.aborted) {
        setRawResult(data);
        setActiveTab('overview');
      }
    } catch (e: any) {
      // Swallow abort/cancel — a newer request is already in flight
      const isCanceled = e?.code === 'ERR_CANCELED' || e?.name === 'AbortError' || e?.name === 'CanceledError';
      if (!isCanceled) {
        const msg = e?.response?.data?.error || e?.message || 'Analysis failed';
        setError(msg);
      }
    } finally {
      // Only clear loading if this request is still the active one
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, [blueChamps, redChamps, bluePlayers, redPlayers, weights]);

  const loadPreset = (p: DraftPreset) => {
    setBlueChamps([...p.blueChamps]);
    setRedChamps([...p.redChamps]);
    setBluePlayers([...p.bluePlayers]);
    setRedPlayers([...p.redPlayers]);
  };

  const resetWeights = () => {
    const d = summary?.defaultWeights ?? FALLBACK_WEIGHTS;
    setWeights({ ...d });
  };

  const resetScoreMix = () => {
    const d = summary?.defaultScoreMix ?? FALLBACK_SCORE_MIX;
    setScoreMix({ ...d });
  };

  const runMC = useCallback(async () => {
    if (!result) return;
    setMcLoading(true);
    setMcResult(null);
    try {
      // Map 1: draft-adjusted final probability
      const pMap = Math.max(0.01, Math.min(0.99, result.finalWinProbability));
      // Maps 2+: prior only (draft unknown for subsequent maps)
      const pMapRest = Math.max(0.01, Math.min(0.99, teamStrength.priorBlue));
      const { data } = await api.post<MCResult>('/lol/golgg/predictor/simulate', {
        teamA: blueChamps.filter(Boolean)[0] || 'Blue',
        teamB: redChamps.filter(Boolean)[0] || 'Red',
        pMap,
        pMapRest,
        format: mcFormat,
        nSims: mcNSims,
      });
      setMcResult(data);
    } catch { /* empty */ }
    finally { setMcLoading(false); }
  }, [result, mcFormat, mcNSims, blueChamps, redChamps]);

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold text-white">Draft Analyzer</h1>
          </div>
          <p className="text-sm text-gray-400">
            Analyze pro drafts: champion tier, synergies, lane matchups (with scaling detection), player mastery.
          </p>
        </div>
        <Link href="/lol" className="text-sm text-gray-400 hover:text-gray-200 border border-gray-700 rounded-lg px-3 py-2">
          LoL Data
        </Link>
      </div>

      {/* Summary bar */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <div className="text-[10px] text-gray-500 mb-0.5">Pro Games</div>
            <div className="text-lg font-bold text-white">{summary.games.toLocaleString()}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <div className="text-[10px] text-gray-500 mb-0.5">Champions</div>
            <div className="text-lg font-bold text-blue-400">{summary.uniqueChampions}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <div className="text-[10px] text-gray-500 mb-0.5">Players</div>
            <div className="text-lg font-bold text-purple-400">{summary.uniquePlayers.toLocaleString()}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <div className="text-[10px] text-gray-500 mb-0.5">Recent Patches</div>
            <div className="text-sm font-mono text-green-400">{summary.recentPatches.slice(0, 3).join(', ')}</div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <div className="text-[10px] text-gray-500 mb-0.5">Weighting</div>
            <div className="text-[10px] font-mono text-yellow-400 leading-tight">{summary.weighting || `${summary.recentPatches.length} patches`}</div>
          </div>
        </div>
      )}

      <WeightsForm weights={weights} onChange={setWeights} onReset={resetWeights} />

      <ScoreMixForm mix={scoreMix} onChange={setScoreMix} onReset={resetScoreMix} />

      <TeamStrengthForm
        cfg={teamStrength}
        onChange={setTeamStrength}
        blueName={blueChamps.filter(Boolean)[0] ? `Blue (${blueChamps[0]})` : 'Blue'}
        redName={redChamps.filter(Boolean)[0] ? `Red (${redChamps[0]})` : 'Red'}
      />

      <div className="space-y-2">
        <div className="text-xs font-medium text-gray-400">Test presets (then Analyze)</div>
        <div className="flex flex-wrap gap-2">
          {DRAFT_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => loadPreset(p)}
              className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 transition-colors"
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* Draft input */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Blue side */}
        <div className="bg-gray-900 border border-blue-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-400" />
            <span className="text-sm font-semibold text-blue-300">Blue Side</span>
          </div>
          <div className="space-y-2">
            {POSITIONS.map((pos, i) => (
              <ChampInput
                key={pos}
                pos={pos}
                value={blueChamps[i]}
                onChange={(v) => updateChamp('blue', i, v)}
                player={bluePlayers[i]}
                onPlayerChange={(v) => updatePlayer('blue', i, v)}
                side="blue"
              />
            ))}
          </div>
        </div>

        {/* Red side */}
        <div className="bg-gray-900 border border-red-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
            <span className="text-sm font-semibold text-red-300">Red Side</span>
          </div>
          <div className="space-y-2">
            {POSITIONS.map((pos, i) => (
              <ChampInput
                key={pos}
                pos={pos}
                value={redChamps[i]}
                onChange={(v) => updateChamp('red', i, v)}
                player={redPlayers[i]}
                onPlayerChange={(v) => updatePlayer('red', i, v)}
                side="red"
              />
            ))}
          </div>
        </div>
      </div>

      {/* Buttons */}
      <div className="flex items-center gap-3">
        <button
          onClick={analyze}
          disabled={loading}
          className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm transition-colors disabled:opacity-50"
        >
          {loading ? 'Analyzing...' : 'Analyze Draft'}
        </button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Win probability header */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              {/* Blue */}
              <div className="text-center flex-1 space-y-1">
                <div className="text-xs text-blue-400 font-medium">Blue</div>
                <div className="text-3xl font-bold text-blue-400">{pct(result.finalWinProbability)}</div>
                <div className="space-y-0.5">
                  <div className="text-[10px] text-gray-500 font-mono">
                    prior <span className="text-violet-400">{pct(teamStrength.priorBlue)}</span>
                  </div>
                  {(() => {
                    const shift = result.finalWinProbability - teamStrength.priorBlue;
                    if (Math.abs(shift) < 0.001) return <div className="text-[10px] text-gray-600">draft: no change</div>;
                    return (
                      <div className={`text-[10px] font-mono font-medium ${shift > 0 ? 'text-green-400' : 'text-red-400'}`}>
                        draft {shift > 0 ? '+' : ''}{pct(shift)} shift
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Center */}
              <div className="text-center px-4 space-y-1.5">
                <div className={`text-xs font-bold px-3 py-1 rounded-full ${
                  result.advantage === 'BLUE' ? 'bg-blue-500/20 text-blue-300' :
                  result.advantage === 'RED' ? 'bg-red-500/20 text-red-300' :
                  'bg-gray-700/30 text-gray-400'
                }`}>
                  {result.advantage === 'EVEN' ? 'EVEN' : `${result.advantage} +${pct(result.advantageMargin)}`}
                </div>
                <div className="text-[10px] text-violet-400/80 font-mono">
                  draft impact ×{teamStrength.draftWeight.toFixed(2)}
                </div>
                <div className="text-[10px] text-gray-600">{result.gamesAnalyzed.toLocaleString()} games in DB</div>
                <div className="text-[10px] text-gray-600">patches: {result.patchesUsed.slice(0,3).join(', ')}</div>
                {result.weightsApplied && (
                  <div className="text-[10px] text-amber-400/90 font-mono max-w-[280px] mx-auto leading-tight">
                    T1×{result.weightsApplied.leagueTier1} T2×{result.weightsApplied.leagueTier2} T3×{result.weightsApplied.leagueTier3}
                    {' '}· {result.weightsApplied.anchorYear}×{result.weightsApplied.yearCurrent}
                  </div>
                )}
                {result.scoreMixApplied && (
                  <div className="text-[10px] text-cyan-400/90 font-mono max-w-[320px] mx-auto leading-tight">
                    {(result.scoreMixApplied.championTier * 100).toFixed(0)}% champ ·{' '}
                    {(result.scoreMixApplied.synergy * 100).toFixed(0)}% syn ·{' '}
                    {(result.scoreMixApplied.matchup * 100).toFixed(0)}% match ·{' '}
                    {(result.scoreMixApplied.mastery * 100).toFixed(0)}% mast
                  </div>
                )}
              </div>

              {/* Red */}
              <div className="text-center flex-1 space-y-1">
                <div className="text-xs text-red-400 font-medium">Red</div>
                <div className="text-3xl font-bold text-red-400">{pct(1 - result.finalWinProbability)}</div>
                <div className="space-y-0.5">
                  <div className="text-[10px] text-gray-500 font-mono">
                    prior <span className="text-violet-400">{pct(1 - teamStrength.priorBlue)}</span>
                  </div>
                  {(() => {
                    const shift = (1 - result.finalWinProbability) - (1 - teamStrength.priorBlue);
                    if (Math.abs(shift) < 0.001) return null;
                    return (
                      <div className={`text-[10px] font-mono font-medium ${shift > 0 ? 'text-green-400' : 'text-red-400'}`}>
                        draft {shift > 0 ? '+' : ''}{pct(shift)} shift
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>

            {/* Score breakdown bars */}
            <div className="space-y-3 mt-4 pt-4 border-t border-gray-800">
              <ScoreBar label="Champion Tier" blue={result.blue.championTier - 0.5} red={result.red.championTier - 0.5} description={result.dataWindows?.championWR ?? 'recent patches'} mixShare={result.scoreMixApplied?.championTier} />
              <ScoreBar label="Synergy" blue={result.blue.synergyScore} red={result.red.synergyScore} description={result.dataWindows?.synergiesMatchups ?? 'all data'} mixShare={result.scoreMixApplied?.synergy} />
              <ScoreBar label="Lane Matchups" blue={result.blue.matchupScore} red={result.red.matchupScore} description={result.dataWindows?.synergiesMatchups ?? 'all data'} mixShare={result.scoreMixApplied?.matchup} />
              <ScoreBar label="Player Mastery" blue={result.blue.masteryScore} red={result.red.masteryScore} description={result.dataWindows?.playerMastery ?? 'recent patches'} mixShare={result.scoreMixApplied?.mastery} />
            </div>
          </div>

          {/* Detail tabs */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="flex border-b border-gray-800">
              {(['overview', 'matchups', 'synergy', 'mastery'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 text-xs font-medium py-2.5 transition-colors capitalize ${
                    activeTab === tab
                      ? 'text-white bg-gray-800 border-b-2 border-blue-500'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {tab === 'overview' ? 'Champions' : tab}
                </button>
              ))}
            </div>

            <div className="p-0">
              {activeTab === 'overview' && (
                <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-800">
                  <div>
                    <div className="px-3 py-2 bg-blue-500/5 border-b border-blue-500/20">
                      <span className="text-xs font-semibold text-blue-300">Blue Champions</span>
                    </div>
                    <ChampTable champs={result.blue.components.champions} side="blue" />
                  </div>
                  <div>
                    <div className="px-3 py-2 bg-red-500/5 border-b border-red-500/20">
                      <span className="text-xs font-semibold text-red-300">Red Champions</span>
                    </div>
                    <ChampTable champs={result.red.components.champions} side="red" />
                  </div>
                </div>
              )}

              {activeTab === 'matchups' && (
                <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-800">
                  <div>
                    <div className="px-3 py-2 bg-blue-500/5 border-b border-blue-500/20">
                      <span className="text-xs font-semibold text-blue-300">Blue Lane Matchups</span>
                      <span className="text-[10px] text-gray-500 ml-2">SCALING = loses lane but wins game</span>
                    </div>
                    <MatchupTable matchups={result.blue.components.matchups} />
                  </div>
                  <div>
                    <div className="px-3 py-2 bg-red-500/5 border-b border-red-500/20">
                      <span className="text-xs font-semibold text-red-300">Red Lane Matchups</span>
                    </div>
                    <MatchupTable matchups={result.red.components.matchups} />
                  </div>
                </div>
              )}

              {activeTab === 'synergy' && (
                <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-800">
                  <div>
                    <div className="px-3 py-2 bg-blue-500/5 border-b border-blue-500/20">
                      <span className="text-xs font-semibold text-blue-300">Blue Synergy Pairs</span>
                      <span className="text-[10px] text-gray-500 ml-2">Lift = WR together − avg WR · Role pairs (top+jng, jng+mid, adc+sup) get 1.5× weight</span>
                    </div>
                    <SynergyTable synergies={result.blue.components.synergies} />
                  </div>
                  <div>
                    <div className="px-3 py-2 bg-red-500/5 border-b border-red-500/20">
                      <span className="text-xs font-semibold text-red-300">Red Synergy Pairs</span>
                    </div>
                    <SynergyTable synergies={result.red.components.synergies} />
                  </div>
                </div>
              )}

              {activeTab === 'mastery' && (
                <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-800">
                  <div>
                    <div className="px-3 py-2 bg-blue-500/5 border-b border-blue-500/20">
                      <span className="text-xs font-semibold text-blue-300">Blue Player Mastery</span>
                      <span className="text-[10px] text-gray-500 ml-2">Comfort 1.0 = best champ · ★ = signature · NO DATA = floor coeff (counts in average)</span>
                    </div>
                    <MasteryTable mastery={result.blue.components.mastery} />
                  </div>
                  <div>
                    <div className="px-3 py-2 bg-red-500/5 border-b border-red-500/20">
                      <span className="text-xs font-semibold text-red-300">Red Player Mastery</span>
                    </div>
                    <MasteryTable mastery={result.red.components.mastery} />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Monte Carlo Simulation ─────────────────────────────────── */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-white">Monte Carlo Simulation</div>
                <p className="text-[10px] text-gray-500 mt-0.5">
                  Runs series simulation using final win probability (prior + draft shift) as per-map win rate.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* Format selector */}
                <select
                  value={mcFormat}
                  onChange={(e) => setMcFormat(e.target.value as 'BO1' | 'BO3' | 'BO5')}
                  className="bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white"
                >
                  <option value="BO1">BO1</option>
                  <option value="BO3">BO3</option>
                  <option value="BO5">BO5</option>
                </select>
                {/* nSims selector */}
                <select
                  value={mcNSims}
                  onChange={(e) => setMcNSims(Number(e.target.value))}
                  className="bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white"
                >
                  <option value={30000}>30 000 sims</option>
                  <option value={100_000}>100 000 sims</option>
                  <option value={120_000}>120 000 sims</option>
                  <option value={200_000}>200 000 sims (max)</option>
                </select>
                <button
                  onClick={runMC}
                  disabled={mcLoading}
                  className="px-4 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium disabled:opacity-50 whitespace-nowrap"
                >
                  {mcLoading ? 'Simulating…' : `Run MC ×${mcNSims.toLocaleString()}`}
                </button>
              </div>
            </div>

            {/* pMap info */}
            <div className="text-[11px] text-gray-500 font-mono space-y-0.5">
              <div>
                <span className="text-gray-400">Map 1</span>{' '}
                <span className="text-violet-300 font-semibold">{pct(result.finalWinProbability)}</span>
                <span className="text-gray-700 ml-1">(prior + draft shift)</span>
              </div>
              <div>
                <span className="text-gray-400">Maps 2+</span>{' '}
                <span className="text-blue-300 font-semibold">{pct(teamStrength.priorBlue)}</span>
                <span className="text-gray-700 ml-1">(prior only — draft unknown)</span>
              </div>
            </div>

            {mcResult && (
              <div className="space-y-4">
                {/* Series win probability bar */}
                <div className="space-y-2">
                  <div className="flex h-9 rounded-lg overflow-hidden text-xs font-bold">
                    <div
                      className="bg-blue-600 flex items-center justify-center text-white transition-all"
                      style={{ width: `${mcResult.pSeriesWin * 100}%` }}
                    >
                      Blue {pct(mcResult.pSeriesWin)}
                    </div>
                    <div
                      className="bg-red-600 flex items-center justify-center text-white transition-all"
                      style={{ width: `${(1 - mcResult.pSeriesWin) * 100}%` }}
                    >
                      Red {pct(1 - mcResult.pSeriesWin)}
                    </div>
                  </div>
                  <div className="flex justify-between text-[10px] text-gray-500 font-mono">
                    <span>
                      {mcResult.nSims.toLocaleString()} sims in {mcResult.elapsedMs}ms
                      {' · '}Map 1 <span className="text-violet-300">{pct(mcResult.pMap)}</span>
                      {' · '}Maps 2+ <span className="text-blue-300">{pct(mcResult.pMapRest)}</span>
                    </span>
                    <span>Avg maps: {mcResult.avgMaps.toFixed(2)}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Score distribution chart */}
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-gray-300">Score Distribution</div>
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart
                        data={Object.entries(mcResult.scoreDistribution)
                          .sort(([a], [b]) => a.localeCompare(b))
                          .map(([score, prob]) => ({ score, prob: Math.round(prob * 1000) / 10 }))}
                        margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
                      >
                        <XAxis dataKey="score" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                        <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} unit="%" />
                        <Tooltip
                          contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8 }}
                          labelStyle={{ color: '#fff', fontWeight: 600 }}
                          formatter={(v: number) => [`${v}%`, 'Probability']}
                        />
                        <Bar dataKey="prob" radius={[4, 4, 0, 0]}>
                          {Object.entries(mcResult.scoreDistribution)
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([score], i) => {
                              const [a, b] = score.split('-').map(Number);
                              return <Cell key={i} fill={a > b ? '#3b82f6' : '#ef4444'} />;
                            })}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Derived markets — Polymarket comparison */}
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-gray-300">Derived Markets (Polymarket lines)</div>
                    <div className="space-y-1.5 text-xs">
                      <div className="flex justify-between items-center py-1 border-b border-gray-800">
                        <span className="text-gray-400">Blue wins series</span>
                        <span className="font-mono font-semibold text-blue-400">{pct(mcResult.pSeriesWin)}</span>
                      </div>
                      <div className="flex justify-between items-center py-1 border-b border-gray-800">
                        <span className="text-gray-400">Red wins series</span>
                        <span className="font-mono font-semibold text-red-400">{pct(1 - mcResult.pSeriesWin)}</span>
                      </div>
                      {Object.entries(mcResult.pOver).map(([threshold, p]) => (
                        <div key={threshold} className="flex justify-between items-center py-1 border-b border-gray-800/50">
                          <span className="text-gray-400">Total maps over {threshold}</span>
                          <span className="font-mono text-white">{pct(p)}</span>
                        </div>
                      ))}
                      {Object.entries(mcResult.pHandicap).map(([margin, p]) => (
                        <div key={margin} className="flex justify-between items-center py-1 border-b border-gray-800/50">
                          <span className="text-gray-400">Blue handicap {margin}</span>
                          <span className="font-mono text-white">{pct(p)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {!mcResult && !mcLoading && (
              <div className="text-[11px] text-gray-600 text-center py-4">
                Click "Run MC" to simulate the series and see score distribution + Polymarket line probabilities.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import api from '@/lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

type DragonType = 'infernal' | 'mountain' | 'ocean' | 'hextech' | 'chemtech' | 'cloud';

interface ObjectiveBreakdown {
  firstDragon: number;
  dragonCount: number;
  dragonSoul: number;
  elder: number;
  firstBaron: number;
  baronCount: number;
  firstHerald: number;
  heraldCount: number;
  grubAdvantage: number;
  towerDiff: number;
}

interface LivePrediction {
  pBlue: number;
  breakdown: {
    draftBaseline: number;
    goldWR: number;
    goldShift: number;
    objectiveShift: number;
    scalingShift: number;
    objectives: ObjectiveBreakdown;
  };
  minute: number;
}

interface GoldCurvePoint {
  goldDiffBucket: number;
  blueWinRate: number;
  games: number;
}

interface GoldCurveData {
  minute: number;
  points: GoldCurvePoint[];
}

interface DraftData {
  blueChamps: string[];
  redChamps: string[];
  bluePlayers: string[];
  redPlayers: string[];
  pMap: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DRAGON_TYPES: DragonType[] = ['infernal', 'mountain', 'ocean', 'hextech', 'chemtech', 'cloud'];

const DRAGON_COLORS: Record<DragonType, string> = {
  infernal: 'bg-red-500/20 text-red-400 border-red-500/30',
  mountain: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  ocean: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  hextech: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
  chemtech: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  cloud: 'bg-gray-400/20 text-gray-300 border-gray-400/30',
};

const DRAGON_LABELS: Record<DragonType, string> = {
  infernal: 'INF', mountain: 'MTN', ocean: 'OCN', hextech: 'HEX', chemtech: 'CHM', cloud: 'CLD',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pct(v: number) { return `${(v * 100).toFixed(1)}%`; }
function signedPct(v: number) { const s = (v * 100).toFixed(1); return v >= 0 ? `+${s}%` : `${s}%`; }
function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

// ─── Sub-components ──────────────────────────────────────────────────────────

function WinBar({ pBlue }: { pBlue: number }) {
  const bluePct = Math.round(pBlue * 1000) / 10;
  const redPct = Math.round((1 - pBlue) * 1000) / 10;
  const favors = pBlue > 0.505 ? 'blue' : pBlue < 0.495 ? 'red' : 'even';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm font-bold">
        <span className={favors === 'blue' ? 'text-blue-400 text-lg' : 'text-blue-400/60'}>{bluePct}%</span>
        <span className="text-gray-500 text-xs">WIN PROBABILITY</span>
        <span className={favors === 'red' ? 'text-red-400 text-lg' : 'text-red-400/60'}>{redPct}%</span>
      </div>
      <div className="h-5 rounded-full overflow-hidden flex bg-gray-800">
        <div
          className="h-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-300"
          style={{ width: `${bluePct}%` }}
        />
        <div
          className="h-full bg-gradient-to-r from-red-400 to-red-600 transition-all duration-300"
          style={{ width: `${redPct}%` }}
        />
      </div>
    </div>
  );
}

function NumberStepper({
  value, onChange, min, max, step, label, className = '', size = 'md',
}: {
  value: number; onChange: (v: number) => void;
  min: number; max: number; step: number;
  label: string; className?: string;
  size?: 'sm' | 'md';
}) {
  const sz = size === 'sm' ? 'text-xs px-1.5 py-0.5' : 'text-sm px-2 py-1';
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <span className="text-[10px] text-gray-500 w-10 shrink-0">{label}</span>
      <button
        onClick={() => onChange(clamp(value - step, min, max))}
        className={`${sz} bg-gray-800 hover:bg-gray-700 rounded text-gray-300 font-mono transition-colors`}
      >-</button>
      <input
        type="number"
        value={value}
        onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(clamp(v, min, max)); }}
        className={`${sz} bg-gray-950 border border-gray-700 rounded text-center font-mono text-white w-20`}
      />
      <button
        onClick={() => onChange(clamp(value + step, min, max))}
        className={`${sz} bg-gray-800 hover:bg-gray-700 rounded text-gray-300 font-mono transition-colors`}
      >+</button>
    </div>
  );
}

function DragonRow({
  dragons, onAdd, onRemove, label, side,
}: {
  dragons: DragonType[]; onAdd: (t: DragonType) => void; onRemove: (i: number) => void;
  label: string; side: 'blue' | 'red';
}) {
  const [showPicker, setShowPicker] = useState(false);
  const color = side === 'blue' ? 'text-blue-400' : 'text-red-400';

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={`text-[10px] font-medium ${color} w-10 shrink-0`}>{label}</span>
      {dragons.map((d, i) => (
        <button
          key={`${d}-${i}`}
          onClick={() => onRemove(i)}
          className={`text-[10px] px-1.5 py-0.5 rounded border ${DRAGON_COLORS[d]} hover:opacity-70 transition-opacity`}
          title="Click to remove"
        >
          {DRAGON_LABELS[d]}
        </button>
      ))}
      {dragons.length < 4 && (
        <div className="relative">
          <button
            onClick={() => setShowPicker(!showPicker)}
            className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-white transition-colors"
          >+</button>
          {showPicker && (
            <div className="absolute z-10 top-full left-0 mt-1 bg-gray-900 border border-gray-700 rounded-lg p-1 flex gap-1 shadow-xl">
              {DRAGON_TYPES.map(t => (
                <button
                  key={t}
                  onClick={() => { onAdd(t); setShowPicker(false); }}
                  className={`text-[10px] px-1.5 py-1 rounded border ${DRAGON_COLORS[t]} hover:opacity-80`}
                >
                  {DRAGON_LABELS[t]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FactorRow({ label, value, tip }: { label: string; value: number; tip?: string }) {
  const color = value > 0.005 ? 'text-blue-400' : value < -0.005 ? 'text-red-400' : 'text-gray-500';
  return (
    <div className="flex items-center justify-between text-xs py-0.5" title={tip}>
      <span className="text-gray-400">{label}</span>
      <span className={`font-mono ${color}`}>{signedPct(value)}</span>
    </div>
  );
}

function GoldCurveChart({ curves, currentMinute, currentGold }: {
  curves: GoldCurveData[];
  currentMinute: number;
  currentGold: number;
}) {
  const nearest = useMemo(() => {
    if (curves.length === 0) return null;
    let best = curves[0];
    for (const c of curves) {
      if (Math.abs(c.minute - currentMinute) < Math.abs(best.minute - currentMinute)) best = c;
    }
    return best;
  }, [curves, currentMinute]);

  if (!nearest || nearest.points.length < 2) return null;

  const data = nearest.points.map(p => ({
    gold: p.goldDiffBucket,
    wr: Math.round(p.blueWinRate * 1000) / 10,
  }));

  return (
    <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-3">
      <div className="text-[10px] text-gray-500 mb-2">
        Gold diff &rarr; Win% (closest: {nearest.minute}min)
      </div>
      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <XAxis dataKey="gold" stroke="#4b5563" tick={{ fontSize: 9 }} tickFormatter={v => v > 0 ? `+${(v / 1000).toFixed(0)}k` : `${(v / 1000).toFixed(0)}k`} />
            <YAxis domain={[10, 90]} stroke="#4b5563" tick={{ fontSize: 9 }} tickFormatter={v => `${v}%`} />
            <Tooltip
              contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 10 }}
              formatter={(v: number) => [`${v}%`, 'Blue WR']}
              labelFormatter={(l: number) => `Gold diff: ${l > 0 ? '+' : ''}${l}`}
            />
            <ReferenceLine y={50} stroke="#4b5563" strokeDasharray="3 3" />
            <ReferenceLine x={currentGold} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: 'NOW', fontSize: 9, fill: '#f59e0b' }} />
            <Line type="monotone" dataKey="wr" stroke="#60a5fa" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LivePredictorPage() {
  // Draft baseline
  const [draftPMap, setDraftPMap] = useState<number | null>(null);
  const [blueChamps, setBlueChamps] = useState<string[]>([]);
  const [redChamps, setRedChamps] = useState<string[]>([]);

  // Game state
  const [minute, setMinute] = useState(0);
  const [goldDiff, setGoldDiff] = useState(0);
  const [showLaneGold, setShowLaneGold] = useState(false);
  const [laneGold, setLaneGold] = useState({ top: 0, jng: 0, mid: 0, bot: 0, sup: 0 });

  // Objectives
  const [blueDragons, setBlueDragons] = useState<DragonType[]>([]);
  const [redDragons, setRedDragons] = useState<DragonType[]>([]);
  const [blueSoul, setBlueSoul] = useState(false);
  const [redSoul, setRedSoul] = useState(false);
  const [blueElder, setBlueElder] = useState(0);
  const [redElder, setRedElder] = useState(0);
  const [blueGrubs, setBlueGrubs] = useState(0);
  const [redGrubs, setRedGrubs] = useState(0);
  const [blueHerald, setBlueHerald] = useState(0);
  const [redHerald, setRedHerald] = useState(0);
  const [blueBaron, setBlueBaron] = useState(0);
  const [redBaron, setRedBaron] = useState(0);
  const [blueTowers, setBlueTowers] = useState(0);
  const [redTowers, setRedTowers] = useState(0);

  // Results
  const [prediction, setPrediction] = useState<LivePrediction | null>(null);
  const [goldCurves, setGoldCurves] = useState<GoldCurveData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // History for chart
  const [history, setHistory] = useState<Array<{ min: number; pBlue: number }>>([]);

  // Load gold curves on mount
  useEffect(() => {
    api.get('/lol/live/gold-curves').then(r => setGoldCurves(r.data)).catch(() => {});
  }, []);

  // Load draft from localStorage
  const loadDraft = useCallback(() => {
    try {
      const raw = localStorage.getItem('lol-draft-live');
      if (!raw) { setError('No draft data in localStorage'); return; }
      const data: DraftData = JSON.parse(raw);
      setBlueChamps(data.blueChamps ?? []);
      setRedChamps(data.redChamps ?? []);
      setDraftPMap(data.pMap ?? null);
      setError('');
    } catch { setError('Failed to parse draft data'); }
  }, []);

  // Auto-predict on any state change
  const predict = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = {
        blueChamps,
        redChamps,
        minute,
        goldDiffTotal: showLaneGold
          ? Object.values(laneGold).reduce((a, b) => a + b, 0)
          : goldDiff,
        goldDiffByLane: showLaneGold ? laneGold : undefined,
        blueDragons,
        redDragons,
        blueDragonSoul: blueSoul,
        redDragonSoul: redSoul,
        blueElderDragon: blueElder,
        redElderDragon: redElder,
        blueVoidgrubs: blueGrubs,
        redVoidgrubs: redGrubs,
        blueHerald,
        redHerald,
        blueBaron,
        redBaron,
        blueTowersDestroyed: blueTowers,
        redTowersDestroyed: redTowers,
        draftPMap,
      };
      const res = await api.post('/lol/live/predict', body);
      setPrediction(res.data);
      setHistory(prev => {
        const next = [...prev.filter(h => h.min !== minute), { min: minute, pBlue: res.data.pBlue }];
        return next.sort((a, b) => a.min - b.min);
      });
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Prediction failed');
    } finally {
      setLoading(false);
    }
  }, [
    blueChamps, redChamps, minute, goldDiff, showLaneGold, laneGold,
    blueDragons, redDragons, blueSoul, redSoul, blueElder, redElder,
    blueGrubs, redGrubs, blueHerald, redHerald, blueBaron, redBaron,
    blueTowers, redTowers, draftPMap,
  ]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(predict, 150);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [predict]);

  const resetAll = () => {
    setMinute(0); setGoldDiff(0); setShowLaneGold(false);
    setLaneGold({ top: 0, jng: 0, mid: 0, bot: 0, sup: 0 });
    setBlueDragons([]); setRedDragons([]);
    setBlueSoul(false); setRedSoul(false);
    setBlueElder(0); setRedElder(0);
    setBlueGrubs(0); setRedGrubs(0);
    setBlueHerald(0); setRedHerald(0);
    setBlueBaron(0); setRedBaron(0);
    setBlueTowers(0); setRedTowers(0);
    setHistory([]);
  };

  const bd = prediction?.breakdown;
  const totalGold = showLaneGold ? Object.values(laneGold).reduce((a, b) => a + b, 0) : goldDiff;

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-white">Live Predictor</h1>
            {loading && <span className="text-[10px] text-yellow-400 animate-pulse">updating...</span>}
          </div>
          <p className="text-xs text-gray-500">Real-time win probability based on draft + game state</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/lol/draft" className="text-xs text-gray-400 hover:text-gray-200 border border-gray-700 rounded-lg px-3 py-1.5 transition-colors">
            Draft
          </Link>
          <button onClick={loadDraft} className="text-xs bg-purple-600 hover:bg-purple-500 text-white px-3 py-1.5 rounded-lg transition-colors">
            Load Draft
          </button>
          <button onClick={resetAll} className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 px-3 py-1.5 rounded-lg transition-colors">
            Reset
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/40 rounded-lg px-3 py-2 text-xs text-red-300">{error}</div>
      )}

      {/* Win probability bar */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <WinBar pBlue={prediction?.pBlue ?? 0.5} />
        {/* Draft info pill */}
        {draftPMap != null && (
          <div className="mt-2 flex items-center gap-2 text-[10px] text-gray-500">
            <span>Draft baseline: <span className="text-blue-400 font-mono">{pct(draftPMap)}</span></span>
            {blueChamps.length > 0 && (
              <span className="text-gray-600">
                {blueChamps.filter(Boolean).join(', ')} vs {redChamps.filter(Boolean).join(', ')}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Left: Controls (3 cols) */}
        <div className="lg:col-span-3 space-y-3">
          {/* Minute + Gold */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Game State</div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-gray-500">Minute</span>
                  <span className="text-lg font-bold text-white font-mono">{minute}</span>
                </div>
                <input
                  type="range" min={0} max={60} value={minute}
                  onChange={e => setMinute(parseInt(e.target.value))}
                  className="w-full h-2 rounded-full appearance-none bg-gray-700 accent-cyan-500 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-gray-600">
                  <span>0</span><span>15</span><span>30</span><span>45</span><span>60</span>
                </div>
              </div>
              <div className="space-y-1">
                <NumberStepper
                  label="Gold"
                  value={showLaneGold ? totalGold : goldDiff}
                  onChange={v => { if (!showLaneGold) setGoldDiff(v); }}
                  min={-30000} max={30000} step={500}
                />
                <div className="flex items-center gap-2 mt-1">
                  <button
                    onClick={() => setShowLaneGold(!showLaneGold)}
                    className={`text-[9px] px-2 py-0.5 rounded border transition-colors ${
                      showLaneGold ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' : 'bg-gray-800 text-gray-500 border-gray-700'
                    }`}
                  >
                    {showLaneGold ? 'By Lane ON' : 'By Lane'}
                  </button>
                  {showLaneGold && (
                    <span className="text-[9px] text-gray-600 font-mono">Total: {totalGold > 0 ? '+' : ''}{totalGold}</span>
                  )}
                </div>
              </div>
            </div>

            {showLaneGold && (
              <div className="grid grid-cols-5 gap-2 pt-2 border-t border-gray-800">
                {(['top', 'jng', 'mid', 'bot', 'sup'] as const).map(lane => (
                  <div key={lane} className="space-y-0.5">
                    <span className="text-[9px] text-gray-500 uppercase">{lane}</span>
                    <input
                      type="number" step={100}
                      value={laneGold[lane]}
                      onChange={e => {
                        const v = parseInt(e.target.value);
                        if (Number.isFinite(v)) setLaneGold(prev => ({ ...prev, [lane]: v }));
                      }}
                      className="w-full bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-white font-mono text-center"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Objectives */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Objectives</div>

            {/* Dragons */}
            <div className="space-y-1.5">
              <div className="text-[10px] text-gray-600">Dragons</div>
              <DragonRow label="BLUE" side="blue" dragons={blueDragons}
                onAdd={t => setBlueDragons([...blueDragons, t])}
                onRemove={i => setBlueDragons(blueDragons.filter((_, idx) => idx !== i))}
              />
              <DragonRow label="RED" side="red" dragons={redDragons}
                onAdd={t => setRedDragons([...redDragons, t])}
                onRemove={i => setRedDragons(redDragons.filter((_, idx) => idx !== i))}
              />
              <div className="flex items-center gap-4 pt-1">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={blueSoul} onChange={e => { setBlueSoul(e.target.checked); if (e.target.checked) setRedSoul(false); }}
                    className="w-3 h-3 rounded bg-gray-800 border-gray-600 accent-blue-500" />
                  <span className="text-[10px] text-blue-400">Blue Soul</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={redSoul} onChange={e => { setRedSoul(e.target.checked); if (e.target.checked) setBlueSoul(false); }}
                    className="w-3 h-3 rounded bg-gray-800 border-gray-600 accent-red-500" />
                  <span className="text-[10px] text-red-400">Red Soul</span>
                </label>
              </div>
            </div>

            {/* Grid of other objectives */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 pt-2 border-t border-gray-800">
              {/* Elder */}
              <NumberStepper label="Elder B" value={blueElder} onChange={setBlueElder} min={0} max={3} step={1} size="sm" />
              <NumberStepper label="Elder R" value={redElder} onChange={setRedElder} min={0} max={3} step={1} size="sm" />

              {/* Grubs */}
              <NumberStepper label="Grubs B" value={blueGrubs} onChange={setBlueGrubs} min={0} max={6} step={1} size="sm" />
              <NumberStepper label="Grubs R" value={redGrubs} onChange={setRedGrubs} min={0} max={6} step={1} size="sm" />

              {/* Herald */}
              <NumberStepper label="Herld B" value={blueHerald} onChange={setBlueHerald} min={0} max={2} step={1} size="sm" />
              <NumberStepper label="Herld R" value={redHerald} onChange={setRedHerald} min={0} max={2} step={1} size="sm" />

              {/* Baron */}
              <NumberStepper label="Baron B" value={blueBaron} onChange={setBlueBaron} min={0} max={4} step={1} size="sm" />
              <NumberStepper label="Baron R" value={redBaron} onChange={setRedBaron} min={0} max={4} step={1} size="sm" />

              {/* Towers */}
              <NumberStepper label="Towrs B" value={blueTowers} onChange={setBlueTowers} min={0} max={11} step={1} size="sm" />
              <NumberStepper label="Towrs R" value={redTowers} onChange={setRedTowers} min={0} max={11} step={1} size="sm" />
            </div>
          </div>
        </div>

        {/* Right: Breakdown (2 cols) */}
        <div className="lg:col-span-2 space-y-3">
          {/* Factor breakdown */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
            <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Probability Breakdown</div>

            {bd ? (
              <>
                <div className="space-y-0.5">
                  <FactorRow label="Draft Baseline" value={bd.draftBaseline - 0.5} tip="Draft analysis pMap - 50%" />
                  <FactorRow label="Gold Impact" value={bd.goldShift} tip={`Gold WR at ${minute}min: ${pct(bd.goldWR)}`} />
                  <FactorRow label="Objectives" value={bd.objectiveShift} />
                  <FactorRow label="Scaling" value={bd.scalingShift} />
                </div>
                <div className="border-t border-gray-800 pt-1">
                  <div className="flex items-center justify-between text-sm font-bold">
                    <span className="text-gray-300">Final</span>
                    <span className={prediction!.pBlue > 0.5 ? 'text-blue-400' : 'text-red-400'}>
                      {pct(prediction!.pBlue)}
                    </span>
                  </div>
                </div>

                {/* Objective detail */}
                <div className="pt-2 border-t border-gray-800 space-y-0.5">
                  <div className="text-[9px] text-gray-600 uppercase">Objective Detail</div>
                  {Object.entries(bd.objectives)
                    .filter(([, v]) => Math.abs(v) > 0.0001)
                    .map(([key, val]) => (
                      <FactorRow key={key} label={key.replace(/([A-Z])/g, ' $1').trim()} value={val} />
                    ))}
                  {Object.values(bd.objectives).every(v => Math.abs(v) < 0.0001) && (
                    <div className="text-[10px] text-gray-600 italic">No objective impact yet</div>
                  )}
                </div>
              </>
            ) : (
              <div className="text-xs text-gray-600 italic py-4">Calculating...</div>
            )}
          </div>

          {/* Gold curve chart */}
          <GoldCurveChart curves={goldCurves} currentMinute={minute} currentGold={totalGold} />

          {/* Probability history */}
          {history.length >= 2 && (
            <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-3">
              <div className="text-[10px] text-gray-500 mb-2">Win% over time</div>
              <div className="h-28">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history}>
                    <XAxis dataKey="min" stroke="#4b5563" tick={{ fontSize: 9 }} tickFormatter={v => `${v}m`} />
                    <YAxis domain={[0, 1]} stroke="#4b5563" tick={{ fontSize: 9 }} tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                    <Tooltip
                      contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 10 }}
                      formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, 'Blue WR']}
                      labelFormatter={l => `Min ${l}`}
                    />
                    <ReferenceLine y={0.5} stroke="#4b5563" strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="pBlue" stroke="#60a5fa" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

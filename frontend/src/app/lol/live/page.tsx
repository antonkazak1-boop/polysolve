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
  firstDragon: number; dragonCount: number; dragonSoul: number; elder: number;
  firstBaron: number; baronCount: number; firstHerald: number; heraldCount: number;
  grubAdvantage: number; towerDiff: number;
}

interface LivePrediction {
  pBlue: number;
  breakdown: {
    draftBaseline: number; goldWR: number; goldShift: number;
    objectiveShift: number; killShift: number; scalingShift: number;
    objectives: ObjectiveBreakdown;
  };
  minute: number;
}

interface GoldCurvePoint { goldDiffBucket: number; blueWinRate: number; games: number; }
interface GoldCurveData { minute: number; points: GoldCurvePoint[]; }

interface DraftData {
  blueChamps: string[]; redChamps: string[];
  bluePlayers: string[]; redPlayers: string[];
  pMap: number;
  mapIndex?: number;
  seriesFormat?: string;
  seriesScore?: { blue: number; red: number };
}

interface GameState {
  minute: number;
  goldDiff: number;
  killDiff: number;
  showLaneGold: boolean;
  laneGold: { top: number; jng: number; mid: number; bot: number; sup: number };
  blueDragons: DragonType[]; redDragons: DragonType[];
  blueSoul: boolean; redSoul: boolean;
  blueElder: number; redElder: number;
  blueGrubs: number; redGrubs: number;
  blueHerald: number; redHerald: number;
  blueBaron: number; redBaron: number;
  blueTowers: number; redTowers: number;
}

interface LiveSession {
  id: string;
  name: string;
  createdAt: number;
  draft: DraftData | null;
  state: GameState;
  history: Array<{ min: number; pBlue: number }>;
  lastPrediction: LivePrediction | null;
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
const LS_SESSIONS = 'lol-live-sessions';
const LS_ACTIVE = 'lol-live-active';
const LS_DRAFT = 'lol-draft-live';

function emptyState(): GameState {
  return {
    minute: 0, goldDiff: 0, killDiff: 0, showLaneGold: false,
    laneGold: { top: 0, jng: 0, mid: 0, bot: 0, sup: 0 },
    blueDragons: [], redDragons: [], blueSoul: false, redSoul: false,
    blueElder: 0, redElder: 0, blueGrubs: 0, redGrubs: 0,
    blueHerald: 0, redHerald: 0, blueBaron: 0, redBaron: 0,
    blueTowers: 0, redTowers: 0,
  };
}

function newSession(name: string, draft: DraftData | null): LiveSession {
  return {
    id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name, createdAt: Date.now(), draft,
    state: emptyState(), history: [], lastPrediction: null,
  };
}

function loadSessions(): LiveSession[] {
  try {
    const raw: LiveSession[] = JSON.parse(localStorage.getItem(LS_SESSIONS) || '[]');
    return raw.map(s => ({
      ...s,
      state: { ...emptyState(), ...s.state },
    }));
  } catch { return []; }
}
function saveSessions(sessions: LiveSession[]) {
  try { localStorage.setItem(LS_SESSIONS, JSON.stringify(sessions)); } catch { /* */ }
}
function loadActiveId(): string | null {
  try { return localStorage.getItem(LS_ACTIVE); } catch { return null; }
}
function saveActiveId(id: string) {
  try { localStorage.setItem(LS_ACTIVE, id); } catch { /* */ }
}
function loadDraft(): DraftData | null {
  try { const r = localStorage.getItem(LS_DRAFT); return r ? JSON.parse(r) : null; } catch { return null; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pct(v: number) { return `${(v * 100).toFixed(1)}%`; }
function signedPct(v: number) { const s = (v * 100).toFixed(1); return v >= 0 ? `+${s}%` : `${s}%`; }
function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }
function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${d.toLocaleDateString('ru', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

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
        <div className="h-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-300" style={{ width: `${bluePct}%` }} />
        <div className="h-full bg-gradient-to-r from-red-400 to-red-600 transition-all duration-300" style={{ width: `${redPct}%` }} />
      </div>
    </div>
  );
}

function NumberStepper({ value, onChange, min, max, step, label, size = 'md' }: {
  value: number; onChange: (v: number) => void;
  min: number; max: number; step: number; label: string; size?: 'sm' | 'md';
}) {
  const sz = size === 'sm' ? 'text-xs px-1.5 py-0.5' : 'text-sm px-2 py-1';
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-gray-500 w-10 shrink-0">{label}</span>
      <button onClick={() => onChange(clamp(value - step, min, max))} className={`${sz} bg-gray-800 hover:bg-gray-700 rounded text-gray-300 font-mono transition-colors`}>-</button>
      <input type="number" value={value} onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(clamp(v, min, max)); }}
        className={`${sz} bg-gray-950 border border-gray-700 rounded text-center font-mono text-white w-20`} />
      <button onClick={() => onChange(clamp(value + step, min, max))} className={`${sz} bg-gray-800 hover:bg-gray-700 rounded text-gray-300 font-mono transition-colors`}>+</button>
    </div>
  );
}

function DragonRow({ dragons, onAdd, onRemove, label, side }: {
  dragons: DragonType[]; onAdd: (t: DragonType) => void; onRemove: (i: number) => void;
  label: string; side: 'blue' | 'red';
}) {
  const [showPicker, setShowPicker] = useState(false);
  const color = side === 'blue' ? 'text-blue-400' : 'text-red-400';
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={`text-[10px] font-medium ${color} w-10 shrink-0`}>{label}</span>
      {dragons.map((d, i) => (
        <button key={`${d}-${i}`} onClick={() => onRemove(i)}
          className={`text-[10px] px-1.5 py-0.5 rounded border ${DRAGON_COLORS[d]} hover:opacity-70 transition-opacity`} title="Click to remove">
          {DRAGON_LABELS[d]}
        </button>
      ))}
      {dragons.length < 4 && (
        <div className="relative">
          <button onClick={() => setShowPicker(!showPicker)}
            className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-white transition-colors">+</button>
          {showPicker && (
            <div className="absolute z-10 top-full left-0 mt-1 bg-gray-900 border border-gray-700 rounded-lg p-1 flex gap-1 shadow-xl">
              {DRAGON_TYPES.map(t => (
                <button key={t} onClick={() => { onAdd(t); setShowPicker(false); }}
                  className={`text-[10px] px-1.5 py-1 rounded border ${DRAGON_COLORS[t]} hover:opacity-80`}>{DRAGON_LABELS[t]}</button>
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

function GoldCurveChart({ curves, currentMinute, currentGold }: { curves: GoldCurveData[]; currentMinute: number; currentGold: number; }) {
  const nearest = useMemo(() => {
    if (!curves.length) return null;
    let best = curves[0];
    for (const c of curves) if (Math.abs(c.minute - currentMinute) < Math.abs(best.minute - currentMinute)) best = c;
    return best;
  }, [curves, currentMinute]);
  if (!nearest || nearest.points.length < 2) return null;
  const data = nearest.points.map(p => ({ gold: p.goldDiffBucket, wr: Math.round(p.blueWinRate * 1000) / 10 }));
  return (
    <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-3">
      <div className="text-[10px] text-gray-500 mb-2">Gold diff &rarr; Win% (closest: {nearest.minute}min)</div>
      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <XAxis dataKey="gold" stroke="#4b5563" tick={{ fontSize: 9 }} tickFormatter={v => v > 0 ? `+${(v / 1000).toFixed(0)}k` : `${(v / 1000).toFixed(0)}k`} />
            <YAxis domain={[10, 90]} stroke="#4b5563" tick={{ fontSize: 9 }} tickFormatter={v => `${v}%`} />
            <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 10 }} formatter={(v: number) => [`${v}%`, 'Blue WR']} labelFormatter={(l: number) => `Gold diff: ${l > 0 ? '+' : ''}${l}`} />
            <ReferenceLine y={50} stroke="#4b5563" strokeDasharray="3 3" />
            <ReferenceLine x={currentGold} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: 'NOW', fontSize: 9, fill: '#f59e0b' }} />
            <Line type="monotone" dataKey="wr" stroke="#60a5fa" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function BaronTimer() {
  const BARON_DURATION = 180;
  const [running, setRunning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(BARON_DURATION);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!running) return;
    intervalRef.current = setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(intervalRef.current);
          setRunning(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  }, [running]);

  const start = () => { setSecondsLeft(BARON_DURATION); setRunning(true); };
  const stop = () => { setRunning(false); clearInterval(intervalRef.current); };
  const reset = () => { stop(); setSecondsLeft(BARON_DURATION); };

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const pct = secondsLeft / BARON_DURATION;
  const urgency = pct < 0.33 ? 'text-red-400' : pct < 0.66 ? 'text-yellow-400' : 'text-purple-400';

  return (
    <div className="bg-gray-900/80 border border-purple-500/20 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-purple-400 font-medium uppercase tracking-wide">Baron Timer</span>
        <span className={`text-lg font-mono font-bold ${running ? urgency : 'text-gray-500'}`}>
          {mins}:{secs.toString().padStart(2, '0')}
        </span>
      </div>
      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full transition-all duration-1000 rounded-full ${pct < 0.33 ? 'bg-red-500' : pct < 0.66 ? 'bg-yellow-500' : 'bg-purple-500'}`}
          style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="flex items-center gap-1.5">
        {!running ? (
          <button onClick={start} className="text-[10px] px-2.5 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white transition-colors">
            {secondsLeft < BARON_DURATION ? 'Restart' : 'Start'}
          </button>
        ) : (
          <button onClick={stop} className="text-[10px] px-2.5 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors">
            Pause
          </button>
        )}
        {running && (
          <button onClick={reset} className="text-[10px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors">
            Reset
          </button>
        )}
        {secondsLeft === 0 && !running && (
          <span className="text-[10px] text-red-400 font-medium animate-pulse">Baron expired!</span>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LivePredictorPage() {
  // Sessions
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');

  // Shared
  const [goldCurves, setGoldCurves] = useState<GoldCurveData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const prevDraftRef = useRef<string>('');

  // ─── Init: load sessions, auto-load draft ────────────────────────────────
  useEffect(() => {
    api.get('/lol/live/gold-curves').then(r => setGoldCurves(r.data)).catch(() => {});

    let stored = loadSessions();
    const savedActiveId = loadActiveId();
    const draft = loadDraft();

    if (stored.length === 0) {
      const s = newSession('Match 1', draft);
      stored = [s];
      saveSessions(stored);
      saveActiveId(s.id);
    }

    setSessions(stored);
    setActiveId(savedActiveId && stored.find(s => s.id === savedActiveId) ? savedActiveId : stored[0].id);
    if (draft) prevDraftRef.current = JSON.stringify(draft);
  }, []);

  // ─── Auto-detect draft changes from draft page ────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const draft = loadDraft();
      if (!draft) return;
      const key = JSON.stringify(draft);
      if (key !== prevDraftRef.current) {
        prevDraftRef.current = key;
        setSessions(prev => {
          const idx = prev.findIndex(s => s.id === activeId);
          if (idx < 0) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], draft };
          saveSessions(next);
          return next;
        });
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [activeId]);

  // ─── Active session helpers ───────────────────────────────────────────────
  const session = sessions.find(s => s.id === activeId) ?? sessions[0];
  const st = session?.state ?? emptyState();
  const draft = session?.draft ?? null;
  const history = session?.history ?? [];
  const prediction = session?.lastPrediction ?? null;

  const updateSession = useCallback((patch: Partial<LiveSession>) => {
    setSessions(prev => {
      const next = prev.map(s => s.id === activeId ? { ...s, ...patch } : s);
      saveSessions(next);
      return next;
    });
  }, [activeId]);

  const updateState = useCallback((patch: Partial<GameState>) => {
    setSessions(prev => {
      const next = prev.map(s => s.id === activeId ? { ...s, state: { ...s.state, ...patch } } : s);
      saveSessions(next);
      return next;
    });
  }, [activeId]);

  // ─── Auto-predict ─────────────────────────────────────────────────────────
  const predict = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError('');
    try {
      const s = session.state;
      const totalGold = s.showLaneGold ? Object.values(s.laneGold).reduce((a, b) => a + b, 0) : s.goldDiff;
      const body = {
        blueChamps: session.draft?.blueChamps ?? [],
        redChamps: session.draft?.redChamps ?? [],
        minute: s.minute, goldDiffTotal: totalGold,
        goldDiffByLane: s.showLaneGold ? s.laneGold : undefined,
        blueDragons: s.blueDragons, redDragons: s.redDragons,
        blueDragonSoul: s.blueSoul, redDragonSoul: s.redSoul,
        blueElderDragon: s.blueElder, redElderDragon: s.redElder,
        blueVoidgrubs: s.blueGrubs, redVoidgrubs: s.redGrubs,
        blueHerald: s.blueHerald, redHerald: s.redHerald,
        blueBaron: s.blueBaron, redBaron: s.redBaron,
        blueTowersDestroyed: s.blueTowers, redTowersDestroyed: s.redTowers,
        killDiff: s.killDiff,
        draftPMap: session.draft?.pMap ?? undefined,
      };
      const res = await api.post('/lol/live/predict', body);
      const pred: LivePrediction = res.data;
      setSessions(prev => {
        const next = prev.map(ss => {
          if (ss.id !== activeId) return ss;
          const h = [...ss.history.filter(h => h.min !== s.minute), { min: s.minute, pBlue: pred.pBlue }].sort((a, b) => a.min - b.min);
          return { ...ss, lastPrediction: pred, history: h };
        });
        saveSessions(next);
        return next;
      });
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Prediction failed');
    } finally { setLoading(false); }
  }, [session, activeId]);

  useEffect(() => {
    if (!session) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(predict, 150);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.state, session?.draft, activeId]);

  // ─── Session management ───────────────────────────────────────────────────
  const addSession = () => {
    const draft = loadDraft();
    const s = newSession(`Match ${sessions.length + 1}`, draft);
    const next = [...sessions, s];
    setSessions(next); saveSessions(next);
    setActiveId(s.id); saveActiveId(s.id);
  };

  const switchSession = (id: string) => { setActiveId(id); saveActiveId(id); };

  const deleteSession = (id: string) => {
    if (sessions.length <= 1) return;
    const next = sessions.filter(s => s.id !== id);
    setSessions(next); saveSessions(next);
    if (activeId === id) { setActiveId(next[0].id); saveActiveId(next[0].id); }
  };

  const duplicateSession = (id: string) => {
    const src = sessions.find(s => s.id === id);
    if (!src) return;
    const s = { ...newSession(src.name + ' copy', src.draft), state: { ...src.state }, history: [...src.history], lastPrediction: src.lastPrediction };
    const next = [...sessions, s];
    setSessions(next); saveSessions(next);
    setActiveId(s.id); saveActiveId(s.id);
  };

  const resetSession = () => {
    updateSession({ state: emptyState(), history: [], lastPrediction: null });
  };

  const reloadDraft = () => {
    const draft = loadDraft();
    if (draft) updateSession({ draft });
    else setError('No draft data found');
  };

  const startRename = (id: string) => {
    const s = sessions.find(ss => ss.id === id);
    setRenaming(id); setRenameVal(s?.name ?? '');
  };

  const finishRename = () => {
    if (renaming && renameVal.trim()) {
      setSessions(prev => {
        const next = prev.map(s => s.id === renaming ? { ...s, name: renameVal.trim() } : s);
        saveSessions(next); return next;
      });
    }
    setRenaming(null);
  };

  // ─── Derived ──────────────────────────────────────────────────────────────
  const totalGold = st.showLaneGold ? Object.values(st.laneGold).reduce((a, b) => a + b, 0) : st.goldDiff;
  const bd = prediction?.breakdown;

  if (!session) return null;

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-white">Live Predictor</h1>
            {loading && <span className="text-[10px] text-yellow-400 animate-pulse">updating...</span>}
          </div>
          <p className="text-xs text-gray-500">Real-time win probability &middot; draft auto-loads &middot; sessions persist</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/lol/draft" className="text-xs text-gray-400 hover:text-gray-200 border border-gray-700 rounded-lg px-3 py-1.5 transition-colors">Draft</Link>
          <button onClick={reloadDraft} className="text-xs bg-purple-600 hover:bg-purple-500 text-white px-3 py-1.5 rounded-lg transition-colors">Reload Draft</button>
          <button onClick={resetSession} className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 px-3 py-1.5 rounded-lg transition-colors">Reset</button>
        </div>
      </div>

      {error && <div className="bg-red-900/30 border border-red-700/40 rounded-lg px-3 py-2 text-xs text-red-300">{error}</div>}

      {/* Session tabs */}
      <div className="flex items-center gap-1 flex-wrap">
        {sessions.map(s => (
          <div key={s.id} className={`group flex items-center gap-1 rounded-lg border text-xs transition-colors ${
            s.id === activeId ? 'bg-gray-800 border-cyan-500/40 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600'
          }`}>
            {renaming === s.id ? (
              <input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)}
                onBlur={finishRename} onKeyDown={e => e.key === 'Enter' && finishRename()}
                className="bg-transparent px-2 py-1 text-xs text-white outline-none w-24" />
            ) : (
              <button onClick={() => switchSession(s.id)} onDoubleClick={() => startRename(s.id)}
                className="px-2.5 py-1 truncate max-w-[140px]" title={`${s.name} — ${fmtTime(s.createdAt)}\nDouble-click to rename`}>
                {s.name}
                {s.lastPrediction && (
                  <span className={`ml-1.5 font-mono text-[10px] ${s.lastPrediction.pBlue > 0.5 ? 'text-blue-400/70' : 'text-red-400/70'}`}>
                    {pct(s.lastPrediction.pBlue)}
                  </span>
                )}
              </button>
            )}
            <div className="hidden group-hover:flex items-center gap-0.5 pr-1">
              <button onClick={() => duplicateSession(s.id)} className="text-gray-500 hover:text-gray-300 px-0.5" title="Duplicate">+</button>
              {sessions.length > 1 && (
                <button onClick={() => deleteSession(s.id)} className="text-gray-500 hover:text-red-400 px-0.5" title="Delete">&times;</button>
              )}
            </div>
          </div>
        ))}
        <button onClick={addSession} className="text-xs text-gray-500 hover:text-white border border-dashed border-gray-700 hover:border-gray-500 rounded-lg px-2.5 py-1 transition-colors" title="New match session">
          + New
        </button>
      </div>

      {/* Win probability bar */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <WinBar pBlue={prediction?.pBlue ?? 0.5} />
        {draft && (
          <div className="mt-2 flex items-center gap-2 text-[10px] text-gray-500 flex-wrap">
            <span>Draft baseline: <span className="text-blue-400 font-mono">{pct(draft.pMap)}</span></span>
            {draft.seriesFormat && draft.seriesScore && (
              <span className="text-gray-600">
                {draft.seriesFormat} Map {(draft.mapIndex ?? 0) + 1} &middot;
                <span className="text-blue-400 ml-1">{draft.seriesScore.blue}</span>
                <span className="text-gray-600">:</span>
                <span className="text-red-400">{draft.seriesScore.red}</span>
              </span>
            )}
            {draft.blueChamps.filter(Boolean).length > 0 && (
              <span className="text-gray-600">{draft.blueChamps.filter(Boolean).join(', ')} vs {draft.redChamps.filter(Boolean).join(', ')}</span>
            )}
          </div>
        )}
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Left: Controls */}
        <div className="lg:col-span-3 space-y-3">
          {/* Minute + Gold */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Game State</div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-gray-500">Minute</span>
                  <span className="text-lg font-bold text-white font-mono">{st.minute}</span>
                </div>
                <input type="range" min={0} max={60} value={st.minute} onChange={e => updateState({ minute: parseInt(e.target.value) })}
                  className="w-full h-2 rounded-full appearance-none bg-gray-700 accent-cyan-500 cursor-pointer" />
                <div className="flex justify-between text-[9px] text-gray-600"><span>0</span><span>15</span><span>30</span><span>45</span><span>60</span></div>
              </div>
              <div className="space-y-1">
                <NumberStepper label="Gold" value={st.showLaneGold ? totalGold : st.goldDiff}
                  onChange={v => { if (!st.showLaneGold) updateState({ goldDiff: v }); }}
                  min={-30000} max={30000} step={500} />
                <div className="flex items-center gap-2 mt-1">
                  <button onClick={() => updateState({ showLaneGold: !st.showLaneGold })}
                    className={`text-[9px] px-2 py-0.5 rounded border transition-colors ${st.showLaneGold ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' : 'bg-gray-800 text-gray-500 border-gray-700'}`}>
                    {st.showLaneGold ? 'By Lane ON' : 'By Lane'}
                  </button>
                  {st.showLaneGold && <span className="text-[9px] text-gray-600 font-mono">Total: {totalGold > 0 ? '+' : ''}{totalGold}</span>}
                </div>
              </div>
              <div className="space-y-1">
                <NumberStepper label="Kills" value={st.killDiff}
                  onChange={v => updateState({ killDiff: v })}
                  min={-40} max={40} step={1} />
                <div className="text-[9px] text-gray-600 mt-1">
                  {st.killDiff > 0 ? `Blue +${st.killDiff}` : st.killDiff < 0 ? `Red +${Math.abs(st.killDiff)}` : 'Even'}
                </div>
              </div>
            </div>
            {st.showLaneGold && (
              <div className="grid grid-cols-5 gap-2 pt-2 border-t border-gray-800">
                {(['top', 'jng', 'mid', 'bot', 'sup'] as const).map(lane => (
                  <div key={lane} className="space-y-0.5">
                    <span className="text-[9px] text-gray-500 uppercase">{lane}</span>
                    <input type="number" step={100} value={st.laneGold[lane]}
                      onChange={e => { const v = parseInt(e.target.value); if (Number.isFinite(v)) updateState({ laneGold: { ...st.laneGold, [lane]: v } }); }}
                      className="w-full bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-white font-mono text-center" />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Objectives */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Objectives</div>
            <div className="space-y-1.5">
              <div className="text-[10px] text-gray-600">Dragons</div>
              <DragonRow label="BLUE" side="blue" dragons={st.blueDragons}
                onAdd={t => updateState({ blueDragons: [...st.blueDragons, t] })}
                onRemove={i => updateState({ blueDragons: st.blueDragons.filter((_, idx) => idx !== i) })} />
              <DragonRow label="RED" side="red" dragons={st.redDragons}
                onAdd={t => updateState({ redDragons: [...st.redDragons, t] })}
                onRemove={i => updateState({ redDragons: st.redDragons.filter((_, idx) => idx !== i) })} />
              <div className="flex items-center gap-4 pt-1">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={st.blueSoul} onChange={e => updateState({ blueSoul: e.target.checked, redSoul: e.target.checked ? false : st.redSoul })}
                    className="w-3 h-3 rounded bg-gray-800 border-gray-600 accent-blue-500" />
                  <span className="text-[10px] text-blue-400">Blue Soul</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={st.redSoul} onChange={e => updateState({ redSoul: e.target.checked, blueSoul: e.target.checked ? false : st.blueSoul })}
                    className="w-3 h-3 rounded bg-gray-800 border-gray-600 accent-red-500" />
                  <span className="text-[10px] text-red-400">Red Soul</span>
                </label>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 pt-2 border-t border-gray-800">
              <NumberStepper label="Elder B" value={st.blueElder} onChange={v => updateState({ blueElder: v })} min={0} max={3} step={1} size="sm" />
              <NumberStepper label="Elder R" value={st.redElder} onChange={v => updateState({ redElder: v })} min={0} max={3} step={1} size="sm" />
              <NumberStepper label="Grubs B" value={st.blueGrubs} onChange={v => updateState({ blueGrubs: v })} min={0} max={6} step={1} size="sm" />
              <NumberStepper label="Grubs R" value={st.redGrubs} onChange={v => updateState({ redGrubs: v })} min={0} max={6} step={1} size="sm" />
              <NumberStepper label="Herld B" value={st.blueHerald} onChange={v => updateState({ blueHerald: v })} min={0} max={2} step={1} size="sm" />
              <NumberStepper label="Herld R" value={st.redHerald} onChange={v => updateState({ redHerald: v })} min={0} max={2} step={1} size="sm" />
              <NumberStepper label="Baron B" value={st.blueBaron} onChange={v => updateState({ blueBaron: v })} min={0} max={4} step={1} size="sm" />
              <NumberStepper label="Baron R" value={st.redBaron} onChange={v => updateState({ redBaron: v })} min={0} max={4} step={1} size="sm" />
              <NumberStepper label="Towrs B" value={st.blueTowers} onChange={v => updateState({ blueTowers: v })} min={0} max={11} step={1} size="sm" />
              <NumberStepper label="Towrs R" value={st.redTowers} onChange={v => updateState({ redTowers: v })} min={0} max={11} step={1} size="sm" />
            </div>
          </div>
        </div>

        {/* Right: Breakdown */}
        <div className="lg:col-span-2 space-y-3">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
            <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Probability Breakdown</div>
            {bd ? (
              <>
                <div className="space-y-0.5">
                  <FactorRow label="Draft Baseline" value={bd.draftBaseline - 0.5} tip="Draft analysis pMap - 50%" />
                  <FactorRow label="Gold Impact" value={bd.goldShift} tip={`Gold WR at ${st.minute}min: ${pct(bd.goldWR)}`} />
                  <FactorRow label="Kill Diff" value={bd.killShift} tip={`Kill diff: ${st.killDiff > 0 ? '+' : ''}${st.killDiff}`} />
                  <FactorRow label="Objectives" value={bd.objectiveShift} />
                  <FactorRow label="Scaling" value={bd.scalingShift} />
                </div>
                <div className="border-t border-gray-800 pt-1">
                  <div className="flex items-center justify-between text-sm font-bold">
                    <span className="text-gray-300">Final</span>
                    <span className={prediction!.pBlue > 0.5 ? 'text-blue-400' : 'text-red-400'}>{pct(prediction!.pBlue)}</span>
                  </div>
                </div>
                <div className="pt-2 border-t border-gray-800 space-y-0.5">
                  <div className="text-[9px] text-gray-600 uppercase">Objective Detail</div>
                  {Object.entries(bd.objectives).filter(([, v]) => Math.abs(v) > 0.0001).map(([key, val]) => (
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

          <BaronTimer />

          <GoldCurveChart curves={goldCurves} currentMinute={st.minute} currentGold={totalGold} />

          {history.length >= 2 && (
            <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-3">
              <div className="text-[10px] text-gray-500 mb-2">Win% over time</div>
              <div className="h-28">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history}>
                    <XAxis dataKey="min" stroke="#4b5563" tick={{ fontSize: 9 }} tickFormatter={v => `${v}m`} />
                    <YAxis domain={[0, 1]} stroke="#4b5563" tick={{ fontSize: 9 }} tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                    <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 10 }}
                      formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, 'Blue WR']} labelFormatter={l => `Min ${l}`} />
                    <ReferenceLine y={0.5} stroke="#4b5563" strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="pBlue" stroke="#60a5fa" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* All sessions summary */}
          {sessions.length > 1 && (
            <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-3">
              <div className="text-[10px] text-gray-500 mb-2">All Sessions</div>
              <div className="space-y-1">
                {sessions.map(s => (
                  <button key={s.id} onClick={() => switchSession(s.id)}
                    className={`w-full flex items-center justify-between text-xs py-1 px-2 rounded transition-colors ${s.id === activeId ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}`}>
                    <span className="truncate">{s.name}</span>
                    <span className={`font-mono ${(s.lastPrediction?.pBlue ?? 0.5) > 0.5 ? 'text-blue-400' : 'text-red-400'}`}>
                      {s.lastPrediction ? pct(s.lastPrediction.pBlue) : '—'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

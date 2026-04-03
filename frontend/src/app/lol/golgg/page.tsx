'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import api from '@/lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GolDataset {
  label?: string;
  data?: number[];
  borderColor?: string;
}

interface GoldOverTime {
  labels?: string[];
  datasets?: GolDataset[];
}

interface RoleChart {
  labels?: string[];
  datasets?: Array<{ label?: string; data?: number[]; backgroundColor?: string | string[] }>;
}

interface VisionChart {
  labels?: string[];
  datasets?: Array<{ label?: string; data?: number[] }>;
}

interface JungleChart {
  labels?: string[];
  datasets?: Array<{ data?: number[]; backgroundColor?: string | string[] }>;
}

interface TimelineEv {
  side: 'blue' | 'red' | 'unknown';
  gameTime: string;
  label: string;
  iconFile: string | null;
}

interface PlayerRow {
  side: 'blue' | 'red';
  champion?: string;
  player: string | null;
  kda: string | null;
  cs?: number;
  csm?: number | null;
  dpm?: number | null;
  wpm?: number | null;
}

interface GolSnapshot {
  id: string;
  gameId: number;
  pageSlug: string;
  sourceUrl: string;
  title: string | null;
  meta: Record<string, unknown>;
  charts: {
    goldOverTime?: GoldOverTime;
    goldByRole?: RoleChart;
    damageByRole?: RoleChart;
    vision?: VisionChart;
    jungleShare?: JungleChart;
  };
  timeline: TimelineEv[];
  plates: Record<string, unknown> | null;
  players: PlayerRow[] | null;
  fetchedAt: string;
}

/** Build chart rows from Chart.js golddatas */
function goldLineData(g: GoldOverTime | undefined) {
  if (!g?.labels?.length || !g.datasets?.length) return [];
  const goldDs = g.datasets.find((d) => d.label === 'Gold') ?? g.datasets[g.datasets.length - 1];
  const pts = goldDs?.data ?? [];
  return g.labels.map((lab, i) => ({
    t: String(lab),
    goldLead: typeof pts[i] === 'number' ? pts[i] : 0,
  }));
}

function roleBarRows(chart: RoleChart | undefined, keyA: string, keyB: string) {
  const labels = chart?.labels ?? [];
  const ds = chart?.datasets ?? [];
  const a = ds[0];
  const b = ds[1];
  return labels.map((role, i) => ({
    role,
    [keyA]: a?.data?.[i] ?? 0,
    [keyB]: b?.data?.[i] ?? 0,
    nameA: a?.label ?? 'Team A',
    nameB: b?.label ?? 'Team B',
  }));
}

function visionRows(v: VisionChart | undefined) {
  const labels = v?.labels ?? [];
  const ds = v?.datasets ?? [];
  return ds.map((d) => {
    const row: Record<string, string | number> = { team: d.label ?? '' };
    labels.forEach((lab, i) => {
      row[lab] = d.data?.[i] ?? 0;
    });
    return row;
  });
}

function jungleRows(j: JungleChart | undefined) {
  const labels = j?.labels ?? ['At 15', 'End'];
  const ds = j?.datasets ?? [];
  const a = ds[0]?.data ?? [];
  const b = ds[1]?.data ?? [];
  return labels.map((phase, i) => ({
    phase,
    bluePct: a[i] ?? 0,
    redPct: b[i] ?? 0,
  }));
}

// ─── Page ────────────────────────────────────────────────────────────────────

function GolGgPageInner() {
  const sp = useSearchParams();
  const qpGame = sp.get('gameId');
  const qpPage = sp.get('page');
  const [gameId, setGameId] = useState(qpGame || '75588');
  const [pageSlug, setPageSlug] = useState(qpPage || 'page-game');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [snap, setSnap] = useState<GolSnapshot | null>(null);

  const load = useCallback(async (id: string, page: string) => {
    setLoading(true);
    setErr(null);
    try {
      const { data } = await api.get<{ ok: boolean; snapshot: GolSnapshot }>('/lol/golgg/fetch', {
        params: { gameId: id, page },
      });
      setSnap(data.snapshot);
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'response' in e
        ? String((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? e)
        : String(e);
      setErr(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (qpGame) setGameId(qpGame);
    if (qpPage) setPageSlug(qpPage);
  }, [qpGame, qpPage]);

  useEffect(() => {
    if (!qpGame) return;
    const slug = qpPage || 'page-game';
    setGameId(qpGame);
    setPageSlug(slug);
    void load(qpGame, slug);
  }, [qpGame, qpPage, load]);

  const goldData = useMemo(() => goldLineData(snap?.charts?.goldOverTime), [snap]);
  const goldRole = useMemo(() => roleBarRows(snap?.charts?.goldByRole, 't1', 't2'), [snap]);
  const dmgRole = useMemo(() => roleBarRows(snap?.charts?.damageByRole, 't1', 't2'), [snap]);
  const visionData = useMemo(() => visionRows(snap?.charts?.vision), [snap]);
  const jungleData = useMemo(() => jungleRows(snap?.charts?.jungleShare), [snap]);

  const visionKeys = snap?.charts?.vision?.labels ?? [];

  const t1Name = snap?.charts?.goldByRole?.datasets?.[0]?.label ?? 'Blue';
  const t2Name = snap?.charts?.goldByRole?.datasets?.[1]?.label ?? 'Red';

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-gray-200 p-6 md:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Games of Legends (gol.gg)</h1>
            <p className="text-sm text-gray-500 mt-1">
              Парсинг страницы матча: график золота, таймлайн, роли, vision, джунгли. Данные сохраняются в локальную БД.
            </p>
          </div>
          <Link href="/lol" className="text-sm text-blue-400 hover:text-blue-300">
            ← PandaScore LoL
          </Link>
        </div>

        <div className="flex flex-wrap items-end gap-3 bg-gray-900/40 border border-gray-800 rounded-xl p-4">
          <input
            type="text"
            value={gameId}
            onChange={(e) => setGameId(e.target.value.replace(/\D/g, ''))}
            className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm w-48 text-white"
            placeholder="game id (URL)"
          />
          <select
            value={pageSlug}
            onChange={(e) => setPageSlug(e.target.value)}
            className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="page-game">page-game (charts/timeline)</option>
            <option value="page-summary">page-summary (series summary)</option>
          </select>
          <button
            type="button"
            disabled={loading}
            onClick={() => load(gameId, pageSlug)}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50"
          >
            {loading ? 'Загрузка…' : 'Загрузить & сохранить'}
          </button>
          {snap?.sourceUrl && (
            <a
              href={snap.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-gray-400 hover:text-gray-300 underline"
            >
              Открыть на gol.gg
            </a>
          )}
        </div>

        {err && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {err}
          </div>
        )}

        {!snap && !loading && !err && (
          <div className="text-gray-500 text-sm">Введите game id из URL (например 75588) и нажмите «Загрузить».</div>
        )}

        {snap && (
          <>
            <div className="border border-gray-800 rounded-xl p-5 bg-gray-900/30">
              <h2 className="text-lg font-semibold text-white mb-1">{snap.title ?? `Game ${snap.gameId}`}</h2>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
                {typeof snap.meta.gameTimeLabel === 'string' && (
                  <span>Длительность: <span className="text-gray-300">{snap.meta.gameTimeLabel}</span></span>
                )}
                {typeof snap.meta.patch === 'string' && (
                  <span>Патч: <span className="text-gray-300">{snap.meta.patch}</span></span>
                )}
                <span>
                  Обновлено: {new Date(snap.fetchedAt).toLocaleString('ru-RU')}
                </span>
                <span>Страница: <span className="text-gray-300">{snap.pageSlug}</span></span>
              </div>
            </div>

            {/* Gold graph */}
            <section className="border border-gray-800 rounded-xl p-5 bg-gray-900/20">
              <h3 className="text-sm font-medium text-gray-300 mb-3">Gold graph &amp; Timeline</h3>
              <p className="text-xs text-gray-600 mb-4">
                Ось X — минуты игры, Y — преимущество синей команды (положительное = синие впереди, отрицательное = красные).
              </p>
              {goldData.length > 0 ? (
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={goldData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                      <XAxis dataKey="t" tick={{ fill: '#6b7280', fontSize: 10 }} />
                      <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} />
                      <Tooltip
                        contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 12 }}
                        labelFormatter={(l) => `Минута ${l}`}
                      />
                      <Line type="monotone" dataKey="goldLead" name="Gold lead" stroke="#24a2be" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="text-gray-600 text-sm">Для этой страницы gol.gg график золота отсутствует.</div>
              )}

              {snap.timeline?.length > 0 && (
                <div className="mt-6">
                  <div className="text-xs text-gray-500 mb-2">События (порядок как на сайте)</div>
                  <div className="flex flex-wrap gap-2">
                    {snap.timeline.map((ev, i) => (
                      <div
                        key={`${ev.gameTime}-${i}`}
                        className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs border ${
                          ev.side === 'blue'
                            ? 'bg-blue-500/10 border-blue-500/30 text-blue-200'
                            : 'bg-red-500/10 border-red-500/30 text-red-200'
                        }`}
                      >
                        <span className="font-mono text-gray-400">{ev.gameTime}</span>
                        <span>{ev.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <section className="border border-gray-800 rounded-xl p-5 bg-gray-900/20">
                <h3 className="text-sm font-medium text-gray-300 mb-3">Gold distribution (%)</h3>
                {goldRole.length > 0 ? (
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={goldRole} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                        <XAxis dataKey="role" tick={{ fill: '#6b7280', fontSize: 10 }} />
                        <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} />
                        <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 12 }} />
                        <Legend />
                        <Bar dataKey="t1" name={t1Name} fill="#6194bc" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="t2" name={t2Name} fill="#ee3233" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="text-gray-600 text-sm">Нет данных в этой вкладке gol.gg.</div>
                )}
              </section>

              <section className="border border-gray-800 rounded-xl p-5 bg-gray-900/20">
                <h3 className="text-sm font-medium text-gray-300 mb-3">Damage distribution (%)</h3>
                {dmgRole.length > 0 ? (
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dmgRole} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                        <XAxis dataKey="role" tick={{ fill: '#6b7280', fontSize: 10 }} />
                        <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} />
                        <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 12 }} />
                        <Legend />
                        <Bar dataKey="t1" name={t1Name} fill="#6194bc" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="t2" name={t2Name} fill="#ee3233" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="text-gray-600 text-sm">Нет данных в этой вкладке gol.gg.</div>
                )}
              </section>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <section className="border border-gray-800 rounded-xl p-5 bg-gray-900/20">
                <h3 className="text-sm font-medium text-gray-300 mb-3">Vision</h3>
                {visionData.length > 0 && visionKeys.length >= 2 ? (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={visionData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                        <XAxis dataKey="team" tick={{ fill: '#6b7280', fontSize: 10 }} />
                        <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} />
                        <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 12 }} />
                        <Legend />
                        <Bar dataKey={visionKeys[0]} name={visionKeys[0]} fill="#94a3b8" radius={[4, 4, 0, 0]} />
                        <Bar dataKey={visionKeys[1]} name={visionKeys[1]} fill="#64748b" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="text-gray-600 text-sm">Нет данных в этой вкладке gol.gg.</div>
                )}
              </section>

              <section className="border border-gray-800 rounded-xl p-5 bg-gray-900/20">
                <h3 className="text-sm font-medium text-gray-300 mb-3">Jungle share (CS %)</h3>
                {jungleData.length > 0 ? (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={jungleData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                        <XAxis dataKey="phase" tick={{ fill: '#6b7280', fontSize: 10 }} />
                        <YAxis domain={[0, 100]} tick={{ fill: '#6b7280', fontSize: 10 }} />
                        <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', fontSize: 12 }} />
                        <Legend />
                        <Bar dataKey="bluePct" name={t1Name} fill="#6194bc" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="redPct" name={t2Name} fill="#ee3233" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="text-gray-600 text-sm">Нет данных в этой вкладке gol.gg.</div>
                )}
              </section>
            </div>

            {Array.isArray((snap.meta as { summaryTeams?: unknown[] }).summaryTeams) && (
              <section className="border border-gray-800 rounded-xl p-5 bg-gray-900/20">
                <h3 className="text-sm font-medium text-gray-300 mb-3">Series Team Totals</h3>
                <pre className="text-xs text-gray-500 overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify((snap.meta as { summaryTeams?: unknown[] }).summaryTeams, null, 2)}
                </pre>
              </section>
            )}

            {snap.plates && typeof snap.plates === 'object' && (
              <section className="border border-gray-800 rounded-xl p-5 bg-gray-900/20">
                <h3 className="text-sm font-medium text-gray-300 mb-2">Plates</h3>
                <pre className="text-xs text-gray-500 overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(snap.plates, null, 2)}
                </pre>
              </section>
            )}

            {snap.players && snap.players.length > 0 && (() => {
              const bluePlayers = snap.players.filter((p) => p.side === 'blue');
              const redPlayers = snap.players.filter((p) => p.side === 'red');
              const blueTeam = t1Name !== 'Blue' ? t1Name : (typeof snap.meta.winnerHint === 'string' ? '' : 'Blue');
              const redTeam = t2Name !== 'Red' ? t2Name : 'Red';

              const PlayerTable = ({ players, side }: { players: PlayerRow[]; side: 'blue' | 'red' }) => (
                <table className="w-full text-xs">
                  <thead>
                    <tr className={`text-left border-b ${side === 'blue' ? 'border-blue-500/20 text-blue-400/70' : 'border-red-500/20 text-red-400/70'}`}>
                      <th className="px-4 py-2 font-medium">Champion</th>
                      <th className="px-4 py-2 font-medium">Player</th>
                      <th className="px-4 py-2 font-medium">KDA</th>
                      <th className="px-4 py-2 font-medium text-right">CS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {players.map((p, i) => (
                      <tr key={i} className="border-b border-gray-800/40 hover:bg-white/[0.02]">
                        <td className="px-4 py-2.5 font-medium text-white">{p.champion ?? '—'}</td>
                        <td className="px-4 py-2.5 text-gray-400">{p.player ?? '—'}</td>
                        <td className="px-4 py-2.5 font-mono text-gray-300">{p.kda ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right text-gray-400">{typeof p.cs === 'number' ? p.cs : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );

              return (
                <section className="border border-gray-800 rounded-xl overflow-hidden bg-gray-900/20">
                  <div className="px-5 py-3 border-b border-gray-800">
                    <h3 className="text-sm font-medium text-gray-300">Составы команд</h3>
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-800">
                    <div>
                      <div className="px-4 py-2.5 bg-blue-500/5 border-b border-blue-500/20 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />
                        <span className="text-sm font-semibold text-blue-300">{blueTeam || 'Blue Side'}</span>
                      </div>
                      <PlayerTable players={bluePlayers} side="blue" />
                    </div>
                    <div>
                      <div className="px-4 py-2.5 bg-red-500/5 border-b border-red-500/20 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
                        <span className="text-sm font-semibold text-red-300">{redTeam || 'Red Side'}</span>
                      </div>
                      <PlayerTable players={redPlayers} side="red" />
                    </div>
                  </div>
                </section>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}

export default function GolGgPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#0a0a0f] text-gray-400 p-8 flex items-center justify-center text-sm">
          Загрузка…
        </div>
      }
    >
      <GolGgPageInner />
    </Suspense>
  );
}

'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AccuracyStats {
  overall: {
    total: number;
    pending: number;
    resolved: number;
    wins: number;
    losses: number;
    voids: number;
    winRate: number;
    avgRoi: number;
    avgConfidence: number;
    avgClvCents: number | null;
    pctPositiveClv: number | null;
  };
  byHorizon: Record<string, HorizonStats>;
  byCategory: Record<string, HorizonStats>;
  byConfidenceLevel: Record<string, HorizonStats>;
  byConfidenceBucket: Record<string, HorizonStats>;
  topWins: SignalRecord[];
}

interface HorizonStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  avgRoi: number;
}

interface SignalRecord {
  id: string;
  marketQuestion: string;
  eventTitle: string;
  side: string;
  horizon: string;
  category: string;
  confidence: number;
  confidenceLevel: string;
  entryPrice: number;
  potentialRoi: number;
  outcome: string;
  actualRoi: number | null;
  anomalyTypes: string[];
  reasons: string[];
  generatedAt: string;
  resolvedAt: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtRoi(roi: number | null): string {
  if (roi === null) return '—';
  return `${roi >= 0 ? '+' : ''}${roi.toFixed(0)}%`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  return 'just now';
}

const OUTCOME_CFG: Record<string, { label: string; color: string; bg: string }> = {
  WIN:     { label: 'WIN',     color: 'text-green-400',  bg: 'bg-green-500/10 border-green-500/20' },
  LOSS:    { label: 'LOSS',    color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20' },
  PENDING: { label: 'PENDING', color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/20' },
  VOID:    { label: 'VOID',    color: 'text-gray-400',   bg: 'bg-gray-800 border-gray-700' },
};

const HORIZON_CFG: Record<string, { icon: string; color: string }> = {
  fast:   { icon: '⚡', color: 'text-red-400' },
  medium: { icon: '⏳', color: 'text-yellow-400' },
  long:   { icon: '📅', color: 'text-blue-400' },
};

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, highlight }: {
  label: string; value: string | number; sub?: string; highlight?: string;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${highlight ?? 'text-white'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-600 mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── Horizon breakdown table ──────────────────────────────────────────────────

function BreakdownTable({ data, label }: { data: Record<string, HorizonStats>; label: string }) {
  const rows = Object.entries(data).filter(([, s]) => s.total > 0);
  if (rows.length === 0) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 text-sm font-medium text-gray-300">{label}</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 bg-gray-800/40">
            <th className="text-left px-4 py-2">Group</th>
            <th className="text-right px-4 py-2">Total</th>
            <th className="text-right px-4 py-2">Wins</th>
            <th className="text-right px-4 py-2">Losses</th>
            <th className="text-right px-4 py-2">Win Rate</th>
            <th className="text-right px-4 py-2">Avg ROI</th>
          </tr>
        </thead>
        <tbody>
          {rows.sort(([, a], [, b]) => b.winRate - a.winRate).map(([key, s]) => (
            <tr key={key} className="border-t border-gray-800/50 hover:bg-gray-800/20">
              <td className="px-4 py-2.5 font-medium text-gray-200 capitalize">{key}</td>
              <td className="px-4 py-2.5 text-right text-gray-400">{s.total}</td>
              <td className="px-4 py-2.5 text-right text-green-400">{s.wins}</td>
              <td className="px-4 py-2.5 text-right text-red-400">{s.losses}</td>
              <td className="px-4 py-2.5 text-right font-medium">
                <span className={s.winRate >= 50 ? 'text-green-400' : s.winRate > 0 ? 'text-yellow-400' : 'text-gray-500'}>
                  {s.wins + s.losses > 0 ? `${s.winRate}%` : '—'}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right font-mono">
                <span className={s.avgRoi >= 0 ? 'text-green-400' : 'text-red-400'}>
                  {s.wins + s.losses > 0 ? fmtRoi(s.avgRoi) : '—'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Signal row ──────────────────────────────────────────────────────────────

function SignalRow({ record }: { record: SignalRecord }) {
  const oc = OUTCOME_CFG[record.outcome] ?? OUTCOME_CFG.PENDING;
  const hc = HORIZON_CFG[record.horizon] ?? { icon: '?', color: 'text-gray-400' };

  return (
    <tr className="border-t border-gray-800/50 hover:bg-gray-800/20 group">
      <td className="px-4 py-3">
        <div className="text-xs text-gray-500 truncate max-w-[240px]">{record.eventTitle}</div>
        <div className="text-sm text-gray-200 font-medium line-clamp-1 max-w-[240px]">{record.marketQuestion}</div>
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
          record.side === 'YES'
            ? 'bg-green-500/10 text-green-400 border border-green-500/20'
            : 'bg-red-500/10 text-red-400 border border-red-500/20'
        }`}>
          {record.side}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className={`text-xs font-medium ${hc.color}`}>
          {hc.icon} {record.horizon}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-gray-400">{record.category}</td>
      <td className="px-4 py-3 text-right">
        <span className={`text-xs px-1.5 py-0.5 rounded ${
          record.confidenceLevel === 'strong' ? 'bg-green-500/10 text-green-400' :
          record.confidenceLevel === 'good' ? 'bg-yellow-500/10 text-yellow-400' :
          'bg-gray-800 text-gray-500'
        }`}>
          {record.confidence}%
        </span>
      </td>
      <td className="px-4 py-3 text-right font-mono text-sm text-gray-300">{(record.entryPrice * 100).toFixed(0)}¢</td>
      <td className="px-4 py-3 text-right font-mono text-sm text-yellow-400">+{record.potentialRoi.toFixed(0)}%</td>
      <td className="px-4 py-3 text-right">
        <span className={`text-xs px-2 py-0.5 rounded border font-medium ${oc.bg} ${oc.color}`}>
          {oc.label}
        </span>
      </td>
      <td className="px-4 py-3 text-right font-mono text-sm">
        <span className={record.actualRoi !== null ? (record.actualRoi >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-600'}>
          {fmtRoi(record.actualRoi)}
        </span>
      </td>
      <td className="px-4 py-3 text-right text-xs text-gray-500">{fmtAge(record.generatedAt)}</td>
    </tr>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'history';

export default function SignalHistoryPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [stats, setStats] = useState<AccuracyStats | null>(null);
  const [history, setHistory] = useState<SignalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [horizonFilter, setHorizonFilter] = useState('all');
  const [outcomeFilter, setOutcomeFilter] = useState('all');
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    api.get('/signals/accuracy')
      .then(res => setStats(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await api.get('/signals/history', {
        params: { limit: 100, horizon: horizonFilter, outcome: outcomeFilter },
      });
      setHistory(res.data.records || []);
    } catch {}
    finally { setHistoryLoading(false); }
  }, [horizonFilter, outcomeFilter]);

  useEffect(() => {
    if (tab === 'history') loadHistory();
  }, [tab, loadHistory]);

  const handleResolve = async () => {
    setResolving(true);
    try {
      const res = await api.post('/signals/resolve');
      alert(`Resolved ${res.data.resolved} signals: ${res.data.wins} wins, ${res.data.losses} losses`);
      // reload stats
      const statsRes = await api.get('/signals/accuracy');
      setStats(statsRes.data);
    } catch {}
    finally { setResolving(false); }
  };

  const o = stats?.overall;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/signals" className="text-gray-500 hover:text-gray-300 text-sm">← Signals</Link>
            <span className="text-gray-700">/</span>
            <h1 className="text-2xl font-bold text-white">Signal Accuracy</h1>
          </div>
          <p className="text-gray-400 text-sm">
            Track how well our signals perform over time. Updated automatically as markets resolve.
          </p>
        </div>
        <button
          onClick={handleResolve}
          disabled={resolving}
          className="px-4 py-2 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {resolving ? 'Checking...' : '↻ Check Outcomes'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-800">
        {(['overview', 'history'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg capitalize transition-colors ${
              tab === t
                ? 'bg-gray-800 text-white border border-gray-700 border-b-0'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t === 'overview' ? '📊 Overview' : '📋 Signal Log'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 animate-pulse h-24" />
          ))}
        </div>
      ) : tab === 'overview' ? (
        <div className="space-y-6">
          {/* No data yet */}
          {o && o.total === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
              <div className="text-4xl mb-3">📡</div>
              <div className="text-gray-300 font-medium mb-2">No signal data yet</div>
              <div className="text-gray-500 text-sm max-w-md mx-auto">
                Signals are saved automatically every time the engine runs (every 15 min).
                Once markets resolve, win/loss outcomes will be tracked here.
              </div>
              <div className="mt-4 text-xs text-gray-600">
                Tip: Go to the Signals page and click Refresh to trigger the first save.
              </div>
            </div>
          ) : (
            <>
              {/* Overall stats */}
              <div>
                <div className="text-sm font-medium text-gray-400 mb-3">Overall Performance</div>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
                  <StatCard label="Total Signals" value={o?.total ?? 0} />
                  <StatCard label="Resolved" value={o?.resolved ?? 0} sub={`${o?.pending ?? 0} pending`} />
                  <StatCard label="Wins" value={o?.wins ?? 0} highlight="text-green-400" />
                  <StatCard label="Losses" value={o?.losses ?? 0} highlight="text-red-400" />
                  <StatCard
                    label="Win Rate"
                    value={o?.resolved ? `${o.winRate}%` : '—'}
                    highlight={o?.winRate && o.winRate >= 50 ? 'text-green-400' : 'text-yellow-400'}
                    sub="of resolved"
                  />
                  <StatCard
                    label="Avg ROI"
                    value={o?.resolved ? fmtRoi(o.avgRoi) : '—'}
                    highlight={o?.avgRoi !== undefined && o.avgRoi >= 0 ? 'text-green-400' : 'text-red-400'}
                    sub="when resolved"
                  />
                  <StatCard label="Avg Confidence" value={o?.avgConfidence ? `${o.avgConfidence}%` : '—'} />
                  <StatCard
                    label="Avg CLV"
                    value={o?.avgClvCents != null ? `${o.avgClvCents >= 0 ? '+' : ''}${o.avgClvCents.toFixed(1)}¢` : '—'}
                    highlight={o?.avgClvCents != null ? (o.avgClvCents >= 0 ? 'text-green-400' : 'text-red-400') : 'text-gray-500'}
                    sub={o?.avgClvCents != null && o?.pctPositiveClv != null ? `${o.pctPositiveClv}% positive` : (o?.avgClvCents == null ? 'нужны резолвы со snapshot' : undefined)}
                  />
                </div>
              </div>

              {/* Пояснения: ROI, Kelly, калибровка, CLV */}
              <details className="bg-gray-800/30 border border-gray-700 rounded-xl overflow-hidden">
                <summary className="px-4 py-3 text-sm font-medium text-gray-300 cursor-pointer hover:bg-gray-800/50">
                  📖 Как считается ROI, где Kelly и калибровка
                </summary>
                <div className="px-4 pb-4 pt-1 text-sm text-gray-400 space-y-3">
                  <p>
                    <strong className="text-gray-300">ROI по длинным / нерезолвленным событиям:</strong> Пока рынок не закрыт, показывается только <em>потенциальный</em> ROI — «если купишь по этой цене и исход выиграет»: <code className="bg-gray-900 px-1 rounded">(1 / цена − 1) × 100%</code>. Реальный ROI (actualRoi) появляется только после резолюции (WIN/LOSS).
                  </p>
                  <p>
                    <strong className="text-gray-300">Где Kelly:</strong> На каждой карточке сигнала (страница Signals) и рекомендации (Top 10) внизу — строка «Kelly: X% stake». Это рекомендуемый % банкролла по формуле Кelly (макс. 5%). Если 0% — модель не советует ставить.
                  </p>
                  <p>
                    <strong className="text-gray-300">Калибровка:</strong> Блок ниже — по корзинам уверенности (40–49%, 50–59% …). Фактический винрейт по резолвам сравнивается с «ожидаемым» (середина корзины). Зелёный «+X pt vs expected» = мы недооценивали (сигналы выигрывают чаще); красный минус = переоценивали. Так можно подкручивать веса и пороги.
                  </p>
                  <p>
                    <strong className="text-gray-300">Avg CLV (карточка выше):</strong> Closing Line Value — насколько мы заходили лучше «закрывающей» цены. Если видишь «—» и подпись «нужны резолвы со snapshot» — значит по резолвленным сигналам ещё не накопились ценовые снимки (cron раз в 15 мин снимает цены; после резолва CLV считается автоматически). Как появятся данные — здесь покажется средний CLV и % сигналов с плюсом.
                  </p>
                </div>
              </details>

              {/* Note about profitability math */}
              {o && o.resolved > 0 && (
                <div className="bg-blue-500/5 border border-blue-500/15 rounded-xl px-4 py-3 text-sm text-gray-400">
                  <span className="text-blue-400 font-medium">Profitability check: </span>
                  Even at {o.winRate}% win rate with avg ROI {fmtRoi(o.avgRoi)} on wins, the expected value per bet is{' '}
                  <span className={
                    (o.winRate / 100) * (1 + o.avgRoi / 100) - (1 - o.winRate / 100) > 0
                      ? 'text-green-400 font-medium'
                      : 'text-red-400 font-medium'
                  }>
                    {(((o.winRate / 100) * (1 + o.avgRoi / 100) - (1 - o.winRate / 100)) * 100).toFixed(1)}¢ per $1 bet
                  </span>
                  {' '}(positive = profitable long-term).
                </div>
              )}

              {/* Breakdowns */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {stats && <BreakdownTable data={stats.byHorizon} label="By Time Horizon" />}
                {stats && <BreakdownTable data={stats.byConfidenceLevel} label="By Confidence Level" />}
              </div>
              {stats && Object.keys(stats.byCategory).length > 0 && (
                <BreakdownTable data={stats.byCategory} label="By Category" />
              )}

              {/* Calibration: confidence vs actual win rate */}
              {stats?.byConfidenceBucket && Object.keys(stats.byConfidenceBucket).length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-800 text-sm font-medium text-gray-300">
                    Calibration (Confidence vs Actual Win Rate)
                  </div>
                  <div className="p-4">
                    <div className="grid grid-cols-5 gap-2">
                      {Object.entries(stats.byConfidenceBucket)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([bucket, s]) => {
                          const midConfidence = bucket === '80+' ? 85 : parseInt(bucket) + 5;
                          const diff = s.wins + s.losses > 0 ? s.winRate - midConfidence : null;
                          return (
                            <div key={bucket} className="text-center bg-gray-800/50 rounded-lg p-3">
                              <div className="text-xs text-gray-500 mb-1">Conf {bucket}</div>
                              <div className={`text-xl font-bold ${
                                s.wins + s.losses === 0 ? 'text-gray-600'
                                : s.winRate >= midConfidence ? 'text-green-400' : 'text-yellow-400'
                              }`}>
                                {s.wins + s.losses > 0 ? `${s.winRate}%` : '-'}
                              </div>
                              <div className="text-[10px] text-gray-500">{s.wins + s.losses} resolved</div>
                              {diff !== null && (
                                <div className={`text-[10px] mt-1 ${diff >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                  {diff >= 0 ? '+' : ''}{diff}pt vs expected
                                </div>
                              )}
                            </div>
                          );
                        })}
                    </div>
                    <div className="text-[10px] text-gray-600 mt-2 text-center">
                      Идеал: фактический винрейт = уверенности. Зелёный «+X pt» = мы недооценивали (хорошо). Красный минус = переоценивали — можно снизить веса или порог «strong».
                    </div>
                  </div>
                </div>
              )}

              {/* Top wins */}
              {stats?.topWins && stats.topWins.length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
                    <span className="text-green-400">🏆</span>
                    <span className="text-sm font-medium text-gray-300">Best Wins</span>
                  </div>
                  <div className="divide-y divide-gray-800/50">
                    {stats.topWins.map(w => (
                      <div key={w.id} className="px-4 py-3 flex items-center gap-4">
                        <span className={`shrink-0 text-xs font-bold px-2 py-0.5 rounded ${
                          w.side === 'YES'
                            ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                            : 'bg-red-500/10 text-red-400 border border-red-500/20'
                        }`}>{w.side}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-gray-200 truncate">{w.marketQuestion}</div>
                          <div className="text-xs text-gray-500">{w.category} · {w.horizon} · {fmtAge(w.generatedAt)}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-bold text-green-400 font-mono">{fmtRoi(w.actualRoi)}</div>
                          <div className="text-xs text-gray-500">actual ROI</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        /* Signal Log */
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex items-center gap-4 flex-wrap text-sm">
            <div className="flex items-center gap-2">
              <span className="text-gray-500">Horizon:</span>
              {['all', 'fast', 'medium', 'long'].map(h => (
                <button key={h} onClick={() => setHorizonFilter(h)}
                  className={`px-3 py-1 rounded text-xs transition-colors capitalize ${
                    horizonFilter === h ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}>{h}</button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500">Outcome:</span>
              {['all', 'WIN', 'LOSS', 'PENDING'].map(o => (
                <button key={o} onClick={() => setOutcomeFilter(o)}
                  className={`px-3 py-1 rounded text-xs transition-colors ${
                    outcomeFilter === o ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}>{o}</button>
              ))}
            </div>
            {!historyLoading && (
              <span className="text-xs text-gray-600 ml-auto">{history.length} records</span>
            )}
          </div>

          {historyLoading ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500 animate-pulse">
              Loading...
            </div>
          ) : history.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
              <div className="text-4xl mb-3">📋</div>
              <div className="text-gray-400">No signals in history yet</div>
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 bg-gray-800/50">
                      <th className="text-left px-4 py-2.5">Market</th>
                      <th className="text-left px-4 py-2.5">Side</th>
                      <th className="text-left px-4 py-2.5">Horizon</th>
                      <th className="text-left px-4 py-2.5">Category</th>
                      <th className="text-right px-4 py-2.5">Confidence</th>
                      <th className="text-right px-4 py-2.5">Entry</th>
                      <th className="text-right px-4 py-2.5">Pot. ROI</th>
                      <th className="text-right px-4 py-2.5">Result</th>
                      <th className="text-right px-4 py-2.5">Actual ROI</th>
                      <th className="text-right px-4 py-2.5">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map(r => <SignalRow key={r.id} record={r} />)}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import prisma from '../config/database';
import { gammaClient, parseOutcomePrices } from '../clients/gamma-client';
import { Signal } from './signal-engine';

// ─── Save signals to DB ───────────────────────────────────────────────────────

/**
 * Persists a batch of generated signals to the DB for later accuracy tracking.
 * Skips signals that already exist for the same market+side+horizon+day
 * to avoid duplicate rows on every cron tick.
 */
export async function saveSignals(signals: Signal[]): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let saved = 0;

  for (const s of signals) {
    // One signal per market+side+horizon per calendar day
    const existing = await (prisma as any).signalRecord.findFirst({
      where: {
        marketId: s.marketId,
        side: s.side,
        horizon: s.horizon,
        generatedAt: { gte: today },
      },
    });
    if (existing) continue;

    await (prisma as any).signalRecord.create({
      data: {
        marketId: s.marketId,
        eventId: s.eventId,
        eventTitle: s.eventTitle,
        marketQuestion: s.marketQuestion,
        side: s.side,
        horizon: s.horizon,
        category: s.category,
        anomalyTypes: JSON.stringify(s.anomalyTypes),
        reasons: JSON.stringify(s.reasons.slice(0, 5)),
        confidence: s.confidence,
        confidenceLevel: s.confidenceLevel,
        entryPrice: s.entryPrice,
        potentialRoi: s.potentialRoi,
        outcome: 'PENDING',
      },
    });
    saved++;
  }

  return saved;
}

// ─── Resolve pending signals ──────────────────────────────────────────────────

/**
 * For every PENDING signal, checks if the market has resolved.
 * A market resolves when any price hits ≥ 0.995.
 * Updates outcome to WIN/LOSS and records actual ROI.
 */
export async function resolvePendingSignals(): Promise<{ resolved: number; wins: number; losses: number }> {
  const pending = await (prisma as any).signalRecord.findMany({
    where: { outcome: 'PENDING' },
    orderBy: { generatedAt: 'asc' },
    take: 200,
  });

  let resolved = 0, wins = 0, losses = 0;

  for (const record of pending) {
    try {
      const market = await gammaClient.getMarketById(record.marketId).catch(() => null);
      if (!market) continue;

      const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
      if (prices.length === 0) continue;

      const yesPrice = prices[0];
      const noPrice = prices[1] ?? (1 - yesPrice);

      // Check if resolved: one side at 99.5%+
      const isResolved = prices.some((p: number) => p >= 0.995);
      if (!isResolved) {
        // Not resolved yet — check if it expired (past endDate) without resolving
        if (market.endDate) {
          const endDate = new Date(market.endDate);
          const daysPastEnd = (Date.now() - endDate.getTime()) / 86400000;
          if (daysPastEnd > 3) {
            // 3 days past end and still not resolved = VOID (no data)
            await (prisma as any).signalRecord.update({
              where: { id: record.id },
              data: { outcome: 'VOID', resolvedAt: new Date() },
            });
            resolved++;
          }
        }
        continue;
      }

      // Determine winning side
      const wonYes = yesPrice >= 0.995;
      const wonNo = noPrice >= 0.995;

      let outcome: 'WIN' | 'LOSS';
      let exitPrice: number;
      let actualRoi: number;

      if (record.side === 'YES') {
        exitPrice = yesPrice;
        outcome = wonYes ? 'WIN' : 'LOSS';
        actualRoi = wonYes
          ? (1 / record.entryPrice - 1) * 100   // full win: paid $1 for entryPrice stake
          : -100;                                 // full loss
      } else {
        exitPrice = noPrice;
        outcome = wonNo ? 'WIN' : 'LOSS';
        actualRoi = wonNo
          ? (1 / record.entryPrice - 1) * 100
          : -100;
      }

      // CLV: get the most recent price snapshot before resolution
      let closingPrice: number | null = null;
      let clvCents: number | null = null;
      try {
        const snap = await (prisma as any).signalPriceSnapshot.findFirst({
          where: { signalRecordId: record.id },
          orderBy: { snapshotAt: 'desc' },
        });
        if (snap) {
          closingPrice = snap.ourSidePrice;
          clvCents = Math.round((snap.ourSidePrice - record.entryPrice) * 10000) / 100;
        }
      } catch { /* non-critical */ }

      await (prisma as any).signalRecord.update({
        where: { id: record.id },
        data: {
          outcome,
          resolvedAt: new Date(),
          exitPrice,
          actualRoi,
          closingPrice,
          clvCents,
        },
      });

      resolved++;
      if (outcome === 'WIN') wins++;
      else losses++;
    } catch {
      // skip individual failures silently
    }
  }

  return { resolved, wins, losses };
}

// ─── Accuracy stats ───────────────────────────────────────────────────────────

export interface AccuracyStats {
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
  recent: RecentSignal[];
  topWins: RecentSignal[];
}

interface HorizonStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  avgRoi: number;
}

export interface RecentSignal {
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

function groupStats(records: any[]): HorizonStats {
  const resolved = records.filter(r => r.outcome === 'WIN' || r.outcome === 'LOSS');
  const wins = resolved.filter(r => r.outcome === 'WIN');
  const rois = resolved.filter(r => r.actualRoi != null).map(r => r.actualRoi as number);

  return {
    total: records.length,
    wins: wins.length,
    losses: resolved.length - wins.length,
    winRate: resolved.length > 0 ? Math.round((wins.length / resolved.length) * 100) : 0,
    avgRoi: rois.length > 0 ? Math.round(rois.reduce((a, b) => a + b, 0) / rois.length) : 0,
  };
}

export async function getAccuracyStats(): Promise<AccuracyStats> {
  const all = await (prisma as any).signalRecord.findMany({
    orderBy: { generatedAt: 'desc' },
    take: 1000,
  });

  const resolved = all.filter((r: any) => r.outcome !== 'PENDING' && r.outcome !== 'VOID');
  const wins = resolved.filter((r: any) => r.outcome === 'WIN');
  const losses = resolved.filter((r: any) => r.outcome === 'LOSS');
  const rois = resolved.filter((r: any) => r.actualRoi != null).map((r: any) => r.actualRoi as number);
  const confidences = all.map((r: any) => r.confidence as number);

  const byHorizon: Record<string, HorizonStats> = {};
  for (const h of ['fast', 'medium', 'long']) {
    byHorizon[h] = groupStats(all.filter((r: any) => r.horizon === h));
  }

  const categories: string[] = [...new Set<string>(all.map((r: any) => r.category as string))];
  const byCategory: Record<string, HorizonStats> = {};
  for (const cat of categories) {
    byCategory[cat] = groupStats(all.filter((r: any) => r.category === cat));
  }

  const byConfidenceLevel: Record<string, HorizonStats> = {};
  for (const cl of ['strong', 'good', 'speculative']) {
    byConfidenceLevel[cl] = groupStats(all.filter((r: any) => r.confidenceLevel === cl));
  }

  // Calibration: confidence buckets
  const byConfidenceBucket: Record<string, HorizonStats> = {};
  const buckets = [
    { label: '40-49', min: 40, max: 50 },
    { label: '50-59', min: 50, max: 60 },
    { label: '60-69', min: 60, max: 70 },
    { label: '70-79', min: 70, max: 80 },
    { label: '80+', min: 80, max: 101 },
  ];
  for (const b of buckets) {
    byConfidenceBucket[b.label] = groupStats(
      all.filter((r: any) => r.confidence >= b.min && r.confidence < b.max)
    );
  }

  // CLV stats
  const clvRecords = resolved.filter((r: any) => r.clvCents != null);
  const avgClvCents = clvRecords.length > 0
    ? Math.round(clvRecords.reduce((s: number, r: any) => s + (r.clvCents as number), 0) / clvRecords.length * 100) / 100
    : null;
  const pctPositiveClv = clvRecords.length > 0
    ? Math.round(clvRecords.filter((r: any) => r.clvCents > 0).length / clvRecords.length * 100)
    : null;

  function formatRecord(r: any): RecentSignal {
    return {
      id: r.id,
      marketQuestion: r.marketQuestion,
      eventTitle: r.eventTitle,
      side: r.side,
      horizon: r.horizon,
      category: r.category,
      confidence: r.confidence,
      confidenceLevel: r.confidenceLevel,
      entryPrice: r.entryPrice,
      potentialRoi: r.potentialRoi,
      outcome: r.outcome,
      actualRoi: r.actualRoi,
      anomalyTypes: (() => { try { return JSON.parse(r.anomalyTypes); } catch { return []; } })(),
      reasons: (() => { try { return JSON.parse(r.reasons); } catch { return []; } })(),
      generatedAt: r.generatedAt?.toISOString?.() ?? r.generatedAt,
      resolvedAt: r.resolvedAt?.toISOString?.() ?? r.resolvedAt ?? null,
    };
  }

  const recent = all.slice(0, 30).map(formatRecord);
  const topWins = resolved
    .filter((r: any) => r.outcome === 'WIN' && r.actualRoi != null)
    .sort((a: any, b: any) => b.actualRoi - a.actualRoi)
    .slice(0, 10)
    .map(formatRecord);

  return {
    overall: {
      total: all.length,
      pending: all.filter((r: any) => r.outcome === 'PENDING').length,
      resolved: resolved.length,
      wins: wins.length,
      losses: losses.length,
      voids: all.filter((r: any) => r.outcome === 'VOID').length,
      winRate: resolved.length > 0 ? Math.round((wins.length / resolved.length) * 100) : 0,
      avgRoi: rois.length > 0 ? Math.round(rois.reduce((a: number, b: number) => a + b, 0) / rois.length) : 0,
      avgConfidence: confidences.length > 0
        ? Math.round(confidences.reduce((a: number, b: number) => a + b, 0) / confidences.length)
        : 0,
      avgClvCents,
      pctPositiveClv,
    },
    byHorizon,
    byCategory,
    byConfidenceLevel,
    byConfidenceBucket,
    recent,
    topWins,
  };
}

export async function getSignalHistory(
  limit = 50,
  horizon?: string,
  outcome?: string,
): Promise<RecentSignal[]> {
  const where: any = {};
  if (horizon && horizon !== 'all') where.horizon = horizon;
  if (outcome && outcome !== 'all') where.outcome = outcome;

  const records = await (prisma as any).signalRecord.findMany({
    where,
    orderBy: { generatedAt: 'desc' },
    take: Math.min(limit, 200),
  });

  return records.map((r: any) => ({
    id: r.id,
    marketQuestion: r.marketQuestion,
    eventTitle: r.eventTitle,
    side: r.side,
    horizon: r.horizon,
    category: r.category,
    confidence: r.confidence,
    confidenceLevel: r.confidenceLevel,
    entryPrice: r.entryPrice,
    potentialRoi: r.potentialRoi,
    outcome: r.outcome,
    actualRoi: r.actualRoi,
    anomalyTypes: (() => { try { return JSON.parse(r.anomalyTypes); } catch { return []; } })(),
    reasons: (() => { try { return JSON.parse(r.reasons); } catch { return []; } })(),
    generatedAt: r.generatedAt?.toISOString?.() ?? r.generatedAt,
    resolvedAt: r.resolvedAt?.toISOString?.() ?? r.resolvedAt ?? null,
  }));
}

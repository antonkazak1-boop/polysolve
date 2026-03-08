'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';

interface Signal {
  id: string;
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  marketId: string;
  marketQuestion: string;
  side: 'YES' | 'NO';
  horizon: 'fast' | 'medium' | 'long';
  confidence: number;
  confidenceLevel: 'strong' | 'good' | 'speculative';
  entryPrice: number;
  roiMultiple: number;
  daysUntilClose: number | null;
  reasons: string[];
  category: string;
}

function fmtTimeLeft(days: number | null): string {
  if (days === null) return '—';
  if (days <= 0) return 'Today';
  const hours = Math.round(days * 24);
  if (hours <= 24) return `${hours}h`;
  return `${days}d`;
}

function polymarketUrl(slug?: string, id?: string) {
  if (slug) return `https://polymarket.com/event/${slug}`;
  return `https://polymarket.com/event/${id}`;
}

const HORIZON_CFG = {
  fast:   { icon: '⚡', color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20' },
  medium: { icon: '⏳', color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/20' },
  long:   { icon: '📅', color: 'text-blue-400',   bg: 'bg-blue-500/10 border-blue-500/20' },
};

export default function SignalsPreview({ limit = 5 }: { limit?: number }) {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/signals', { params: { limit, horizon: 'all' } })
      .then(res => setSignals(res.data.signals?.slice(0, limit) || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [limit]);

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-3 animate-pulse h-20" />
        ))}
      </div>
    );
  }

  if (signals.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center text-gray-500 text-sm">
        No signals available right now
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {signals.map(s => {
        const hcfg = HORIZON_CFG[s.horizon];
        const isYes = s.side === 'YES';
        const pmUrl = polymarketUrl(s.eventSlug, s.eventId);

        return (
          <div key={s.id} className="bg-gray-900 border border-gray-800 rounded-xl p-3 hover:border-gray-700 transition-all">
            <div className="flex items-center gap-3">
              {/* Side badge compact */}
              <div className={`shrink-0 w-14 text-center py-1.5 rounded-lg text-xs font-bold ${
                isYes
                  ? 'bg-green-500/15 text-green-400 border border-green-500/20'
                  : 'bg-red-500/15 text-red-400 border border-red-500/20'
              }`}>
                {s.side}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-100 truncate font-medium">
                  {s.marketQuestion !== s.eventTitle ? s.marketQuestion : s.eventTitle}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${hcfg.bg} ${hcfg.color}`}>
                    {hcfg.icon} {s.horizon.toUpperCase()} · {fmtTimeLeft(s.daysUntilClose)}
                  </span>
                  <span className="text-[10px] text-gray-500">{s.reasons[0]?.slice(0, 50)}</span>
                </div>
              </div>

              {/* Price + ROI */}
              <div className="shrink-0 text-right">
                <div className="text-sm font-bold text-white font-mono">{(s.entryPrice * 100).toFixed(0)}¢</div>
                <div className="text-xs text-yellow-400 font-mono">{s.roiMultiple.toFixed(1)}x</div>
              </div>

              {/* Confidence */}
              <div className="shrink-0 text-right w-12">
                <div className={`text-xs font-medium ${
                  s.confidenceLevel === 'strong' ? 'text-green-400' :
                  s.confidenceLevel === 'good' ? 'text-yellow-400' : 'text-gray-500'
                }`}>
                  {s.confidence}%
                </div>
              </div>

              {/* Links */}
              <div className="shrink-0 flex gap-1">
                <Link href={`/events/${s.eventId}`} className="text-[10px] text-blue-400 hover:underline">↗</Link>
                <a href={pmUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-green-400 hover:underline">PM</a>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

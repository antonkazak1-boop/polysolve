'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';

interface Recommendation {
  rank: number;
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  marketId: string;
  marketQuestion: string;
  outcome: string;
  price: number;
  potentialRoi: number;
  volume24hr: number;
  liquidity: number;
  tags: string[];
  score: number;
  anomalyScore: number;
  roiScore: number;
  volumeScore: number;
  newsScore: number;
  liquidityScore: number;
  politicsBoost: number;
  reasoning: string;
  category: string;
  isIranCrisis: boolean;
  isPolitics: boolean;
  news?: {
    summary: string;
    sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    sentimentScore: number;
    relevance: number;
    keyPoints: string[];
  };
  correlationWarning?: string;
  marketEfficiency?: number;
  suggestedStakePct?: number;
  generatedAt: string;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function fmtRoi(roi: number): string {
  if (roi >= 10000) return `${(roi / 100).toFixed(0)}x`;
  if (roi >= 1000) return `${(roi / 100).toFixed(1)}x`;
  return `+${roi.toFixed(0)}%`;
}

const CATEGORY_STYLE: Record<string, { bg: string; text: string; border: string }> = {
  'Iran / Middle East': { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
  Politics: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
  Crypto: { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/30' },
  Sports: { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/30' },
  Economy: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/30' },
};

const SENTIMENT_COLOR: Record<string, string> = {
  BULLISH: 'text-green-400',
  BEARISH: 'text-red-400',
  NEUTRAL: 'text-gray-400',
};

function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="text-xs text-gray-500 w-20 shrink-0">{label}</div>
      <div className="flex-1 bg-gray-800 rounded-full h-1.5">
        <div className="h-1.5 rounded-full bg-blue-500/60" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-gray-400 w-6 text-right">{Math.round(value)}</div>
    </div>
  );
}

function RecommendationCard({ rec, onTrade }: { rec: Recommendation; onTrade?: (rec: Recommendation) => void }) {
  const [expanded, setExpanded] = useState(false);
  const catStyle = CATEGORY_STYLE[rec.category] ?? { bg: 'bg-gray-700', text: 'text-gray-300', border: 'border-gray-600' };

  return (
    <div className={`bg-gray-900 border rounded-xl overflow-hidden ${rec.isIranCrisis ? 'border-red-500/40' : rec.isPolitics ? 'border-blue-500/30' : 'border-gray-800'}`}>
      <div className="p-4">
        <div className="flex items-start gap-3">
          {/* Rank */}
          <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${rec.rank <= 3 ? 'bg-yellow-500/20 text-yellow-400' : 'bg-gray-800 text-gray-400'}`}>
            {rec.rank}
          </div>
          <div className="flex-1 min-w-0">
            {/* Category + tags */}
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${catStyle.bg} ${catStyle.text} ${catStyle.border}`}>
                {rec.isIranCrisis && '🚨 '}{rec.category}
              </span>
              {rec.isPolitics && !rec.isIranCrisis && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">🏛️ Politics</span>}
              {rec.anomalyScore > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">⚡ Anomaly</span>}
            </div>

            {/* Title */}
            <div className="text-xs text-gray-500 truncate mb-0.5">{rec.eventTitle}</div>
            <h3 className="text-sm font-medium text-gray-100 leading-snug line-clamp-2 mb-3">{rec.marketQuestion}</h3>

            {/* Price + ROI */}
            <div className="flex items-center gap-3">
              <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 text-center">
                <div className="text-xs text-gray-400 mb-0.5">YES price</div>
                <div className="text-xl font-bold text-green-400 font-mono">{(rec.price * 100).toFixed(0)}¢</div>
              </div>
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 text-center">
                <div className="text-xs text-gray-400 mb-0.5">Potential ROI</div>
                <div className="text-xl font-bold text-yellow-400 font-mono">{fmtRoi(rec.potentialRoi)}</div>
              </div>
              <div className="flex-1 text-xs text-gray-500 space-y-1">
                <div>Vol 24h: <span className="text-gray-300">{fmt(rec.volume24hr)}</span></div>
                <div>Liq: <span className="text-gray-300">{fmt(rec.liquidity)}</span></div>
                <div>Score: <span className="text-white font-bold">{Math.round(rec.score)}</span></div>
              </div>
            </div>
          </div>
        </div>

        {/* Reasoning */}
        {rec.reasoning && (
          <div className="mt-3 text-xs text-gray-400 leading-relaxed bg-gray-800/40 rounded-lg px-3 py-2">
            {rec.reasoning}
          </div>
        )}

        {/* News summary */}
        {rec.news && rec.news.relevance > 30 && (
          <div className="mt-3 border-t border-gray-800 pt-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-gray-500">📰 News</span>
              <span className={`text-xs font-medium ${SENTIMENT_COLOR[rec.news.sentiment]}`}>
                {rec.news.sentiment}
              </span>
              <span className="text-xs text-gray-600">relevance {rec.news.relevance}%</span>
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">{rec.news.summary}</p>
            {expanded && rec.news.keyPoints.length > 0 && (
              <ul className="mt-2 space-y-1">
                {rec.news.keyPoints.map((pt, i) => (
                  <li key={i} className="text-xs text-gray-500 flex gap-1.5">
                    <span className="text-gray-600 shrink-0">•</span>{pt}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Score breakdown (expanded) */}
        {expanded && (
          <div className="mt-3 border-t border-gray-800 pt-3 space-y-1.5">
            <div className="text-xs text-gray-500 mb-2">Score breakdown (total: {Math.round(rec.score)})</div>
            <ScoreBar label="ROI" value={rec.roiScore} max={40} />
            <ScoreBar label="Volume" value={rec.volumeScore} max={20} />
            <ScoreBar label="Liquidity" value={rec.liquidityScore} max={10} />
            <ScoreBar label="Anomaly" value={rec.anomalyScore} max={30} />
            <ScoreBar label="News" value={rec.newsScore} max={15} />
            <ScoreBar label="Politics+" value={rec.politicsBoost} max={15} />
          </div>
        )}

        {/* Correlation warning + efficiency + Kelly */}
        <div className="flex items-center flex-wrap gap-2 mt-2 text-[10px]">
          {rec.correlationWarning && (
            <span className="bg-yellow-500/10 text-yellow-400 border border-yellow-500/15 px-2 py-0.5 rounded">
              ⚠ {rec.correlationWarning}
            </span>
          )}
          {rec.marketEfficiency != null && (
            <span className={`px-2 py-0.5 rounded ${
              rec.marketEfficiency < 30 ? 'bg-green-500/10 text-green-500 border border-green-500/15' :
              rec.marketEfficiency < 60 ? 'bg-gray-800 text-gray-400 border border-gray-700' :
              'bg-gray-800 text-gray-600 border border-gray-700'
            }`}>
              Efficiency: {rec.marketEfficiency < 30 ? 'Low' : rec.marketEfficiency < 60 ? 'Mid' : 'High'} ({rec.marketEfficiency})
            </span>
          )}
          <span className="bg-blue-500/10 text-blue-400 border border-blue-500/15 px-2 py-0.5 rounded" title="Рек. % банкролла по Кelly (макс. 5%)">
            Kelly: {rec.suggestedStakePct != null ? `${rec.suggestedStakePct.toFixed(1)}%` : '—'} stake
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-3">
          <Link
            href={`/events/${rec.eventId}`}
            className="flex-1 text-center bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs py-2 rounded-lg transition-colors"
          >
            View Details
          </Link>
          <a
            href={`https://polymarket.com/event/${rec.eventSlug || rec.eventId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 bg-blue-600/20 hover:bg-blue-600/40 border border-blue-500/30 text-blue-400 text-xs px-3 py-2 rounded-lg transition-colors"
            title="Open on Polymarket"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            PM
          </a>
          {onTrade && (
            <button
              onClick={() => onTrade(rec)}
              className="flex-1 bg-green-600 hover:bg-green-500 text-white text-xs py-2 rounded-lg font-semibold transition-colors"
            >
              Demo Trade
            </button>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 text-xs rounded-lg transition-colors"
          >
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface TopRecommendationsProps {
  limit?: number;
  compact?: boolean;
  onTrade?: (rec: Recommendation) => void;
  refreshKey?: number;
}

export default function TopRecommendations({ limit = 10, compact = false, onTrade, refreshKey = 0 }: TopRecommendationsProps) {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generatedAt, setGeneratedAt] = useState('');

  useEffect(() => {
    setLoading(true);
    api.get('/recommendations', { params: { limit, skipNews: compact ? 'true' : 'false' } })
      .then(res => {
        setRecommendations(res.data.recommendations ?? []);
        setGeneratedAt(res.data.generatedAt ?? '');
      })
      .catch(() => setError('Failed to load recommendations'))
      .finally(() => setLoading(false));
  }, [limit, compact, refreshKey]);

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: compact ? 3 : 5 }).map((_, i) => (
          <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 animate-pulse h-36" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-red-400 text-sm">{error}</div>
    );
  }

  if (recommendations.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center text-gray-500 text-sm">
        No recommendations available right now
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {generatedAt && !compact && (
        <div className="text-xs text-gray-600 text-right">
          Updated {new Date(generatedAt).toLocaleTimeString()}
        </div>
      )}
      {(compact ? recommendations.slice(0, 3) : recommendations).map(rec => (
        <RecommendationCard key={`${rec.eventId}-${rec.marketId}`} rec={rec} onTrade={onTrade} />
      ))}
    </div>
  );
}

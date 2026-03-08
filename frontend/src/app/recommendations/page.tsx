'use client';

import { useState, useEffect, useCallback } from 'react';
import TopRecommendations from '@/components/TopRecommendations';
import DemoTradeModal from '@/components/DemoTradeModal';
import api from '@/lib/api';

interface ScoringWeights {
  newsRelevance: number;
  newsSideBonus: number;
  newsTotal: number;
  momentum: number;
  anomaly: number;
  volume: number;
  consensus: number;
  roiPotential: number;
  numbersTotalCap: number;
  numbersOutputWeight: number;
  generalPenalty: number;
  sportsPenalty: number;
  cryptoBoost: number;
  politicsBoost: number;
  economyBoost: number;
}

interface WeightField {
  key: keyof ScoringWeights;
  label: string;
  group: 'news' | 'numbers' | 'mixing' | 'category';
  min: number;
  max: number;
  step: number;
  description: string;
}

const WEIGHT_FIELDS: WeightField[] = [
  { key: 'newsRelevance',      label: 'News Relevance',      group: 'news',     min: 0, max: 80, step: 5, description: 'Weight for Perplexity relevance score' },
  { key: 'newsSideBonus',      label: 'News Side Bonus',     group: 'news',     min: 0, max: 40, step: 2, description: 'Bonus when news agrees with numbers' },
  { key: 'newsTotal',          label: 'News Cap',            group: 'news',     min: 20, max: 100, step: 5, description: 'Max total news contribution' },
  { key: 'momentum',           label: 'Momentum',            group: 'numbers',  min: 0, max: 30, step: 1, description: 'Max pts from day price change' },
  { key: 'anomaly',            label: 'Anomaly',             group: 'numbers',  min: 0, max: 30, step: 1, description: 'Max pts from anomaly detector' },
  { key: 'volume',             label: 'Volume 24h',          group: 'numbers',  min: 0, max: 20, step: 1, description: 'Max pts from trading volume' },
  { key: 'consensus',          label: 'Consensus',           group: 'numbers',  min: 0, max: 20, step: 1, description: 'Max pts from vote agreement' },
  { key: 'roiPotential',       label: 'ROI Potential',       group: 'numbers',  min: 0, max: 30, step: 1, description: 'Max pts from cheap entry price' },
  { key: 'numbersTotalCap',    label: 'Numbers Cap',         group: 'mixing',   min: 20, max: 100, step: 5, description: 'Max total for numbers score' },
  { key: 'numbersOutputWeight',label: 'Numbers Weight',      group: 'mixing',   min: 10, max: 60, step: 5, description: 'Numbers share of final confidence (out of 100)' },
  { key: 'generalPenalty',     label: 'General Penalty',     group: 'category', min: -40, max: 10, step: 5, description: 'Modifier for General (20% win rate)' },
  { key: 'sportsPenalty',      label: 'Sports Modifier',     group: 'category', min: -30, max: 10, step: 5, description: 'Modifier for Sports (-3% avg ROI)' },
  { key: 'cryptoBoost',        label: 'Crypto Boost',        group: 'category', min: -10, max: 30, step: 2, description: 'Boost for Crypto (+55% avg ROI)' },
  { key: 'politicsBoost',      label: 'Politics Boost',      group: 'category', min: -10, max: 20, step: 1, description: 'Boost for Politics / Iran' },
  { key: 'economyBoost',       label: 'Economy Boost',       group: 'category', min: -10, max: 20, step: 1, description: 'Boost for Economy category' },
];

const GROUP_LABELS: Record<string, { title: string; color: string }> = {
  news: { title: 'News / Perplexity', color: 'text-cyan-400' },
  numbers: { title: 'Numerical Signals', color: 'text-purple-400' },
  mixing: { title: 'Score Mixing', color: 'text-blue-400' },
  category: { title: 'Category Modifiers', color: 'text-yellow-400' },
};

export default function RecommendationsPage() {
  const [tradeMarket, setTradeMarket] = useState<any>(null);
  const [tradeSuccess, setTradeSuccess] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [weights, setWeights] = useState<ScoringWeights | null>(null);
  const [defaults, setDefaults] = useState<ScoringWeights | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [weightsOpen, setWeightsOpen] = useState(false);

  const loadWeights = useCallback(async () => {
    try {
      const res = await api.get('/signals/weights');
      setWeights(res.data.weights);
      setDefaults(res.data.defaults);
      setDirty(false);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadWeights(); }, [loadWeights]);

  function updateWeight(key: keyof ScoringWeights, val: number) {
    if (!weights) return;
    setWeights({ ...weights, [key]: val });
    setDirty(true);
  }

  async function saveWeights() {
    if (!weights) return;
    setSaving(true);
    try {
      await api.post('/signals/weights', weights);
      setDirty(false);
      setRefreshKey(k => k + 1);
    } catch { /* silent */ }
    setSaving(false);
  }

  async function doReset() {
    setSaving(true);
    try {
      const res = await api.post('/signals/weights/reset');
      setWeights(res.data.weights);
      setDirty(false);
      setRefreshKey(k => k + 1);
    } catch { /* silent */ }
    setSaving(false);
  }

  function handleTrade(rec: any) {
    setTradeMarket({
      eventId: rec.eventId,
      eventTitle: rec.eventTitle,
      marketId: rec.marketId,
      marketQuestion: rec.marketQuestion,
      prices: [rec.price, 1 - rec.price],
      outcomes: ['Yes', 'No'],
      tags: rec.tags,
    });
  }

  const groups = ['news', 'numbers', 'mixing', 'category'] as const;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Top Recommendations</h1>
          <p className="text-gray-500 text-sm mt-1">
            AI-scored events combining anomaly detection, ROI potential, volume momentum, and news sentiment.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setWeightsOpen(o => !o)}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-3 py-2 rounded-xl text-sm transition-colors"
          >
            {weightsOpen ? '▾ Hide Weights' : '▸ Scoring Weights'}
          </button>
          <button
            onClick={() => setRefreshKey(k => k + 1)}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-4 py-2 rounded-xl text-sm transition-colors"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Interactive Weight Editor */}
      {weightsOpen && weights && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-white">Scoring Weight Configuration</div>
            <div className="flex items-center gap-2">
              {dirty && (
                <span className="text-[10px] px-2 py-0.5 bg-yellow-500/20 text-yellow-400 rounded border border-yellow-500/30">
                  unsaved changes
                </span>
              )}
              <button
                onClick={doReset}
                disabled={saving}
                className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 border border-gray-700 transition-colors disabled:opacity-50"
              >
                Reset Defaults
              </button>
              <button
                onClick={saveWeights}
                disabled={saving || !dirty}
                className="text-xs px-3 py-1.5 rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save & Regenerate'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {groups.map(group => {
              const meta = GROUP_LABELS[group];
              const fields = WEIGHT_FIELDS.filter(f => f.group === group);
              return (
                <div key={group} className="bg-gray-800/50 rounded-lg p-3 space-y-3">
                  <div className={`text-xs font-bold ${meta.color} uppercase tracking-wider`}>
                    {meta.title}
                  </div>
                  {fields.map(f => {
                    const val = weights[f.key];
                    const def = defaults?.[f.key];
                    const isDefault = val === def;
                    return (
                      <div key={f.key} className="space-y-1">
                        <div className="flex items-center justify-between">
                          <label className="text-xs text-gray-400" title={f.description}>
                            {f.label}
                          </label>
                          <div className="flex items-center gap-2">
                            {!isDefault && (
                              <span className="text-[9px] text-gray-600">def: {def}</span>
                            )}
                            <input
                              type="number"
                              value={val}
                              min={f.min}
                              max={f.max}
                              step={f.step}
                              onChange={e => updateWeight(f.key, Number(e.target.value))}
                              className="w-16 text-right text-xs bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-white focus:border-cyan-500 focus:outline-none"
                            />
                          </div>
                        </div>
                        <input
                          type="range"
                          value={val}
                          min={f.min}
                          max={f.max}
                          step={f.step}
                          onChange={e => updateWeight(f.key, Number(e.target.value))}
                          className="w-full h-1.5 rounded-full appearance-none bg-gray-700 accent-cyan-500 cursor-pointer"
                        />
                        <div className="flex justify-between text-[9px] text-gray-600">
                          <span>{f.min}</span>
                          <span className="text-gray-500 italic">{f.description}</span>
                          <span>{f.max}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Quick summary */}
          <div className="bg-gray-800/30 rounded-lg p-3 text-xs text-gray-500">
            <span className="text-gray-400 font-medium">Formula: </span>
            confidence = news_score (0–{weights.newsTotal}) + numbers_score (0–{weights.numbersTotalCap}) scaled to {weights.numbersOutputWeight}pts + category_modifier
            <span className="text-gray-600 ml-2">| News ~{Math.round(weights.newsTotal / (weights.newsTotal + weights.numbersOutputWeight) * 100)}%, Numbers ~{Math.round(weights.numbersOutputWeight / (weights.newsTotal + weights.numbersOutputWeight) * 100)}%</span>
          </div>
        </div>
      )}

      {tradeSuccess && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 text-sm px-4 py-3 rounded-xl flex items-center justify-between">
          <span>✓ {tradeSuccess}</span>
          <button onClick={() => setTradeSuccess(null)} className="ml-4 text-green-600 hover:text-green-400">×</button>
        </div>
      )}

      <TopRecommendations limit={10} compact={false} onTrade={handleTrade} refreshKey={refreshKey} />

      {tradeMarket && (
        <DemoTradeModal
          eventId={tradeMarket.eventId}
          eventTitle={tradeMarket.eventTitle}
          marketId={tradeMarket.marketId}
          marketQuestion={tradeMarket.marketQuestion}
          prices={tradeMarket.prices}
          outcomes={tradeMarket.outcomes}
          tags={tradeMarket.tags}
          onClose={() => setTradeMarket(null)}
          onSuccess={(trade, newBal) => {
            setTradeMarket(null);
            setTradeSuccess(`Opened ${trade.outcome} — $${trade.amount.toFixed(0)}. New balance: $${newBal.toFixed(0)}`);
          }}
        />
      )}
    </div>
  );
}

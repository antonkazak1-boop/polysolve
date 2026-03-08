'use client';

import { useEffect, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, CartesianGrid, Area, AreaChart,
} from 'recharts';
import api from '@/lib/api';

interface HistoryPoint {
  date: string;
  pnl: number;
  roi: number;
  cumPnl: number;
  status: string;
  label: string;
}

interface EquityChartProps {
  refreshKey?: number;
  startingBalance?: number;
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-xs shadow-xl max-w-xs">
      <div className="text-gray-400 mb-2">{new Date(d.date).toLocaleDateString()}</div>
      <div className="font-medium text-white truncate mb-1">{d.label}</div>
      <div className={`font-bold ${d.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
        Trade P&L: {d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}
      </div>
      <div className={`${d.cumPnl >= 0 ? 'text-green-300' : 'text-red-300'}`}>
        Total P&L: {d.cumPnl >= 0 ? '+' : ''}${d.cumPnl.toFixed(2)}
      </div>
      <div className="text-gray-500 mt-1 capitalize">{d.status.toLowerCase().replace(/_/g, ' ')}</div>
    </div>
  );
}

export default function EquityChart({ refreshKey = 0, startingBalance = 10000 }: EquityChartProps) {
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [totalPnl, setTotalPnl] = useState(0);
  const [currentBalance, setCurrentBalance] = useState(startingBalance);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/portfolio/demo/history')
      .then(res => {
        setHistory(res.data.history ?? []);
        setTotalPnl(res.data.totalPnl ?? 0);
        setCurrentBalance(res.data.currentBalance ?? startingBalance);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [refreshKey]);

  if (loading) {
    return <div className="h-48 bg-gray-800/40 rounded-2xl animate-pulse" />;
  }

  if (history.length === 0) {
    return (
      <div className="h-48 bg-gray-900 border border-gray-800 rounded-2xl flex items-center justify-center">
        <div className="text-center text-gray-500 text-sm">
          <div className="text-2xl mb-2">📈</div>
          <div>No closed trades yet</div>
          <div className="text-xs text-gray-600 mt-1">Open and close trades to see your equity curve</div>
        </div>
      </div>
    );
  }

  // Build chart data: starting point + each closed trade
  const chartData = [
    { date: history[0]?.date, cumPnl: 0, pnl: 0, label: 'Start', status: 'START' },
    ...history,
  ];

  const totalRoi = ((currentBalance - startingBalance) / startingBalance) * 100;
  const isPositive = totalPnl >= 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm text-gray-400">Total P&L: </span>
          <span className={`text-lg font-bold font-mono ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
            {isPositive ? '+' : ''}${totalPnl.toFixed(2)}
          </span>
          <span className={`ml-2 text-sm ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
            ({isPositive ? '+' : ''}{totalRoi.toFixed(1)}%)
          </span>
        </div>
        <div className="text-sm text-gray-500">
          Balance: <span className="text-white font-mono">${currentBalance.toFixed(0)}</span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <defs>
            <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0.3} />
              <stop offset="95%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis
            dataKey="date"
            tickFormatter={d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            tick={{ fontSize: 10, fill: '#6b7280' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={v => `$${v >= 0 ? '+' : ''}${v.toFixed(0)}`}
            tick={{ fontSize: 10, fill: '#6b7280' }}
            axisLine={false}
            tickLine={false}
            width={60}
          />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="4 4" />
          <Area
            type="monotone"
            dataKey="cumPnl"
            stroke={isPositive ? '#22c55e' : '#ef4444'}
            strokeWidth={2}
            fill="url(#pnlGrad)"
            dot={(props: any) => {
              const d = props.payload;
              if (!d.status || d.status === 'START') return <g key={props.key} />;
              const color = d.pnl >= 0 ? '#22c55e' : '#ef4444';
              return <circle key={props.key} cx={props.cx} cy={props.cy} r={4} fill={color} stroke="#111827" strokeWidth={2} />;
            }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

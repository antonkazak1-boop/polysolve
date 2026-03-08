'use client';

import { formatRoi } from '@/lib/utils';

interface PortfolioOverviewProps {
  stats: {
    totalBalance: number;
    totalInvested: number;
    totalPnl: number;
    totalRoi: number;
    activePositions: number;
    wonPositions: number;
    lostPositions: number;
    averageRoi: number;
    winRate: number;
  } | null;
}

export default function PortfolioOverview({ stats }: PortfolioOverviewProps) {
  if (!stats) {
    return <div className="text-center p-8">Загрузка статистики...</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-sm text-gray-400 mb-2">Общий баланс</h3>
        <p className="text-2xl font-bold">${stats.totalBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-sm text-gray-400 mb-2">Общий P&L</h3>
        <p className={`text-2xl font-bold ${stats.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          ${stats.totalPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </p>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-sm text-gray-400 mb-2">Общий ROI</h3>
        <p className={`text-2xl font-bold ${stats.totalRoi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {stats.totalRoi.toFixed(2)}%
        </p>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-sm text-gray-400 mb-2">Активные позиции</h3>
        <p className="text-2xl font-bold">{stats.activePositions}</p>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-sm text-gray-400 mb-2">Выигранные</h3>
        <p className="text-2xl font-bold text-green-400">{stats.wonPositions}</p>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-sm text-gray-400 mb-2">Проигранные</h3>
        <p className="text-2xl font-bold text-red-400">{stats.lostPositions}</p>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-sm text-gray-400 mb-2">Средний ROI</h3>
        <p className={`text-2xl font-bold ${stats.averageRoi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {formatRoi(stats.averageRoi)}
        </p>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-sm text-gray-400 mb-2">Win Rate</h3>
        <p className="text-2xl font-bold">{stats.winRate.toFixed(2)}%</p>
      </div>
    </div>
  );
}

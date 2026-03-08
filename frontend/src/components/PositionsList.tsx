'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { formatRoi } from '@/lib/utils';
import { format } from 'date-fns';

interface Position {
  id: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  amount: number;
  entryPrice: number;
  currentPrice?: number;
  potentialPnl?: number;
  potentialRoi?: number;
  status: string;
  entryTime: Date;
  marketEndDate?: Date;
  market?: {
    question: string;
    category: string;
  };
}

export default function PositionsList() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    fetchPositions();
  }, [filter]);

  const fetchPositions = async () => {
    try {
      const params: any = {};
      if (filter !== 'all') {
        params.status = filter;
      }
      const response = await api.get('/portfolio/positions', { params });
      setPositions(response.data);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching positions:', error);
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="text-center p-8">Загрузка позиций...</div>;
  }

  return (
    <div>
      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setFilter('all')}
          className={`px-4 py-2 rounded ${filter === 'all' ? 'bg-blue-600' : 'bg-gray-700'}`}
        >
          Все
        </button>
        <button
          onClick={() => setFilter('ACTIVE')}
          className={`px-4 py-2 rounded ${filter === 'ACTIVE' ? 'bg-blue-600' : 'bg-gray-700'}`}
        >
          Активные
        </button>
        <button
          onClick={() => setFilter('WON')}
          className={`px-4 py-2 rounded ${filter === 'WON' ? 'bg-blue-600' : 'bg-gray-700'}`}
        >
          Выигранные
        </button>
        <button
          onClick={() => setFilter('LOST')}
          className={`px-4 py-2 rounded ${filter === 'LOST' ? 'bg-blue-600' : 'bg-gray-700'}`}
        >
          Проигранные
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full bg-gray-800 rounded-lg">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="p-4 text-left">Событие</th>
              <th className="p-4 text-left">Направление</th>
              <th className="p-4 text-right">Сумма</th>
              <th className="p-4 text-right">Цена входа</th>
              <th className="p-4 text-right">Текущая цена</th>
              <th className="p-4 text-right">Потенциальный ROI</th>
              <th className="p-4 text-right">P&L</th>
              <th className="p-4 text-left">Статус</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <tr key={position.id} className="border-b border-gray-700 hover:bg-gray-700">
                <td className="p-4">
                  <div className="max-w-xs truncate">
                    {position.market?.question || position.marketId}
                  </div>
                  <div className="text-sm text-gray-400">{position.market?.category}</div>
                </td>
                <td className="p-4">
                  <span className={`px-2 py-1 rounded ${position.outcome === 'YES' ? 'bg-green-600' : 'bg-red-600'}`}>
                    {position.outcome}
                  </span>
                </td>
                <td className="p-4 text-right">${position.amount.toLocaleString()}</td>
                <td className="p-4 text-right">{(position.entryPrice * 100).toFixed(2)}%</td>
                <td className="p-4 text-right">
                  {position.currentPrice ? `${(position.currentPrice * 100).toFixed(2)}%` : '-'}
                </td>
                <td className="p-4 text-right">
                  {position.potentialRoi !== undefined ? (
                    <span className={position.potentialRoi >= 0 ? 'text-green-400' : 'text-red-400'}>
                      {formatRoi(position.potentialRoi)}
                    </span>
                  ) : '-'}
                </td>
                <td className="p-4 text-right">
                  {position.potentialPnl !== undefined ? (
                    <span className={position.potentialPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                      ${position.potentialPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  ) : '-'}
                </td>
                <td className="p-4">
                  <span className={`px-2 py-1 rounded text-sm ${
                    position.status === 'WON' ? 'bg-green-600' :
                    position.status === 'LOST' ? 'bg-red-600' :
                    position.status === 'ACTIVE' ? 'bg-blue-600' :
                    'bg-gray-600'
                  }`}>
                    {position.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {positions.length === 0 && (
        <div className="text-center p-8 text-gray-400">
          Нет позиций
        </div>
      )}
    </div>
  );
}

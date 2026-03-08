'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import api from '@/lib/api';
import { format } from 'date-fns';

interface MarketPrice {
  outcome: string;
  price: number;
  liquidity: number;
  volume24h: number;
  timestamp: Date;
}

interface Market {
  id: string;
  question: string;
  description: string;
  category: string;
  liquidity: number;
  volume: number;
  endDate: Date;
  status: string;
  conditionId: string;
  prices?: MarketPrice[];
}

export default function MarketDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [market, setMarket] = useState<Market | null>(null);
  const [prices, setPrices] = useState<MarketPrice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (params.id) {
      fetchMarket();
      fetchPrices();
    }
  }, [params.id]);

  const fetchMarket = async () => {
    try {
      const response = await api.get(`/markets/${params.id}`);
      setMarket(response.data);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching market:', error);
      setLoading(false);
    }
  };

  const fetchPrices = async () => {
    try {
      const response = await api.get(`/markets/${params.id}/prices`);
      setPrices(response.data);
    } catch (error) {
      console.error('Error fetching prices:', error);
    }
  };

  if (loading) {
    return <div className="text-center p-8">Загрузка...</div>;
  }

  if (!market) {
    return (
      <div className="text-center p-8">
        <p className="text-gray-400 mb-4">Рынок не найден</p>
        <button
          onClick={() => router.back()}
          className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-700"
        >
          Назад
        </button>
      </div>
    );
  }

  const yesPrice = prices.find(p => p.outcome === 'YES');
  const noPrice = prices.find(p => p.outcome === 'NO');

  return (
    <div className="space-y-6">
      <button
        onClick={() => router.back()}
        className="text-blue-400 hover:text-blue-300"
      >
        ← Назад к списку
      </button>

      <div className="bg-gray-800 rounded-lg p-6">
        <h1 className="text-3xl font-bold mb-4">{market.question}</h1>
        <div className="flex gap-4 mb-4">
          <span className="px-3 py-1 rounded bg-gray-700">{market.category}</span>
          <span className={`px-3 py-1 rounded ${
            market.status === 'OPEN' ? 'bg-green-600' :
            market.status === 'CLOSED' ? 'bg-gray-600' :
            'bg-blue-600'
          }`}>
            {market.status}
          </span>
        </div>
        
        {market.description && (
          <p className="text-gray-300 mb-6">{market.description}</p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-gray-700 rounded p-4">
            <div className="text-sm text-gray-400 mb-1">Ликвидность</div>
            <div className="text-2xl font-bold">${(market.liquidity / 1000).toFixed(1)}k</div>
          </div>
          <div className="bg-gray-700 rounded p-4">
            <div className="text-sm text-gray-400 mb-1">Объем</div>
            <div className="text-2xl font-bold">${(market.volume / 1000).toFixed(1)}k</div>
          </div>
          <div className="bg-gray-700 rounded p-4">
            <div className="text-sm text-gray-400 mb-1">Закрытие</div>
            <div className="text-lg">{format(new Date(market.endDate), 'dd.MM.yyyy HH:mm')}</div>
          </div>
        </div>
      </div>

      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-2xl font-semibold mb-4">Котировки</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {yesPrice && (
            <div className="bg-green-900/30 border border-green-600 rounded-lg p-6">
              <div className="text-sm text-gray-400 mb-2">YES</div>
              <div className="text-4xl font-bold mb-2">{(yesPrice.price * 100).toFixed(2)}%</div>
              <div className="text-sm text-gray-400">
                Ликвидность: ${(yesPrice.liquidity / 1000).toFixed(1)}k
              </div>
            </div>
          )}
          {noPrice && (
            <div className="bg-red-900/30 border border-red-600 rounded-lg p-6">
              <div className="text-sm text-gray-400 mb-2">NO</div>
              <div className="text-4xl font-bold mb-2">{(noPrice.price * 100).toFixed(2)}%</div>
              <div className="text-sm text-gray-400">
                Ликвидность: ${(noPrice.liquidity / 1000).toFixed(1)}k
              </div>
            </div>
          )}
        </div>

        {prices.length === 0 && (
          <div className="text-center p-8 text-gray-400">
            Котировки не загружены
          </div>
        )}
      </div>

      {yesPrice && noPrice && (
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-2xl font-semibold mb-4">Анализ</h2>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-400">Сумма вероятностей:</span>
              <span className="font-mono">
                {((yesPrice.price + noPrice.price) * 100).toFixed(2)}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Потенциальный ROI (Yes):</span>
              <span className="font-mono text-green-400">
                {yesPrice.price > 0 ? ((1 / yesPrice.price - 1) * 100).toFixed(1) : 0}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Потенциальный ROI (No):</span>
              <span className="font-mono text-red-400">
                {noPrice.price > 0 ? ((1 / noPrice.price - 1) * 100).toFixed(1) : 0}%
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

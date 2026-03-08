'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { format } from 'date-fns';

interface Alert {
  id: string;
  type: string;
  message: string;
  confidence: number;
  read: boolean;
  createdAt: Date;
}

export default function AlertsList() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAlerts();
  }, []);

  const fetchAlerts = async () => {
    try {
      const response = await api.get('/alerts/unread', {
        params: { limit: 20 },
      });
      setAlerts(response.data);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching alerts:', error);
      setLoading(false);
    }
  };

  const markAsRead = async (alertId: string) => {
    try {
      await api.put(`/alerts/${alertId}/read`);
      setAlerts(alerts.filter(a => a.id !== alertId));
    } catch (error) {
      console.error('Error marking alert as read:', error);
    }
  };

  const getEmoji = (type: string) => {
    switch (type) {
      case 'ASYMMETRIC_RETURNS': return '🚀';
      case 'ARBITRAGE': return '💰';
      case 'NEW_BET': return '📊';
      case 'CLOSING_EVENT': return '⏰';
      case 'PATTERN_DETECTED': return '🔍';
      default: return '📢';
    }
  };

  if (loading) {
    return <div className="text-center p-8">Загрузка алертов...</div>;
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4 space-y-2 max-h-96 overflow-y-auto">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className="bg-gray-700 rounded p-4 hover:bg-gray-600 transition cursor-pointer"
          onClick={() => markAsRead(alert.id)}
        >
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-2xl">{getEmoji(alert.type)}</span>
                <span className="text-sm text-gray-400">{alert.type}</span>
                <span className={`px-2 py-1 rounded text-xs ${
                  alert.confidence >= 80 ? 'bg-green-600' :
                  alert.confidence >= 60 ? 'bg-yellow-600' :
                  'bg-gray-600'
                }`}>
                  {alert.confidence}%
                </span>
              </div>
              <p className="text-sm">{alert.message}</p>
              <p className="text-xs text-gray-400 mt-1">
                {format(new Date(alert.createdAt), 'dd.MM.yyyy HH:mm')}
              </p>
            </div>
          </div>
        </div>
      ))}

      {alerts.length === 0 && (
        <div className="text-center p-8 text-gray-400">
          Нет новых алертов
        </div>
      )}
    </div>
  );
}

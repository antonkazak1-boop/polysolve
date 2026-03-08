'use client';

import EventsList from '@/components/EventsList';

export default function EventsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Markets</h1>
        <p className="text-gray-500 text-sm mt-1">Browse all active Polymarket events</p>
      </div>
      <EventsList />
    </div>
  );
}

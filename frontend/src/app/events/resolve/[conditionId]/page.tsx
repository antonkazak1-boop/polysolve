'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';

/** Resolves conditionId to event slug and redirects to event page. Used when opening a wallet position that has no eventSlug. */
export default function ResolveEventPage() {
  const params = useParams();
  const router = useRouter();
  const conditionId = (params?.conditionId as string) || '';
  const [status, setStatus] = useState<'loading' | 'found' | 'not_found' | 'error'>('loading');
  const [slug, setSlug] = useState<string | null>(null);

  useEffect(() => {
    if (!conditionId) {
      setStatus('error');
      return;
    }
    api
      .get(`/events/resolve-condition/${encodeURIComponent(conditionId)}`)
      .then((res) => {
        const s = res.data?.slug ?? res.data?.eventId;
        if (s) {
          setSlug(s);
          setStatus('found');
          router.replace(`/events/${s}`);
        } else {
          setStatus('not_found');
        }
      })
      .catch(() => setStatus('not_found'));
  }, [conditionId, router]);

  if (status === 'loading') {
    return (
      <div className="max-w-md mx-auto text-center py-20">
        <div className="animate-spin text-4xl text-cyan-400 mb-4">⟳</div>
        <p className="text-gray-400">Ищем событие по рынку...</p>
      </div>
    );
  }

  if (status === 'found' && slug) {
    return (
      <div className="max-w-md mx-auto text-center py-20">
        <p className="text-gray-400">Переход к событию...</p>
        <Link href={`/events/${slug}`} className="text-cyan-400 hover:underline mt-2 inline-block">
          Открыть событие →
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto text-center py-20">
      <div className="text-4xl mb-4">⚠️</div>
      <h1 className="text-lg font-semibold text-white mb-2">Событие не найдено</h1>
      <p className="text-gray-400 text-sm mb-4">
        По этому рынку не удалось найти событие в нашем списке. Попробуйте открыть его на Polymarket.
      </p>
      <Link href="/events" className="text-cyan-400 hover:underline">
        ← К списку событий
      </Link>
    </div>
  );
}

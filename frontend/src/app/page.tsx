'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useEffect } from 'react';

export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) router.replace('/copytrading');
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="w-8 h-8 border-2 border-gray-700 border-t-blue-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (user) return null;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-950 px-4">
      <div className="max-w-md w-full text-center space-y-8">
        {/* Logo */}
        <div>
          <div className="text-5xl mb-4 text-blue-400 font-bold">⬡</div>
          <h1 className="text-3xl font-bold text-white tracking-tight">PolySolve</h1>
          <p className="mt-3 text-gray-400 text-base leading-relaxed">
            Copy-trade top Polymarket traders automatically.<br />
            Analytics, signals, and portfolio tracking.
          </p>
        </div>

        {/* CTA */}
        <div className="space-y-3">
          <Link href="/login"
            className="block w-full bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-xl px-6 py-3 text-center transition-colors">
            Sign In
          </Link>
          <Link href="/register"
            className="block w-full bg-white/[0.04] hover:bg-white/[0.08] text-gray-300 font-medium rounded-xl px-6 py-3 text-center ring-1 ring-white/[0.06] transition-all">
            Create Account
          </Link>
        </div>

        {/* Features */}
        <div className="grid grid-cols-3 gap-4 pt-4">
          <div className="text-center">
            <div className="text-2xl mb-1.5">🤖</div>
            <div className="text-xs text-gray-400">Auto Copy Trading</div>
          </div>
          <div className="text-center">
            <div className="text-2xl mb-1.5">📊</div>
            <div className="text-xs text-gray-400">Live Analytics</div>
          </div>
          <div className="text-center">
            <div className="text-2xl mb-1.5">🐋</div>
            <div className="text-xs text-gray-400">Whale Tracking</div>
          </div>
        </div>

        {/* Explore link */}
        <div className="pt-2">
          <Link href="/dashboard" className="text-sm text-gray-600 hover:text-gray-400 transition-colors">
            Explore public analytics →
          </Link>
        </div>
      </div>
    </div>
  );
}

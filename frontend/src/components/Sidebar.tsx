'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/dashboard',       icon: '📊', label: 'Dashboard' },
  { href: '/feed',            icon: '📡', label: 'Live Feed', badge: 'live' },
  { href: '/events',          icon: '🌐', label: 'Markets' },
  { href: '/signals',         icon: '⚡', label: 'Signals',   badge: 'new' },
  { href: '/crypto',          icon: '₿',  label: 'Crypto',    badge: 'new' },
  { href: '/recommendations', icon: '🎯', label: 'Top 10' },
  { href: '/asymmetric',      icon: '💎', label: 'Strategies' },
  { href: '/anomalies',       icon: '🔔', label: 'Anomalies' },
  { href: '/whales',          icon: '🐋', label: 'Whales' },
  { href: '/wallets',         icon: '👛', label: 'Wallets' },
  { href: '/portfolio',       icon: '💼', label: 'Portfolio' },
];

const STORAGE_KEY = 'sidebar_collapsed';

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved !== null) setCollapsed(saved === 'true');
    } catch { /* ignore */ }
  }, []);

  const toggle = () => {
    setCollapsed(c => {
      const next = !c;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  };

  if (!mounted) {
    // Avoid hydration mismatch — render collapsed placeholder
    return <aside className="w-16 flex-shrink-0" />;
  }

  return (
    <aside
      className={`
        flex flex-col flex-shrink-0 h-screen sticky top-0
        bg-gray-900 border-r border-gray-800
        transition-all duration-200
        ${collapsed ? 'w-14' : 'w-52'}
      `}
    >
      {/* Logo + toggle */}
      <div className={`flex items-center h-14 px-3 border-b border-gray-800 ${collapsed ? 'justify-center' : 'justify-between'}`}>
        {!collapsed && (
          <Link href="/" className="flex items-center gap-2 font-bold text-base tracking-tight min-w-0">
            <span className="text-blue-400 text-lg">⬡</span>
            <span className="text-white truncate">PolySolve</span>
          </Link>
        )}
        {collapsed && (
          <Link href="/" className="text-blue-400 text-xl">⬡</Link>
        )}
        <button
          onClick={toggle}
          className="p-1.5 rounded-md text-gray-500 hover:text-white hover:bg-gray-800 transition-colors flex-shrink-0"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      {/* Nav links */}
      <nav className="flex-1 overflow-y-auto py-3 space-y-0.5 px-2">
        {NAV_ITEMS.map(item => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={`
                flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm font-medium transition-colors
                w-full min-h-[40px] cursor-pointer select-none
                ${active
                  ? 'bg-blue-500/15 text-blue-300 border border-blue-500/20'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'}
                ${collapsed ? 'justify-center' : ''}
              `}
            >
              <span className="text-base flex-shrink-0 pointer-events-none">{item.icon}</span>
              {!collapsed && (
                <span className="flex-1 truncate pointer-events-none">{item.label}</span>
              )}
              {!collapsed && item.badge === 'live' && (
                <span className="flex-shrink-0">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                  </span>
                </span>
              )}
              {!collapsed && item.badge === 'new' && (
                <span className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-green-500/20 text-green-400 border border-green-500/30 font-bold">
                  NEW
                </span>
              )}
              {collapsed && item.badge === 'live' && (
                <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-green-400" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      {!collapsed && (
        <div className="px-3 py-3 border-t border-gray-800 text-[10px] text-gray-700">
          Polymarket Analyzer
        </div>
      )}
    </aside>
  );
}

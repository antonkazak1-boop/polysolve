'use client';

import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import AuthGuard from '@/components/AuthGuard';

const FULLSCREEN_PATHS = ['/login', '/register', '/'];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isFullscreen = FULLSCREEN_PATHS.includes(pathname);

  if (isFullscreen) {
    return <>{children}</>;
  }

  return (
    <>
      <Sidebar />
      <div className="flex-1 min-w-0 overflow-x-hidden">
        <main className="px-6 py-6">
          <AuthGuard>{children}</AuthGuard>
        </main>
      </div>
    </>
  );
}

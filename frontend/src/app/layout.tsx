import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Sidebar from '@/components/Sidebar'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'PolySolve — Polymarket Analyzer',
  description: 'Professional Polymarket analytics: events, asymmetric returns, wallet tracking',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-gray-950 text-white min-h-screen flex`}>
        <Sidebar />
        <div className="flex-1 min-w-0 overflow-x-hidden">
          <main className="px-6 py-6">
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}

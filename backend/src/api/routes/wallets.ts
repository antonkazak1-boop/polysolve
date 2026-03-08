import { Router, Request, Response } from 'express';
import prisma from '../../config/database';
import { WalletTracker } from '../../services/wallet-tracker';
import {
  getWalletProfile,
  getWatchedWallets,
  addWatchedWallet,
  removeWatchedWallet,
  detectConvergence,
  invalidateConvergenceCache,
  getConvergenceWinRate,
  resolveConvergenceHistory,
} from '../../services/wallet-profile';
import { getFeedEvents, getFeedMeta } from '../../services/activity-feed';

export const walletsRouter = Router();
const walletTracker = new WalletTracker();

// ─── Watched Wallets (Favorites) ─────────────────────────────────────────────

walletsRouter.get('/watched', async (_req: Request, res: Response) => {
  try {
    const wallets = await getWatchedWallets();
    res.json(wallets);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

walletsRouter.post('/watched', async (req: Request, res: Response) => {
  try {
    const { address, label, userName, pnl, vol, rank } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required' });
    const wallet = await addWatchedWallet(address, label, { userName, pnl, vol, rank });
    res.json(wallet);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

walletsRouter.delete('/watched/:address', async (req: Request, res: Response) => {
  try {
    await removeWatchedWallet(req.params.address);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Wallet Profile (rich analytics) ─────────────────────────────────────────

walletsRouter.get('/profile/:address', async (req: Request, res: Response) => {
  try {
    const profile = await getWalletProfile(req.params.address);
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Live Activity Feed ───────────────────────────────────────────────────────

walletsRouter.get('/activity-feed', (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) || '60'), 200);
  const filter = (req.query.filter as string) || 'all'; // all | whale | watched
  const category = (req.query.category as string) || ''; // e.g. Sports, Politics, Crypto, General

  let events = getFeedEvents(200);
  if (filter === 'whale') events = events.filter(e => e.isWhale);
  if (filter === 'watched') events = events.filter(e => e.isWatched);
  if (category && category !== 'all') events = events.filter(e => (e.category || 'General') === category);

  res.json({ events: events.slice(0, limit), meta: getFeedMeta() });
});

// ─── Convergence: markets multiple top/watched wallets share ──────────────────

walletsRouter.get('/convergence', async (req: Request, res: Response) => {
  try {
    const topN = parseInt(req.query.topN as string) || 20;
    const minValue = parseFloat(req.query.minValue as string) || 100;
    const data = await detectConvergence(topN, minValue);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Watched Convergence Markets (Bookmarks) ──────────────────────────────────

walletsRouter.get('/convergence/watched', async (_req: Request, res: Response) => {
  try {
    const items = await (prisma as any).watchedConvergence.findMany({ orderBy: { addedAt: 'desc' } });
    res.json(items);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

walletsRouter.post('/convergence/watched', async (req: Request, res: Response) => {
  try {
    const { marketId, title, eventSlug, notes, consensus, walletCount, avgEntryPrice } = req.body;
    if (!marketId || !title) return res.status(400).json({ error: 'marketId and title required' });
    const item = await (prisma as any).watchedConvergence.upsert({
      where: { marketId },
      update: { title, eventSlug, notes, consensus, walletCount, avgEntryPrice, updatedAt: new Date() },
      create: { marketId, title, eventSlug, notes, consensus, walletCount, avgEntryPrice },
    });
    res.json(item);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

walletsRouter.delete('/convergence/watched/:marketId', async (req: Request, res: Response) => {
  try {
    await (prisma as any).watchedConvergence.delete({ where: { marketId: req.params.marketId } }).catch(() => {});
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Force refresh convergence cache
walletsRouter.post('/convergence/refresh', async (_req: Request, res: Response) => {
  try {
    invalidateConvergenceCache();
    res.json({ success: true, message: 'Convergence cache invalidated' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get win rate statistics for convergence signals
walletsRouter.get('/convergence/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await getConvergenceWinRate();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Resolve a convergence signal (for cron/admin use)
walletsRouter.post('/convergence/resolve/:marketId', async (req: Request, res: Response) => {
  try {
    const { winningOutcome } = req.body;
    if (!winningOutcome || !['YES', 'NO'].includes(winningOutcome)) {
      return res.status(400).json({ error: 'winningOutcome must be YES or NO' });
    }
    await resolveConvergenceHistory(req.params.marketId, winningOutcome);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Получить топ кошельков по ROI
walletsRouter.get('/top', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const minBets = parseInt(req.query.minBets as string) || 10;
    const wallets = await walletTracker.getTopWalletsByRoi(limit, minBets);
    res.json(wallets);
  } catch (error) {
    console.error('Error fetching top wallets:', error);
    res.status(500).json({ error: 'Failed to fetch top wallets' });
  }
});

// Получить кошельки с асимметричными доходностями
walletsRouter.get('/asymmetric', async (req: Request, res: Response) => {
  try {
    const minRoi = parseFloat(req.query.minRoi as string) || 5;
    const minBets = parseInt(req.query.minBets as string) || 10;
    const wallets = await walletTracker.getAsymmetricWallets(minRoi, minBets);
    res.json(wallets);
  } catch (error) {
    console.error('Error fetching asymmetric wallets:', error);
    res.status(500).json({ error: 'Failed to fetch asymmetric wallets' });
  }
});

// Получить информацию о кошельке
walletsRouter.get('/:address', async (req: Request, res: Response) => {
  try {
    const wallet = await walletTracker.getWallet(req.params.address);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    res.json(wallet);
  } catch (error) {
    console.error('Error fetching wallet:', error);
    res.status(500).json({ error: 'Failed to fetch wallet' });
  }
});

// Получить ставки кошелька
walletsRouter.get('/:address/bets', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const bets = await walletTracker.getWalletBets(req.params.address, limit);
    res.json(bets);
  } catch (error) {
    console.error('Error fetching wallet bets:', error);
    res.status(500).json({ error: 'Failed to fetch wallet bets' });
  }
});

// Отслеживать новый кошелек
walletsRouter.post('/:address/track', async (req: Request, res: Response) => {
  try {
    const wallet = await walletTracker.trackWallet(req.params.address);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found or has no bets' });
    }
    res.json(wallet);
  } catch (error) {
    console.error('Error tracking wallet:', error);
    res.status(500).json({ error: 'Failed to track wallet' });
  }
});

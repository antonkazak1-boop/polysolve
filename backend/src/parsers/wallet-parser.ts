import { Wallet, Bet } from '../types';
import prisma from '../config/database';
import { calculatePotentialRoi, calculateActualRoi } from '../utils/roi';

/**
 * Парсер кошельков и их ставок
 */
export class WalletParser {
  /**
   * Сохраняет или обновляет кошелек в БД
   */
  async saveWallet(wallet: Wallet): Promise<void> {
    await prisma.wallet.upsert({
      where: { address: wallet.address },
      update: {
        totalBets: wallet.totalBets,
        totalVolume: wallet.totalVolume,
        totalPnl: wallet.totalPnl,
        averageRoi: wallet.averageRoi,
        winRate: wallet.winRate,
        lastActiveAt: wallet.lastActiveAt || new Date(),
        updatedAt: new Date(),
      },
      create: {
        id: wallet.id,
        address: wallet.address,
        totalBets: wallet.totalBets,
        totalVolume: wallet.totalVolume,
        totalPnl: wallet.totalPnl,
        averageRoi: wallet.averageRoi,
        winRate: wallet.winRate,
        lastActiveAt: wallet.lastActiveAt,
      },
    });
  }

  /**
   * Сохраняет ставку в БД
   */
  async saveBet(bet: Bet): Promise<void> {
    await prisma.bet.upsert({
      where: { id: bet.id },
      update: {
        amount: bet.amount,
        price: bet.price,
        potentialRoi: bet.potentialRoi,
        status: bet.status,
        pnl: bet.pnl,
        roi: bet.roi,
        updatedAt: new Date(),
      },
      create: {
        id: bet.id,
        walletId: bet.walletId,
        marketId: bet.marketId,
        outcome: bet.outcome,
        amount: bet.amount,
        price: bet.price,
        potentialRoi: bet.potentialRoi,
        status: bet.status,
        pnl: bet.pnl,
        roi: bet.roi,
        timestamp: bet.timestamp,
      },
    });
  }

  /**
   * Обновляет статистику кошелька на основе его ставок
   */
  async updateWalletStats(walletAddress: string): Promise<Wallet | null> {
    const wallet = await prisma.wallet.findUnique({
      where: { address: walletAddress },
      include: {
        bets: true,
      },
    });

    if (!wallet) {
      return null;
    }

    const bets = wallet.bets;
    const totalBets = bets.length;
    const totalVolume = bets.reduce((sum: number, bet: any) => sum + bet.amount, 0);
    
    // Рассчитываем PnL и ROI
    const closedBets = bets.filter((b: any) => b.status === 'WON' || b.status === 'LOST');
    const totalPnl = closedBets.reduce((sum: number, bet: any) => {
      if (bet.pnl !== null) {
        return sum + bet.pnl;
      }
      // Если PnL не рассчитан, рассчитываем
      if (bet.status === 'WON') {
        return sum + (bet.amount * (1 / bet.price - 1));
      } else {
        return sum - bet.amount;
      }
    }, 0);

    // Рассчитываем средний ROI (главная метрика!)
    const rois = closedBets
      .map((bet: any) => {
        if (bet.roi !== null) {
          return bet.roi;
        }
        if (bet.status === 'WON') {
          return calculateActualRoi(bet.price, 1);
        } else {
          return -1; // Проигрыш = -100%
        }
      })
      .filter((roi: any) => roi !== null && roi !== undefined);

    const averageRoi = rois.length > 0
      ? rois.reduce((sum: number, roi: number) => sum + roi, 0) / rois.length
      : 0;

    // Win rate
    const wonBets = closedBets.filter((b: any) => b.status === 'WON').length;
    const winRate = closedBets.length > 0 ? (wonBets / closedBets.length) * 100 : 0;

    // Обновляем кошелек
    const updated = await prisma.wallet.update({
      where: { address: walletAddress },
      data: {
        totalBets,
        totalVolume,
        totalPnl,
        averageRoi,
        winRate,
        lastActiveAt: new Date(),
        updatedAt: new Date(),
      },
    });

    return {
      id: updated.id,
      address: updated.address,
      totalBets: updated.totalBets,
      totalVolume: updated.totalVolume,
      totalPnl: updated.totalPnl,
      averageRoi: updated.averageRoi,
      winRate: updated.winRate,
      lastActiveAt: updated.lastActiveAt || undefined,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  /**
   * Получает топ кошельков по ROI
   */
  async getTopWalletsByRoi(limit: number = 100, minBets: number = 10): Promise<Wallet[]> {
    const wallets = await prisma.wallet.findMany({
      where: {
        totalBets: {
          gte: minBets,
        },
      },
      orderBy: {
        averageRoi: 'desc',
      },
      take: limit,
    });

    return wallets.map((w: any) => ({
      id: w.id,
      address: w.address,
      totalBets: w.totalBets,
      totalVolume: w.totalVolume,
      totalPnl: w.totalPnl,
      averageRoi: w.averageRoi,
      winRate: w.winRate,
      lastActiveAt: w.lastActiveAt || undefined,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    }));
  }

  /**
   * Получает ставки кошелька
   */
  async getWalletBets(walletAddress: string, limit: number = 100): Promise<Bet[]> {
    const wallet = await prisma.wallet.findUnique({
      where: { address: walletAddress },
    });

    if (!wallet) {
      return [];
    }

    const bets = await prisma.bet.findMany({
      where: { walletId: wallet.id },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    return bets.map((b: any) => ({
      id: b.id,
      walletId: b.walletId,
      marketId: b.marketId,
      outcome: b.outcome as 'YES' | 'NO',
      amount: b.amount,
      price: b.price,
      potentialRoi: b.potentialRoi,
      status: b.status as Bet['status'],
      pnl: b.pnl || undefined,
      roi: b.roi || undefined,
      timestamp: b.timestamp,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }));
  }
}

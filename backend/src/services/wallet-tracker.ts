import { Wallet, Bet } from '../types';
import prisma from '../config/database';
import { WalletParser } from '../parsers/wallet-parser';
import { PolymarketParser } from '../parsers/polymarket-parser';

/**
 * Сервис отслеживания кошельков по ROI
 * Главная метрика: ROI, а не win rate
 */
export class WalletTracker {
  private walletParser: WalletParser;
  private polymarketParser: PolymarketParser;

  constructor() {
    this.walletParser = new WalletParser();
    this.polymarketParser = new PolymarketParser();
  }

  /**
   * Обновляет статистику всех кошельков
   */
  async updateAllWallets(): Promise<void> {
    const wallets = await prisma.wallet.findMany({
      take: 1000, // Ограничение для производительности
    });

    for (const wallet of wallets) {
      await this.walletParser.updateWalletStats(wallet.address);
    }
  }

  /**
   * Отслеживает новый кошелек
   */
  async trackWallet(walletAddress: string): Promise<Wallet | null> {
    // Получаем данные о ставках кошелька с Polymarket
    const bets = await this.polymarketParser.fetchWalletBets(walletAddress);

    if (bets.length === 0) {
      return null;
    }

    // Сохраняем кошелек и его ставки
    const wallet = await this.createOrUpdateWallet(walletAddress, bets);
    
    // Обновляем статистику
    return await this.walletParser.updateWalletStats(walletAddress);
  }

  /**
   * Создает или обновляет кошелек на основе ставок
   */
  private async createOrUpdateWallet(walletAddress: string, bets: any[]): Promise<Wallet> {
    let wallet = await prisma.wallet.findUnique({
      where: { address: walletAddress },
    });

    if (!wallet) {
      wallet = await prisma.wallet.create({
        data: {
          address: walletAddress,
          totalBets: 0,
          totalVolume: 0,
          totalPnl: 0,
          averageRoi: 0,
          winRate: 0,
        },
      });
    }

    // Сохраняем ставки
    for (const bet of bets) {
      await this.walletParser.saveBet({
        id: `bet-${bet.id}-${Date.now()}`,
        walletId: wallet.id,
        marketId: bet.conditionId,
        outcome: bet.outcomeIndex === 0 ? 'YES' : 'NO',
        amount: parseFloat(bet.amount || 0),
        price: parseFloat(bet.price || 0),
        potentialRoi: bet.price ? (1 / parseFloat(bet.price)) - 1 : 0,
        status: 'ACTIVE' as Bet['status'],
        timestamp: new Date(bet.timestamp * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    return {
      id: wallet.id,
      address: wallet.address,
      totalBets: wallet.totalBets,
      totalVolume: wallet.totalVolume,
      totalPnl: wallet.totalPnl,
      averageRoi: wallet.averageRoi,
      winRate: wallet.winRate,
      lastActiveAt: wallet.lastActiveAt || undefined,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  /**
   * Получает топ кошельков по ROI
   */
  async getTopWalletsByRoi(limit: number = 100, minBets: number = 10): Promise<Wallet[]> {
    return await this.walletParser.getTopWalletsByRoi(limit, minBets);
  }

  /**
   * Получает кошельки с асимметричными доходностями
   */
  async getAsymmetricWallets(minRoi: number = 5, minBets: number = 10): Promise<Wallet[]> {
    return await prisma.wallet.findMany({
      where: {
        totalBets: {
          gte: minBets,
        },
        averageRoi: {
          gte: minRoi, // ROI 5x+
        },
      },
      orderBy: {
        averageRoi: 'desc',
      },
      take: 100,
    }).then((wallets: any[]) => wallets.map((w: any) => ({
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
    })));
  }

  /**
   * Получает информацию о кошельке
   */
  async getWallet(walletAddress: string): Promise<Wallet | null> {
    const wallet = await prisma.wallet.findUnique({
      where: { address: walletAddress },
    });

    if (!wallet) {
      return null;
    }

    return {
      id: wallet.id,
      address: wallet.address,
      totalBets: wallet.totalBets,
      totalVolume: wallet.totalVolume,
      totalPnl: wallet.totalPnl,
      averageRoi: wallet.averageRoi,
      winRate: wallet.winRate,
      lastActiveAt: wallet.lastActiveAt || undefined,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  /**
   * Получает историю ставок кошелька
   */
  async getWalletBets(walletAddress: string, limit: number = 100) {
    return await this.walletParser.getWalletBets(walletAddress, limit);
  }
}

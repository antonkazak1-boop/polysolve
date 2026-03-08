import { PortfolioPosition, PortfolioSnapshot } from '../types';
import prisma from '../config/database';
import { calculatePotentialRoi, calculateActualRoi } from '../utils/roi';

/**
 * Сервис управления портфелем ставок
 */
export class PortfolioService {
  /**
   * Создает новую позицию в портфеле
   */
  async createPosition(position: Omit<PortfolioPosition, 'id' | 'createdAt' | 'updatedAt'>): Promise<PortfolioPosition> {
    const created = await prisma.portfolioPosition.create({
      data: {
        userId: position.userId,
        marketId: position.marketId,
        betId: position.betId,
        outcome: position.outcome,
        amount: position.amount,
        entryPrice: position.entryPrice,
        currentPrice: position.currentPrice,
        potentialPnl: position.potentialPnl,
        potentialRoi: position.potentialRoi,
        status: position.status,
        entryTime: position.entryTime,
        marketEndDate: position.marketEndDate,
      },
    });

    return this.mapToPortfolioPosition(created);
  }

  /**
   * Обновляет позицию
   */
  async updatePosition(
    positionId: string,
    updates: Partial<PortfolioPosition>
  ): Promise<PortfolioPosition | null> {
    const updated = await prisma.portfolioPosition.update({
      where: { id: positionId },
      data: {
        currentPrice: updates.currentPrice,
        potentialPnl: updates.potentialPnl,
        potentialRoi: updates.potentialRoi,
        status: updates.status,
        updatedAt: new Date(),
      },
    });

    return this.mapToPortfolioPosition(updated);
  }

  /**
   * Получает все позиции пользователя
   */
  async getPositions(userId?: string, status?: string): Promise<PortfolioPosition[]> {
    const where: any = {};
    if (userId) {
      where.userId = userId;
    }
    if (status) {
      where.status = status;
    }

    const positions = await prisma.portfolioPosition.findMany({
      where,
      include: {
        market: true,
      },
      orderBy: {
        entryTime: 'desc',
      },
    });

    return positions.map(this.mapToPortfolioPosition);
  }

  /**
   * Получает активные позиции
   */
  async getActivePositions(userId?: string): Promise<PortfolioPosition[]> {
    return this.getPositions(userId, 'ACTIVE');
  }

  /**
   * Обновляет цены всех активных позиций
   */
  async updateActivePositionsPrices(): Promise<void> {
    const activePositions = await prisma.portfolioPosition.findMany({
      where: {
        status: 'ACTIVE',
      },
      include: {
        market: {
          include: {
            prices: {
              orderBy: {
                timestamp: 'desc',
              },
              take: 2,
            },
          },
        },
      },
    });

    for (const position of activePositions) {
      const currentPrice = position.outcome === 'YES'
        ? position.market.prices.find((p: any) => p.outcome === 'YES')?.price
        : position.market.prices.find((p: any) => p.outcome === 'NO')?.price;

      if (currentPrice !== undefined) {
        const potentialRoi = calculatePotentialRoi(currentPrice);
        const potentialPnl = position.amount * potentialRoi;

        await prisma.portfolioPosition.update({
          where: { id: position.id },
          data: {
            currentPrice,
            potentialRoi,
            potentialPnl,
            updatedAt: new Date(),
          },
        });
      }
    }
  }

  /**
   * Рассчитывает статистику портфеля
   */
  async getPortfolioStats(userId?: string): Promise<{
    totalBalance: number;
    totalInvested: number;
    totalPnl: number;
    totalRoi: number;
    activePositions: number;
    wonPositions: number;
    lostPositions: number;
    averageRoi: number;
    winRate: number;
  }> {
    const positions = await this.getPositions(userId);

    const activePositions = positions.filter((p: any) => p.status === 'ACTIVE');
    const wonPositions = positions.filter((p: any) => p.status === 'WON');
    const lostPositions = positions.filter((p: any) => p.status === 'LOST');

    const totalInvested = positions.reduce((sum, p) => sum + p.amount, 0);
    
    // Рассчитываем PnL
    let totalPnl = 0;
    for (const position of positions) {
      if (position.status === 'WON') {
        const roi = calculateActualRoi(position.entryPrice, 1);
        totalPnl += position.amount * roi;
      } else if (position.status === 'LOST') {
        totalPnl -= position.amount;
      } else if (position.status === 'ACTIVE' && position.potentialPnl !== undefined) {
        totalPnl += position.potentialPnl;
      }
    }

    const totalBalance = totalInvested + totalPnl;
    const totalRoi = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    // Средний ROI закрытых позиций
    const closedPositions = [...wonPositions, ...lostPositions];
    const rois = closedPositions.map(p => {
      if (p.status === 'WON') {
        return calculateActualRoi(p.entryPrice, 1);
      } else {
        return -1;
      }
    });
    const averageRoi = rois.length > 0
      ? rois.reduce((sum, roi) => sum + roi, 0) / rois.length
      : 0;

    const winRate = closedPositions.length > 0
      ? (wonPositions.length / closedPositions.length) * 100
      : 0;

    return {
      totalBalance,
      totalInvested,
      totalPnl,
      totalRoi,
      activePositions: activePositions.length,
      wonPositions: wonPositions.length,
      lostPositions: lostPositions.length,
      averageRoi,
      winRate,
    };
  }

  /**
   * Создает снимок портфеля
   */
  async createSnapshot(userId?: string): Promise<PortfolioSnapshot> {
    const stats = await this.getPortfolioStats(userId);

    const snapshot = await prisma.portfolioSnapshot.create({
      data: {
        userId,
        totalBalance: stats.totalBalance,
        totalInvested: stats.totalInvested,
        totalPnl: stats.totalPnl,
        totalRoi: stats.totalRoi,
        activePositions: stats.activePositions,
        wonPositions: stats.wonPositions,
        lostPositions: stats.lostPositions,
        timestamp: new Date(),
      },
    });

    return {
      id: snapshot.id,
      userId: snapshot.userId || undefined,
      totalBalance: snapshot.totalBalance,
      totalInvested: snapshot.totalInvested,
      totalPnl: snapshot.totalPnl,
      totalRoi: snapshot.totalRoi,
      activePositions: snapshot.activePositions,
      wonPositions: snapshot.wonPositions,
      lostPositions: snapshot.lostPositions,
      timestamp: snapshot.timestamp,
    };
  }

  /**
   * Получает историю снимков портфеля
   */
  async getSnapshots(userId?: string, limit: number = 100): Promise<PortfolioSnapshot[]> {
    const where: any = {};
    if (userId) {
      where.userId = userId;
    }

    const snapshots = await prisma.portfolioSnapshot.findMany({
      where,
      orderBy: {
        timestamp: 'desc',
      },
      take: limit,
    });

    return snapshots.map((s: any) => ({
      id: s.id,
      userId: s.userId || undefined,
      totalBalance: s.totalBalance,
      totalInvested: s.totalInvested,
      totalPnl: s.totalPnl,
      totalRoi: s.totalRoi,
      activePositions: s.activePositions,
      wonPositions: s.wonPositions,
      lostPositions: s.lostPositions,
      timestamp: s.timestamp,
    }));
  }

  /**
   * Получает распределение по категориям
   */
  async getCategoryDistribution(userId?: string): Promise<Record<string, number>> {
    const positions = await this.getPositions(userId);
    const distribution: Record<string, number> = {};

    for (const position of positions) {
      const category = (position as any).market?.category || 'uncategorized';
      distribution[category] = (distribution[category] || 0) + position.amount;
    }

    return distribution;
  }

  private mapToPortfolioPosition(position: any): PortfolioPosition {
    return {
      id: position.id,
      userId: position.userId || undefined,
      marketId: position.marketId,
      betId: position.betId || undefined,
      outcome: position.outcome as 'YES' | 'NO',
      amount: position.amount,
      entryPrice: position.entryPrice,
      currentPrice: position.currentPrice || undefined,
      potentialPnl: position.potentialPnl || undefined,
      potentialRoi: position.potentialRoi || undefined,
      status: position.status as PortfolioPosition['status'],
      entryTime: position.entryTime,
      marketEndDate: position.marketEndDate || undefined,
      createdAt: position.createdAt,
      updatedAt: position.updatedAt,
    };
  }
}

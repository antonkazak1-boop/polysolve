import { Alert, AlertType } from '../types';
import prisma from '../config/database';
import { calculatePotentialRoi } from '../utils/roi';

/**
 * Монитор новых крупных ставок
 * Отслеживает ставки >$5-10k или >X% от ликвидности
 */
export class NewBetsMonitor {
  private minBetAmount: number = 5000; // $5,000
  private minBetPercentage: number = 0.05; // 5% от ликвидности

  /**
   * Мониторит новые крупные ставки
   */
  async monitorNewBets(): Promise<Alert[]> {
    const alerts: Alert[] = [];

    // Получаем недавние ставки (за последний час)
    const recentBets = await prisma.bet.findMany({
      where: {
        timestamp: {
          gte: new Date(Date.now() - 60 * 60 * 1000),
        },
        status: 'ACTIVE',
      },
      include: {
        wallet: true,
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
      orderBy: {
        timestamp: 'desc',
      },
      take: 100,
    });

    for (const bet of recentBets) {
      // Проверяем, является ли ставка крупной
      const isLargeBet = this.isLargeBet(bet.amount, bet.market.liquidity);

      if (isLargeBet) {
        // Проверяем, является ли кошелек успешным (по ROI)
        const isSuccessfulWallet = bet.wallet.averageRoi >= 3; // ROI 300%+

        if (isSuccessfulWallet) {
          const alert = this.createAlert(bet);
          if (alert) {
            alerts.push(alert);
          }
        }
      }
    }

    await this.saveAlerts(alerts);
    return alerts;
  }

  /**
   * Проверяет, является ли ставка крупной
   */
  private isLargeBet(amount: number, marketLiquidity: number): boolean {
    // По абсолютной сумме
    if (amount >= this.minBetAmount) {
      return true;
    }

    // По проценту от ликвидности
    if (marketLiquidity > 0 && (amount / marketLiquidity) >= this.minBetPercentage) {
      return true;
    }

    return false;
  }

  /**
   * Создает алерт для крупной ставки
   */
  private createAlert(bet: any): Alert | null {
    const potentialRoi = calculatePotentialRoi(bet.price);
    const confidence = this.calculateConfidence(bet, potentialRoi);

    return {
      id: `new-bet-${bet.id}-${Date.now()}`,
      type: AlertType.NEW_BET,
      strategy: 'NEW_BET',
      marketId: bet.marketId,
      walletId: bet.walletId,
      message: `Крупная ставка: ${bet.wallet.address.slice(0, 8)}... поставил $${bet.amount.toLocaleString()} (ROI ${(potentialRoi * 100).toFixed(2)}%) на "${bet.market.question}"`,
      confidence,
      data: {
        walletAddress: bet.wallet.address,
        walletRoi: bet.wallet.averageRoi,
        walletWinRate: bet.wallet.winRate,
        betAmount: bet.amount,
        betOutcome: bet.outcome,
        betPrice: bet.price,
        potentialRoi,
        marketQuestion: bet.market.question,
        marketCategory: bet.market.category,
        marketLiquidity: bet.market.liquidity,
      },
      read: false,
      createdAt: new Date(),
    };
  }

  /**
   * Рассчитывает confidence для алерта
   */
  private calculateConfidence(bet: any, potentialRoi: number): number {
    let confidence = 50;

    // Размер ставки
    if (bet.amount >= 10000) confidence += 15;
    else if (bet.amount >= 5000) confidence += 10;

    // ROI кошелька
    if (bet.wallet.averageRoi >= 8) confidence += 20; // ROI 8x+
    else if (bet.wallet.averageRoi >= 5) confidence += 15; // ROI 5x+
    else if (bet.wallet.averageRoi >= 3) confidence += 10; // ROI 3x+

    // Потенциальный ROI ставки
    if (potentialRoi >= 5) confidence += 15; // ROI 5x+
    else if (potentialRoi >= 3) confidence += 10; // ROI 3x+

    // Ликвидность рынка
    if (bet.market.liquidity >= 100000) confidence += 10;
    else if (bet.market.liquidity >= 50000) confidence += 5;

    return Math.min(100, Math.max(0, confidence));
  }

  /**
   * Сохраняет алерты в БД
   */
  private async saveAlerts(alerts: Alert[]): Promise<void> {
    for (const alert of alerts) {
      await prisma.alert.upsert({
        where: { id: alert.id },
        update: {
          confidence: alert.confidence,
          message: alert.message,
          data: alert.data as any,
        },
        create: {
          id: alert.id,
          type: alert.type,
          strategy: alert.strategy,
          marketId: alert.marketId,
          walletId: alert.walletId,
          message: alert.message,
          confidence: alert.confidence,
          data: alert.data as any,
          read: alert.read,
          createdAt: alert.createdAt,
        },
      });
    }
  }

  /**
   * Получает последние крупные ставки
   */
  async getRecentLargeBets(limit: number = 50): Promise<any[]> {
    return await prisma.bet.findMany({
      where: {
        amount: {
          gte: this.minBetAmount,
        },
        timestamp: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // За последние 24 часа
        },
      },
      include: {
        wallet: true,
        market: true,
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: limit,
    });
  }
}

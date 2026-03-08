import { Alert, AlertType } from '../types';
import prisma from '../config/database';

/**
 * Анализатор паттернов успешных трейдеров
 * Кластеризация кошельков по стратегиям
 * Выявление "smart money" кошельков по ROI
 */
export class PatternAnalyzer {
  /**
   * Анализирует паттерны ставок успешных кошельков
   */
  async analyzePatterns(): Promise<Alert[]> {
    const alerts: Alert[] = [];

    // Получаем топ кошельков по ROI
    const topWallets = await prisma.wallet.findMany({
      where: {
        totalBets: {
          gte: 10,
        },
        averageRoi: {
          gte: 3, // ROI 300%+
        },
      },
      orderBy: {
        averageRoi: 'desc',
      },
      take: 20,
    });

    // Анализируем кластеризацию ставок
    for (const wallet of topWallets) {
      const walletBets = await prisma.bet.findMany({
        where: {
          walletId: wallet.id,
          status: 'ACTIVE',
        },
        include: {
          market: true,
        },
        take: 50,
      });

      // Ищем паттерны: несколько кошельков ставят на одно событие
      const marketClusters = this.findMarketClusters(walletBets, topWallets);

      for (const cluster of marketClusters) {
        if (cluster.walletCount >= 3) {
          // Если 3+ успешных кошелька ставят на одно событие
          const alert = this.createClusterAlert(cluster);
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
   * Находит кластеры рынков, на которые ставят несколько успешных кошельков
   */
  private findMarketClusters(bets: any[], topWallets: any[]): any[] {
    const marketMap = new Map<string, any>();

    for (const bet of bets) {
      const marketId = bet.marketId;
      if (!marketMap.has(marketId)) {
        marketMap.set(marketId, {
          marketId,
          market: bet.market,
          wallets: new Set<string>(),
          bets: [],
        });
      }

      const cluster = marketMap.get(marketId);
      cluster.wallets.add(bet.walletId);
      cluster.bets.push(bet);
    }

    const clusters: any[] = [];
    for (const [marketId, cluster] of marketMap.entries()) {
      if (cluster.wallets.size >= 2) {
        clusters.push({
          marketId,
          market: cluster.market,
          walletCount: cluster.wallets.size,
          bets: cluster.bets,
          averageRoi: this.calculateAverageRoi(cluster.bets, topWallets),
        });
      }
    }

    return clusters.sort((a, b) => b.walletCount - a.walletCount);
  }

  /**
   * Рассчитывает средний ROI кошельков в кластере
   */
  private calculateAverageRoi(bets: any[], topWallets: any[]): number {
    const walletRois = new Map<string, number>();
    
    for (const wallet of topWallets) {
      walletRois.set(wallet.id, wallet.averageRoi);
    }

    let totalRoi = 0;
    let count = 0;

    for (const bet of bets) {
      const roi = walletRois.get(bet.walletId);
      if (roi) {
        totalRoi += roi;
        count++;
      }
    }

    return count > 0 ? totalRoi / count : 0;
  }

  /**
   * Создает алерт для кластера ставок
   */
  private createAlert(cluster: any): Alert | null {
    const confidence = Math.min(100, 50 + (cluster.walletCount * 10) + (cluster.averageRoi * 5));

    return {
      id: `pattern-${cluster.marketId}-${Date.now()}`,
      type: AlertType.PATTERN_DETECTED,
      strategy: 'PATTERN_ANALYSIS',
      marketId: cluster.marketId,
      message: `Паттерн: ${cluster.walletCount} успешных кошельков (средний ROI ${(cluster.averageRoi * 100).toFixed(2)}%) ставят на "${cluster.market.question}"`,
      confidence: Math.round(confidence),
      data: {
        walletCount: cluster.walletCount,
        averageRoi: cluster.averageRoi,
        marketQuestion: cluster.market.question,
        marketCategory: cluster.market.category,
        marketLiquidity: cluster.market.liquidity,
      },
      read: false,
      createdAt: new Date(),
    };
  }

  private createClusterAlert(cluster: any): Alert | null {
    return this.createAlert(cluster);
  }

  /**
   * Анализирует корреляции между связанными событиями
   */
  async analyzeCorrelations(): Promise<Alert[]> {
    const alerts: Alert[] = [];

    // Получаем события по категориям
    const marketsByCategory = await prisma.market.groupBy({
      by: ['category'],
      where: {
        status: 'OPEN',
      },
      _count: {
        id: true,
      },
    });

    // Для каждой категории ищем корреляции
    for (const category of marketsByCategory) {
      const markets = await prisma.market.findMany({
        where: {
          category: category.category,
          status: 'OPEN',
        },
        include: {
          bets: {
            include: {
              wallet: true,
            },
          },
        },
        take: 20,
      });

      // Ищем кошельки, которые ставят на несколько связанных событий
      const walletMarkets = new Map<string, Set<string>>();
      
      for (const market of markets) {
        for (const bet of market.bets) {
          if (!walletMarkets.has(bet.walletId)) {
            walletMarkets.set(bet.walletId, new Set());
          }
          walletMarkets.get(bet.walletId)!.add(market.id);
        }
      }

      // Если кошелек ставит на 3+ связанных события
      for (const [walletId, marketIds] of walletMarkets.entries()) {
        if (marketIds.size >= 3) {
          const wallet = await prisma.wallet.findUnique({
            where: { id: walletId },
          });

          if (wallet && wallet.averageRoi >= 3) {
            const alert = this.createCorrelationAlert(wallet, Array.from(marketIds), category.category);
            if (alert) {
              alerts.push(alert);
            }
          }
        }
      }
    }

    await this.saveAlerts(alerts);
    return alerts;
  }

  private createCorrelationAlert(wallet: any, marketIds: string[], category: string): Alert | null {
    return {
      id: `correlation-${wallet.id}-${Date.now()}`,
      type: AlertType.PATTERN_DETECTED,
      strategy: 'CORRELATION_ANALYSIS',
      walletId: wallet.id,
      message: `Корреляция: кошелек ${wallet.address.slice(0, 8)}... (ROI ${(wallet.averageRoi * 100).toFixed(2)}%) ставит на ${marketIds.length} связанных событий в категории "${category}"`,
      confidence: 70,
      data: {
        walletAddress: wallet.address,
        walletRoi: wallet.averageRoi,
        marketIds,
        category,
      },
      read: false,
      createdAt: new Date(),
    };
  }

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
}

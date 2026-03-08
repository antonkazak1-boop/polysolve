import { Market, MarketPrice, StrategySignal, Alert, AlertType } from '../types';
import prisma from '../config/database';
import { calculatePotentialRoi, isAsymmetricRoi, formatRoi } from '../utils/roi';
import { EventParser } from '../parsers/event-parser';
import { WalletParser } from '../parsers/wallet-parser';

/**
 * Анализатор асимметричных доходностей (ГЛАВНАЯ СТРАТЕГИЯ)
 * 
 * Ищет ставки с ROI 5x+ (500%+)
 * Ключевая метрика: ROI, а не win rate
 * Логика: кошелек может иметь win rate 25%, но ROI 800-1100% - это успешная стратегия
 */
export class AsymmetricReturnsAnalyzer {
  private eventParser: EventParser;
  private walletParser: WalletParser;
  private minRoi: number = 5; // 5x (500%+)
  private minLiquidity: number = 10000; // Минимальная ликвидность для больших рынков

  constructor() {
    this.eventParser = new EventParser();
    this.walletParser = new WalletParser();
  }

  /**
   * Анализирует рынки на наличие асимметричных доходностей
   */
  async analyzeMarkets(): Promise<StrategySignal[]> {
    const signals: StrategySignal[] = [];

    // Получаем активные рынки с достаточной ликвидностью
    const markets = await prisma.market.findMany({
      where: {
        status: 'OPEN',
        liquidity: {
          gte: this.minLiquidity,
        },
        endDate: {
          gt: new Date(),
        },
      },
      include: {
        prices: {
          orderBy: {
            timestamp: 'desc',
          },
          take: 2, // YES и NO
        },
      },
      take: 100,
    });

    for (const market of markets) {
      // Анализируем цены YES и NO
      const yesPrice = market.prices.find((p: any) => p.outcome === 'YES');
      const noPrice = market.prices.find((p: any) => p.outcome === 'NO');

      if (yesPrice) {
        const roi = calculatePotentialRoi(yesPrice.price);
        if (isAsymmetricRoi(roi)) {
          const signal = await this.createSignal(market, 'YES', yesPrice.price, roi);
          if (signal) {
            signals.push(signal);
          }
        }
      }

      if (noPrice) {
        const roi = calculatePotentialRoi(noPrice.price);
        if (isAsymmetricRoi(roi)) {
          const signal = await this.createSignal(market, 'NO', noPrice.price, roi);
          if (signal) {
            signals.push(signal);
          }
        }
      }
    }

    // Сохраняем сигналы в БД
    await this.saveSignals(signals);

    return signals;
  }

  /**
   * Анализирует ставки успешных кошельков на асимметричные доходности
   */
  async analyzeSuccessfulWallets(): Promise<Alert[]> {
    const alerts: Alert[] = [];

    // Получаем топ кошельков по ROI (минимум 10 ставок, ROI > 300%)
    const topWallets = await prisma.wallet.findMany({
      where: {
        totalBets: {
          gte: 10,
        },
        averageRoi: {
          gte: 3, // 300%+
        },
      },
      orderBy: {
        averageRoi: 'desc',
      },
      take: 50,
    });

    for (const wallet of topWallets) {
      // Получаем активные ставки кошелька
      const activeBets = await prisma.bet.findMany({
        where: {
          walletId: wallet.id,
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

      for (const bet of activeBets) {
        // Проверяем текущую цену и потенциальный ROI
        const currentPrice = bet.outcome === 'YES'
          ? bet.market.prices.find((p: any) => p.outcome === 'YES')?.price
          : bet.market.prices.find((p: any) => p.outcome === 'NO')?.price;

        if (currentPrice) {
          const currentRoi = calculatePotentialRoi(currentPrice);
          if (isAsymmetricRoi(currentRoi)) {
            const alert = await this.createAlert(
              wallet,
              bet.market,
              bet.outcome as 'YES' | 'NO',
              currentPrice,
              currentRoi,
              wallet.averageRoi
            );
            if (alert) {
              alerts.push(alert);
            }
          }
        }
      }
    }

    // Сохраняем алерты в БД
    await this.saveAlerts(alerts);

    return alerts;
  }

  /**
   * Создает сигнал для ставки с асимметричной доходностью
   */
  private async createSignal(
    market: any,
    outcome: 'YES' | 'NO',
    price: number,
    roi: number
  ): Promise<StrategySignal | null> {
    // Рассчитываем confidence score
    const confidence = this.calculateConfidence(market, price, roi);

    const signal: StrategySignal = {
      id: `signal-${market.id}-${outcome}-${Date.now()}`,
      strategy: 'ASYMMETRIC_RETURNS',
      marketId: market.id,
      signal: outcome === 'YES' ? 'BUY_YES' : 'BUY_NO',
      confidence,
      potentialRoi: roi,
      reasoning: `Асимметричная доходность: ${formatRoi(roi)}. Цена ${(price * 100).toFixed(2)}%, ликвидность $${market.liquidity.toLocaleString()}`,
      data: {
        price,
        roi,
        liquidity: market.liquidity,
        volume: market.volume,
        category: market.category,
      },
      createdAt: new Date(),
    };

    return signal;
  }

  /**
   * Создает алерт для ставки успешного кошелька
   */
  private async createAlert(
    wallet: any,
    market: any,
    outcome: 'YES' | 'NO',
    price: number,
    roi: number,
    walletRoi: number
  ): Promise<Alert | null> {
    const confidence = this.calculateConfidence(market, price, roi, walletRoi);

    const alert: Alert = {
      id: `alert-${wallet.id}-${market.id}-${Date.now()}`,
      type: AlertType.ASYMMETRIC_RETURNS,
      strategy: 'ASYMMETRIC_RETURNS',
      marketId: market.id,
      walletId: wallet.id,
      message: `Успешный кошелек (ROI ${formatRoi(walletRoi)}) делает ставку с потенциальным ROI ${formatRoi(roi)} на "${market.question}"`,
      confidence,
      data: {
        walletAddress: wallet.address,
        walletRoi,
        walletWinRate: wallet.winRate,
        outcome,
        price,
        roi,
        marketQuestion: market.question,
        marketCategory: market.category,
      },
      read: false,
      createdAt: new Date(),
    };

    return alert;
  }

  /**
   * Рассчитывает confidence score для сигнала
   */
  private calculateConfidence(
    market: any,
    price: number,
    roi: number,
    walletRoi?: number
  ): number {
    let confidence = 50; // Базовый confidence

    // ROI выше = выше confidence
    if (roi >= 10) confidence += 20; // 10x+
    else if (roi >= 7) confidence += 15; // 7x+
    else if (roi >= 5) confidence += 10; // 5x+

    // Ликвидность выше = выше confidence
    if (market.liquidity >= 100000) confidence += 15;
    else if (market.liquidity >= 50000) confidence += 10;
    else if (market.liquidity >= 20000) confidence += 5;

    // Если это ставка успешного кошелька
    if (walletRoi && walletRoi >= 5) {
      confidence += 20; // Кошелек с ROI 5x+
    } else if (walletRoi && walletRoi >= 3) {
      confidence += 10; // Кошелек с ROI 3x+
    }

    // Время до закрытия (ближе к закрытию = выше риск)
    const timeToClose = market.endDate.getTime() - Date.now();
    const hoursToClose = timeToClose / (1000 * 60 * 60);
    if (hoursToClose < 1) confidence -= 10; // Меньше часа
    else if (hoursToClose < 6) confidence -= 5; // Меньше 6 часов

    return Math.min(100, Math.max(0, confidence));
  }

  /**
   * Сохраняет сигналы в БД
   */
  private async saveSignals(signals: StrategySignal[]): Promise<void> {
    for (const signal of signals) {
      await prisma.strategySignal.upsert({
        where: { id: signal.id },
        update: {
          confidence: signal.confidence,
          potentialRoi: signal.potentialRoi,
          reasoning: signal.reasoning,
          data: signal.data as any,
        },
        create: {
          id: signal.id,
          strategy: signal.strategy,
          marketId: signal.marketId,
          signal: signal.signal,
          confidence: signal.confidence,
          potentialRoi: signal.potentialRoi,
          reasoning: signal.reasoning,
          data: signal.data as any,
          createdAt: signal.createdAt,
        },
      });
    }
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
          read: alert.read,
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
   * Получает последние сигналы с асимметричными доходностями
   */
  async getRecentSignals(limit: number = 50): Promise<StrategySignal[]> {
    const signals = await prisma.strategySignal.findMany({
      where: {
        strategy: 'ASYMMETRIC_RETURNS',
        potentialRoi: {
          gte: this.minRoi,
        },
      },
      include: {
        market: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: limit,
    });

    return signals.map((s: any) => ({
      id: s.id,
      strategy: s.strategy,
      marketId: s.marketId,
      signal: s.signal as 'BUY_YES' | 'BUY_NO' | 'SELL',
      confidence: s.confidence,
      potentialRoi: s.potentialRoi || undefined,
      reasoning: s.reasoning,
      data: s.data as Record<string, any>,
      createdAt: s.createdAt,
    }));
  }
}

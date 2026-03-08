import { Market, StrategySignal, Alert, AlertType } from '../types';
import prisma from '../config/database';

/**
 * Анализатор арбитражных возможностей
 * Ищет расхождения цен после завершения событий (5-7% от реального исхода)
 */
export class ArbitrageAnalyzer {
  private priceDeviationThreshold: number = 0.05; // 5%

  /**
   * Анализирует завершенные события на арбитражные возможности
   */
  async analyzeResolvedMarkets(): Promise<StrategySignal[]> {
    const signals: StrategySignal[] = [];

    // Получаем недавно завершенные события
    const resolvedMarkets = await prisma.market.findMany({
      where: {
        status: 'RESOLVED',
        updatedAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // За последние 24 часа
        },
      },
      include: {
        prices: {
          orderBy: {
            timestamp: 'desc',
          },
          take: 2,
        },
      },
    });

    for (const market of resolvedMarkets) {
      // Проверяем, есть ли расхождение между текущей ценой и реальным исходом
      // Предполагаем, что если событие RESOLVED, то исход известен
      // В реальности нужно интегрироваться с внешними источниками для проверки результата
      
      const yesPrice = market.prices.find((p: any) => p.outcome === 'YES');
      const noPrice = market.prices.find((p: any) => p.outcome === 'NO');

      if (yesPrice && yesPrice.price < 0.90) {
        // Если цена YES < 0.90, но событие должно быть YES - арбитраж
        const signal = this.createSignal(market, 'YES', yesPrice.price, 0.90);
        if (signal) {
          signals.push(signal);
        }
      }

      if (noPrice && noPrice.price < 0.90) {
        // Если цена NO < 0.90, но событие должно быть NO - арбитраж
        const signal = this.createSignal(market, 'NO', noPrice.price, 0.90);
        if (signal) {
          signals.push(signal);
        }
      }
    }

    await this.saveSignals(signals);
    return signals;
  }

  /**
   * Мониторит события после завершения (например, после матча)
   */
  async monitorPostEventArbitrage(): Promise<Alert[]> {
    const alerts: Alert[] = [];

    // Получаем события, которые должны быть закрыты, но еще не обновлены
    const closingMarkets = await prisma.market.findMany({
      where: {
        status: 'OPEN',
        endDate: {
          lte: new Date(), // Уже прошло время закрытия
        },
      },
      include: {
        prices: {
          orderBy: {
            timestamp: 'desc',
          },
          take: 2,
        },
      },
      take: 50,
    });

    for (const market of closingMarkets) {
      const yesPrice = market.prices.find((p: any) => p.outcome === 'YES');
      const noPrice = market.prices.find((p: any) => p.outcome === 'NO');

      // Если цена далека от 0 или 1, возможно есть арбитраж
      if (yesPrice && yesPrice.price > 0.10 && yesPrice.price < 0.90) {
        const deviation = Math.min(
          Math.abs(yesPrice.price - 0),
          Math.abs(yesPrice.price - 1)
        );

        if (deviation >= this.priceDeviationThreshold) {
          const alert = this.createAlert(market, 'YES', yesPrice.price, deviation);
          if (alert) {
            alerts.push(alert);
          }
        }
      }
    }

    await this.saveAlerts(alerts);
    return alerts;
  }

  private createSignal(
    market: any,
    outcome: 'YES' | 'NO',
    currentPrice: number,
    expectedPrice: number
  ): StrategySignal | null {
    const deviation = Math.abs(currentPrice - expectedPrice);
    if (deviation < this.priceDeviationThreshold) {
      return null;
    }

    const potentialProfit = (expectedPrice - currentPrice) / currentPrice;
    const confidence = Math.min(100, Math.max(50, deviation * 1000));

    return {
      id: `arbitrage-${market.id}-${outcome}-${Date.now()}`,
      strategy: 'ARBITRAGE',
      marketId: market.id,
      signal: outcome === 'YES' ? 'BUY_YES' : 'BUY_NO',
      confidence: Math.round(confidence),
      potentialRoi: potentialProfit,
      reasoning: `Арбитраж: цена ${(currentPrice * 100).toFixed(2)}%, ожидаемая ${(expectedPrice * 100).toFixed(2)}%, отклонение ${(deviation * 100).toFixed(2)}%`,
      data: {
        currentPrice,
        expectedPrice,
        deviation,
        potentialProfit,
      },
      createdAt: new Date(),
    };
  }

  private createAlert(
    market: any,
    outcome: 'YES' | 'NO',
    price: number,
    deviation: number
  ): Alert | null {
    return {
      id: `arbitrage-alert-${market.id}-${Date.now()}`,
      type: AlertType.ARBITRAGE,
      strategy: 'ARBITRAGE',
      marketId: market.id,
      message: `Арбитражная возможность: "${market.question}". Цена ${(price * 100).toFixed(2)}%, отклонение ${(deviation * 100).toFixed(2)}%`,
      confidence: Math.min(100, Math.max(50, deviation * 1000)),
      data: {
        outcome,
        price,
        deviation,
        marketQuestion: market.question,
        endDate: market.endDate,
      },
      read: false,
      createdAt: new Date(),
    };
  }

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

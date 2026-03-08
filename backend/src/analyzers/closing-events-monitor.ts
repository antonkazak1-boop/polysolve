import { Alert, AlertType } from '../types';
import prisma from '../config/database';
import { calculatePotentialRoi } from '../utils/roi';

/**
 * Монитор событий перед закрытием
 * Отслеживает последние 5-10 минут до resolution
 */
export class ClosingEventsMonitor {
  private monitoringWindowMinutes: number = 10;

  /**
   * Мониторит события, закрывающиеся в ближайшее время
   */
  async monitorClosingEvents(): Promise<Alert[]> {
    const alerts: Alert[] = [];

    const now = new Date();
    const closingTime = new Date(now.getTime() + this.monitoringWindowMinutes * 60 * 1000);

    // Получаем события, закрывающиеся в ближайшие 10 минут
    const closingMarkets = await prisma.market.findMany({
      where: {
        status: 'OPEN',
        endDate: {
          gte: now,
          lte: closingTime,
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
      orderBy: {
        endDate: 'asc',
      },
      take: 50,
    });

    for (const market of closingMarkets) {
      const yesPrice = market.prices.find((p: any) => p.outcome === 'YES');
      const noPrice = market.prices.find((p: any) => p.outcome === 'NO');

      // Проверяем, есть ли возможность когда исход уже ясен, но цена не обновилась
      if (yesPrice && yesPrice.price > 0.10 && yesPrice.price < 0.90) {
        // Цена далека от 0 или 1 - возможно есть возможность
        const timeToClose = (market.endDate.getTime() - now.getTime()) / (1000 * 60); // минуты
        
        if (timeToClose <= 5) {
          // Меньше 5 минут до закрытия
          const alert = this.createAlert(market, 'YES', yesPrice.price, timeToClose);
          if (alert) {
            alerts.push(alert);
          }
        }
      }

      if (noPrice && noPrice.price > 0.10 && noPrice.price < 0.90) {
        const timeToClose = (market.endDate.getTime() - now.getTime()) / (1000 * 60);
        
        if (timeToClose <= 5) {
          const alert = this.createAlert(market, 'NO', noPrice.price, timeToClose);
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
   * Создает алерт для события перед закрытием
   */
  private createAlert(
    market: any,
    outcome: 'YES' | 'NO',
    price: number,
    minutesToClose: number
  ): Alert | null {
    const potentialRoi = calculatePotentialRoi(price);
    const confidence = this.calculateConfidence(market, price, minutesToClose, potentialRoi);

    return {
      id: `closing-${market.id}-${outcome}-${Date.now()}`,
      type: AlertType.CLOSING_EVENT,
      strategy: 'CLOSING_EVENTS',
      marketId: market.id,
      message: `Событие закрывается через ${minutesToClose.toFixed(1)} мин: "${market.question}". Цена ${(price * 100).toFixed(2)}%, потенциальный ROI ${(potentialRoi * 100).toFixed(2)}%`,
      confidence,
      data: {
        outcome,
        price,
        potentialRoi,
        minutesToClose,
        marketQuestion: market.question,
        marketCategory: market.category,
        marketLiquidity: market.liquidity,
        endDate: market.endDate,
      },
      read: false,
      createdAt: new Date(),
    };
  }

  /**
   * Рассчитывает confidence для алерта
   */
  private calculateConfidence(
    market: any,
    price: number,
    minutesToClose: number,
    potentialRoi: number
  ): number {
    let confidence = 40; // Базовый confidence (ниже, т.к. риск выше)

    // Время до закрытия (ближе = выше риск, но выше потенциальная выгода)
    if (minutesToClose <= 1) {
      confidence += 10; // Очень близко к закрытию
    } else if (minutesToClose <= 3) {
      confidence += 5;
    }

    // Потенциальный ROI
    if (potentialRoi >= 5) confidence += 20; // ROI 5x+
    else if (potentialRoi >= 3) confidence += 15; // ROI 3x+
    else if (potentialRoi >= 2) confidence += 10; // ROI 2x+

    // Ликвидность (выше = можно быстрее выйти)
    if (market.liquidity >= 50000) confidence += 15;
    else if (market.liquidity >= 20000) confidence += 10;
    else if (market.liquidity >= 10000) confidence += 5;

    // Цена близка к 0 или 1 (выше уверенность в исходе)
    const distanceFromEdge = Math.min(price, 1 - price);
    if (distanceFromEdge < 0.05) confidence += 10; // Очень близко к краю
    else if (distanceFromEdge < 0.10) confidence += 5;

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
   * Получает события, закрывающиеся в ближайшее время
   */
  async getClosingSoonMarkets(minutes: number = 10): Promise<any[]> {
    const now = new Date();
    const closingTime = new Date(now.getTime() + minutes * 60 * 1000);

    return await prisma.market.findMany({
      where: {
        status: 'OPEN',
        endDate: {
          gte: now,
          lte: closingTime,
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
      orderBy: {
        endDate: 'asc',
      },
    });
  }
}

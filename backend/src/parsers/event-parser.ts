import { Market } from '../types';
import prisma from '../config/database';

/**
 * Парсер событий (markets) с сохранением в БД
 */
export class EventParser {
  /**
   * Сохраняет или обновляет событие в БД
   */
  async saveMarket(market: Market): Promise<void> {
    await prisma.market.upsert({
      where: { conditionId: market.conditionId },
      update: {
        question: market.question,
        description: market.description,
        category: market.category,
        endDate: market.endDate,
        resolutionSource: market.resolutionSource,
        liquidity: market.liquidity,
        volume: market.volume,
        status: market.status,
        updatedAt: new Date(),
      },
      create: {
        id: market.id,
        conditionId: market.conditionId,
        question: market.question,
        description: market.description,
        category: market.category,
        endDate: market.endDate,
        resolutionSource: market.resolutionSource,
        liquidity: market.liquidity,
        volume: market.volume,
        status: market.status,
      },
    });
  }

  /**
   * Сохраняет цены рынка
   */
  async saveMarketPrices(marketId: string, prices: Array<{ outcome: string; price: number; liquidity: number; volume24h?: number }>): Promise<void> {
    const priceRecords = prices.map(price => ({
      marketId,
      outcome: price.outcome,
      price: price.price,
      liquidity: price.liquidity,
      volume24h: price.volume24h ?? 0,
      timestamp: new Date(),
    }));

    if (priceRecords.length > 0) {
      await (prisma.marketPrice as any).createMany({
        data: priceRecords,
        skipDuplicates: true,
      });
    }
  }

  /**
   * Получает активные события из БД
   */
  async getActiveMarkets(limit: number = 100): Promise<Market[]> {
    // Получаем все рынки (не только OPEN), т.к. многие могут быть закрыты, но актуальны
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    
    const markets = await prisma.market.findMany({
      where: {
        endDate: {
          gte: threeMonthsAgo, // Не старше 3 месяцев
        },
      },
      orderBy: {
        liquidity: 'desc',
      },
      take: limit,
    });

    return markets.map((m: any) => ({
      id: m.id,
      conditionId: m.conditionId,
      question: m.question,
      description: m.description || undefined,
      category: m.category,
      endDate: m.endDate,
      resolutionSource: m.resolutionSource || undefined,
      liquidity: m.liquidity,
      volume: m.volume,
      status: m.status as Market['status'],
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
  }

  /**
   * Получает события, закрывающиеся в ближайшее время
   */
  async getClosingSoonMarkets(minutes: number = 10): Promise<Market[]> {
    const now = new Date();
    const closingTime = new Date(now.getTime() + minutes * 60 * 1000);

    const markets = await prisma.market.findMany({
      where: {
        status: 'OPEN',
        endDate: {
          gte: now,
          lte: closingTime,
        },
      },
      orderBy: {
        endDate: 'asc',
      },
    });

    return markets.map((m: any) => ({
      id: m.id,
      conditionId: m.conditionId,
      question: m.question,
      description: m.description || undefined,
      category: m.category,
      endDate: m.endDate,
      resolutionSource: m.resolutionSource || undefined,
      liquidity: m.liquidity,
      volume: m.volume,
      status: m.status as Market['status'],
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
  }
}

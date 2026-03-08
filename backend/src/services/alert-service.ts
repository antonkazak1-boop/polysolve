import { Alert } from '../types';
import prisma from '../config/database';

/**
 * Сервис управления алертами
 */
export class AlertService {
  /**
   * Получает все алерты
   */
  async getAlerts(
    filters?: {
      type?: string;
      read?: boolean;
      limit?: number;
      offset?: number;
    }
  ): Promise<Alert[]> {
    const where: any = {};
    if (filters?.type) {
      where.type = filters.type;
    }
    if (filters?.read !== undefined) {
      where.read = filters.read;
    }

    const alerts = await prisma.alert.findMany({
      where,
      include: {
        market: true,
        wallet: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: filters?.limit || 100,
      skip: filters?.offset || 0,
    });

    return alerts.map(this.mapToAlert);
  }

  /**
   * Получает непрочитанные алерты
   */
  async getUnreadAlerts(limit: number = 50): Promise<Alert[]> {
    return this.getAlerts({ read: false, limit });
  }

  /**
   * Отмечает алерт как прочитанный
   */
  async markAsRead(alertId: string): Promise<void> {
    await prisma.alert.update({
      where: { id: alertId },
      data: { read: true },
    });
  }

  /**
   * Отмечает все алерты как прочитанные
   */
  async markAllAsRead(): Promise<void> {
    await prisma.alert.updateMany({
      where: { read: false },
      data: { read: true },
    });
  }

  /**
   * Удаляет алерт
   */
  async deleteAlert(alertId: string): Promise<void> {
    await prisma.alert.delete({
      where: { id: alertId },
    });
  }

  /**
   * Получает количество непрочитанных алертов
   */
  async getUnreadCount(): Promise<number> {
    return await prisma.alert.count({
      where: { read: false },
    });
  }

  /**
   * Получает алерты по типу стратегии
   */
  async getAlertsByStrategy(strategy: string, limit: number = 50): Promise<Alert[]> {
    return this.getAlerts({
      limit,
    }).then(alerts => alerts.filter(a => a.strategy === strategy));
  }

  /**
   * Получает алерты с высокой уверенностью
   */
  async getHighConfidenceAlerts(minConfidence: number = 70, limit: number = 50): Promise<Alert[]> {
    const alerts = await prisma.alert.findMany({
      where: {
        confidence: {
          gte: minConfidence,
        },
        read: false,
      },
      include: {
        market: true,
        wallet: true,
      },
      orderBy: [
        { confidence: 'desc' },
        { createdAt: 'desc' },
      ],
      take: limit,
    });

    return alerts.map(this.mapToAlert);
  }

  private mapToAlert(alert: any): Alert {
    return {
      id: alert.id,
      type: alert.type as Alert['type'],
      strategy: alert.strategy,
      marketId: alert.marketId || undefined,
      walletId: alert.walletId || undefined,
      message: alert.message,
      confidence: alert.confidence,
      data: alert.data as Record<string, any>,
      read: alert.read,
      createdAt: alert.createdAt,
    };
  }
}

import TelegramBot from 'node-telegram-bot-api';
import { Alert } from '../types';

/**
 * Сервис уведомлений (Telegram, email, web push)
 */
export class NotificationService {
  private telegramBot: TelegramBot | null = null;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token) {
      this.telegramBot = new TelegramBot(token, { polling: false });
    }
  }

  /**
   * Отправляет уведомление об алерте
   */
  async sendAlert(alert: Alert): Promise<void> {
    // Telegram
    if (this.telegramBot) {
      await this.sendTelegramNotification(alert);
    }

    // TODO: Добавить email и web push уведомления
  }

  /**
   * Отправляет Telegram уведомление
   */
  private async sendTelegramNotification(alert: Alert): Promise<void> {
    if (!this.telegramBot) {
      return;
    }

    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) {
      console.warn('TELEGRAM_CHAT_ID not set, skipping Telegram notification');
      return;
    }

    const emoji = this.getEmojiForAlertType(alert.type);
    const message = `${emoji} *${alert.type}*\n\n${alert.message}\n\nConfidence: ${alert.confidence}%`;

    try {
      await this.telegramBot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
      });
    } catch (error) {
      console.error('Error sending Telegram notification:', error);
    }
  }

  /**
   * Получает emoji для типа алерта
   */
  private getEmojiForAlertType(type: string): string {
    switch (type) {
      case 'ASYMMETRIC_RETURNS':
        return '🚀';
      case 'ARBITRAGE':
        return '💰';
      case 'NEW_BET':
        return '📊';
      case 'CLOSING_EVENT':
        return '⏰';
      case 'PATTERN_DETECTED':
        return '🔍';
      default:
        return '📢';
    }
  }

  /**
   * Отправляет batch уведомлений
   */
  async sendBatchAlerts(alerts: Alert[]): Promise<void> {
    // Группируем по типу для более компактных уведомлений
    const grouped = this.groupAlertsByType(alerts);

    for (const [type, typeAlerts] of Object.entries(grouped)) {
      if (typeAlerts.length === 1) {
        await this.sendAlert(typeAlerts[0]);
      } else {
        await this.sendBatchNotification(type, typeAlerts);
      }
    }
  }

  /**
   * Группирует алерты по типу
   */
  private groupAlertsByType(alerts: Alert[]): Record<string, Alert[]> {
    const grouped: Record<string, Alert[]> = {};
    for (const alert of alerts) {
      if (!grouped[alert.type]) {
        grouped[alert.type] = [];
      }
      grouped[alert.type].push(alert);
    }
    return grouped;
  }

  /**
   * Отправляет batch уведомление
   */
  private async sendBatchNotification(type: string, alerts: Alert[]): Promise<void> {
    if (!this.telegramBot) {
      return;
    }

    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) {
      return;
    }

    const emoji = this.getEmojiForAlertType(type);
    const message = `${emoji} *${type}*\n\nНайдено ${alerts.length} новых сигналов:\n\n${alerts.slice(0, 5).map(a => `• ${a.message}`).join('\n')}${alerts.length > 5 ? `\n\n...и еще ${alerts.length - 5}` : ''}`;

    try {
      await this.telegramBot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
      });
    } catch (error) {
      console.error('Error sending batch Telegram notification:', error);
    }
  }
}

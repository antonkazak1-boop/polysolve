import { Server } from 'socket.io';
import { PortfolioService } from '../services/portfolio-service';
import { AlertService } from '../services/alert-service';

const portfolioService = new PortfolioService();
const alertService = new AlertService();

export function setupWebSocket(io: Server) {
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Подписка на обновления портфеля
    socket.on('subscribe:portfolio', async (userId?: string) => {
      socket.join(`portfolio:${userId || 'default'}`);
      
      // Отправляем текущую статистику
      const stats = await portfolioService.getPortfolioStats(userId);
      socket.emit('portfolio:stats', stats);
    });

    // Подписка на алерты
    socket.on('subscribe:alerts', async () => {
      socket.join('alerts');
      
      // Отправляем непрочитанные алерты
      const alerts = await alertService.getUnreadAlerts(50);
      socket.emit('alerts:new', alerts);
    });

    // Отключение
    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });

  // Периодическое обновление данных
  setInterval(async () => {
    // Обновляем цены активных позиций
    await portfolioService.updateActivePositionsPrices();

    // Отправляем обновления портфеля
    const stats = await portfolioService.getPortfolioStats();
    io.to('portfolio:default').emit('portfolio:stats', stats);

    // Отправляем новые алерты
    const unreadCount = await alertService.getUnreadCount();
    io.to('alerts').emit('alerts:count', { count: unreadCount });
  }, 2 * 60 * 1000); // Every 2 min (was 30s) — less load
}

import { Router, Request, Response } from 'express';
import { AlertService } from '../../services/alert-service';

export const alertsRouter = Router();
const alertService = new AlertService();

// Получить все алерты
alertsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const filters = {
      type: req.query.type as string,
      read: req.query.read === 'true' ? true : req.query.read === 'false' ? false : undefined,
      limit: parseInt(req.query.limit as string) || 100,
      offset: parseInt(req.query.offset as string) || 0,
    };
    const alerts = await alertService.getAlerts(filters);
    res.json(alerts);
  } catch (error) {
    console.error('Error fetching alerts:', error);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// Получить непрочитанные алерты
alertsRouter.get('/unread', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const alerts = await alertService.getUnreadAlerts(limit);
    res.json(alerts);
  } catch (error) {
    console.error('Error fetching unread alerts:', error);
    res.status(500).json({ error: 'Failed to fetch unread alerts' });
  }
});

// Получить количество непрочитанных алертов
alertsRouter.get('/unread/count', async (req: Request, res: Response) => {
  try {
    const count = await alertService.getUnreadCount();
    res.json({ count });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// Получить алерты с высокой уверенностью
alertsRouter.get('/high-confidence', async (req: Request, res: Response) => {
  try {
    const minConfidence = parseInt(req.query.minConfidence as string) || 70;
    const limit = parseInt(req.query.limit as string) || 50;
    const alerts = await alertService.getHighConfidenceAlerts(minConfidence, limit);
    res.json(alerts);
  } catch (error) {
    console.error('Error fetching high confidence alerts:', error);
    res.status(500).json({ error: 'Failed to fetch high confidence alerts' });
  }
});

// Отметить алерт как прочитанный
alertsRouter.put('/:id/read', async (req: Request, res: Response) => {
  try {
    await alertService.markAsRead(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking alert as read:', error);
    res.status(500).json({ error: 'Failed to mark alert as read' });
  }
});

// Отметить все алерты как прочитанные
alertsRouter.put('/read-all', async (req: Request, res: Response) => {
  try {
    await alertService.markAllAsRead();
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking all alerts as read:', error);
    res.status(500).json({ error: 'Failed to mark all alerts as read' });
  }
});

// Удалить алерт
alertsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    await alertService.deleteAlert(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting alert:', error);
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});

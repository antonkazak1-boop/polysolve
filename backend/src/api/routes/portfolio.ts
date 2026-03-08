import { Router, Request, Response } from 'express';
import { PortfolioService } from '../../services/portfolio-service';
import prisma from '../../config/database';
import { getDemoBalance, setDemoBalance, updateDemoTradePrices } from '../../services/cron-scheduler';
import { gammaClient, parseOutcomePrices } from '../../clients/gamma-client';

export const portfolioRouter = Router();
const portfolioService = new PortfolioService();

// ────── DEMO TRADING ──────────────────────────────────────────────────────────

// GET /api/portfolio/demo/balance
portfolioRouter.get('/demo/balance', async (_req: Request, res: Response) => {
  try {
    const balance = await getDemoBalance();
    const trades = await (prisma as any).demoTrade.findMany({ where: { status: 'OPEN' } });
    const invested = trades.reduce((s: number, t: any) => s + t.amount, 0);
    const unrealizedPnl = trades.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0);
    res.json({ balance, invested, unrealizedPnl, total: balance + invested + unrealizedPnl });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get demo balance' });
  }
});

// GET /api/portfolio/demo/trades
portfolioRouter.get('/demo/trades', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const where = status ? { status } : {};
    const trades = await (prisma as any).demoTrade.findMany({
      where,
      orderBy: { openedAt: 'desc' },
    });
    res.json(trades);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get trades' });
  }
});

// POST /api/portfolio/demo/open — open a new demo trade
portfolioRouter.post('/demo/open', async (req: Request, res: Response) => {
  try {
    const { eventId, eventTitle, eventSlug, marketId, marketQuestion, outcome, amount, tags } = req.body;

    if (!marketId || !outcome || !amount || amount <= 0) {
      return res.status(400).json({ error: 'marketId, outcome and amount are required' });
    }

    const balance = await getDemoBalance();
    if (amount > balance) {
      return res.status(400).json({ error: `Insufficient balance. Available: $${balance.toFixed(2)}` });
    }

    // Fetch current price
    const market = await gammaClient.getMarketById(marketId).catch(() => null);
    if (!market) return res.status(404).json({ error: 'Market not found' });

    const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
    if (prices.length === 0) return res.status(400).json({ error: 'No prices available' });
    if (prices.some((p: number) => p < 0.005 || p > 0.995)) {
      return res.status(400).json({ error: 'Market already resolved or near-resolved' });
    }

    const entryPrice = outcome === 'YES' ? prices[0] : (prices[1] ?? 1 - prices[0]);

    const trade = await (prisma as any).demoTrade.create({
      data: {
        eventId: eventId ?? marketId,
        eventTitle: eventTitle ?? market.question ?? '',
        marketId,
        marketQuestion: marketQuestion ?? market.question ?? '',
        outcome,
        amount: parseFloat(amount),
        entryPrice,
        currentPrice: entryPrice,
        pnl: 0,
        roi: 0,
        status: 'OPEN',
        tags: JSON.stringify(tags ?? []),
      },
    });

    await setDemoBalance(balance - amount);
    res.json({ trade, newBalance: balance - amount });
  } catch (err: any) {
    console.error('Error opening trade:', err.message);
    res.status(500).json({ error: 'Failed to open trade', detail: err.message });
  }
});

// POST /api/portfolio/demo/close/:id — close a demo trade at current market price
portfolioRouter.post('/demo/close/:id', async (req: Request, res: Response) => {
  try {
    const trade = await (prisma as any).demoTrade.findUnique({ where: { id: req.params.id } });
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    if (trade.status !== 'OPEN') return res.status(400).json({ error: 'Trade already closed' });

    const market = await gammaClient.getMarketById(trade.marketId).catch(() => null);
    let exitPrice = trade.currentPrice ?? trade.entryPrice;

    if (market) {
      const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
      if (prices.length > 0) {
        exitPrice = trade.outcome === 'YES' ? prices[0] : (prices[1] ?? 1 - prices[0]);
      }
    }

    const pnl = (exitPrice - trade.entryPrice) * (trade.amount / trade.entryPrice);
    const roi = ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100;

    const updated = await (prisma as any).demoTrade.update({
      where: { id: trade.id },
      data: {
        exitPrice,
        currentPrice: exitPrice,
        pnl,
        roi,
        status: 'CLOSED_MANUAL',
        closedAt: new Date(),
      },
    });

    const balance = await getDemoBalance();
    const returned = trade.amount + pnl;
    await setDemoBalance(balance + returned);

    res.json({ trade: updated, pnl, roi, newBalance: balance + returned });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to close trade', detail: err.message });
  }
});

// POST /api/portfolio/demo/close-partial/:id — partially close a demo trade
// Body: { fraction: 0.5 }  OR  { amount: 50 }  (one is required)
portfolioRouter.post('/demo/close-partial/:id', async (req: Request, res: Response) => {
  try {
    const trade = await (prisma as any).demoTrade.findUnique({ where: { id: req.params.id } });
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    if (trade.status !== 'OPEN') return res.status(400).json({ error: 'Trade already closed' });

    const { fraction, amount: rawAmount } = req.body;
    let closeFraction: number;
    if (fraction !== undefined) {
      closeFraction = Math.max(0.01, Math.min(0.99, parseFloat(fraction)));
    } else if (rawAmount !== undefined) {
      closeFraction = Math.max(0.01, Math.min(0.99, parseFloat(rawAmount) / trade.amount));
    } else {
      return res.status(400).json({ error: 'Provide fraction (0-1) or amount' });
    }

    const market = await gammaClient.getMarketById(trade.marketId).catch(() => null);
    let exitPrice: number = trade.currentPrice ?? trade.entryPrice;
    if (market) {
      const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
      if (prices.length > 0) {
        exitPrice = trade.outcome === 'YES' ? prices[0] : (prices[1] ?? 1 - prices[0]);
      }
    }

    const closeAmount = trade.amount * closeFraction;
    const remainAmount = trade.amount * (1 - closeFraction);
    const partialPnl = (exitPrice - trade.entryPrice) * (closeAmount / trade.entryPrice);

    // Update original trade to reduced size
    const updated = await (prisma as any).demoTrade.update({
      where: { id: trade.id },
      data: {
        amount: remainAmount,
        currentPrice: exitPrice,
        updatedAt: new Date(),
      },
    });

    // Record the partial close as a separate closed entry for history
    await (prisma as any).demoTrade.create({
      data: {
        eventId: trade.eventId,
        eventTitle: trade.eventTitle,
        marketId: trade.marketId,
        marketQuestion: trade.marketQuestion + ' [partial]',
        outcome: trade.outcome,
        amount: closeAmount,
        entryPrice: trade.entryPrice,
        exitPrice,
        currentPrice: exitPrice,
        pnl: partialPnl,
        roi: ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100,
        status: 'CLOSED_MANUAL',
        openedAt: trade.openedAt,
        closedAt: new Date(),
      },
    });

    const balance = await getDemoBalance();
    await setDemoBalance(balance + closeAmount + partialPnl);

    res.json({ trade: updated, partialPnl, exitPrice, closedFraction: closeFraction, remainAmount });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to partially close trade', detail: err.message });
  }
});

// POST /api/portfolio/demo/refresh-prices — inline price updater (no dynamic import)
portfolioRouter.post('/demo/refresh-prices', async (_req: Request, res: Response) => {
  try {
    // Update all open trades inline to avoid import issues
    const openTrades = await (prisma as any).demoTrade.findMany({ where: { status: 'OPEN' } });
    const results: string[] = [];

    for (const trade of openTrades) {
      try {
        const market = await gammaClient.getMarketById(trade.marketId);
        if (!market) { results.push(`${trade.marketId}: not found`); continue; }

        const prices = parseOutcomePrices(market.outcomePrices ?? '[]');
        if (prices.length === 0) { results.push(`${trade.marketId}: no prices`); continue; }

        const yesPrice = prices[0];
        const noPrice = prices[1] ?? (1 - yesPrice);
        const currentPrice = trade.outcome === 'YES' ? yesPrice : noPrice;
        const pnl = (currentPrice - trade.entryPrice) * (trade.amount / trade.entryPrice);
        const roi = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

        if (prices.some((p: number) => p >= 0.995)) {
          // Market resolved
          const wonOutcome = yesPrice >= 0.995 ? 'YES' : 'NO';
          const won = trade.outcome === wonOutcome;
          const finalPnl = won ? trade.amount * (1 / trade.entryPrice - 1) : -trade.amount;
          const finalRoi = won ? (1 / trade.entryPrice - 1) * 100 : -100;

          await (prisma as any).demoTrade.update({
            where: { id: trade.id },
            data: { currentPrice, exitPrice: currentPrice, pnl: finalPnl, roi: finalRoi,
              status: won ? 'CLOSED_WIN' : 'CLOSED_LOSS', closedAt: new Date() },
          });
          const bal = await getDemoBalance();
          await setDemoBalance(bal + trade.amount + finalPnl);
          results.push(`${trade.marketId}: RESOLVED (${won ? 'WIN' : 'LOSS'})`);
        } else {
          await (prisma as any).demoTrade.update({
            where: { id: trade.id },
            data: { currentPrice, pnl, roi },
          });
          results.push(`${trade.marketId}: OK price=${currentPrice.toFixed(3)} pnl=${pnl.toFixed(2)}`);
        }
      } catch (e: any) {
        results.push(`${trade.marketId}: error ${e.message}`);
      }
    }

    const balance = await getDemoBalance();
    const trades2 = await (prisma as any).demoTrade.findMany({ where: { status: 'OPEN' } });
    const invested = trades2.reduce((s: number, t: any) => s + t.amount, 0);
    const unrealizedPnl = trades2.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0);
    res.json({ balance, invested, unrealizedPnl, total: balance + invested + unrealizedPnl, updated: true, log: results });
  } catch (err: any) {
    console.error('Refresh prices error:', err.message);
    res.status(500).json({ error: 'Failed to refresh prices', detail: err.message });
  }
});

// GET /api/portfolio/demo/history — closed trades with P&L history for chart
portfolioRouter.get('/demo/history', async (_req: Request, res: Response) => {
  try {
    const trades = await (prisma as any).demoTrade.findMany({
      where: { status: { not: 'OPEN' } },
      orderBy: { closedAt: 'asc' },
    });

    let cumulative = 0;
    const history = trades.map((t: any) => {
      cumulative += t.pnl ?? 0;
      return {
        date: t.closedAt ?? t.updatedAt,
        pnl: t.pnl ?? 0,
        roi: t.roi ?? 0,
        cumPnl: cumulative,
        status: t.status,
        label: (t.marketQuestion ?? '').slice(0, 40),
      };
    });

    const balance = await getDemoBalance();
    res.json({ history, currentBalance: balance, totalPnl: cumulative });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// Получить все позиции
portfolioRouter.get('/positions', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const status = req.query.status as string;
    const positions = await portfolioService.getPositions(userId, status);
    res.json(positions);
  } catch (error) {
    console.error('Error fetching positions:', error);
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

// Получить активные позиции
portfolioRouter.get('/positions/active', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const positions = await portfolioService.getActivePositions(userId);
    res.json(positions);
  } catch (error) {
    console.error('Error fetching active positions:', error);
    res.status(500).json({ error: 'Failed to fetch active positions' });
  }
});

// Создать новую позицию
portfolioRouter.post('/positions', async (req: Request, res: Response) => {
  try {
    const position = await portfolioService.createPosition(req.body);
    res.json(position);
  } catch (error) {
    console.error('Error creating position:', error);
    res.status(500).json({ error: 'Failed to create position' });
  }
});

// Обновить позицию
portfolioRouter.put('/positions/:id', async (req: Request, res: Response) => {
  try {
    const position = await portfolioService.updatePosition(req.params.id, req.body);
    if (!position) {
      return res.status(404).json({ error: 'Position not found' });
    }
    res.json(position);
  } catch (error) {
    console.error('Error updating position:', error);
    res.status(500).json({ error: 'Failed to update position' });
  }
});

// Получить статистику портфеля
portfolioRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const stats = await portfolioService.getPortfolioStats(userId);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching portfolio stats:', error);
    res.status(500).json({ error: 'Failed to fetch portfolio stats' });
  }
});

// Получить распределение по категориям
portfolioRouter.get('/distribution', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const distribution = await portfolioService.getCategoryDistribution(userId);
    res.json(distribution);
  } catch (error) {
    console.error('Error fetching distribution:', error);
    res.status(500).json({ error: 'Failed to fetch distribution' });
  }
});

// Получить снимки портфеля
portfolioRouter.get('/snapshots', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const limit = parseInt(req.query.limit as string) || 100;
    const snapshots = await portfolioService.getSnapshots(userId, limit);
    res.json(snapshots);
  } catch (error) {
    console.error('Error fetching snapshots:', error);
    res.status(500).json({ error: 'Failed to fetch snapshots' });
  }
});

// Создать снимок портфеля
portfolioRouter.post('/snapshots', async (req: Request, res: Response) => {
  try {
    const userId = req.body.userId as string;
    const snapshot = await portfolioService.createSnapshot(userId);
    res.json(snapshot);
  } catch (error) {
    console.error('Error creating snapshot:', error);
    res.status(500).json({ error: 'Failed to create snapshot' });
  }
});

// Обновить цены активных позиций
portfolioRouter.post('/positions/update-prices', async (req: Request, res: Response) => {
  try {
    await portfolioService.updateActivePositionsPrices();
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating prices:', error);
    res.status(500).json({ error: 'Failed to update prices' });
  }
});

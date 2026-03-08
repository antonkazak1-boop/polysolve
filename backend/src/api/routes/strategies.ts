import { Router, Request, Response } from 'express';
import { AsymmetricReturnsAnalyzer } from '../../analyzers/asymmetric-returns-analyzer';
import { ArbitrageAnalyzer } from '../../analyzers/arbitrage-analyzer';
import { NewBetsMonitor } from '../../analyzers/new-bets-monitor';
import { PatternAnalyzer } from '../../analyzers/pattern-analyzer';
import { ClosingEventsMonitor } from '../../analyzers/closing-events-monitor';

export const strategiesRouter = Router();

const asymmetricAnalyzer = new AsymmetricReturnsAnalyzer();
const arbitrageAnalyzer = new ArbitrageAnalyzer();
const newBetsMonitor = new NewBetsMonitor();
const patternAnalyzer = new PatternAnalyzer();
const closingMonitor = new ClosingEventsMonitor();

// Получить сигналы асимметричных доходностей
strategiesRouter.get('/asymmetric-returns', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const signals = await asymmetricAnalyzer.getRecentSignals(limit);
    res.json(signals);
  } catch (error) {
    console.error('Error fetching asymmetric returns signals:', error);
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

// Запустить анализ асимметричных доходностей
strategiesRouter.post('/asymmetric-returns/analyze', async (req: Request, res: Response) => {
  try {
    const signals = await asymmetricAnalyzer.analyzeMarkets();
    res.json({ signals, count: signals.length });
  } catch (error) {
    console.error('Error analyzing asymmetric returns:', error);
    res.status(500).json({ error: 'Failed to analyze' });
  }
});

// Запустить анализ успешных кошельков
strategiesRouter.post('/asymmetric-returns/analyze-wallets', async (req: Request, res: Response) => {
  try {
    const alerts = await asymmetricAnalyzer.analyzeSuccessfulWallets();
    res.json({ alerts, count: alerts.length });
  } catch (error) {
    console.error('Error analyzing wallets:', error);
    res.status(500).json({ error: 'Failed to analyze wallets' });
  }
});

// Получить арбитражные сигналы
strategiesRouter.post('/arbitrage/analyze', async (req: Request, res: Response) => {
  try {
    const signals = await arbitrageAnalyzer.analyzeResolvedMarkets();
    res.json({ signals, count: signals.length });
  } catch (error) {
    console.error('Error analyzing arbitrage:', error);
    res.status(500).json({ error: 'Failed to analyze arbitrage' });
  }
});

// Мониторинг пост-событийного арбитража
strategiesRouter.post('/arbitrage/monitor-post-event', async (req: Request, res: Response) => {
  try {
    const alerts = await arbitrageAnalyzer.monitorPostEventArbitrage();
    res.json({ alerts, count: alerts.length });
  } catch (error) {
    console.error('Error monitoring post-event arbitrage:', error);
    res.status(500).json({ error: 'Failed to monitor' });
  }
});

// Мониторинг новых крупных ставок
strategiesRouter.post('/new-bets/monitor', async (req: Request, res: Response) => {
  try {
    const alerts = await newBetsMonitor.monitorNewBets();
    res.json({ alerts, count: alerts.length });
  } catch (error) {
    console.error('Error monitoring new bets:', error);
    res.status(500).json({ error: 'Failed to monitor new bets' });
  }
});

// Получить последние крупные ставки
strategiesRouter.get('/new-bets/recent', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const bets = await newBetsMonitor.getRecentLargeBets(limit);
    res.json(bets);
  } catch (error) {
    console.error('Error fetching recent large bets:', error);
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
});

// Анализ паттернов
strategiesRouter.post('/patterns/analyze', async (req: Request, res: Response) => {
  try {
    const alerts = await patternAnalyzer.analyzePatterns();
    res.json({ alerts, count: alerts.length });
  } catch (error) {
    console.error('Error analyzing patterns:', error);
    res.status(500).json({ error: 'Failed to analyze patterns' });
  }
});

// Анализ корреляций
strategiesRouter.post('/patterns/correlations', async (req: Request, res: Response) => {
  try {
    const alerts = await patternAnalyzer.analyzeCorrelations();
    res.json({ alerts, count: alerts.length });
  } catch (error) {
    console.error('Error analyzing correlations:', error);
    res.status(500).json({ error: 'Failed to analyze correlations' });
  }
});

// Мониторинг закрывающихся событий
strategiesRouter.post('/closing-events/monitor', async (req: Request, res: Response) => {
  try {
    const alerts = await closingMonitor.monitorClosingEvents();
    res.json({ alerts, count: alerts.length });
  } catch (error) {
    console.error('Error monitoring closing events:', error);
    res.status(500).json({ error: 'Failed to monitor closing events' });
  }
});

// Получить события, закрывающиеся в ближайшее время
strategiesRouter.get('/closing-events/soon', async (req: Request, res: Response) => {
  try {
    const minutes = parseInt(req.query.minutes as string) || 10;
    const markets = await closingMonitor.getClosingSoonMarkets(minutes);
    res.json(markets);
  } catch (error) {
    console.error('Error fetching closing markets:', error);
    res.status(500).json({ error: 'Failed to fetch closing markets' });
  }
});

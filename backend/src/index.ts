import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { marketsRouter } from './api/routes/markets';
import { eventsRouter } from './api/routes/events';
import { leaderboardRouter } from './api/routes/leaderboard';
import { anomaliesRouter } from './api/routes/anomalies';
import { walletsRouter } from './api/routes/wallets';
import { portfolioRouter } from './api/routes/portfolio';
import { alertsRouter } from './api/routes/alerts';
import { strategiesRouter } from './api/routes/strategies';
import { recommendationsRouter } from './api/routes/recommendations';
import { signalsRouter } from './api/routes/signals';
import { whalesRouter } from './api/routes/whales';
import { cryptoRouter } from './api/routes/crypto';
import { copytradingRouter } from './api/routes/copytrading';
import { authRouter } from './api/routes/auth';
import { adminRouter } from './api/routes/admin';
import { lolPandascoreRouter } from './api/routes/lol-pandascore';
import { lolGolggRouter } from './api/routes/lol-golgg';
import { btcStrategyRouter } from './api/routes/btc-strategy';
import { lolDraftRouter } from './api/routes/lol-draft-analysis';
import { setupWebSocket } from './api/websocket';
import { startCron } from './services/cron-scheduler';
import { startActivityFeedPoller } from './services/activity-feed';
import { startCopyTradePoller } from './services/copy-trade';
import { initClobClient, getClobStatus } from './clients/polymarket-clob';
import { ensureAdminExists, ensureBootstrapAdminIfNoAdmin } from './services/auth';

dotenv.config();

// Prevent uncaught errors from killing the process
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException (process kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection (process kept alive):', reason);
});

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/markets', marketsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/leaderboard', leaderboardRouter);
app.use('/api/anomalies', anomaliesRouter);
app.use('/api/wallets', walletsRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/strategies', strategiesRouter);
app.use('/api/recommendations', recommendationsRouter);
app.use('/api/signals', signalsRouter);
app.use('/api/whales', whalesRouter);
app.use('/api/crypto', cryptoRouter);
app.use('/api/copytrading', copytradingRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/lol', lolPandascoreRouter);
app.use('/api/lol', lolGolggRouter);
app.use('/api/btc-strategy', btcStrategyRouter);
app.use('/api', lolDraftRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// CLOB status
app.get('/api/clob/status', (_req, res) => {
  res.json(getClobStatus());
});

// Setup WebSocket
setupWebSocket(io);

// Start server
httpServer.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 WebSocket server ready`);
  startCron();
  startActivityFeedPoller();
  startCopyTradePoller();

  if (process.env.POLY_PRIVATE_KEY) {
    await initClobClient();
    // init runs once at boot — if VPN was off or IP was blocked, CLOB stays "offline" until restart.
    // Retry every 90s so turning VPN on later recovers without manual server restart.
    setInterval(async () => {
      if (!getClobStatus().ready && process.env.POLY_PRIVATE_KEY) {
        const ok = await initClobClient();
        if (ok) console.log('[clob] recovered after retry (VPN/region or keys now OK)');
      }
    }, 90_000);
  } else {
    console.log('[clob] POLY_PRIVATE_KEY not set — live trading disabled');
  }

  await ensureAdminExists();
  await ensureBootstrapAdminIfNoAdmin();
});

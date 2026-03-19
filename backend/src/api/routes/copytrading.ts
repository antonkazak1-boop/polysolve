import { Router, Request, Response } from 'express';
import axios from 'axios';
import prisma from '../../config/database';
import { gammaClient } from '../../clients/gamma-client';
import { poll, syncTraderExits, getClobPrice } from '../../services/copy-trade';
import { getClobStatus, cancelAllOrders, getTradingUserAddress, getTradingAddresses } from '../../clients/polymarket-clob';
import { getCurrentCountry, getBlockedCountries, isRegionAllowedForTrading } from '../../utils/region-guard';

export const copytradingRouter = Router();

// GET /api/copytrading/settings — global copy-trading settings
copytradingRouter.get('/settings', async (_req: Request, res: Response) => {
  try {
    const s = await (prisma as any).copyTradingSettings.upsert({
      where: { id: 'global' },
      update: {},
      create: { id: 'global', minCopyPrice: 0.004, maxCopyPrice: 0.95 },
    });
    res.json(s);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// PATCH /api/copytrading/settings — update global settings
copytradingRouter.patch('/settings', async (req: Request, res: Response) => {
  try {
    const { minCopyPrice, maxCopyPrice } = req.body;
    const data: Record<string, any> = {};
    if (minCopyPrice !== undefined) data.minCopyPrice = Math.min(Math.max(parseFloat(minCopyPrice), 0.001), 0.1);
    if (maxCopyPrice !== undefined) data.maxCopyPrice = Math.min(Math.max(parseFloat(maxCopyPrice), 0.5), 0.999);
    const s = await (prisma as any).copyTradingSettings.upsert({
      where: { id: 'global' },
      update: data,
      create: { id: 'global', minCopyPrice: 0.004, maxCopyPrice: 0.95, ...data },
    });
    res.json(s);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update settings', detail: err.message });
  }
});

// GET /api/copytrading/wallets — list all copy wallets
copytradingRouter.get('/wallets', async (_req: Request, res: Response) => {
  try {
    const list = await (prisma as any).copyWallet.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list wallets' });
  }
});

// POST /api/copytrading/wallets — add wallet
copytradingRouter.post('/wallets', async (req: Request, res: Response) => {
  try {
    const {
      walletAddress,
      label,
      amountPerTrade,
      enabled,
      takeProfitEnabled,
      takeProfitRoiPercent,
      takeProfitClosePercent,
      staleExitEnabled,
      staleExitDays,
      staleExitLossPct,
      preCloseExitHours,
    } = req.body;
    const addr = (walletAddress || '').trim();
    if (!addr) return res.status(400).json({ error: 'walletAddress required' });

    const existing = await (prisma as any).copyWallet.findUnique({
      where: { walletAddress: addr.toLowerCase() },
    });
    if (existing) return res.status(400).json({ error: 'Wallet already added' });

    const { mode } = req.body;
    const minSh = Math.min(10_000, Math.max(5, parseInt(req.body.minOrderShares, 10) || 5));
    const cScale = Math.min(10, Math.max(0.01, parseFloat(req.body.copyScale) || 1));
    const created = await (prisma as any).copyWallet.create({
      data: {
        walletAddress: addr.toLowerCase(),
        label: label || null,
        amountPerTrade: parseFloat(amountPerTrade) || 1,
        minOrderShares: minSh,
        copyScale: cScale,
        takeProfitEnabled: Boolean(takeProfitEnabled),
        takeProfitRoiPercent: Math.max(parseFloat(takeProfitRoiPercent) || 150, 1),
        takeProfitClosePercent: Math.min(Math.max(parseFloat(takeProfitClosePercent) || 40, 1), 95),
        takeProfitFallbackPrice: Math.min(Math.max(parseFloat(req.body.takeProfitFallbackPrice) || 0.80, 0.1), 0.99),
        staleExitEnabled: staleExitEnabled !== false,
        staleExitDays: parseInt(staleExitDays) || 7,
        staleExitLossPct: parseFloat(staleExitLossPct) || 70,
        preCloseExitHours: parseInt(preCloseExitHours) || 3,
        enabled: enabled !== false,
        mode: mode === 'live' ? 'live' : 'demo',
      },
    });
    res.json(created);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to add wallet', detail: err.message });
  }
});

// PATCH /api/copytrading/wallets/:id
copytradingRouter.patch('/wallets/:id', async (req: Request, res: Response) => {
  try {
    const {
      label,
      amountPerTrade,
      enabled,
      mode,
      takeProfitEnabled,
      takeProfitRoiPercent,
      takeProfitClosePercent,
      staleExitEnabled,
      staleExitDays,
      staleExitLossPct,
      preCloseExitHours,
    } = req.body;
    const data: Record<string, any> = {};
    if (label !== undefined) data.label = label;
    if (amountPerTrade !== undefined) data.amountPerTrade = parseFloat(amountPerTrade);
    if (req.body.minOrderShares !== undefined) {
      data.minOrderShares = Math.min(10_000, Math.max(5, parseInt(req.body.minOrderShares, 10) || 5));
    }
    if (req.body.copyScale !== undefined) {
      data.copyScale = Math.min(10, Math.max(0.01, parseFloat(req.body.copyScale) || 1));
    }
    if (enabled !== undefined) data.enabled = Boolean(enabled);
    if (mode !== undefined) data.mode = mode === 'live' ? 'live' : 'demo';
    if (takeProfitEnabled !== undefined) data.takeProfitEnabled = Boolean(takeProfitEnabled);
    if (takeProfitRoiPercent !== undefined) data.takeProfitRoiPercent = Math.max(parseFloat(takeProfitRoiPercent), 1);
    if (takeProfitClosePercent !== undefined) data.takeProfitClosePercent = Math.min(Math.max(parseFloat(takeProfitClosePercent), 1), 95);
    if (req.body.takeProfitFallbackPrice !== undefined) data.takeProfitFallbackPrice = Math.min(Math.max(parseFloat(req.body.takeProfitFallbackPrice), 0.1), 0.99);
    if (staleExitEnabled !== undefined) data.staleExitEnabled = Boolean(staleExitEnabled);
    if (staleExitDays !== undefined) data.staleExitDays = Math.max(parseInt(staleExitDays), 1);
    if (staleExitLossPct !== undefined) data.staleExitLossPct = Math.min(Math.max(parseFloat(staleExitLossPct), 10), 99);
    if (preCloseExitHours !== undefined) data.preCloseExitHours = Math.max(parseInt(preCloseExitHours), 0);

    const updated = await (prisma as any).copyWallet.update({
      where: { id: req.params.id },
      data,
    });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update wallet', detail: err.message });
  }
});

// DELETE /api/copytrading/wallets/:id
copytradingRouter.delete('/wallets/:id', async (req: Request, res: Response) => {
  try {
    await (prisma as any).copyWallet.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete wallet', detail: err.message });
  }
});

// GET /api/copytrading/logs?limit=30&offset=0&wallet=0x...&action=BUY
copytradingRouter.get('/logs', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 30, 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const wallet = (req.query.wallet as string)?.toLowerCase();
    const action = req.query.action as string | undefined;
    const status = req.query.status as string | undefined;

    const where: Record<string, any> = {};
    if (wallet) where.walletAddress = wallet;
    if (action) where.action = action.toUpperCase();
    if (status) where.status = status;

    const [logs, total] = await Promise.all([
      (prisma as any).copyTradeLog.findMany({
        where,
        orderBy: { copiedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      (prisma as any).copyTradeLog.count({ where }),
    ]);
    res.json({ items: logs, total, limit, offset });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

// GET /api/copytrading/stats?wallet=0x... — per wallet or global
copytradingRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const wallet = (req.query.wallet as string)?.toLowerCase();
    const where = wallet ? { walletAddress: wallet } : {};
    const posWhere: Record<string, any> = { sourceWalletAddress: { not: null } };
    if (wallet) posWhere.sourceWalletAddress = wallet;

    const [totalCopied, totalSkipped, todayCopied, copyLogs, openPositions] = await Promise.all([
      (prisma as any).copyTradeLog.count({ where: { ...where, status: 'COPIED' } }),
      (prisma as any).copyTradeLog.count({ where: { ...where, status: 'SKIPPED' } }),
      (prisma as any).copyTradeLog.count({
        where: {
          ...where,
          status: 'COPIED',
          copiedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
      (prisma as any).copyTradeLog.findMany({
        where: { ...where, status: 'COPIED', demoTradeId: { not: null } },
        select: { demoTradeId: true },
      }),
      (prisma as any).demoTrade.findMany({
        where: { ...posWhere, status: 'OPEN' },
        select: { amount: true, pnl: true },
      }),
    ]);

    const demoIds = copyLogs.map((l: any) => l.demoTradeId).filter(Boolean);
    const demoTrades = demoIds.length > 0
      ? await (prisma as any).demoTrade.findMany({
          where: { id: { in: demoIds } },
          select: { pnl: true, roi: true, status: true },
        })
      : [];

    const totalPnl = demoTrades.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0);
    const wins = demoTrades.filter((t: any) => t.status === 'CLOSED_WIN').length;
    const losses = demoTrades.filter((t: any) => t.status === 'CLOSED_LOSS').length;
    const open = demoTrades.filter((t: any) => t.status === 'OPEN').length;
    const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : null;

    const invested = openPositions.reduce((s: number, t: any) => s + t.amount, 0);
    const unrealizedPnl = openPositions.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0);

    res.json({
      totalCopied, totalSkipped, todayCopied, totalPnl, wins, losses, open, winRate,
      invested, unrealizedPnl, openPositions: openPositions.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// GET /api/copytrading/stats/per-wallet — array of per-wallet mini-stats for wallet cards
copytradingRouter.get('/stats/per-wallet', async (_req: Request, res: Response) => {
  try {
    const wallets = await (prisma as any).copyWallet.findMany({ select: { walletAddress: true } });
    const result = await Promise.all(
      wallets.map(async (w: any) => {
        const addr = w.walletAddress.toLowerCase();
        const [openPositions, copyLogs] = await Promise.all([
          (prisma as any).demoTrade.findMany({
            where: { sourceWalletAddress: addr, status: 'OPEN' },
            select: { amount: true, pnl: true },
          }),
          (prisma as any).copyTradeLog.findMany({
            where: { walletAddress: addr, status: 'COPIED', demoTradeId: { not: null } },
            select: { demoTradeId: true },
          }),
        ]);
        const demoIds = copyLogs.map((l: any) => l.demoTradeId).filter(Boolean);
        const demoTrades = demoIds.length > 0
          ? await (prisma as any).demoTrade.findMany({
              where: { id: { in: demoIds } },
              select: { pnl: true, status: true },
            })
          : [];
        const totalPnl = demoTrades.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0);
        const unrealizedPnl = openPositions.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0);
        return {
          walletAddress: addr,
          totalCopied: copyLogs.length,
          open: openPositions.length,
          totalPnl,
          unrealizedPnl,
        };
      })
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get per-wallet stats' });
  }
});

// GET /api/copytrading/positions?wallet=0x...&status=OPEN|CLOSED|ALL&limit=30&offset=0
copytradingRouter.get('/positions', async (req: Request, res: Response) => {
  try {
    const wallet = (req.query.wallet as string)?.toLowerCase();
    const statusParam = ((req.query.status as string) || 'ALL').toUpperCase();
    const limit = Math.min(parseInt(req.query.limit as string) || 30, 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const where: Record<string, any> = { sourceWalletAddress: { not: null } };
    if (wallet) where.sourceWalletAddress = wallet;
    if (statusParam === 'OPEN') where.status = 'OPEN';
    else if (statusParam === 'CLOSED') where.status = { not: 'OPEN' };

    const [positions, total] = await Promise.all([
      (prisma as any).demoTrade.findMany({
        where,
        orderBy: { openedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      (prisma as any).demoTrade.count({ where }),
    ]);
    res.json({ items: positions, total, limit, offset });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get positions' });
  }
});

// GET /api/copytrading/wallet/trades?address=0x...
copytradingRouter.get('/wallet/trades', async (req: Request, res: Response) => {
  try {
    const address = (req.query.address as string)?.trim();
    if (!address) return res.status(400).json({ error: 'address required' });
    const trades = await gammaClient.getWalletTrades(address, 30);
    res.json(trades);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch wallet trades', detail: err.message });
  }
});

// GET /api/copytrading/clob-status
copytradingRouter.get('/clob-status', (_req: Request, res: Response) => {
  res.json(getClobStatus());
});

// GET /api/copytrading/region-check — текущий IP, страна, разрешена ли торговля
copytradingRouter.get('/region-check', async (_req: Request, res: Response) => {
  try {
    const country = await getCurrentCountry();
    const blockedList = getBlockedCountries();
    const allowed = !country || !blockedList.includes(country);
    res.json({
      country: country || null,
      allowed,
      blockedCountries: blockedList,
      message: country
        ? (allowed ? `Регион ${country} разрешён для торговли в боте.` : `Регион ${country} в списке блокировки (${blockedList.join(', ')}). Включите VPN.`)
        : 'Не удалось определить страну по IP.',
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Region check failed', detail: err?.message });
  }
});

// GET /api/copytrading/live-trades?wallet=0x...
copytradingRouter.get('/live-trades', async (req: Request, res: Response) => {
  try {
    const wallet = (req.query.wallet as string)?.toLowerCase();
    const where: Record<string, any> = {};
    if (wallet) where.sourceWalletAddress = wallet;

    const trades = await (prisma as any).liveTrade.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(trades);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get live trades' });
  }
});

// GET /api/copytrading/live-positions?wallet=0x...&status=open|closed|all&limit=30&offset=0
// Returns liveTrade BUYs with current CLOB prices, PnL, ROI — replaces demoTrade positions
copytradingRouter.get('/live-positions', async (req: Request, res: Response) => {
  try {
    const wallet = (req.query.wallet as string)?.toLowerCase();
    const statusParam = ((req.query.status as string) || 'open').toLowerCase();
    const limit = Math.min(parseInt(req.query.limit as string) || 30, 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const where: Record<string, any> = { side: 'BUY', isTakeProfit: false };
    if (wallet) where.sourceWalletAddress = wallet;
    if (statusParam === 'open') where.status = 'FILLED';
    else if (statusParam === 'closed') where.status = { in: ['CLOSED', 'CANCELLED'] };
    // 'all' = no status filter

    const [buys, total] = await Promise.all([
      (prisma as any).liveTrade.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      (prisma as any).liveTrade.count({ where }),
    ]);

    // Fetch current prices for FILLED (open) positions in batch
    const openBuys = buys.filter((b: any) => b.status === 'FILLED' && b.tokenId);
    const priceMap = new Map<string, number | null>();
    await Promise.all(
      openBuys.map(async (b: any) => {
        try {
          const p = await getClobPrice(b.tokenId);
          priceMap.set(b.tokenId, p);
        } catch { priceMap.set(b.tokenId, null); }
      })
    );

    const items = buys.map((b: any) => {
      const entryPrice = b.price ?? 0;
      const currentPrice = b.status === 'FILLED'
        ? (priceMap.get(b.tokenId) ?? entryPrice)
        : entryPrice;
      const invested = b.usdcAmount ?? (entryPrice * (b.size ?? 0));
      const currentValue = currentPrice * (b.size ?? 0);
      const pnl = b.status === 'FILLED' ? currentValue - invested : 0;
      const roi = invested > 0 ? (pnl / invested) * 100 : 0;
      return {
        id: b.id,
        marketTitle: b.marketTitle,
        outcome: b.outcome,
        side: b.side,
        status: b.status,
        entryPrice,
        currentPrice: b.status === 'FILLED' ? currentPrice : null,
        size: b.size,
        invested,
        pnl: b.status === 'FILLED' ? pnl : null,
        roi: b.status === 'FILLED' ? roi : null,
        sourceWalletAddress: b.sourceWalletAddress,
        tokenId: b.tokenId,
        orderId: b.orderId,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        errorMessage: b.errorMessage,
      };
    });

    res.json({ items, total, limit, offset });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get live positions', detail: err.message });
  }
});

// GET /api/copytrading/live-stats — overall + per-wallet stats from liveTrade (not demoTrade)
copytradingRouter.get('/live-stats', async (_req: Request, res: Response) => {
  try {
    const wallets = await (prisma as any).copyWallet.findMany({ select: { walletAddress: true } });
    const perWallet = await Promise.all(
      wallets.map(async (w: any) => {
        const addr = w.walletAddress.toLowerCase();
        const openBuys = await (prisma as any).liveTrade.findMany({
          where: { sourceWalletAddress: addr, side: 'BUY', status: 'FILLED', isTakeProfit: false },
          select: { tokenId: true, price: true, size: true, usdcAmount: true },
        });
        // Fetch current prices
        const priceResults = await Promise.all(
          openBuys.map(async (b: any) => {
            try { return b.tokenId ? await getClobPrice(b.tokenId) : null; } catch { return null; }
          })
        );
        let invested = 0, unrealizedPnl = 0;
        openBuys.forEach((b: any, i: number) => {
          const entryInvested = b.usdcAmount ?? (b.price * (b.size ?? 0));
          invested += entryInvested;
          const cur = priceResults[i];
          if (cur !== null && cur !== undefined) {
            unrealizedPnl += cur * (b.size ?? 0) - entryInvested;
          }
        });
        // Closed sells for realized PnL
        const closedSells = await (prisma as any).liveTrade.findMany({
          where: { sourceWalletAddress: addr, side: 'SELL', status: 'FILLED' },
          select: { usdcAmount: true },
        });
        const closedBuys = await (prisma as any).liveTrade.findMany({
          where: { sourceWalletAddress: addr, side: 'BUY', status: 'CLOSED', isTakeProfit: false },
          select: { usdcAmount: true },
        });
        const realizedPnl = closedSells.reduce((s: number, t: any) => s + (t.usdcAmount ?? 0), 0)
          - closedBuys.reduce((s: number, t: any) => s + (t.usdcAmount ?? 0), 0);

        return { walletAddress: addr, open: openBuys.length, invested, unrealizedPnl, totalPnl: realizedPnl + unrealizedPnl, totalCopied: openBuys.length + closedBuys.length };
      })
    );
    res.json(perWallet);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get live stats', detail: err.message });
  }
});

// POST /api/copytrading/trigger
copytradingRouter.post('/trigger', async (_req: Request, res: Response) => {
  try {
    const result = await poll();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: 'Poll failed', detail: err.message });
  }
});

// POST /api/copytrading/cancel-all — cancel all pending CLOB orders + mark DB as CANCELLED
copytradingRouter.post('/cancel-all', async (_req: Request, res: Response) => {
  try {
    const clobResult = await cancelAllOrders();
    const dbResult = await (prisma as any).liveTrade.updateMany({
      where: { status: 'LIVE' },
      data: { status: 'CANCELLED' },
    });
    res.json({ ok: true, clobCancelled: clobResult, dbCancelled: dbResult.count });
  } catch (err: any) {
    res.status(500).json({ error: 'Cancel failed', detail: err.message });
  }
});

// GET /api/copytrading/reconcile — compare real Polymarket positions vs DB (для проверки актуальности)
copytradingRouter.get('/reconcile', async (_req: Request, res: Response) => {
  try {
    const { funder, signer } = getTradingAddresses();
    const tradingUser = getTradingUserAddress();
    if (!tradingUser) {
      return res.json({ ok: false, error: 'CLOB not configured', realPositions: [], dbOpenBuys: [], ghostCandidates: [], desynced: [] });
    }
    // Polymarket API may return positions for proxy (funder) or for signer (EOA) — try both
    const addressesToTry = [funder, signer].filter(Boolean) as string[];
    const seenAssets = new Map<string, { asset: string; size: number; market?: string }>();
    let usedAddress = '';
    for (const addr of addressesToTry) {
      const posResp = await axios.get('https://data-api.polymarket.com/positions', {
        params: { user: addr, sizeThreshold: 0 },
        timeout: 15_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
      });
      const list: { asset: string; size: number; market?: string }[] = (posResp.data || []).map((p: any) => ({
        asset: p.asset,
        size: parseFloat(p.size || 0),
        market: p.market,
      }));
      if (list.some((r) => r.size > 0)) {
        usedAddress = addr;
        list.forEach((r) => {
          if (r.size > 0) seenAssets.set(r.asset, r);
        });
        break;
      }
    }
    const realPositions = Array.from(seenAssets.values());
    const realMap = new Map(realPositions.map((r) => [r.asset, r.size]));

    const dbOpenBuys = await (prisma as any).liveTrade.findMany({
      where: { side: 'BUY', status: 'FILLED', isTakeProfit: false },
      select: { id: true, tokenId: true, conditionId: true, marketTitle: true, outcome: true, size: true, sourceWalletAddress: true },
    });
    const dbClosedBuysByToken = new Map<string, any>();
    const closedBuys = await (prisma as any).liveTrade.findMany({
      where: { side: 'BUY', status: 'CLOSED' },
      select: { id: true, tokenId: true, marketTitle: true, outcome: true, errorMessage: true },
    });
    closedBuys.forEach((b: any) => {
      if (b.tokenId) dbClosedBuysByToken.set(b.tokenId, b);
    });

    const ghostCandidates: { id: string; marketTitle: string; tokenId: string; dbSize: number; realSize: number }[] = [];
    const desynced: { asset: string; realSize: number; marketTitle?: string; outcome?: string; errorMessage?: string }[] = [];

    for (const buy of dbOpenBuys) {
      const realSize = buy.tokenId ? realMap.get(buy.tokenId) ?? 0 : 0;
      if (realSize === 0 && buy.tokenId) {
        ghostCandidates.push({
          id: buy.id,
          marketTitle: buy.marketTitle || '',
          tokenId: buy.tokenId,
          dbSize: buy.size || 0,
          realSize: 0,
        });
      }
    }

    for (const r of realPositions) {
      if (r.size <= 0) continue;
      const openMatch = dbOpenBuys.find((b: any) => b.tokenId === r.asset);
      if (openMatch) continue;
      const closedMatch = dbClosedBuysByToken.get(r.asset);
      if (closedMatch) {
        desynced.push({
          asset: r.asset,
          realSize: r.size,
          marketTitle: closedMatch.marketTitle,
          outcome: closedMatch.outcome,
          errorMessage: closedMatch.errorMessage,
        });
      }
    }

    res.json({
      ok: true,
      tradingUser: usedAddress || tradingUser,
      realPositionsCount: realPositions.length,
      dbOpenBuysCount: dbOpenBuys.length,
      ghostCandidates,
      desynced,
      realPositions: realPositions.slice(0, 50),
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Reconcile failed', detail: err.message });
  }
});

// POST /api/copytrading/sync-exits — force check if traders exited our positions
copytradingRouter.post('/sync-exits', async (_req: Request, res: Response) => {
  try {
    const closed = await syncTraderExits();
    res.json({ ok: true, closed });
  } catch (err: any) {
    res.status(500).json({ error: 'Sync failed', detail: err.message });
  }
});

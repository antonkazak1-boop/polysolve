/**
 * One-shot: find copy-trade positions that are still open on-chain (FILLED BUY in DB,
 * or orphan shares with no open BUY row) and place GTC SELL limit orders at the CLOB ask.
 *
 * Usage (from backend/):  npx tsx scripts/place-copy-exit-sells.ts
 * Requires: .env with POLY_* keys, VPN if your region is blocked.
 */

import 'dotenv/config';
import axios from 'axios';
import prisma from '../src/config/database';
import {
  initClobClient,
  getClobStatus,
  placeSellOrder,
  cancelOrder,
  getTradingUserAddress,
  getOpenSellOrders,
} from '../src/clients/polymarket-clob';
import { isRegionAllowedForTrading, getCurrentCountry } from '../src/utils/region-guard';

const clobHttp = axios.create({
  baseURL: 'https://clob.polymarket.com',
  timeout: 15_000,
});

async function getAskPrice(tokenId: string): Promise<number | null> {
  try {
    const res = await clobHttp.get('/price', { params: { token_id: tokenId, side: 'sell' } });
    const p = parseFloat(res.data?.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

/** Free shares = on-chain position minus size locked in open SELL orders (same as copy-trade). */
async function getFreeSharesForToken(tokenId: string): Promise<number | null> {
  const tradingUser = getTradingUserAddress();
  if (!tradingUser) return null;
  try {
    const [posResp, sellOrders] = await Promise.all([
      axios.get('https://data-api.polymarket.com/positions', {
        params: { user: tradingUser, sizeThreshold: 0 },
        timeout: 15_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; polysolve-flush/1.0)' },
      }),
      getOpenSellOrders(tokenId),
    ]);
    const position = (posResp.data || []).find((p: any) => p.asset === tokenId);
    if (!position) return 0;
    const totalSize = Math.max(Math.round(position.size || 0), 0);
    const lockedInSells = sellOrders.reduce((sum, o) => sum + o.size_remaining, 0);
    return Math.max(totalSize - Math.round(lockedInSells), 0);
  } catch {
    return null;
  }
}

async function cancelTpForBuy(buyId: string): Promise<number> {
  const pending = await prisma.liveTrade.findMany({
    where: {
      parentTradeId: buyId,
      isTakeProfit: true,
      status: 'LIVE',
      orderId: { not: null },
    },
  });
  let n = 0;
  for (const o of pending) {
    if (o.orderId) {
      await cancelOrder(o.orderId);
      await prisma.liveTrade.update({ where: { id: o.id }, data: { status: 'CANCELLED' } });
      n++;
    }
  }
  return n;
}

async function main() {
  const ok = await initClobClient();
  const st = getClobStatus();
  if (!ok || !st.ready) {
    console.error('[flush-sells] CLOB not ready:', st.error || 'unknown');
    process.exit(1);
  }
  const regionOk = await isRegionAllowedForTrading();
  if (!regionOk) {
    const c = await getCurrentCountry();
    console.error(`[flush-sells] Region blocked (country=${c || 'unknown'}). Use VPN and retry.`);
    process.exit(1);
  }

  const tradingUser = getTradingUserAddress();
  if (!tradingUser) {
    console.error('[flush-sells] No trading address (POLY_PRIVATE_KEY / funder).');
    process.exit(1);
  }

  // 1) FILLED copy BUYs with size > 0 — group by tokenId
  const filledBuys = await prisma.liveTrade.findMany({
    where: {
      side: 'BUY',
      status: 'FILLED',
      isTakeProfit: false,
      size: { gt: 0 },
    },
    orderBy: { createdAt: 'asc' },
  });
  const tokenToBuys = new Map<string, typeof filledBuys>();
  for (const b of filledBuys) {
    if (!b.tokenId) continue;
    const list = tokenToBuys.get(b.tokenId) || [];
    list.push(b);
    tokenToBuys.set(b.tokenId, list);
  }

  let placed = 0;
  const processedTokens = new Set<string>();

  for (const [tokenId, buys] of tokenToBuys) {
    let tpCancelled = 0;
    for (const b of buys) tpCancelled += await cancelTpForBuy(b.id);
    if (tpCancelled) console.log(`[flush-sells] Cancelled ${tpCancelled} TP order(s) for token ${tokenId.slice(0, 16)}...`);
  }

  if (tokenToBuys.size) await sleep(2000);

  for (const [tokenId, buys] of tokenToBuys) {
    const free = await getFreeSharesForToken(tokenId);
    if (free === null) {
      console.warn(`[flush-sells] Skip ${tokenId.slice(0, 16)}... (could not read free shares)`);
      continue;
    }
    if (free < 5) {
      console.log(`[flush-sells] Skip FILLED-tracked ${buys[0].marketTitle?.slice(0, 45)} — free=${free} (<5)`);
      continue;
    }
    const ask = await getAskPrice(tokenId);
    if (!ask || ask * free < 1) {
      console.warn(`[flush-sells] Skip ${buys[0].marketTitle?.slice(0, 45)} — bad ask or below $1 min`);
      continue;
    }
    const title = buys[0].marketTitle || tokenId.slice(0, 20);
    console.log(`[flush-sells] SELL ${free}sh @ ask ${ask.toFixed(4)} — ${title.slice(0, 55)}`);
    const res = await placeSellOrder(tokenId, ask, free);
    if (!res.success) {
      console.error(`[flush-sells] FAILED: ${title.slice(0, 45)} — ${res.error}`);
      continue;
    }
    placed++;
    const first = buys[0];
    await prisma.liveTrade.create({
      data: {
        userId: first.userId,
        sourceWalletAddress: first.sourceWalletAddress,
        conditionId: first.conditionId,
        tokenId,
        marketTitle: first.marketTitle,
        outcome: first.outcome,
        side: 'SELL',
        price: ask,
        size: free,
        usdcAmount: ask * free,
        orderId: res.orderID || null,
        status: res.status === 'matched' ? 'FILLED' : 'LIVE',
        isTakeProfit: false,
      },
    });
    for (const b of buys) {
      await prisma.liveTrade.update({
        where: { id: b.id },
        data: { status: 'CLOSED', size: 0, usdcAmount: 0 },
      });
    }
    // Mark related FAILED SELL rows as closed so retry does not duplicate
    await prisma.liveTrade.updateMany({
      where: { tokenId, side: 'SELL', status: 'FAILED' },
      data: { status: 'CLOSED', errorMessage: 'superseded by flush script' },
    });
    processedTokens.add(tokenId);
    console.log(`[flush-sells] OK orderId=${res.orderID || 'n/a'} status=${res.status}`);
  }

  // 2) Orphan shares: on-chain position but no FILLED/LIVE BUY row for that token
  let posResp: any;
  try {
    posResp = await axios.get('https://data-api.polymarket.com/positions', {
      params: { user: tradingUser, sizeThreshold: 0 },
      timeout: 15_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; polysolve-flush/1.0)' },
    });
  } catch (e: any) {
    console.error('[flush-sells] positions API failed:', e.message);
    process.exit(placed > 0 ? 0 : 1);
  }

  const positions = (posResp.data || []) as any[];
  for (const p of positions) {
    const tokenId = p.asset as string;
    const sz = Math.round(p.size || 0);
    if (!tokenId || sz < 5) continue;
    if (processedTokens.has(tokenId)) continue;

    const openBuy = await prisma.liveTrade.findFirst({
      where: {
        tokenId,
        side: 'BUY',
        status: { in: ['FILLED', 'LIVE'] },
        isTakeProfit: false,
      },
    });
    if (openBuy) continue;

    const pendingSell = await prisma.liveTrade.findFirst({
      where: { tokenId, side: 'SELL', status: { in: ['LIVE', 'PENDING'] } },
    });
    if (pendingSell) continue;

    const free = await getFreeSharesForToken(tokenId);
    if (free === null || free < 5) continue;

    const ask = await getAskPrice(tokenId);
    if (!ask || ask * free < 1) continue;

    const title = (p.title as string) || tokenId.slice(0, 20);
    console.log(`[flush-sells] ORPHAN SELL ${free}sh @ ask ${ask.toFixed(4)} — ${title.slice(0, 55)}`);
    const res = await placeSellOrder(tokenId, ask, free);
    if (!res.success) {
      console.error(`[flush-sells] ORPHAN FAILED: ${title.slice(0, 45)} — ${res.error}`);
      continue;
    }
    placed++;
    const closedBuy = await prisma.liveTrade.findFirst({
      where: { tokenId, side: 'BUY', status: 'CLOSED' },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.liveTrade.create({
      data: {
        userId: closedBuy?.userId ?? null,
        sourceWalletAddress: closedBuy?.sourceWalletAddress || '',
        conditionId: closedBuy?.conditionId || '',
        tokenId,
        marketTitle: title,
        outcome: closedBuy?.outcome || String(p.outcome || ''),
        side: 'SELL',
        price: ask,
        size: free,
        usdcAmount: ask * free,
        orderId: res.orderID || null,
        status: res.status === 'matched' ? 'FILLED' : 'LIVE',
        isTakeProfit: false,
      },
    });
    await prisma.liveTrade.updateMany({
      where: { tokenId, side: 'SELL', status: 'FAILED' },
      data: { status: 'CLOSED', errorMessage: 'superseded by flush script (orphan)' },
    });
    console.log(`[flush-sells] ORPHAN OK orderId=${res.orderID || 'n/a'}`);
    processedTokens.add(tokenId);
  }

  console.log(`[flush-sells] Done. Placed/filled ${placed} sell(s).`);
  await prisma.$disconnect();
}

main().catch(async e => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

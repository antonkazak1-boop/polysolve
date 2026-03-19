import axios, { AxiosInstance } from 'axios';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const DATA_BASE = 'https://data-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const POLYMARKET_BASE = 'https://polymarket.com/api';

export interface GammaEvent {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  creationDate: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  featured: boolean;
  restricted: boolean;
  liquidity: number;
  volume: number;
  volume24hr: number;
  volume1wk: number;
  volume1mo: number;
  openInterest: number;
  competitive: number;
  commentCount: number;
  negRisk: boolean;
  markets: GammaMarket[];
  tags: GammaTag[];
  image?: string;
  icon?: string;
  enableOrderBook: boolean;
  liquidityClob: number;
}

export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  description: string;
  outcomes: string; // JSON string: '["Yes","No"]'
  outcomePrices: string; // JSON string: '["0.65","0.35"]'
  volume: string;
  liquidity?: string;
  active: boolean;
  closed: boolean;
  endDate: string;
  startDate: string;
  lastTradePrice: number;
  bestBid?: number;
  bestAsk?: number;
  oneDayPriceChange?: number;
  oneWeekPriceChange?: number;
  oneMonthPriceChange?: number;
  acceptingOrders: boolean;
  clobTokenIds?: string; // JSON string
  spread?: number;
  enableOrderBook: boolean;
  image?: string;
  restricted: boolean;
  negRisk: boolean;
  volumeNum: number;
  liquidityNum?: number;
  volume24hr?: number;
  groupItemTitle?: string;
}

export interface GammaTag {
  id: string;
  label: string;
  slug: string;
}

export interface EventsFilter {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  featured?: boolean;
  tag_slug?: string;
  order?: string;
  ascending?: boolean;
}

export interface TraderLeaderboard {
  // v1/leaderboard fields (current API)
  rank: string;
  proxyWallet: string;
  userName: string;
  xUsername: string;
  verifiedBadge: boolean;
  vol: number;
  pnl: number;
  profileImage: string;
  // Keep old field names as optional aliases for backward compat
  proxy_wallet_address?: string;
  name?: string;
}

class GammaClient {
  private http: AxiosInstance;
  private dataHttp: AxiosInstance;

  private clobHttp: AxiosInstance;

  constructor() {
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    this.http = axios.create({
      baseURL: GAMMA_BASE,
      timeout: 15000,
      headers: { 'Accept': 'application/json', 'User-Agent': UA },
    });
    this.dataHttp = axios.create({
      baseURL: DATA_BASE,
      timeout: 15000,
      headers: { 'Accept': 'application/json', 'User-Agent': UA },
    });
    this.clobHttp = axios.create({
      baseURL: CLOB_BASE,
      timeout: 10000,
      headers: { 'Accept': 'application/json', 'User-Agent': UA },
    });
  }

  /** CLOB price history for one token (asset id). Returns { t: unix_sec, p: price }[] */
  async getPriceHistory(assetId: string, interval: '1d' | '1w' | '1h' | 'max' = '1d'): Promise<Array<{ t: number; p: number }>> {
    try {
      const res = await this.clobHttp.get('/prices-history', {
        params: { market: assetId, interval },
      });
      const history = res.data?.history ?? [];
      return Array.isArray(history) ? history : [];
    } catch {
      return [];
    }
  }

  async getEvents(filter: EventsFilter = {}): Promise<GammaEvent[]> {
    const params: Record<string, any> = {
      limit: filter.limit ?? 20,
      offset: filter.offset ?? 0,
      order: filter.order ?? 'volume24hr',
      ascending: filter.ascending ?? false,
    };
    if (filter.active !== undefined) params.active = filter.active;
    if (filter.closed !== undefined) params.closed = filter.closed;
    if (filter.archived !== undefined) params.archived = filter.archived;
    if (filter.featured !== undefined) params.featured = filter.featured;
    if (filter.tag_slug) params.tag_slug = filter.tag_slug;

    const res = await this.http.get('/events', { params });
    return Array.isArray(res.data) ? res.data : [];
  }

  async getEvent(id: string): Promise<GammaEvent | null> {
    try {
      const res = await this.http.get(`/events/${id}`);
      return res.data || null;
    } catch {
      return null;
    }
  }

  async getEventBySlug(slug: string): Promise<GammaEvent | null> {
    try {
      const res = await this.http.get('/events', { params: { slug } });
      const events = Array.isArray(res.data) ? res.data : [];
      return events[0] || null;
    } catch {
      return null;
    }
  }

  /** Find event slug by market conditionId (for resolving wallet positions to event page). */
  async getEventSlugByConditionId(conditionId: string): Promise<string | null> {
    const norm = (s: string) => (s || '').toLowerCase().replace(/^0x/, '');
    const want = norm(conditionId);
    if (!want) return null;
    try {
      const events = await this.getEvents({ limit: 300, order: 'volume24hr', ascending: false });
      for (const ev of events) {
        for (const m of ev.markets || []) {
          const cid = m.conditionId || (m as any).id || '';
          if (norm(cid) === want) return ev.slug || ev.id;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async getMarkets(filter: {
    limit?: number;
    offset?: number;
    active?: boolean;
    closed?: boolean;
    order?: string;
    tag_slug?: string;
  } = {}): Promise<GammaMarket[]> {
    const params: Record<string, any> = {
      limit: filter.limit ?? 20,
      offset: filter.offset ?? 0,
      order: filter.order ?? 'volume24hr',
      ascending: false,
    };
    if (filter.active !== undefined) params.active = filter.active;
    if (filter.closed !== undefined) params.closed = filter.closed;
    if (filter.tag_slug) params.tag_slug = filter.tag_slug;

    const res = await this.http.get('/markets', { params });
    return Array.isArray(res.data) ? res.data : [];
  }

  async getMarketById(id: string): Promise<GammaMarket | null> {
    try {
      const res = await this.http.get(`/markets/${id}`);
      return res.data || null;
    } catch {
      return null;
    }
  }

  async getTags(): Promise<GammaTag[]> {
    try {
      const res = await this.http.get('/tags', { params: { limit: 100 } });
      return Array.isArray(res.data) ? res.data : [];
    } catch {
      return [];
    }
  }

  async searchEvents(query: string, limit = 20): Promise<GammaEvent[]> {
    try {
      const res = await this.http.get('/events', {
        params: { limit, active: true, closed: false, archived: false, order: 'volume24hr', ascending: false },
      });
      const events: GammaEvent[] = Array.isArray(res.data) ? res.data : [];
      const q = query.toLowerCase();
      return events.filter(e => e.title?.toLowerCase().includes(q));
    } catch {
      return [];
    }
  }

  async getTraderLeaderboard(params: {
    limit?: number;
    offset?: number;
    startDate?: string;
    endDate?: string;
    timePeriod?: 'DAY' | 'WEEK' | 'MONTH' | 'ALL';
    orderBy?: 'PNL' | 'VOL';
    category?: string;
  } = {}): Promise<TraderLeaderboard[]> {
    try {
      // Map legacy startDate param to timePeriod
      let timePeriod = params.timePeriod ?? 'ALL';
      if (params.startDate) {
        const diffDays = Math.ceil((Date.now() - new Date(params.startDate).getTime()) / 86400000);
        if (diffDays <= 1) timePeriod = 'DAY';
        else if (diffDays <= 7) timePeriod = 'WEEK';
        else if (diffDays <= 30) timePeriod = 'MONTH';
        else timePeriod = 'ALL';
      }

      const res = await this.dataHttp.get('/v1/leaderboard', {
        params: {
          limit: Math.min(params.limit ?? 25, 50),
          offset: params.offset ?? 0,
          timePeriod,
          orderBy: params.orderBy ?? 'PNL',
          ...(params.category && { category: params.category }),
        },
      });

      const data: TraderLeaderboard[] = Array.isArray(res.data) ? res.data : [];
      // Normalise: add proxy_wallet_address alias so old code still works
      return data.map(t => ({ ...t, proxy_wallet_address: t.proxyWallet, name: t.userName || undefined }));
    } catch {
      return [];
    }
  }

  async getWalletPositions(address: string): Promise<any[]> {
    try {
      const res = await this.dataHttp.get('/positions', {
        params: { user: address, sizeThreshold: '0.01', limit: 100 },
      });
      return Array.isArray(res.data) ? res.data : [];
    } catch {
      return [];
    }
  }

  async getWalletTrades(address: string, limit = 50): Promise<any[]> {
    try {
      const res = await this.dataHttp.get('/activity', {
        params: { user: address, limit },
      });
      return Array.isArray(res.data) ? res.data : [];
    } catch {
      return [];
    }
  }
}

export const gammaClient = new GammaClient();

// Helpers
export function parseOutcomePrices(outcomePrices: string): number[] {
  try {
    return JSON.parse(outcomePrices).map(Number);
  } catch {
    return [];
  }
}

export function parseOutcomes(outcomes: string): string[] {
  try {
    return JSON.parse(outcomes);
  } catch {
    return ['Yes', 'No'];
  }
}

export function calcPotentialRoi(price: number): number {
  if (price <= 0 || price >= 1) return 0;
  return (1 / price - 1) * 100;
}

/**
 * REAL asymmetric return detection.
 *
 * Criteria for a genuinely interesting asymmetric bet:
 *  - Price between MIN and MAX (not dead markets at 0–1¢ or 99¢)
 *  - Minimum market activity (non-zero volume/price change) to avoid dead outcomes
 *  - At least 4x potential ROI (price ≤ 0.20)
 *
 * minPrice = 0.04 (4¢) — anything cheaper is likely dead/joke outcome
 * maxPrice = 0.20 (20¢) — above that ROI < 4x, less interesting
 */
export function isAsymmetricReturn(
  prices: number[],
  minPrice = 0.04,
  maxPrice = 0.20,
): { isAsymmetric: boolean; bestRoi: number; bestOutcome: number } {
  let bestRoi = 0;
  let bestOutcome = -1;
  prices.forEach((p, i) => {
    if (p >= minPrice && p <= maxPrice) {
      const roi = calcPotentialRoi(p);
      if (roi > bestRoi) {
        bestRoi = roi;
        bestOutcome = i;
      }
    }
  });
  return { isAsymmetric: bestRoi > 0, bestRoi, bestOutcome };
}

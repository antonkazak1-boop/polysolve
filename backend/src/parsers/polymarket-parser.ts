import axios from 'axios';
import { Market, MarketPrice } from '../types';

/**
 * Основной парсер данных Polymarket
 * Использует GraphQL API или веб-скрапинг для получения данных
 */
export class PolymarketParser {
  private graphqlUrl: string;
  private apiUrl: string;

  constructor() {
    this.graphqlUrl = process.env.POLYMARKET_GRAPHQL_URL || 'https://api.thegraph.com/subgraphs/name/polymarket';
    this.apiUrl = process.env.POLYMARKET_API_URL || 'https://clob.polymarket.com';
  }

  /**
   * Получает список активных рынков
   */
  async fetchMarkets(limit: number = 100): Promise<Market[]> {
    try {
      // Используем публичный CLOB API
      const response = await axios.get(`${this.apiUrl}/markets`, {
        params: {
          limit: Math.min(limit * 3, 1000), // Берем больше, т.к. многие могут быть закрыты
        },
      });

      // API возвращает данные в поле 'data', а не 'results'
      const markets = response.data?.data || response.data?.results || [];
      
      if (markets.length === 0) {
        console.log('No markets returned from API');
        return [];
      }
      
      // Фильтруем только активные и открытые рынки
      const activeMarkets = markets.filter((m: any) => 
        m.active === true && 
        m.closed === false &&
        m.archived === false && 
        m.condition_id && 
        m.question &&
        m.tokens &&
        m.tokens.length > 0
      );
      
      // Фильтруем по датам - только актуальные события (будущие или закрытые недавно)
      const now = new Date();
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      
      const filterByDate = (m: any) => {
        // Если нет даты, разрешаем (могут быть вечные рынки)
        if (!m.end_date_iso) return true;
        try {
          const endDate = new Date(m.end_date_iso);
          // Показываем только будущие события или события, закрытые не более 3 месяцев назад
          return endDate >= threeMonthsAgo;
        } catch {
          return false; // Если ошибка парсинга даты, исключаем
        }
      };
      
      // Если активных нет, берем просто не архивированные с валидными данными и актуальными датами
      const marketsToProcess = activeMarkets.length > 0 
        ? activeMarkets.filter(filterByDate)
        : markets.filter((m: any) => 
            m.archived === false && 
            m.condition_id && 
            m.question &&
            m.tokens &&
            m.tokens.length > 0 &&
            m.tokens.some((t: any) => t.price !== undefined && t.price > 0) &&
            filterByDate(m)
          ).slice(0, limit * 3);
      
      return marketsToProcess.slice(0, limit).map((market: any) => {
        // Находим токены (могут быть Yes/No или названия команд)
        const tokens = market.tokens || [];
        const yesToken = tokens.find((t: any) => 
          t.outcome === 'Yes' || t.outcome === 'YES' || 
          (typeof t.outcome === 'string' && t.outcome.toLowerCase().includes('yes'))
        );
        const noToken = tokens.find((t: any) => 
          t.outcome === 'No' || t.outcome === 'NO' ||
          (typeof t.outcome === 'string' && t.outcome.toLowerCase().includes('no'))
        );
        
        // Если нет Yes/No, берем первые два токена
        const firstToken = tokens[0];
        const secondToken = tokens[1];
        
        // Получаем реальные данные о ликвидности и объеме из API
        const liquidity = parseFloat(market.liquidity || market.total_liquidity || market.liquidity_usd || '0') || 0;
        const volume = parseFloat(market.volume || market.volume_24h || market.volume_usd || '0') || 0;
        
        // Получаем цены из токенов
        const price1 = parseFloat(yesToken?.price || firstToken?.price || '0') || 0;
        const price2 = parseFloat(noToken?.price || secondToken?.price || '0') || 0;
        const totalPrice = price1 + price2;
        
        // Если нет ликвидности в API, используем расчет из цен (но это неточно)
        const calculatedLiquidity = liquidity > 0 ? liquidity : (totalPrice > 0 ? totalPrice * 10000 : 0);
        const calculatedVolume = volume > 0 ? volume : (calculatedLiquidity * 0.1);
          
          return {
            id: market.condition_id || `market-${Date.now()}-${Math.random()}`,
            conditionId: market.condition_id || '',
            question: market.question || '',
            description: market.description || market.market_slug || '',
            category: (market.tags && market.tags.length > 0 && market.tags[0] !== 'All') ? market.tags[0] : 'uncategorized',
            endDate: market.end_date_iso ? new Date(market.end_date_iso) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            resolutionSource: market.description || '',
            liquidity: calculatedLiquidity,
            volume: calculatedVolume,
            status: (market.active && !market.closed) ? 'OPEN' as Market['status'] : 'CLOSED' as Market['status'],
            createdAt: new Date(),
            updatedAt: new Date(),
          };
      });
    } catch (error) {
      console.error('Error fetching markets:', error);
      return [];
    }
  }

  /**
   * Получает текущие цены для рынка
   */
  async fetchMarketPrices(conditionId: string): Promise<MarketPrice[]> {
    try {
      // Получаем рынок по condition_id
      const response = await axios.get(`${this.apiUrl}/markets`, {
        params: {
          condition_id: conditionId,
        },
      });
      
      // API возвращает данные в поле 'data', а не 'results'
      const markets = response.data?.data || response.data?.results || [];
      const market = markets.find((m: any) => m.condition_id === conditionId);
      
      if (!market || !market.tokens) {
        return [];
      }
      
      const result: MarketPrice[] = [];
      
      const yesToken = market.tokens.find((t: any) => 
        t.outcome === 'Yes' || t.outcome === 'YES' ||
        (typeof t.outcome === 'string' && t.outcome.toLowerCase().includes('yes'))
      );
      const noToken = market.tokens.find((t: any) => 
        t.outcome === 'No' || t.outcome === 'NO' ||
        (typeof t.outcome === 'string' && t.outcome.toLowerCase().includes('no'))
      );
      
      if (yesToken && yesToken.price !== undefined) {
        result.push({
          id: `${conditionId}-yes-${Date.now()}`,
          marketId: conditionId,
          outcome: 'YES',
          price: parseFloat(yesToken.price),
          timestamp: new Date(),
          liquidity: (parseFloat(yesToken.price) + (noToken ? parseFloat(noToken.price || 0) : 0)) * 10000,
          volume24h: 0,
        });
      }
      
      if (noToken && noToken.price !== undefined) {
        result.push({
          id: `${conditionId}-no-${Date.now()}`,
          marketId: conditionId,
          outcome: 'NO',
          price: parseFloat(noToken.price),
          timestamp: new Date(),
          liquidity: ((yesToken ? parseFloat(yesToken.price || 0) : 0) + parseFloat(noToken.price)) * 10000,
          volume24h: 0,
        });
      }
      
      return result;
    } catch (error) {
      console.error(`Error fetching prices for ${conditionId}:`, error);
      return [];
    }
  }

  /**
   * Получает историю ставок для кошелька
   */
  async fetchWalletBets(walletAddress: string, limit: number = 100): Promise<any[]> {
    try {
      const query = `
        query GetWalletBets($wallet: String!, $limit: Int!) {
          positions(
            first: $limit,
            where: { user: $wallet }
            orderBy: timestamp
            orderDirection: desc
          ) {
            id
            user
            conditionId
            outcomeIndex
            outcome
            amount
            price
            timestamp
          }
        }
      `;

      const response = await axios.post(this.graphqlUrl, {
        query,
        variables: { wallet: walletAddress.toLowerCase(), limit },
      });

      if (response.data.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(response.data.errors)}`);
      }

      return response.data.data?.positions || [];
    } catch (error) {
      console.error(`Error fetching bets for wallet ${walletAddress}:`, error);
      return [];
    }
  }

  /**
   * Получает информацию о рынке по ID
   */
  async fetchMarketById(conditionId: string): Promise<Market | null> {
    try {
      const response = await axios.get(`${this.apiUrl}/markets`, {
        params: {
          condition_id: conditionId,
        },
      });

      // API возвращает данные в поле 'data', а не 'results'
      const markets = response.data?.data || response.data?.results || [];
      const market = markets.find((m: any) => m.condition_id === conditionId);
      
      if (!market) {
        return null;
      }

      const tokens = market.tokens || [];
      const firstToken = tokens[0];
      const secondToken = tokens[1];
      const price1 = parseFloat(firstToken?.price || 0);
      const price2 = parseFloat(secondToken?.price || 0);
      const liquidity = (price1 + price2) * 10000;
      
      return {
        id: market.condition_id,
        conditionId: market.condition_id,
        question: market.question,
        description: market.description || market.market_slug,
        category: (market.tags && market.tags.length > 0 && market.tags[0] !== 'All') ? market.tags[0] : 'uncategorized',
        endDate: market.end_date_iso ? new Date(market.end_date_iso) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        resolutionSource: market.description || '',
        liquidity: liquidity,
        volume: 0,
        status: (market.active && !market.closed) ? 'OPEN' as Market['status'] : 'RESOLVED' as Market['status'],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    } catch (error) {
      console.error(`Error fetching market ${conditionId}:`, error);
      return null;
    }
  }
}

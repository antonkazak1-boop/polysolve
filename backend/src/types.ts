// Shared types between backend and frontend

export interface Market {
  id: string;
  question: string;
  description?: string;
  category: string;
  conditionId: string;
  endDate: Date;
  resolutionSource?: string;
  liquidity: number;
  volume: number;
  status: MarketStatus;
  createdAt: Date;
  updatedAt: Date;
}

export enum MarketStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  RESOLVED = 'RESOLVED',
  DISPUTED = 'DISPUTED'
}

export interface MarketPrice {
  id: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  price: number; // 0-1
  timestamp: Date;
  liquidity: number;
  volume24h?: number;
}

export interface Wallet {
  id: string;
  address: string;
  totalBets: number;
  totalVolume: number;
  totalPnl: number;
  averageRoi: number; // Главная метрика!
  winRate: number;
  lastActiveAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface Bet {
  id: string;
  walletId: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  amount: number;
  price: number; // Цена входа
  potentialRoi: number; // (1 / price) - 1
  status: BetStatus;
  pnl?: number;
  roi?: number; // Фактический ROI после закрытия
  timestamp: Date;
  createdAt: Date;
  updatedAt: Date;
}

export enum BetStatus {
  ACTIVE = 'ACTIVE',
  WON = 'WON',
  LOST = 'LOST',
  CANCELLED = 'CANCELLED'
}

export interface PortfolioPosition {
  id: string;
  userId?: string; // Для мультипользовательской системы
  marketId: string;
  betId?: string;
  outcome: 'YES' | 'NO';
  amount: number;
  entryPrice: number;
  currentPrice?: number;
  potentialPnl?: number;
  potentialRoi?: number;
  status: BetStatus;
  entryTime: Date;
  marketEndDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PortfolioSnapshot {
  id: string;
  userId?: string;
  totalBalance: number;
  totalInvested: number;
  totalPnl: number;
  totalRoi: number;
  activePositions: number;
  wonPositions: number;
  lostPositions: number;
  timestamp: Date;
}

export interface Alert {
  id: string;
  type: AlertType;
  strategy: string;
  marketId?: string;
  walletId?: string;
  message: string;
  confidence: number; // 0-100
  data: Record<string, any>;
  read: boolean;
  createdAt: Date;
}

export enum AlertType {
  ARBITRAGE = 'ARBITRAGE',
  ASYMMETRIC_RETURNS = 'ASYMMETRIC_RETURNS',
  NEW_BET = 'NEW_BET',
  CLOSING_EVENT = 'CLOSING_EVENT',
  PATTERN_DETECTED = 'PATTERN_DETECTED'
}

export interface StrategySignal {
  id: string;
  strategy: string;
  marketId: string;
  signal: 'BUY_YES' | 'BUY_NO' | 'SELL';
  confidence: number;
  potentialRoi?: number;
  reasoning: string;
  data: Record<string, any>;
  createdAt: Date;
}

/**
 * Core type definitions for the trading bot
 */

export interface TradeSignal {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  confidence: number;
  scores: {
    whale: number;
    smartMoney: number;
    accumulation: number;
    pumpProbability: number;
  };
  derivedMetrics: {
    pressure: number;
    riskLevel: 'low' | 'medium' | 'high';
    momentum: number;
    volumeSpike: boolean;
    deepValue: boolean;
  };
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  timestamp: number;
  reasoning: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  leverage: number;
  openTime: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp1Hit: boolean;
  trailingStopPrice?: number;
  status: 'OPEN' | 'PARTIAL' | 'CLOSED';
  pnl?: number;
  pnlPercent?: number;
  /** Bybit order ID for initial SL (conditional); cancelled when TP1 hits so we can set SL to entry. */
  slOrderId?: string;
  /** Bybit order ID for TP1 limit (50%); used to detect TP1 fill if needed. */
  tp1OrderId?: string;
  /** True after we have cancelled SL order and set position SL to entry on exchange. */
  slMovedToEntry?: boolean;
}

export interface Trade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  leverage: number;
  openTime: number;
  closeTime?: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  exitReason?: 'TP1' | 'TP2' | 'SL' | 'TRAILING_STOP' | 'MANUAL';
  pnl?: number;
  pnlPercent?: number;
  riskRewardRatio: number;
  status: 'OPEN' | 'CLOSED';
}

export interface CoinMarketData {
  symbol: string;
  price: number;
  priceChange24h: number;
  priceChangePercent24h: number;
  volume24h: number;
  marketCap: number;
  marketCapRank: number;
  highPrice24h: number;
  lowPrice24h: number;
  circulatingSupply: number;
  totalSupply: number;
}

export interface BinanceTickerData {
  symbol: string;
  lastPrice: string;
  bidPrice: string;
  askPrice: string;
  volume: string;
  quoteAssetVolume: string;
  openTime: number;
  closeTime: number;
  firstTradeId: number;
  lastTradeId: number;
  count: number;
}

export interface BookTicker {
  symbol: string;
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
}

export interface FundingRate {
  symbol: string;
  fundingRate: number;
  fundingTime: number;
}

export interface SafetyCheckResult {
  passed: boolean;
  rule: string;
  message: string;
  timestamp: number;
}

export interface BotConfig {
  riskPerTrade: number;
  leverage: number;
  entryMode: 'aggressive' | 'conservative';
  minConfidence: number;
  maxOpenTrades: number;
  closeAtTp1: boolean;
  /** When true: at TP1 take 50% profit, move SL to entry, let remainder run to TP2 */
  takeHalfAtTp1MoveSlToEntry?: boolean;
  trailingStop: boolean;
  quoteCurrency: string;
  dailyLossLimit: number;
  slDistancePct: number;
  tp1Percent: number;
  tp2Percent: number;
  refreshCycle: number;
  useTestnet: boolean;
  dryRun: boolean;
  paperTrading: boolean;
}

export interface DailyStats {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  totalPnlPercent: number;
  maxDailyDrawdown: number;
  startBalance: number;
  endBalance: number;
}

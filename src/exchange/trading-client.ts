/**
 * Trading client abstraction
 * Balance/readiness: uses EXCHANGE env (Bybit or Binance).
 * Execution (orders, leverage, close): Bybit only.
 */

import logger from '../utils/logger';
import binanceClient from './binance-client';
import BybitClient from './bybit-client';

const EXCHANGE = (process.env.EXCHANGE || 'binance').toLowerCase();

let _bybitClient: BybitClient | null | undefined;

function getBybitClient(): BybitClient | null {
  if (_bybitClient !== undefined) return _bybitClient;
  const apiKey = process.env.BYBIT_API_KEY || '';
  const apiSecret = process.env.BYBIT_API_SECRET || '';
  if (!apiKey || !apiSecret) {
    _bybitClient = null;
    return null;
  }
  const testnet = process.env.BYBIT_TESTNET === 'true';
  _bybitClient = new BybitClient(apiKey, apiSecret, testnet);
  return _bybitClient;
}

function getTradingClient(): { getBalance: () => Promise<number>; validateCredentials: () => Promise<boolean> } {
  if (EXCHANGE === 'bybit') {
    const bybit = getBybitClient();
    if (!bybit) {
      logger.warn('Bybit API credentials not configured — trading disabled');
      return { getBalance: async () => 0, validateCredentials: async () => false };
    }
    return {
      getBalance: () => bybit.getBalance('USDT'),
      validateCredentials: () => bybit.validateCredentials(),
    };
  }
  return {
    getBalance: () => binanceClient.getBalance(),
    validateCredentials: () => binanceClient.validateCredentials(),
  };
}

const tradingClient = getTradingClient();

/** Bybit uses different names for some pairs (e.g. 1000PEPE instead of PEPE). */
const BYBIT_SYMBOL_MAP: Record<string, string> = {
  PEPE: '1000PEPE',
  SHIB: '1000SHIB',
  BONK: '1000BONK',
  FLOKI: '1000FLOKI',
  LUNC: '1000LUNC',
};

export function toBybitSymbol(symbol: string): string {
  const base = symbol.replace(/USDT$/i, '');
  const bybitBase = BYBIT_SYMBOL_MAP[base] ?? base;
  return bybitBase.includes('USDT') ? bybitBase : `${bybitBase}USDT`;
}

export function getExchange(): string { return EXCHANGE; }
export function isBybit(): boolean { return EXCHANGE === 'bybit'; }
export function isBinance(): boolean { return EXCHANGE === 'binance'; }

export async function getTradingBalance(): Promise<number> {
  return tradingClient.getBalance();
}

export async function validateTradingCredentials(): Promise<boolean> {
  return tradingClient.validateCredentials();
}

export async function placeMarketOrder(
  symbol: string,
  side: 'LONG' | 'SHORT',
  quantity: number,
  leverage: number
): Promise<{ success: boolean; quantity?: number }> {
  const bybit = getBybitClient();
  if (!bybit) {
    logger.error('Cannot place order: Bybit credentials not configured');
    return { success: false };
  }
  const result = await bybit.placeMarketOrder(
    toBybitSymbol(symbol),
    side === 'LONG' ? 'Buy' : 'Sell',
    quantity,
    leverage
  );
  if (!result) return { success: false };
  return { success: true, quantity: result.quantity };
}

/** positionIdx for Bybit: 0 = one-way, 1 = long (hedge), 2 = short (hedge). */
export function getBybitPositionIdx(direction: 'LONG' | 'SHORT'): number {
  if ((process.env.BYBIT_POSITION_MODE || '').toLowerCase() === 'one-way') return 0;
  return direction === 'LONG' ? 1 : 2;
}

/** Split position quantity into 50% TP1 and 50% TP2 respecting lot size. */
export async function getTp1Tp2Quantities(
  symbol: string,
  quantity: number
): Promise<{ tp1Qty: number; tp2Qty: number }> {
  const bybit = getBybitClient();
  const sym = toBybitSymbol(symbol);
  if (!bybit) {
    return { tp1Qty: quantity, tp2Qty: 0 };
  }
  const filter = await bybit.getLotSizeFilter(sym);
  if (!filter || filter.qtyStep <= 0) {
    return { tp1Qty: quantity, tp2Qty: 0 };
  }
  const step = filter.qtyStep;
  const minQty = filter.minOrderQty;
  // Decimal precision of step (e.g. step=0.1 → 1, step=0.01 → 2, step=1 → 0)
  const decimals = step >= 1 ? 0 : Math.round(-Math.log10(step));
  const round = (v: number) => Math.round(v * Math.pow(10, decimals)) / Math.pow(10, decimals);

  if (quantity < minQty) {
    return { tp1Qty: 0, tp2Qty: quantity };
  }
  const tp1Qty = round(Math.floor(quantity / step) * step);
  const tp2Qty = 0;
  if (tp1Qty < minQty || tp2Qty < minQty) {
    return { tp1Qty: 0, tp2Qty: quantity };
  }
  return { tp1Qty, tp2Qty };
}

export async function setStopLossLimit(
  symbol: string,
  side: 'LONG' | 'SHORT',
  quantity: number,
  triggerPrice: number,
  limitPrice: number,
  positionIdx: number
): Promise<string | null> {
  const bybit = getBybitClient();
  if (!bybit) return null;
  const posSide = side === 'LONG' ? 'Buy' : 'Sell';
  return bybit.setStopLossLimit(
    toBybitSymbol(symbol),
    posSide,
    quantity,
    triggerPrice,
    limitPrice,
    positionIdx
  );
}

export async function placeReduceOnlyLimitOrder(
  symbol: string,
  closeSide: 'Buy' | 'Sell',
  quantity: number,
  price: number,
  positionIdx: number
): Promise<string | null> {
  const bybit = getBybitClient();
  if (!bybit) return null;
  return bybit.placeReduceOnlyLimitOrder(
    toBybitSymbol(symbol),
    closeSide,
    quantity,
    price,
    positionIdx
  );
}

/** Place reduce-only trigger MARKET order (e.g. TP2: when price hits triggerPrice, close at market). */
export async function placeReduceOnlyTriggerMarketOrder(
  symbol: string,
  closeSide: 'Buy' | 'Sell',
  quantity: number,
  triggerPrice: number,
  positionIdx: number
): Promise<string | null> {
  const bybit = getBybitClient();
  if (!bybit) return null;
  return bybit.placeReduceOnlyTriggerMarketOrder(
    toBybitSymbol(symbol),
    closeSide,
    quantity,
    triggerPrice,
    positionIdx
  );
}

export async function getOrderStatus(symbol: string, orderId: string): Promise<string | null> {
  const bybit = getBybitClient();
  if (!bybit) return null;
  return bybit.getOrderStatus(toBybitSymbol(symbol), orderId);
}

export async function cancelOrder(symbol: string, orderId: string): Promise<boolean> {
  const bybit = getBybitClient();
  if (!bybit) return false;
  return bybit.cancelOrder(toBybitSymbol(symbol), orderId);
}

export async function getSymbolOpenOrders(symbol: string): Promise<Array<{
  orderId: string; side: string; orderType: string; qty: string;
  price: string; triggerPrice: string; orderStatus: string; reduceOnly: boolean;
}>> {
  const bybit = getBybitClient();
  if (!bybit) return [];
  return bybit.getOpenOrders(toBybitSymbol(symbol));
}

export async function setPositionStopLoss(symbol: string, stopLossPrice: number, positionIdx: number): Promise<boolean> {
  const bybit = getBybitClient();
  if (!bybit) return false;
  return bybit.setPositionStopLoss(toBybitSymbol(symbol), stopLossPrice, positionIdx);
}

export async function placeLimitOrder(
  symbol: string,
  side: 'LONG' | 'SHORT',
  quantity: number,
  price: number,
  leverage: number
): Promise<boolean> {
  const bybit = getBybitClient();
  if (!bybit) {
    logger.error('Cannot place order: Bybit credentials not configured');
    return false;
  }
  const result = await bybit.placeLimitOrder(
    toBybitSymbol(symbol),
    side === 'LONG' ? 'Buy' : 'Sell',
    quantity,
    price,
    leverage
  );
  return result != null;
}

export async function setLeverage(symbol: string, leverage: number): Promise<boolean> {
  const bybit = getBybitClient();
  if (!bybit) return false;
  try {
    await bybit.setLeverage(toBybitSymbol(symbol), leverage);
    return true;
  } catch {
    return false;
  }
}

export interface ExchangePosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  unrealizedPnl?: number;
  markPrice?: number;
}

export async function getExchangeOpenPositions(): Promise<ExchangePosition[]> {
  const bybit = getBybitClient();
  if (!bybit) return [];
  const raw = await bybit.getOpenPositions();
  return raw.map(p => ({
    symbol:      p.symbol.replace(/USDT$/, '').replace(/^1000/, ''),
    side:        p.side === 'Buy' ? 'LONG' : 'SHORT',
    quantity:    p.size,
    entryPrice:  p.entryPrice,
    leverage:    parseFloat(p.leverage) || 1,
    stopLoss:    p.stopLoss,
    takeProfit:  p.takeProfit,
    unrealizedPnl: p.unrealizedPnl,
    markPrice: p.markPrice,
  }));
}

export async function getLastClosedPosition(symbol: string): Promise<{ avgExitPrice: number; exitReason: string; closedPnl: number } | null> {
  const bybit = getBybitClient();
  if (!bybit) return null;
  return bybit.getLastClosedPosition(toBybitSymbol(symbol));
}

export async function getTotalFeesSince(since?: number): Promise<number> {
  const bybit = getBybitClient();
  if (!bybit) return 0;
  return bybit.getTotalFeesSince(since);
}

export async function getConfirmedWithdrawals(since?: number): Promise<Array<{ withdrawId: string; amount: number; createTime: number; coin: string }>> {
  const bybit = getBybitClient();
  if (!bybit) return [];
  return bybit.getWithdrawalHistory(since);
}

export async function closePositionBySymbol(symbol: string): Promise<boolean> {
  const bybit = getBybitClient();
  if (!bybit) {
    logger.error('Cannot close position: Bybit credentials not configured');
    return false;
  }
  return bybit.closePosition(toBybitSymbol(symbol));
}

export default tradingClient;

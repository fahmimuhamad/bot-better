/**
 * Bybit Unified Trading API Client
 * Handles all Bybit exchange operations for futures trading
 */

import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import logger from '../utils/logger';

interface BybitPosition {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: number;
  positionValue: number;
  entryPrice: number;
  leverage: string;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  markPrice: number;
  stopLoss: number;
  takeProfit: number;
}

interface BybitOrder {
  orderId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  quantity: number;
  price: number;
  timeInForce: string;
  orderStatus: string;
  executedQty: number;
  createdTime: number;
}

export class BybitClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private client: AxiosInstance;
  private testnet: boolean;
  private readonly hedgeMode: boolean;

  constructor(apiKey: string, apiSecret: string, testnet: boolean = true) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.testnet = testnet;
    this.hedgeMode = process.env.BYBIT_POSITION_MODE !== 'one-way';
    this.baseUrl = testnet
      ? 'https://api-testnet.bybit.com'
      : 'https://api.bybit.com';

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
    });

    logger.info(`Bybit Client initialized (${testnet ? 'TESTNET' : 'LIVE'})`);
  }

  /** Bybit v5: recv_window (ms) for request validity */
  private readonly recvWindow = '20000';

  /**
   * Build string to sign per Bybit v5: timestamp + api_key + recv_window + queryString (GET) or jsonBody (POST)
   */
  private getSignature(
    timestamp: string,
    method: 'GET' | 'POST',
    path: string,
    queryString: string,
    body?: any
  ): string {
    const payload =
      method === 'GET'
        ? timestamp + this.apiKey + this.recvWindow + queryString
        : timestamp + this.apiKey + this.recvWindow + (body ? JSON.stringify(body) : '');
    return crypto.createHmac('sha256', this.apiSecret).update(payload).digest('hex');
  }

  /**
   * Make authenticated request (Bybit v5 signing).
   * GET: path may include ?a=1&b=2; params are parsed for signing (sorted) and sent as query.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: any,
    explicitParams?: Record<string, string>
  ): Promise<any> {
    let pathOnly = path;
    let params: Record<string, string> = explicitParams ?? {};
    const qIdx = path.indexOf('?');
    if (method === 'GET' && qIdx >= 0) {
      pathOnly = path.slice(0, qIdx);
      const qs = path.slice(qIdx + 1);
      for (const pair of qs.split('&')) {
        const [k, v] = pair.split('=');
        if (k && v !== undefined) params[k] = decodeURIComponent(v);
      }
    }
    const sortedKeys = Object.keys(params).sort();
    const queryString = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
    // Build sorted params object so axios serializes in the same order we signed
    const sortedParams: Record<string, string> = {};
    for (const k of sortedKeys) sortedParams[k] = params[k];

    const timestamp = Date.now().toString();
    const signature = this.getSignature(timestamp, method, pathOnly, queryString, method === 'POST' ? body : undefined);

    const headers: Record<string, string> = {
      'X-BAPI-SIGN': signature,
      'X-BAPI-API-KEY': this.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': this.recvWindow,
      'Content-Type': 'application/json',
    };

    try {
      const response = await this.client({
        method,
        url: pathOnly,
        params: method === 'GET' && queryString ? sortedParams : undefined,
        data: method === 'POST' ? body : undefined,
        headers,
      });

      if (response.data.retCode !== 0) {
        throw new Error(`Bybit API Error: ${response.data.retMsg}`);
      }

      return response.data.result;
    } catch (error: any) {
      const msg = error?.message || String(error);
      if (msg.includes('leverage not modified')) {
        logger.debug(`Bybit: ${msg}`);
      } else {
        logger.error(`Bybit request failed: ${msg}`);
      }
      throw error;
    }
  }

  /**
   * Get account wallet balance
   */
  async getBalance(coin: string = 'USDT'): Promise<number> {
    try {
      const result = await this.request(
        'GET',
        '/v5/account/wallet-balance?accountType=UNIFIED'
      );
      const walletList = result.list || [];

      for (const wallet of walletList) {
        const coinBalance = wallet.coin.find((c: any) => c.coin === coin);
        if (coinBalance) {
          // totalEquity = walletBalance + all unrealized PnL (the true account value)
          const equity = parseFloat(wallet.totalEquity || coinBalance.equity || coinBalance.walletBalance);
          return isNaN(equity) ? parseFloat(coinBalance.walletBalance) : equity;
        }
      }

      return 0;
    } catch (error) {
      logger.error('Failed to get balance');
      throw error;
    }
  }

  /**
   * Validate API credentials (e.g. for readiness check)
   */
  async validateCredentials(): Promise<boolean> {
    try {
      await this.request(
        'GET',
        '/v5/account/wallet-balance?accountType=UNIFIED'
      );
      return true;
    } catch (error: any) {
      logger.error(`API credentials invalid: ${error?.message || error}`, 'validateCredentials');
      return false;
    }
  }

  /**
   * Get open positions
   */
  async getOpenPositions(symbol?: string): Promise<BybitPosition[]> {
    try {
      const qs = symbol
        ? `?category=linear&symbol=${symbol}`
        : '?category=linear&settleCoin=USDT';
      const result = await this.request('GET', `/v5/position/list${qs}`);
      
      return (result.list || [])
        .filter((p: any) => parseFloat(p.size) > 0)
        .map((p: any) => ({
          symbol: p.symbol,
          side: p.side,
          size: parseFloat(p.size),
          positionValue: parseFloat(p.positionValue),
          entryPrice: parseFloat(p.avgPrice),
          leverage: p.leverage,
          unrealizedPnl: parseFloat(p.unrealisedPnl ?? p.unrealizedPnl),
          unrealizedPnlPercent: parseFloat(p.unrealisedPnlPercent ?? p.unrealizedPnlPercent),
          markPrice: parseFloat(p.markPrice) || 0,
          stopLoss: parseFloat(p.stopLoss) || 0,
          takeProfit: parseFloat(p.takeProfit) || 0,
        }));
    } catch (error) {
      logger.error('Failed to get positions');
      return [];
    }
  }

  /**
   * Place market order. Rounds quantity to symbol lot size and enforces min notional.
   */
  async placeMarketOrder(
    symbol: string,
    side: 'Buy' | 'Sell',
    quantity: number,
    leverage: number = 15
  ): Promise<BybitOrder | null> {
    try {
      // Set leverage first (ignore "leverage not modified")
      await this.setLeverage(symbol, leverage);

      // Get current price for notional check when rounding
      const ticker = await this.request('GET', `/v5/market/tickers?category=linear&symbol=${symbol}`);
      const lastPrice = ticker?.list?.[0]?.lastPrice ? parseFloat(ticker.list[0].lastPrice) : 0;
      const filter = await this.getLotSizeFilter(symbol);
      const priceForSize = lastPrice > 0 ? lastPrice : 0;
      const qty = priceForSize > 0 && filter
        ? this.roundQuantityToLotSize(quantity, filter, priceForSize)
        : Math.floor(quantity * 100000) / 100000;

      // positionIdx: 0 = one-way, 1 = hedge long, 2 = hedge short. Set BYBIT_POSITION_MODE=one-way in .env if needed.
      const hedgeMode = this.hedgeMode;
      const positionIdx = hedgeMode ? (side === 'Buy' ? 1 : 2) : 0;
      const body = {
        category: 'linear',
        symbol,
        side,
        orderType: 'Market',
        qty: qty.toString(),
        timeInForce: 'IOC',
        positionIdx,
      };

      const result = await this.request('POST', '/v5/order/create', body);

      logger.info(`Market order placed: ${symbol} ${side} ${qty}`);

      return {
        orderId: result.orderId,
        symbol,
        side,
        orderType: 'Market',
        quantity: qty,
        price: 0,
        timeInForce: 'IOC',
        orderStatus: result.orderStatus,
        executedQty: qty,
        createdTime: Date.now(),
      };
    } catch (error: any) {
      logger.error(`Failed to place market order: ${error.message}`);
      return null;
    }
  }

  /**
   * Place limit order
   */
  async placeLimitOrder(
    symbol: string,
    side: 'Buy' | 'Sell',
    quantity: number,
    price: number,
    leverage: number = 15
  ): Promise<BybitOrder | null> {
    try {
      await this.setLeverage(symbol, leverage);

      const hedgeMode = this.hedgeMode;
      const positionIdx = hedgeMode ? (side === 'Buy' ? 1 : 2) : 0;
      const body = {
        category: 'linear',
        symbol,
        side,
        orderType: 'Limit',
        qty: quantity.toString(),
        price: price.toString(),
        timeInForce: 'GTC',
        positionIdx,
      };

      const result = await this.request('POST', '/v5/order/create', body);

      logger.info(`Limit order placed: ${symbol} ${side} ${quantity} @ ${price}`);

      return {
        orderId: result.orderId,
        symbol,
        side,
        orderType: 'Limit',
        quantity,
        price,
        timeInForce: 'GTC',
        orderStatus: result.orderStatus,
        executedQty: 0,
        createdTime: Date.now(),
      };
    } catch (error: any) {
      logger.error(`Failed to place limit order: ${error.message}`);
      return null;
    }
  }

  /**
   * Close position (reduce-only market order in opposite direction).
   * positionIdx is derived from the existing position side (not the close-order side)
   * so hedge-mode orders target the correct position slot.
   */
  async closePosition(symbol: string): Promise<boolean> {
    try {
      const positions = await this.getOpenPositions(symbol);
      if (positions.length === 0) {
        logger.warn(`No open position for ${symbol}`);
        return false;
      }

      const position = positions[0];
      const closeSide = position.side === 'Buy' ? 'Sell' : 'Buy';
      const hedgeMode = this.hedgeMode;
      // positionIdx must reference the existing position, not the close-order direction
      const positionIdx = hedgeMode ? (position.side === 'Buy' ? 1 : 2) : 0;

      const body = {
        category: 'linear',
        symbol,
        side: closeSide,
        orderType: 'Market',
        qty: position.size.toString(),
        timeInForce: 'IOC',
        reduceOnly: true,
        positionIdx,
      };

      const result = await this.request('POST', '/v5/order/create', body);

      if (result) {
        logger.info(`Position closed: ${symbol} ${position.side} ${position.size}`);
        return true;
      }

      return false;
    } catch (error: any) {
      logger.error(`Failed to close position: ${error.message}`);
      return false;
    }
  }

  /**
   * Set stop loss as a limit order (conditional: when trigger hits, place limit at slLimitPrice).
   * Returns the conditional order ID so it can be cancelled when TP1 fills (then set SL to entry).
   */
  async setStopLossLimit(
    symbol: string,
    side: 'Buy' | 'Sell',
    quantity: number,
    triggerPrice: number,
    limitPrice: number,
    positionIdx: number
  ): Promise<string | null> {
    try {
      const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
      const triggerDirection = side === 'Buy' ? 2 : 1; // Long: SL below, trigger when falls. Short: SL above, trigger when rises.
      const body = {
        category: 'linear',
        symbol,
        side: closeSide,
        orderType: 'Limit',
        qty: quantity.toString(),
        price: limitPrice.toString(),
        timeInForce: 'GTC',
        reduceOnly: true,
        positionIdx,
        triggerPrice: triggerPrice.toString(),
        triggerBy: 'MarkPrice',
        triggerDirection,
      };
      const result = await this.request('POST', '/v5/order/create', body);
      const orderId = result?.orderId ?? null;
      logger.info(`SL limit set: ${symbol} trigger=${triggerPrice} limit=${limitPrice} qty=${quantity} orderId=${orderId}`);
      return orderId;
    } catch (error: any) {
      logger.error(`Failed to set SL limit: ${error.message}`);
      return null;
    }
  }

  /**
   * Place a reduce-only limit order (e.g. TP1 50% at limit price). Returns order ID.
   */
  async placeReduceOnlyLimitOrder(
    symbol: string,
    side: 'Buy' | 'Sell',
    quantity: number,
    price: number,
    positionIdx: number
  ): Promise<string | null> {
    try {
      const filter = await this.getLotSizeFilter(symbol);
      const qty = filter ? this.roundQuantityToLotSize(quantity, filter, price) : quantity;
      const body = {
        category: 'linear',
        symbol,
        side,
        orderType: 'Limit',
        qty: qty.toString(),
        price: price.toString(),
        timeInForce: 'GTC',
        reduceOnly: true,
        positionIdx,
      };
      const result = await this.request('POST', '/v5/order/create', body);
      const orderId = result?.orderId ?? null;
      logger.info(`Reduce-only limit: ${symbol} ${side} qty=${qty} @ ${price} orderId=${orderId}`);
      return orderId;
    } catch (error: any) {
      logger.error(`Failed to place reduce-only limit: ${error.message}`);
      return null;
    }
  }

  /**
   * Place a reduce-only trigger MARKET order: when price reaches triggerPrice, close quantity at market (e.g. TP2 for remaining 50%).
   * triggerDirection: 1 = trigger when price rises (TP2 for long), 2 = when price falls (TP2 for short).
   */
  async placeReduceOnlyTriggerMarketOrder(
    symbol: string,
    side: 'Buy' | 'Sell',
    quantity: number,
    triggerPrice: number,
    positionIdx: number
  ): Promise<string | null> {
    try {
      const filter = await this.getLotSizeFilter(symbol);
      const qty = filter ? this.roundQuantityToLotSize(quantity, filter, triggerPrice) : quantity;
      const triggerDirection = side === 'Sell' ? 1 : 2; // Close long (Sell): trigger when price rises. Close short (Buy): trigger when falls.
      const body = {
        category: 'linear',
        symbol,
        side,
        orderType: 'Market',
        qty: qty.toString(),
        timeInForce: 'GTC',
        reduceOnly: true,
        positionIdx,
        triggerPrice: triggerPrice.toString(),
        triggerBy: 'MarkPrice',
        triggerDirection,
      };
      const result = await this.request('POST', '/v5/order/create', body);
      const orderId = result?.orderId ?? null;
      logger.info(`Reduce-only trigger market: ${symbol} ${side} qty=${quantity} trigger=${triggerPrice} orderId=${orderId}`);
      return orderId;
    } catch (error: any) {
      logger.error(`Failed to place reduce-only trigger market: ${error.message}`);
      return null;
    }
  }

  /**
   * Get order status by orderId (e.g. to detect if TP1 limit order is Filled).
   * Checks active orders first; if not found (already filled/cancelled), falls back to order history.
   */
  async getOrderStatus(symbol: string, orderId: string): Promise<string | null> {
    try {
      const result = await this.request('GET', `/v5/order/realtime?category=linear&symbol=${symbol}&orderId=${orderId}`);
      const list = result?.list;
      if (list && list.length > 0) return list[0].orderStatus ?? null;
    } catch {
      // fall through to history check
    }
    // Order not in active list — check history (covers Filled / Cancelled)
    try {
      const hist = await this.request('GET', `/v5/order/history?category=linear&symbol=${symbol}&orderId=${orderId}&limit=1`);
      const list = hist?.list;
      if (list && list.length > 0) return list[0].orderStatus ?? null;
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Cancel an order (works for conditional/trigger orders too).
   */
  async cancelOrder(symbol: string, orderId: string): Promise<boolean> {
    try {
      await this.request('POST', '/v5/order/cancel', {
        category: 'linear',
        symbol,
        orderId,
      });
      logger.info(`Order cancelled: ${symbol} orderId=${orderId}`);
      return true;
    } catch (error: any) {
      logger.error(`Failed to cancel order: ${error.message}`);
      return false;
    }
  }

  /**
   * Set position stop loss (e.g. breakeven at entry after TP1 fills). Uses position-level trading-stop (market SL).
   */
  async setPositionStopLoss(
    symbol: string,
    stopLossPrice: number,
    positionIdx: number
  ): Promise<boolean> {
    try {
      await this.request('POST', '/v5/position/trading-stop', {
        category: 'linear',
        symbol,
        positionIdx,
        stopLoss: stopLossPrice.toString(),
        slTriggerBy: 'MarkPrice',
      });
      logger.info(`Position SL set: ${symbol} stopLoss=${stopLossPrice}`);
      return true;
    } catch (error: any) {
      logger.error(`Failed to set position SL: ${error.message}`);
      return false;
    }
  }

  /**
   * Set leverage for symbol. Treats "leverage not modified" (already set) as success.
   */
  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    try {
      const body = {
        category: 'linear',
        symbol,
        buyLeverage: leverage.toString(),
        sellLeverage: leverage.toString(),
      };

      await this.request('POST', '/v5/position/set-leverage', body);

      logger.debug(`Leverage set: ${symbol} ${leverage}x`);
      return true;
    } catch (error: any) {
      const msg = error?.message || String(error);
      if (msg.includes('leverage not modified') || msg.includes('Leverage not modified')) {
        logger.debug(`Leverage already ${leverage}x for ${symbol}`);
        return true;
      }
      logger.warn(`Failed to set leverage: ${msg}`);
      return false;
    }
  }

  /**
   * List all active orders for a symbol (open orders).
   * Returns orderId, side, orderType, qty, price, triggerPrice, orderStatus for each active order.
   */
  async getOpenOrders(symbol: string): Promise<Array<{
    orderId: string;
    side: string;
    orderType: string;
    qty: string;
    price: string;
    triggerPrice: string;
    orderStatus: string;
    reduceOnly: boolean;
  }>> {
    try {
      const result = await this.request('GET', `/v5/order/realtime?category=linear&symbol=${symbol}&limit=50`);
      return (result?.list || []).map((o: any) => ({
        orderId: o.orderId,
        side: o.side,
        orderType: o.orderType,
        qty: o.qty,
        price: o.price,
        triggerPrice: o.triggerPrice ?? o.stopOrderPrice ?? '0',
        orderStatus: o.orderStatus,
        reduceOnly: o.reduceOnly === true || o.reduceOnly === 'true',
      }));
    } catch (error: any) {
      logger.error(`Failed to get open orders: ${error.message}`);
      return [];
    }
  }

  /**
   * Get lot size filter for a symbol (public endpoint). Used to round quantity and enforce min notional.
   */
  async getLotSizeFilter(symbol: string): Promise<{ minOrderQty: number; qtyStep: number; minNotionalValue: number; maxMktOrderQty: number } | null> {
    try {
      const result = await this.request('GET', `/v5/market/instruments-info?category=linear&symbol=${symbol}`);
      const list = result?.list;
      if (!list || list.length === 0) return null;
      const filter = list[0].lotSizeFilter;
      if (!filter) return null;
      return {
        minOrderQty: parseFloat(filter.minOrderQty ?? '0'),
        qtyStep: parseFloat(filter.qtyStep ?? '0.001'),
        minNotionalValue: parseFloat(filter.minNotionalValue ?? '5'),
        maxMktOrderQty: parseFloat(filter.maxMktOrderQty ?? '999999'),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the most recent closed position PnL record for a symbol.
   * Used to get actual exit price when a position closes between cycles.
   */
  async getLastClosedPosition(symbol: string): Promise<{ avgExitPrice: number; exitReason: string; closedPnl: number } | null> {
    try {
      const result = await this.request('GET', `/v5/position/closed-pnl?category=linear&symbol=${symbol}&limit=1`);
      const row = result?.list?.[0];
      if (!row) return null;
      return {
        avgExitPrice: parseFloat(row.avgExitPrice) || 0,
        exitReason: String(row.orderType ?? ''),
        closedPnl: parseFloat(row.closedPnl) || 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get confirmed USDT withdrawal history (on-chain + internal).
   * Returns records with withdrawId, amount, createTime for deduplication.
   */
  async getWithdrawalHistory(since?: number): Promise<Array<{ withdrawId: string; amount: number; createTime: number; coin: string }>> {
    try {
      const params: Record<string, string> = { coin: 'USDT', withdrawType: '2', limit: '50' };
      if (since) params.startTime = since.toString();
      const result = await this.request('GET', '/v5/asset/withdraw/query-record', undefined, params);
      return (result?.rows || [])
        .filter((r: any) => (r.status || '').toLowerCase() === 'success')
        .map((r: any) => ({
          withdrawId: String(r.withdrawId),
          amount: parseFloat(r.amount) || 0,
          createTime: parseInt(r.createTime) || 0,
          coin: r.coin ?? 'USDT',
        }));
    } catch {
      return [];
    }
  }

  /**
   * Sum all trading fees + funding fees since a given timestamp.
   * Uses /v5/execution/list which includes both Trade and Funding execTypes.
   */
  async getTotalFeesSince(since?: number): Promise<number> {
    try {
      const params: Record<string, string> = { category: 'linear', limit: '100' };
      if (since) params.startTime = since.toString();
      const result = await this.request('GET', '/v5/execution/list', undefined, params);
      const list = result?.list || [];
      return list.reduce((sum: number, e: any) => sum + Math.abs(parseFloat(e.execFee) || 0), 0);
    } catch {
      return 0;
    }
  }

  /** Round quantity to step and clamp to min/max for Bybit. */
  roundQuantityToLotSize(
    quantity: number,
    filter: { minOrderQty: number; qtyStep: number; minNotionalValue: number; maxMktOrderQty: number } | null,
    price: number
  ): number {
    if (!filter || filter.qtyStep <= 0) {
      return Math.floor(quantity * 100000) / 100000;
    }
    const steps = Math.floor(quantity / filter.qtyStep);
    let qty = steps * filter.qtyStep;
    if (qty < filter.minOrderQty) qty = filter.minOrderQty;
    const notional = qty * price;
    if (notional < filter.minNotionalValue) {
      const minQty = filter.minNotionalValue / price;
      const minSteps = Math.ceil(minQty / filter.qtyStep);
      qty = minSteps * filter.qtyStep;
      if (qty < filter.minOrderQty) qty = filter.minOrderQty;
    }
    if (qty > filter.maxMktOrderQty) qty = filter.maxMktOrderQty;
    const decimals = filter.qtyStep >= 1 ? 0 : Math.max(0, 8 - Math.floor(Math.log10(filter.qtyStep)));
    return Math.floor(qty * Math.pow(10, decimals)) / Math.pow(10, decimals);
  }

}

export default BybitClient;

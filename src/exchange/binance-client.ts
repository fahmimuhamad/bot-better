/**
 * Binance Futures Client Wrapper
 * Handles order execution, position management, and account info
 */

import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import logger from '../utils/logger';

// USD-M Futures: testnet = demo-fapi.binance.com (official docs)
const BINANCE_FUTURES_BASE = process.env.BINANCE_USE_TESTNET === 'true'
  ? 'https://demo-fapi.binance.com'
  : 'https://fapi.binance.com';

export interface OrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity: number;
  price?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  timeInForce?: string;
}

export class BinanceClient {
  private client: AxiosInstance;
  private apiKey: string;
  private apiSecret: string;

  constructor() {
    this.apiKey = process.env.BINANCE_API_KEY || '';
    this.apiSecret = process.env.BINANCE_API_SECRET || '';

    const exchange = (process.env.EXCHANGE || 'binance').toLowerCase();
    if ((!this.apiKey || !this.apiSecret) && exchange === 'binance') {
      logger.warn('Binance API credentials not configured - trading will be disabled');
    }

    this.client = axios.create({
      baseURL: BINANCE_FUTURES_BASE,
      timeout: 10000,
    });
  }

  /**
   * Generate request signature for authenticated requests
   */
  private generateSignature(query: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(query)
      .digest('hex');
  }

  /**
   * Make authenticated request to Binance
   */
  private async authenticatedRequest(
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    params: any = {}
  ): Promise<any> {
    const timestamp = Date.now();
    const query = new URLSearchParams({
      ...params,
      timestamp: String(timestamp),
    }).toString();

    const signature = this.generateSignature(query);

    try {
      const response = await this.client({
        method,
        url: `/fapi/v1${endpoint}`,
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
        params: {
          ...params,
          timestamp,
          signature,
        },
      });

      return response.data;
    } catch (error: any) {
      logger.error(
        `Binance API error: ${error.response?.data?.msg || error.message}`,
        'authenticatedRequest'
      );
      throw error;
    }
  }

  /**
   * Get account information
   */
  async getAccountInfo(): Promise<any> {
    try {
      const data = await this.authenticatedRequest('GET', '/account');
      logger.debug('Account info retrieved', {
        totalWalletBalance: data.totalWalletBalance,
        totalUnrealizedProfit: data.totalUnrealizedProfit,
      });
      return data;
    } catch (error) {
      logger.error(`Failed to get account info: ${error}`, 'getAccountInfo');
      throw error;
    }
  }

  /**
   * Get account balance
   */
  async getBalance(): Promise<number> {
    try {
      const account = await this.getAccountInfo();
      return parseFloat(account.totalWalletBalance);
    } catch (error) {
      logger.error(`Failed to get balance: ${error}`, 'getBalance');
      throw error;
    }
  }

  /**
   * Place a market order
   */
  async placeMarketOrder(params: OrderParams): Promise<any> {
    try {
      const orderParams = {
        symbol: `${params.symbol}USDT`,
        side: params.side,
        type: 'MARKET',
        quantity: params.quantity,
      };

      logger.info('Placing market order', orderParams);
      const response = await this.authenticatedRequest('POST', '/order', orderParams);
      logger.info('Market order placed', { orderId: response.orderId, ...orderParams });
      return response;
    } catch (error) {
      logger.error(`Failed to place market order: ${error}`, 'placeMarketOrder');
      throw error;
    }
  }

  /**
   * Place a limit order
   */
  async placeLimitOrder(params: OrderParams): Promise<any> {
    try {
      const orderParams = {
        symbol: `${params.symbol}USDT`,
        side: params.side,
        type: 'LIMIT',
        timeInForce: params.timeInForce || 'GTC',
        quantity: params.quantity,
        price: params.price?.toFixed(8),
      };

      logger.info('Placing limit order', orderParams);
      const response = await this.authenticatedRequest('POST', '/order', orderParams);
      logger.info('Limit order placed', { orderId: response.orderId, ...orderParams });
      return response;
    } catch (error) {
      logger.error(`Failed to place limit order: ${error}`, 'placeLimitOrder');
      throw error;
    }
  }

  /**
   * Place order with stop loss and take profit
   */
  async placeOrderWithStops(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    entryPrice: number,
    stopLoss: number,
    tp1: number,
    tp2?: number
  ): Promise<any> {
    try {
      const mainOrder = await this.placeMarketOrder({
        symbol,
        side,
        type: 'MARKET',
        quantity,
      });

      // Place take profit orders
      const tpSide = side === 'BUY' ? 'SELL' : 'BUY';
      await this.placeLimitOrder({
        symbol,
        side: tpSide,
        type: 'LIMIT',
        quantity,
        price: tp1,
      });

      if (tp2) {
        await this.placeLimitOrder({
          symbol,
          side: tpSide,
          type: 'LIMIT',
          quantity,
          price: tp2,
        });
      }

      // Place stop loss order
      const stopOrder = await this.placeLimitOrder({
        symbol,
        side: tpSide,
        type: 'LIMIT',
        quantity,
        price: stopLoss,
        stopPrice: stopLoss,
      });

      logger.info('Order with stops placed', {
        mainOrder: mainOrder.orderId,
        stopLoss,
        tp1,
        tp2,
      });

      return { mainOrder, stopOrder };
    } catch (error) {
      logger.error(`Failed to place order with stops: ${error}`, 'placeOrderWithStops');
      throw error;
    }
  }

  /**
   * Get all open orders
   */
  async getOpenOrders(symbol?: string): Promise<any[]> {
    try {
      const params: any = {};
      if (symbol) {
        params.symbol = `${symbol}USDT`;
      }

      const orders = await this.authenticatedRequest('GET', '/openOrders', params);
      logger.debug(`Retrieved ${orders.length} open orders`);
      return orders;
    } catch (error) {
      logger.error(`Failed to get open orders: ${error}`, 'getOpenOrders');
      throw error;
    }
  }

  /**
   * Get all open positions
   */
  async getOpenPositions(): Promise<any[]> {
    try {
      const account = await this.getAccountInfo();
      const positions = (account.positions || [])
        .filter((p: any) => parseFloat(p.positionAmt) !== 0);

      logger.debug(`Retrieved ${positions.length} open positions`);
      return positions;
    } catch (error) {
      logger.error(`Failed to get open positions: ${error}`, 'getOpenPositions');
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(symbol: string, orderId: number): Promise<any> {
    try {
      const response = await this.authenticatedRequest('DELETE', '/order', {
        symbol: `${symbol}USDT`,
        orderId,
      });

      logger.info('Order cancelled', { symbol, orderId });
      return response;
    } catch (error) {
      logger.error(`Failed to cancel order: ${error}`, 'cancelOrder');
      throw error;
    }
  }

  /**
   * Cancel all orders for a symbol
   */
  async cancelAllOrders(symbol: string): Promise<any> {
    try {
      const response = await this.authenticatedRequest('DELETE', '/allOpenOrders', {
        symbol: `${symbol}USDT`,
      });

      logger.info('All orders cancelled', { symbol });
      return response;
    } catch (error) {
      logger.error(`Failed to cancel all orders: ${error}`, 'cancelAllOrders');
      throw error;
    }
  }

  /**
   * Set leverage for a symbol
   */
  async setLeverage(symbol: string, leverage: number): Promise<any> {
    try {
      const response = await this.authenticatedRequest('POST', '/leverage', {
        symbol: `${symbol}USDT`,
        leverage,
      });

      logger.info('Leverage set', { symbol, leverage });
      return response;
    } catch (error) {
      logger.error(`Failed to set leverage: ${error}`, 'setLeverage');
      throw error;
    }
  }

  /**
   * Get current leverage for a symbol
   */
  async getLeverage(symbol: string): Promise<number> {
    try {
      const account = await this.getAccountInfo();
      const position = account.positions?.find((p: any) => p.symbol === `${symbol}USDT`);
      return position ? parseInt(position.leverage, 10) : 1;
    } catch (error) {
      logger.error(`Failed to get leverage: ${error}`, 'getLeverage');
      return 1;
    }
  }

  /**
   * Get funding rate for a symbol
   */
  async getFundingRate(symbol: string): Promise<number> {
    try {
      const response = await this.client.get('/fapi/v1/fundingRate', {
        params: { symbol: `${symbol}USDT` },
      });

      if (response.data && response.data.length > 0) {
        return parseFloat(response.data[response.data.length - 1].fundingRate);
      }
      return 0;
    } catch (error) {
      logger.error(`Failed to get funding rate: ${error}`, 'getFundingRate');
      return 0;
    }
  }

  /**
   * Get liquidation price estimate
   */
  async estimateLiquidationPrice(
    symbol: string,
    quantity: number,
    entryPrice: number,
    leverage: number,
    side: 'LONG' | 'SHORT'
  ): Promise<number> {
    try {
      const account = await this.getAccountInfo();
      const balance = parseFloat(account.totalWalletBalance);

      // Liquidation price = entry ± (maintenance margin % × entry × leverage)
      const maintenanceMargin = 0.05; // 5% maintenance margin (varies by leverage)
      const liquidationPrice = side === 'LONG'
        ? entryPrice * (1 - maintenanceMargin * leverage)
        : entryPrice * (1 + maintenanceMargin * leverage);

      logger.debug('Liquidation price estimated', {
        symbol,
        liquidationPrice,
        entryPrice,
        leverage,
      });

      return liquidationPrice;
    } catch (error) {
      logger.error(`Failed to estimate liquidation price: ${error}`, 'estimateLiquidationPrice');
      return 0;
    }
  }

  /**
   * Check if API credentials are valid (dry run on account endpoint)
   */
  async validateCredentials(): Promise<boolean> {
    try {
      await this.getAccountInfo();
      logger.info('API credentials validated');
      return true;
    } catch (error) {
      logger.error(`API credentials invalid: ${error}`, 'validateCredentials');
      return false;
    }
  }
}

export default new BinanceClient();

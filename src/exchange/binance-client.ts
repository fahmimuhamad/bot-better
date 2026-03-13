/**
 * Binance Futures Client
 * Only used for balance + credential checks when EXCHANGE=binance.
 * All market data is fetched by src/data/fetcher.ts (public endpoints, no auth needed).
 */

import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import logger from '../utils/logger';

const BINANCE_FUTURES_BASE = process.env.BINANCE_USE_TESTNET === 'true'
  ? 'https://demo-fapi.binance.com'
  : 'https://fapi.binance.com';

export class BinanceClient {
  private client: AxiosInstance;
  private apiKey: string;
  private apiSecret: string;

  constructor() {
    this.apiKey    = process.env.BINANCE_API_KEY    || '';
    this.apiSecret = process.env.BINANCE_API_SECRET || '';

    const exchange = (process.env.EXCHANGE || 'binance').toLowerCase();
    if ((!this.apiKey || !this.apiSecret) && exchange === 'binance') {
      logger.warn('Binance API credentials not configured - trading will be disabled');
    }

    this.client = axios.create({ baseURL: BINANCE_FUTURES_BASE, timeout: 10000 });
  }

  private generateSignature(query: string): string {
    return crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
  }

  private async authenticatedRequest(method: 'GET' | 'POST' | 'DELETE', endpoint: string, params: any = {}): Promise<any> {
    const timestamp = Date.now();
    const query = new URLSearchParams({ ...params, timestamp: String(timestamp) }).toString();
    const signature = this.generateSignature(query);

    try {
      const response = await this.client({
        method,
        url: `/fapi/v1${endpoint}`,
        headers: { 'X-MBX-APIKEY': this.apiKey },
        params: { ...params, timestamp, signature },
      });
      return response.data;
    } catch (error: any) {
      logger.error(`Binance API error: ${error.response?.data?.msg || error.message}`, 'authenticatedRequest');
      throw error;
    }
  }

  async getAccountInfo(): Promise<any> {
    return this.authenticatedRequest('GET', '/account');
  }

  async getBalance(): Promise<number> {
    const account = await this.getAccountInfo();
    return parseFloat(account.totalWalletBalance);
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.getAccountInfo();
      return true;
    } catch {
      return false;
    }
  }
}

export default new BinanceClient();

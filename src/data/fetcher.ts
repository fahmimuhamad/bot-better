/**
 * Data fetcher — Binance REST API for market data
 */

import axios, { AxiosInstance } from 'axios';
import logger from '../utils/logger';
import { CoinMarketData, BinanceTickerData, FundingRate } from '../types';

const BINANCE_SPOT_BASE = 'https://api.binance.com/api/v3';
const BINANCE_FUTURES_BASE = process.env.BINANCE_USE_TESTNET === 'true'
  ? 'https://demo-fapi.binance.com'
  : 'https://fapi.binance.com';

export class DataFetcher {
  private binanceClient: AxiosInstance;

  constructor() {
    this.binanceClient = axios.create({ baseURL: BINANCE_SPOT_BASE, timeout: 10000 });
    this.setupRateLimitHandling();
  }

  private setupRateLimitHandling(): void {
    this.binanceClient.interceptors.response.use(
      response => response,
      async error => {
        if (error.response?.status === 429) {
          const retryAfter = parseInt(error.response.headers['retry-after'] || '60', 10);
          logger.warn('Binance rate limited', { retryAfter });
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          return this.binanceClient.request(error.config);
        }
        throw error;
      }
    );
  }

  /**
   * Fetch top 100 coins by 24h volume from Binance spot (single batch request).
   */
  async fetchTop250Coins(): Promise<CoinMarketData[]> {
    try {
      logger.info('Fetching top coins from Binance...');

      const response = await this.binanceClient.get('/ticker/24hr');
      const allTickers: any[] = response.data;

      const usdtTickers = allTickers
        .filter((t: any) => t.symbol.endsWith('USDT'))
        .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, 100);

      const coins: CoinMarketData[] = usdtTickers.map((ticker: any) => ({
        symbol: ticker.symbol.replace('USDT', ''),
        price: parseFloat(ticker.lastPrice),
        priceChange24h: parseFloat(ticker.priceChange),
        priceChangePercent24h: parseFloat(ticker.priceChangePercent),
        volume24h: parseFloat(ticker.quoteVolume),
        marketCap: 0,
        marketCapRank: 0,
        highPrice24h: parseFloat(ticker.highPrice),
        lowPrice24h: parseFloat(ticker.lowPrice),
        circulatingSupply: 0,
        totalSupply: 0,
      }));

      logger.info(`Fetched top ${coins.length} coins by volume`);
      return coins;
    } catch (error) {
      logger.error(`Failed to fetch coins: ${error}`, 'fetchTop250Coins');
      throw error;
    }
  }

  /**
   * Fetch 24hr tickers for given symbols (single batch request, then filter).
   */
  async fetch24hrTickers(symbols: string[]): Promise<Map<string, BinanceTickerData>> {
    try {
      const response = await this.binanceClient.get('/ticker/24hr');
      const allTickers: any[] = response.data;

      const symbolSet = new Set(symbols.map(s => `${s}USDT`));
      const tickers = new Map<string, BinanceTickerData>();

      for (const ticker of allTickers) {
        if (symbolSet.has(ticker.symbol)) {
          const base = ticker.symbol.replace('USDT', '');
          tickers.set(base, ticker);
        }
      }

      logger.info(`Fetched ${tickers.size}/${symbols.length} tickers`);
      return tickers;
    } catch (error) {
      logger.error(`Failed to fetch tickers: ${error}`, 'fetch24hrTickers');
      throw error;
    }
  }

  /**
   * Fetch funding rates from Binance Futures.
   */
  async fetchFundingRates(symbols: string[]): Promise<Map<string, FundingRate>> {
    try {
      const futuresClient = axios.create({ baseURL: BINANCE_FUTURES_BASE, timeout: 10000 });
      const fundingRates = new Map<string, FundingRate>();

      for (const symbol of symbols) {
        try {
          const response = await futuresClient.get('/fapi/v1/fundingRate', {
            params: { symbol: `${symbol}USDT`, limit: 1 },
          });
          if (response.data?.length > 0) {
            const latest = response.data[response.data.length - 1];
            fundingRates.set(symbol, {
              symbol: latest.symbol,
              fundingRate: parseFloat(latest.fundingRate),
              fundingTime: latest.fundingTime,
            });
          }
        } catch {
          // skip symbols without futures
        }
      }

      return fundingRates;
    } catch (error) {
      logger.error(`Failed to fetch funding rates: ${error}`, 'fetchFundingRates');
      throw error;
    }
  }

  /**
   * Fetch OHLCV candle data for a symbol (for live signal generation).
   * Returns candles in OHLCV shape: timestamp, open, high, low, close, volume, quoteAssetVolume, numberOfTrades.
   */
  async fetchOhlcvData(
    symbol: string,
    interval: string = '1h',
    limit: number = 250
  ): Promise<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number; quoteAssetVolume: number; numberOfTrades: number }[]> {
    try {
      const response = await this.binanceClient.get('/klines', {
        params: { symbol: `${symbol}USDT`, interval, limit },
      });
      return response.data.map((k: any) => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        quoteAssetVolume: parseFloat(k[7]),
        numberOfTrades: k[8] ?? 0,
      }));
    } catch {
      return [];
    }
  }
}

export default new DataFetcher();

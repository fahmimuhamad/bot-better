/**
 * Backtest Data Loader
 * Fetches historical OHLCV data from Binance and caches locally
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger';

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteAssetVolume: number;
  numberOfTrades: number;
}

export interface LoaderConfig {
  cacheDir?: string;
  maxRetries?: number;
  retryDelay?: number;
}

export class DataLoader {
  private client: AxiosInstance;
  private cacheDir: string;
  private maxRetries: number;
  private retryDelay: number;
  private readonly BINANCE_API_BASE = 'https://api.binance.com/api/v3';
  private readonly CACHE_VERSION = 1;

  constructor(config: LoaderConfig = {}) {
    this.cacheDir = config.cacheDir || './backtest-cache';
    this.maxRetries = config.maxRetries || 3;
    this.retryDelay = config.retryDelay || 1000;

    // Ensure cache directory exists
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    this.client = axios.create({
      baseURL: this.BINANCE_API_BASE,
      timeout: 10000,
    });
  }

  /**
   * Convert Binance interval string to milliseconds
   */
  private intervalToMs(interval: string): number {
    const multipliers: { [key: string]: number } = {
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
    };
    return multipliers[interval] || 60 * 60 * 1000; // Default to 1h
  }

  /**
   * Generate cache file path
   */
  private getCachePath(symbol: string, interval: string, startTime: number, endTime: number): string {
    const filename = `${symbol}_${interval}_${startTime}_${endTime}_v${this.CACHE_VERSION}.json`;
    return path.join(this.cacheDir, filename);
  }

  /**
   * Check if cached data exists and is valid
   */
  private getCachedData(symbol: string, interval: string, startTime: number, endTime: number): OHLCV[] | null {
    const cachePath = this.getCachePath(symbol, interval, startTime, endTime);

    try {
      if (!fs.existsSync(cachePath)) {
        return null;
      }

      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      logger.debug(`Cache hit for ${symbol} ${interval}`, { cachePath });
      return cached;
    } catch (error) {
      logger.warn(`Failed to read cache: ${error}`, { cachePath });
      return null;
    }
  }

  /**
   * Save data to cache
   */
  private saveToCache(symbol: string, interval: string, startTime: number, endTime: number, data: OHLCV[]): void {
    const cachePath = this.getCachePath(symbol, interval, startTime, endTime);

    try {
      fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
      logger.debug(`Cached ${data.length} candles for ${symbol} ${interval}`);
    } catch (error) {
      logger.warn(`Failed to save cache: ${error}`, { cachePath });
    }
  }

  /**
   * Parse Binance kline response
   */
  private parseKlines(data: any[][]): OHLCV[] {
    return data.map(k => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[7]), // Quote asset volume in USDT
      quoteAssetVolume: parseFloat(k[7]),
      numberOfTrades: k[8],
    }));
  }

  /**
   * Fetch klines from Binance with retry logic
   */
  private async fetchKlinesWithRetry(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number,
    retryCount = 0
  ): Promise<OHLCV[]> {
    try {
      const response = await this.client.get('/klines', {
        params: {
          symbol: `${symbol}USDT`,
          interval,
          startTime,
          endTime,
          limit: 1000, // Max 1000 per request
        },
      });

      return this.parseKlines(response.data);
    } catch (error: any) {
      if (retryCount < this.maxRetries) {
        logger.warn(`Retry ${retryCount + 1}/${this.maxRetries} for ${symbol}...`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        return this.fetchKlinesWithRetry(symbol, interval, startTime, endTime, retryCount + 1);
      }

      throw error;
    }
  }

  /**
   * Load klines for an explicit time range (timestamps in ms)
   */
  async loadKlinesByRange(
    symbol: string,
    interval: string = '1h',
    startTime: number,
    endTime: number,
    useCache: boolean = true
  ): Promise<OHLCV[]> {
    logger.info(`Loading ${symbol} ${interval} data from ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}...`);

    if (useCache) {
      const cached = this.getCachedData(symbol, interval, startTime, endTime);
      if (cached && cached.length > 0) {
        logger.info(`Loaded ${cached.length} candles from cache`);
        return cached;
      }
    }

    const intervalMs = this.intervalToMs(interval);
    const allKlines: OHLCV[] = [];
    let currentStart = startTime;

    while (currentStart < endTime) {
      const currentEnd = Math.min(currentStart + 1000 * intervalMs, endTime);
      logger.debug(`Fetching ${symbol} klines: ${new Date(currentStart).toISOString()} to ${new Date(currentEnd).toISOString()}`);

      try {
        const klines = await this.fetchKlinesWithRetry(symbol, interval, currentStart, currentEnd);
        if (klines.length === 0) break;
        allKlines.push(...klines);
        await new Promise(resolve => setTimeout(resolve, 100));
        currentStart = klines[klines.length - 1].timestamp + intervalMs;
      } catch (error) {
        logger.error(`Failed to fetch ${symbol} klines: ${error}`, 'loadKlinesByRange');
        throw error;
      }
    }

    if (allKlines.length === 0) throw new Error(`No data found for ${symbol}`);

    const uniqueKlines = Array.from(
      new Map(allKlines.map(k => [k.timestamp, k])).values()
    ).sort((a, b) => a.timestamp - b.timestamp);

    logger.info(`Loaded ${uniqueKlines.length} candles for ${symbol} ${interval}`);
    if (useCache) this.saveToCache(symbol, interval, startTime, endTime, uniqueKlines);
    return uniqueKlines;
  }

  /**
   * Load historical klines with pagination
   */
  async loadKlines(
    symbol: string,
    interval: string = '1h',
    days: number = 30,
    useCache: boolean = true
  ): Promise<OHLCV[]> {
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;
    const endTime = now;

    logger.info(`Loading ${symbol} ${interval} data (last ${days} days)...`);

    // Check cache first
    if (useCache) {
      const cached = this.getCachedData(symbol, interval, startTime, endTime);
      if (cached && cached.length > 0) {
        logger.info(`Loaded ${cached.length} candles from cache`);
        return cached;
      }
    }

    // Fetch from Binance
    const intervalMs = this.intervalToMs(interval);
    const allKlines: OHLCV[] = [];
    let currentStart = startTime;

    while (currentStart < endTime) {
      const currentEnd = Math.min(currentStart + 1000 * intervalMs, endTime);

      logger.debug(`Fetching ${symbol} klines: ${new Date(currentStart).toISOString()} to ${new Date(currentEnd).toISOString()}`);

      try {
        const klines = await this.fetchKlinesWithRetry(symbol, interval, currentStart, currentEnd);

        if (klines.length === 0) {
          break;
        }

        allKlines.push(...klines);

        // Avoid hitting rate limits
        await new Promise(resolve => setTimeout(resolve, 100));

        currentStart = klines[klines.length - 1].timestamp + intervalMs;
      } catch (error) {
        logger.error(`Failed to fetch ${symbol} klines: ${error}`, 'loadKlines');
        throw error;
      }
    }

    if (allKlines.length === 0) {
      throw new Error(`No data found for ${symbol}`);
    }

    // Remove duplicates and sort
    const uniqueKlines = Array.from(
      new Map(allKlines.map(k => [k.timestamp, k])).values()
    ).sort((a, b) => a.timestamp - b.timestamp);

    logger.info(`Loaded ${uniqueKlines.length} candles for ${symbol} ${interval}`);

    // Cache the data
    if (useCache) {
      this.saveToCache(symbol, interval, startTime, endTime, uniqueKlines);
    }

    return uniqueKlines;
  }

  /**
   * Load multiple symbols in parallel
   */
  async loadMultipleSymbols(
    symbols: string[],
    interval: string = '1h',
    days: number = 30,
    useCache: boolean = true
  ): Promise<Map<string, OHLCV[]>> {
    const results = new Map<string, OHLCV[]>();

    for (const symbol of symbols) {
      try {
        const klines = await this.loadKlines(symbol, interval, days, useCache);
        results.set(symbol, klines);
      } catch (error) {
        logger.error(`Failed to load data for ${symbol}: ${error}`);
      }
    }

    return results;
  }

  /**
   * Clear cache for a symbol
   */
  clearCache(symbol?: string): void {
    if (symbol) {
      const files = fs.readdirSync(this.cacheDir);
      const filesToDelete = files.filter(f => f.startsWith(symbol));
      filesToDelete.forEach(f => {
        fs.unlinkSync(path.join(this.cacheDir, f));
      });
      logger.info(`Cleared cache for ${symbol}`);
    } else {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
      fs.mkdirSync(this.cacheDir, { recursive: true });
      logger.info('Cleared all cache');
    }
  }
}

export default new DataLoader();

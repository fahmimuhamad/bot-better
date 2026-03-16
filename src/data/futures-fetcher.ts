/**
 * Binance Futures Public Data Fetcher
 * Fetches OI history, orderbook depth, and long/short ratios for bull market analysis.
 * All endpoints are public — no API key required.
 */

import axios, { AxiosInstance } from 'axios';
import logger from '../utils/logger';
import { FuturesMarketData } from '../types';

const FAPI_BASE = process.env.BINANCE_USE_TESTNET === 'true'
  ? 'https://demo-fapi.binance.com'
  : 'https://fapi.binance.com';

const FAPI_DATA_BASE = 'https://fapi.binance.com'; // /futures/data/ endpoints are always mainnet

/** Delay between per-symbol calls to stay within rate limits (~275 weight per 25-coin cycle) */
const INTER_CALL_DELAY_MS = 50;

export class FuturesDataFetcher {
  private client: AxiosInstance;
  private dataClient: AxiosInstance;

  constructor() {
    this.client = axios.create({ baseURL: FAPI_BASE, timeout: 8000 });
    this.dataClient = axios.create({ baseURL: FAPI_DATA_BASE, timeout: 8000 });
  }

  /**
   * Fetch all futures market data for a list of coin base symbols (e.g. ['BTC', 'ETH']).
   * Returns a Map keyed by base symbol. Missing data for a symbol returns null entry.
   */
  async fetchFuturesData(symbols: string[]): Promise<Map<string, FuturesMarketData>> {
    const result = new Map<string, FuturesMarketData>();

    await Promise.allSettled(
      symbols.map(async (sym, idx) => {
        // Stagger requests slightly to avoid burst rate limiting
        if (idx > 0) await delay(idx * INTER_CALL_DELAY_MS);

        const bybitSym = `${sym}USDT`;

        try {
          const [oiHistRaw, obRaw, lsRaw, oiCurrentRaw] = await Promise.allSettled([
            this.fetchOIHistory(bybitSym),
            this.fetchOrderbook(bybitSym),
            this.fetchLongShortRatio(bybitSym),
            this.fetchCurrentOI(bybitSym),
          ]);

          const oiHistory = oiHistRaw.status === 'fulfilled' ? oiHistRaw.value : [];
          const orderbook = obRaw.status === 'fulfilled' ? obRaw.value : { totalBidQty: 0, totalAskQty: 0, imbalanceRatio: 1 };
          const longShortRatio = lsRaw.status === 'fulfilled' ? lsRaw.value : 1;
          const openInterest = oiCurrentRaw.status === 'fulfilled' ? oiCurrentRaw.value : 0;

          result.set(sym, { symbol: sym, openInterest, oiHistory, orderbook, longShortRatio });
        } catch (e) {
          // Symbol might not have a perpetual — silently skip
        }
      })
    );

    return result;
  }

  /** Current open interest in contracts */
  private async fetchCurrentOI(symbol: string): Promise<number> {
    const resp = await this.client.get('/fapi/v1/openInterest', { params: { symbol } });
    return parseFloat(resp.data.openInterest) || 0;
  }

  /**
   * OI history at 5m resolution — last 48 points = 4 hours.
   * Shows whether OI is growing (accumulation) or shrinking (distribution).
   */
  private async fetchOIHistory(symbol: string): Promise<{ timestamp: number; sumOpenInterest: number }[]> {
    const resp = await this.dataClient.get('/futures/data/openInterestHist', {
      params: { symbol, period: '5m', limit: 48 },
    });
    return (resp.data as any[]).map(d => ({
      timestamp: d.timestamp,
      sumOpenInterest: parseFloat(d.sumOpenInterest),
    }));
  }

  /**
   * Orderbook depth — top 100 levels. Returns USDT-weighted bid/ask totals.
   * imbalanceRatio > 2 = buy pressure heavily dominates sell pressure.
   */
  private async fetchOrderbook(symbol: string): Promise<FuturesMarketData['orderbook']> {
    const resp = await this.client.get('/fapi/v1/depth', { params: { symbol, limit: 100 } });
    const bids: [string, string][] = resp.data.bids;
    const asks: [string, string][] = resp.data.asks;

    const totalBidQty = bids.reduce((sum, [price, qty]) => sum + parseFloat(price) * parseFloat(qty), 0);
    const totalAskQty = asks.reduce((sum, [price, qty]) => sum + parseFloat(price) * parseFloat(qty), 0);
    const imbalanceRatio = totalAskQty > 0 ? totalBidQty / totalAskQty : 1;

    return { totalBidQty, totalAskQty, imbalanceRatio };
  }

  /**
   * Global long/short account ratio — last 1 data point.
   * > 1 = more traders are long. Combined with OI, useful for sentiment.
   */
  private async fetchLongShortRatio(symbol: string): Promise<number> {
    const resp = await this.dataClient.get('/futures/data/globalLongShortAccountRatio', {
      params: { symbol, period: '5m', limit: 1 },
    });
    const data = resp.data as any[];
    if (!data || data.length === 0) return 1;
    return parseFloat(data[0].longShortRatio) || 1;
  }

  /**
   * Log a summary of what was fetched successfully.
   */
  logFetchSummary(data: Map<string, FuturesMarketData>, requested: number): void {
    logger.debug(`Futures data fetched: ${data.size}/${requested} symbols`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export default new FuturesDataFetcher();

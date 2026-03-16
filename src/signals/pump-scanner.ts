/**
 * Early Pump Coin Scanner
 *
 * Detects coins that are quietly accumulating before a breakout.
 * Scores each coin 0-100 across 5 independent signals.
 * Coins scoring >= 70 are flagged as high-priority for bull entry.
 *
 * Signals:
 *   1. Volatility Compression  (25 pts) — price range < 5% over last 12 × 4h candles (= 48h)
 *   2. Volume Spike After Decline (20 pts) — volume was declining, now spiking > 2× prior avg
 *   3. OI Accumulation         (25 pts) — OI grew > 1% while price moved < 2% (smart money)
 *   4. Orderbook Imbalance     (20 pts) — bid USDT > 2× ask USDT near mid-price
 *   5. L/S Ratio Improving     (10 pts) — long accounts outnumber short accounts (ratio > 1.1)
 */

import { OHLCV } from '../backtest/data-loader';
import { FuturesMarketData, PumpScanResult } from '../types';

// Score weights per signal (must sum to 100)
const WEIGHT_COMPRESSION  = 25;
const WEIGHT_VOLUME_SPIKE  = 20;
const WEIGHT_OI_ACCUM      = 25;
const WEIGHT_OB_IMBALANCE  = 20;
const WEIGHT_LS_RATIO      = 10;

const FLAG_THRESHOLD = 70;  // Score >= this → flagged for trade consideration

export class PumpScanner {

  /**
   * Scan a single coin for accumulation signals.
   * @param candles  4h OHLCV candles (need >= 20)
   * @param futures  Futures data (OI, orderbook, L/S); null = skip those checks
   */
  scan(candles: OHLCV[], futures: FuturesMarketData | null): PumpScanResult {
    const sym = futures?.symbol ?? 'UNKNOWN';

    const compression    = this.checkVolatilityCompression(candles);
    const volumeSpike    = this.checkVolumeSpike(candles);
    const oiAccumulation = futures ? this.checkOIAccumulation(futures, candles) : false;
    const orderImbalance = futures ? this.checkOrderbookImbalance(futures) : false;
    const lsImproving    = futures ? this.checkLongShortRatio(futures) : false;

    const score = Math.round(
      (compression    ? WEIGHT_COMPRESSION  : 0) +
      (volumeSpike    ? WEIGHT_VOLUME_SPIKE  : 0) +
      (oiAccumulation ? WEIGHT_OI_ACCUM      : 0) +
      (orderImbalance ? WEIGHT_OB_IMBALANCE  : 0) +
      (lsImproving    ? WEIGHT_LS_RATIO      : 0)
    );

    // Partial credit: if futures unavailable, rescale out of max-possible
    const maxScore = futures ? 100 : WEIGHT_COMPRESSION + WEIGHT_VOLUME_SPIKE;
    const normalizedScore = futures ? score : Math.round((score / maxScore) * 100);

    return {
      symbol: sym,
      score: normalizedScore,
      flagged: normalizedScore >= FLAG_THRESHOLD,
      signals: {
        volatilityCompression: compression,
        volumeSpike:           volumeSpike,
        oiAccumulation:        oiAccumulation,
        orderbookImbalance:    orderImbalance,
        longShortImproving:    lsImproving,
      },
    };
  }

  /**
   * Signal 1: Price consolidating in a tight range.
   * Uses 12 × 4h candles = 48h window.
   * Threshold: (high - low) / mid_price < 5%.
   */
  private checkVolatilityCompression(candles: OHLCV[]): boolean {
    if (candles.length < 12) return false;
    const window = candles.slice(-12);
    const high = Math.max(...window.map(c => c.high));
    const low  = Math.min(...window.map(c => c.low));
    const mid  = (high + low) / 2;
    if (mid === 0) return false;
    return (high - low) / mid < 0.05;
  }

  /**
   * Signal 2: Volume was declining, now spiking.
   * Prior 10-candle avg declining vs prior-5 avg = distribution done.
   * Last candle volume > 2× prior-5 avg = energy building.
   */
  private checkVolumeSpike(candles: OHLCV[]): boolean {
    if (candles.length < 15) return false;
    const recent = candles.slice(-15);
    const last = recent[recent.length - 1];
    const prior10Avg = recent.slice(0, 10).reduce((s, c) => s + c.volume, 0) / 10;
    const prior5Avg  = recent.slice(-6, -1).reduce((s, c) => s + c.volume, 0) / 5;
    // Volume was declining (prior5 < prior10 * 0.9) then spikes
    const wasDeclining = prior5Avg < prior10Avg * 0.90;
    const isSpiking    = last.volume > prior5Avg * 2.0;
    return wasDeclining && isSpiking;
  }

  /**
   * Signal 3: Open interest growing while price stays flat.
   * OI net change > 1% over last 4h (48 × 5m OI points).
   * Price change < 2% over same window (using candles).
   * Interpretation: new money entering the market without moving price = accumulation.
   */
  private checkOIAccumulation(futures: FuturesMarketData, candles: OHLCV[]): boolean {
    const hist = futures.oiHistory;
    if (hist.length < 2) return false;
    const oiStart = hist[0].sumOpenInterest;
    const oiEnd   = hist[hist.length - 1].sumOpenInterest;
    if (oiStart === 0) return false;
    const oiChangePct = (oiEnd - oiStart) / oiStart;

    // Price change over last 12 4h candles (~48h)
    if (candles.length < 12) return false;
    const priceStart = candles[candles.length - 12].open;
    const priceEnd   = candles[candles.length - 1].close;
    const priceChangePct = Math.abs((priceEnd - priceStart) / priceStart);

    return oiChangePct > 0.01 && priceChangePct < 0.02;
  }

  /**
   * Signal 4: Buy pressure significantly > sell pressure in orderbook.
   * imbalanceRatio = USDT bid total / USDT ask total.
   * Threshold: >= 2.0 (bids have at least 2× the depth of asks).
   */
  private checkOrderbookImbalance(futures: FuturesMarketData): boolean {
    return futures.orderbook.imbalanceRatio >= 2.0;
  }

  /**
   * Signal 5: More accounts are long than short.
   * L/S ratio > 1.1 = 10% more traders holding long positions.
   * High L/S alone is a weak signal; powerful when combined with OI growth.
   */
  private checkLongShortRatio(futures: FuturesMarketData): boolean {
    return futures.longShortRatio > 1.1;
  }
}

export default new PumpScanner();

/**
 * Synthetic Liquidation Heatmap Analyzer
 *
 * Estimates where leveraged positions are likely to get liquidated based on:
 *   - Candle open/close prices (where positions were likely entered)
 *   - Common leverage levels (5x, 10x, 20x, 25x, 50x) with market-share weights
 *   - Recency + volume weighting: recent high-volume candles carry more weight
 *
 * NOTE: Synthetic model, not real exchange liquidation data.
 *   Short liquidation clusters ABOVE price → bullish price magnets
 *   Long liquidation clusters BELOW price → support/risk zones
 */

import { OHLCV } from '../backtest/data-loader';
import { LiquidationMap } from '../types';

const LEVERAGE_DISTRIBUTION: { leverage: number; weight: number }[] = [
  { leverage: 5,   weight: 0.20 },
  { leverage: 10,  weight: 0.30 },
  { leverage: 20,  weight: 0.25 },
  { leverage: 25,  weight: 0.15 },
  { leverage: 50,  weight: 0.10 },
];

// Liquidation occurs when maintenance margin is consumed (~90% of initial margin)
const LIQ_MARGIN_FRACTION = 0.9;

// Cluster price levels into buckets of this width (1% of current price)
const BUCKET_WIDTH_PCT = 0.01;
const LOOKBACK_CANDLES = 100;
const TOP_CLUSTERS     = 5;
const MIN_STRENGTH_PCT = 10; // drop clusters below 10% relative strength

export class LiquidationAnalyzer {

  analyze(symbol: string, candles: OHLCV[], currentPrice: number): LiquidationMap {
    if (candles.length < 10 || currentPrice <= 0) {
      return { symbol, currentPrice, shortLiqClusters: [], longLiqClusters: [], nearestShortLiq: null, nearestLongLiq: null };
    }

    const window     = candles.slice(-LOOKBACK_CANDLES);
    const bucketSize = currentPrice * BUCKET_WIDTH_PCT;
    const totalVol   = window.reduce((s, c) => s + c.volume, 0) || 1;

    // bucket → accumulated strength (float)
    const shortBuckets = new Map<number, number>(); // short liqs = above price
    const longBuckets  = new Map<number, number>(); // long liqs  = below price

    window.forEach((candle, idx) => {
      const recency = (idx + 1) / window.length; // 0→1
      const volWeight = candle.volume / (totalVol / window.length); // relative to avg volume
      const posWeight = recency * volWeight;

      for (const { leverage, weight } of LEVERAGE_DISTRIBUTION) {
        const liqFrac = LIQ_MARGIN_FRACTION / leverage;
        const strength = weight * posWeight;

        // Long liq: trader entered long at candle.open or candle.close, gets liquidated below
        for (const entry of [candle.open, candle.close]) {
          const longLiqPrice  = entry * (1 - liqFrac);
          const shortLiqPrice = entry * (1 + liqFrac);

          if (longLiqPrice < currentPrice) {
            const bucket = Math.round(longLiqPrice / bucketSize);
            longBuckets.set(bucket, (longBuckets.get(bucket) ?? 0) + strength);
          }
          if (shortLiqPrice > currentPrice) {
            const bucket = Math.round(shortLiqPrice / bucketSize);
            shortBuckets.set(bucket, (shortBuckets.get(bucket) ?? 0) + strength);
          }
        }
      }
    });

    const shortLiqClusters = this.topClusters(shortBuckets, bucketSize);
    const longLiqClusters  = this.topClusters(longBuckets,  bucketSize);

    // Nearest cluster = closest to current price
    const nearestShortLiq = shortLiqClusters.length > 0
      ? shortLiqClusters.slice().sort((a, b) => a.price - b.price)[0].price
      : null;
    const nearestLongLiq = longLiqClusters.length > 0
      ? longLiqClusters.slice().sort((a, b) => b.price - a.price)[0].price
      : null;

    return { symbol, currentPrice, shortLiqClusters, longLiqClusters, nearestShortLiq, nearestLongLiq };
  }

  private topClusters(
    buckets: Map<number, number>,
    bucketSize: number
  ): { price: number; strength: number }[] {
    if (buckets.size === 0) return [];
    const maxStr = Math.max(...buckets.values());
    if (maxStr === 0) return [];

    return Array.from(buckets.entries())
      .map(([bucket, str]) => ({
        price:    bucket * bucketSize,
        strength: Math.round((str / maxStr) * 100),
      }))
      .filter(c => c.strength >= MIN_STRENGTH_PCT)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, TOP_CLUSTERS);
  }
}

export default new LiquidationAnalyzer();

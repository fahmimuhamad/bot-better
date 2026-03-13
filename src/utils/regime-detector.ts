/**
 * Market Regime Detector
 *
 * Uses BTC 4H EMA alignment to determine whether the market is in a
 * sustained bull or bear trend, and recommends the matching bot config.
 *
 * Bull: EMA20 > EMA50 > EMA200  → use TIMEFRAME=4h, ADX_MIN=25
 * Bear: EMA20 < EMA50 < EMA200  → use TIMEFRAME=1h, ADX_MIN=32
 * Neutral: mixed alignment       → no recommendation
 */

import axios from 'axios';
import logger from './logger';
import { OHLCV } from '../backtest/data-loader';

export type Regime = 'bull' | 'bear' | 'neutral';

function calcEMA(closes: number[], period: number): number {
  const k = 2 / (period + 1);
  let val = closes[0];
  for (let i = 1; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k);
  }
  return val;
}

export function detectRegimeFromOhlcv(ohlcv: OHLCV[]): Regime {
  if (ohlcv.length < 220) return 'neutral';
  const closes = ohlcv.map(c => c.close);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);

  if (ema20 > ema50 && ema50 > ema200) return 'bull';
  if (ema20 < ema50 && ema50 < ema200) return 'bear';
  return 'neutral';
}

export async function fetchBtc4hOhlcv(limit = 250): Promise<OHLCV[]> {
  const resp = await axios.get('https://api.binance.com/api/v3/klines', {
    params: { symbol: 'BTCUSDT', interval: '4h', limit },
    timeout: 10000,
  });
  return resp.data.map((k: any[]) => ({
    timestamp:        k[0],
    open:             parseFloat(k[1]),
    high:             parseFloat(k[2]),
    low:              parseFloat(k[3]),
    close:            parseFloat(k[4]),
    volume:           parseFloat(k[5]),
    quoteAssetVolume: parseFloat(k[7]),
    numberOfTrades:   k[8],
  }));
}

// What timeframe setting corresponds to each regime
export const REGIME_CONFIG: Record<'bull' | 'bear', { timeframe: string; adxMin: number }> = {
  bull: { timeframe: '4h', adxMin: 25 },
  bear: { timeframe: '1h', adxMin: 32 },
};

export function buildRegimeAlert(detected: 'bull' | 'bear', currentTimeframe: string): string {
  const cfg = REGIME_CONFIG[detected];
  const emoji = detected === 'bull' ? '🟢' : '🔴';
  const label = detected === 'bull' ? 'BULL' : 'BEAR';
  const perf  = detected === 'bull'
    ? '~60% WR, +39% ROI (Oct–Dec 2024 backtest)'
    : '~70% WR, +226% ROI (90-day bear backtest)';

  return [
    `${emoji} *Regime Change Detected*`,
    ``,
    `BTC 4H EMA alignment signals a *${label}* market.`,
    `Your bot is currently set to \`TIMEFRAME=${currentTimeframe}\`.`,
    ``,
    `*Recommended .env changes:*`,
    `\`\`\``,
    `TIMEFRAME=${cfg.timeframe}`,
    `ADX_MIN=${cfg.adxMin}`,
    `\`\`\``,
    ``,
    `Expected performance: ${perf}`,
    ``,
    `Restart the bot after saving .env.`,
  ].join('\n');
}

/**
 * RegimeMonitor — call checkAndAlert() each bot cycle.
 * Sends a Telegram alert only when:
 *   1. The detected regime mismatches TIMEFRAME in .env
 *   2. The regime has been consistent for CONFIRM_CYCLES consecutive checks
 *   3. We haven't already alerted for this regime (avoids spam)
 */
export class RegimeMonitor {
  private consecutiveCount = 0;
  private lastSeenRegime: Regime = 'neutral';
  private lastAlertedRegime: Regime = 'neutral';
  private readonly CONFIRM_CYCLES = 3;  // require 3 consecutive matches (~6 min at 2-min cycles)

  async checkAndAlert(sendAlert: (msg: string) => Promise<void>): Promise<void> {
    try {
      const ohlcv    = await fetchBtc4hOhlcv(250);
      const detected = detectRegimeFromOhlcv(ohlcv);

      if (detected === 'neutral') {
        this.consecutiveCount = 0;
        this.lastSeenRegime   = 'neutral';
        return;
      }

      if (detected === this.lastSeenRegime) {
        this.consecutiveCount++;
      } else {
        this.lastSeenRegime   = detected;
        this.consecutiveCount = 1;
      }

      logger.debug(`Regime check: ${detected} (${this.consecutiveCount}/${this.CONFIRM_CYCLES} cycles)`);

      if (this.consecutiveCount < this.CONFIRM_CYCLES) return;

      const currentTf = process.env.TIMEFRAME || '1h';
      const expected  = REGIME_CONFIG[detected].timeframe;
      const mismatch  = currentTf !== expected;

      // Alert if mismatch AND haven't already alerted for this regime
      if (mismatch && detected !== this.lastAlertedRegime) {
        const msg = buildRegimeAlert(detected, currentTf);
        logger.info(`Regime mismatch: detected=${detected}, configured=${currentTf} — sending alert`);
        await sendAlert(msg);
        this.lastAlertedRegime = detected;
      }
    } catch (error) {
      logger.warn(`Regime check failed: ${error}`);
    }
  }
}

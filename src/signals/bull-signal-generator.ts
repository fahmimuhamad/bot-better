/**
 * Bull Signal Generator v2 — Trend Pullback + Liquidity Sweep
 *
 * Strategy: EMA pullback with liquidity sweep confirmation, optimized for choppy bull markets.
 * LONG only — only active when BTC > EMA200 (bull regime detected by index.ts).
 *
 * Entry pipeline (all must pass):
 *   1. Macro trend:  price > EMA50 AND price > EMA200 (bulls in control)
 *   2. Pullback zone: price within 7% of EMA21, 6% of EMA50, or Fib 38.2–61.8% retracement
 *   3. ADX >= 28, DI+ leads DI- by > 5 (real trend, not chop)
 *   4. Liquidity sweep OR ADX >= 33 (stop-hunt or strong momentum as entry trigger)
 *
 * Confidence score (0–100):
 *   Backtest mode (pump/liq null): volScore×55% + trendScore×45% (full 0–100 range)
 *   Live mode: accumulation×40% + liquidation×30% + volume×20% + trend×10%
 *
 * Risk Management:
 *   Risk per trade: BULL_RISK_PCT (default 2%, lower than bear to reduce 4H drawdowns)
 *   SL: ATR × 1.5 or min 2% (wider than bear — 4H candles are more volatile)
 *   TP1: 2.0R (or env TP1_R_MULT), TP2: 4.0R (or env TP2_R_MULT)
 *   TP1 snaps to nearest short-liquidation cluster if it falls in TP1–TP2 range
 *
 * Funding rate filter: skip if funding > 0.05% (longs too expensive)
 */

import logger from '../utils/logger';
import { TradeSignal, CoinMarketData, BinanceTickerData, FundingRate, PumpScanResult, LiquidationMap } from '../types';
import { OHLCV } from '../backtest/data-loader';

const MIN_CANDLES = 55;
const ADX_MIN_BULL = 28; // Bull 4H entries need real momentum to be quality

// TP/SL R-multiples for bull strategy (can be overridden by .env)
// 4H candles are 4x more volatile than 1H — needs wider SL
const DEFAULT_TP1_R = 2.0;
const DEFAULT_TP2_R = 4.0;
const DEFAULT_SL_ATR_MULT = 1.5;
const DEFAULT_SL_MIN_PCT  = 2.0;

export class BullSignalGenerator {

  // ─── Indicators ─────────────────────────────────────────────────────────────

  private calcEMA(values: number[], period: number): number[] {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const result: number[] = [ema];
    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
      result.push(ema);
    }
    return result;
  }

  private getEMA(candles: OHLCV[], period: number): number | null {
    const closes = candles.map(c => c.close);
    const arr = this.calcEMA(closes, period);
    return arr.length > 0 ? arr[arr.length - 1] : null;
  }

  private calcATR(candles: OHLCV[], period = 14): number | null {
    if (candles.length < period + 1) return null;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const { high, low } = candles[i];
      const pc = candles[i - 1].close;
      trs.push(Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc)));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  private calcADX(candles: OHLCV[], period = 14): { adx: number; diPlus: number; diMinus: number } | null {
    if (candles.length < period * 3) return null;
    const dmP: number[] = [], dmM: number[] = [], trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const { high, low } = candles[i];
      const pH = candles[i - 1].high, pL = candles[i - 1].low, pC = candles[i - 1].close;
      const up = high - pH, dn = pL - low;
      dmP.push(up > dn && up > 0 ? up : 0);
      dmM.push(dn > up && dn > 0 ? dn : 0);
      trs.push(Math.max(high - low, Math.abs(high - pC), Math.abs(low - pC)));
    }
    const ws = (arr: number[], p: number): number => {
      let val = arr.slice(0, p).reduce((a, b) => a + b, 0);
      for (let i = p; i < arr.length; i++) val = val - val / p + arr[i];
      return val;
    };
    const smTR = ws(trs, period), smDMP = ws(dmP, period), smDMM = ws(dmM, period);
    if (smTR === 0) return { adx: 0, diPlus: 0, diMinus: 0 };
    const diPlus = (smDMP / smTR) * 100, diMinus = (smDMM / smTR) * 100;
    if (diPlus + diMinus === 0) return { adx: 0, diPlus: 0, diMinus: 0 };
    return { adx: (Math.abs(diPlus - diMinus) / (diPlus + diMinus)) * 100, diPlus, diMinus };
  }

  private calcRSI(candles: OHLCV[], period = 14): number | null {
    if (candles.length < period + 1) return null;
    const closes = candles.map(c => c.close);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
    }
    avgGain /= period;
    avgLoss /= period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  // ─── Core Strategy Filters ───────────────────────────────────────────────────

  /**
   * Filter 1: Macro trend.
   * Price must be above EMA50 AND EMA200 — we only go long in an uptrend.
   * EMA21 > EMA50 > EMA200 is ideal but not strictly required here because
   * in choppy bull markets price often drops below EMA21 before resuming.
   */
  private checkMacroTrend(candles: OHLCV[], price: number): boolean {
    const ema50  = this.getEMA(candles, 50);
    const ema200 = this.getEMA(candles, 200);
    if (!ema50 || !ema200) return false;
    return price > ema50 && price > ema200;
  }

  /**
   * Filter 2: Pullback zone.
   * Price has retraced toward EMA21 or EMA50 — we want to buy the dip, not chase.
   * Zone 1: price is within 4% above EMA21 (touched/near EMA21)
   * Zone 2: price is within 3% above EMA50
   * Zone 3: price is in the Fibonacci 0.382–0.618 retracement of the last swing
   */
  private checkPullbackZone(candles: OHLCV[], price: number): { inZone: boolean; type: string } {
    const ema21 = this.getEMA(candles, 21);
    const ema50 = this.getEMA(candles, 50);

    if (ema21 && price >= ema21 && price <= ema21 * 1.07) {
      return { inZone: true, type: 'EMA21' };
    }
    if (ema50 && price >= ema50 && price <= ema50 * 1.06) {
      return { inZone: true, type: 'EMA50' };
    }

    // Fibonacci retracement: find last 30-candle swing high and swing low
    const lookback = candles.slice(-30);
    const swingHigh = Math.max(...lookback.map(c => c.high));
    const swingLow  = Math.min(...lookback.map(c => c.low));
    const range = swingHigh - swingLow;
    if (range > 0) {
      const fib382 = swingHigh - range * 0.382;
      const fib618 = swingHigh - range * 0.618;
      if (price >= fib618 && price <= fib382) {
        return { inZone: true, type: 'FIB382-618' };
      }
    }

    return { inZone: false, type: '' };
  }

  /**
   * Filter 3: Liquidity sweep confirmation.
   * Look at the last 3 candles for a stop-hunt pattern:
   *   - A wick that pierced below the 10-candle low support
   *   - Then closed back above that support
   *   - Volume on that candle > 1.5× avg (real flush, not noise)
   * This is the "smart money entry" pattern — stops below support are hunted,
   * price reclaims, then continues up.
   */
  private checkLiquiditySweep(candles: OHLCV[]): {
    found: boolean;
    sweepLow: number;
    sweepCandleIdx: number;
  } {
    if (candles.length < 15) return { found: false, sweepLow: 0, sweepCandleIdx: -1 };

    const avgVol = candles.slice(-20, -1).reduce((s, c) => s + c.volume, 0) / 19;
    const support10 = Math.min(...candles.slice(-13, -3).map(c => c.low));

    // Check last 3 completed candles for the sweep pattern
    for (let offset = 1; offset <= 3; offset++) {
      const idx = candles.length - 1 - offset;
      if (idx < 0) continue;
      const candle = candles[idx];

      const wickPiercedBelow = candle.low < support10;
      const closedAbove      = candle.close > support10;
      const volumeSpiked     = candle.volume > avgVol * 1.5;

      if (wickPiercedBelow && closedAbove && volumeSpiked) {
        return { found: true, sweepLow: candle.low, sweepCandleIdx: idx };
      }
    }

    return { found: false, sweepLow: 0, sweepCandleIdx: -1 };
  }

  // ─── Confidence Score ────────────────────────────────────────────────────────

  /**
   * Weighted confidence score (0-100):
   *   Accumulation signals  40%
   *   Liquidation setup     30%
   *   Volume expansion      20%
   *   Trend alignment       10%
   */
  private calcConfidence(
    pump: PumpScanResult | null,
    liq: LiquidationMap | null,
    candles: OHLCV[],
    adxResult: { adx: number; diPlus: number; diMinus: number } | null,
    price: number
  ): { score: number; accScore: number; liqScore: number; volScore: number; trendScore: number } {

    // Component: Volume expansion
    const avgVol = candles.slice(-20, -1).reduce((s, c) => s + c.volume, 0) / 19;
    const lastVol = candles[candles.length - 1].volume;
    const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
    let volScore = 50;
    if (volRatio >= 2.0)      volScore = 100;
    else if (volRatio >= 1.5) volScore = 80;
    else if (volRatio >= 1.2) volScore = 65;
    else if (volRatio < 0.8)  volScore = 20;

    // Component: Trend alignment
    let trendScore = 50;
    if (adxResult) {
      const spread = adxResult.diPlus - adxResult.diMinus;
      if (adxResult.adx >= 35 && spread >= 15) trendScore = 100;
      else if (adxResult.adx >= 30 && spread >= 10) trendScore = 85;
      else if (adxResult.adx >= 25 && spread >= 5)  trendScore = 70;
      else if (adxResult.adx >= ADX_MIN_BULL)        trendScore = 55;
    }

    let score: number;
    let accScore = 50;
    let liqScore = 50;

    if (pump === null && liq === null) {
      // Backtest mode: no live data available.
      // Scale purely from volume + trend so confidence spans the full 0-100 range
      // and MIN_CONFIDENCE actually discriminates between strong and weak setups.
      score = Math.round(volScore * 0.55 + trendScore * 0.45);
    } else {
      // Live mode: use all four components
      accScore = pump ? Math.min(100, pump.score) : 50;

      if (liq && liq.nearestShortLiq) {
        const distPct = (liq.nearestShortLiq - price) / price;
        if (distPct >= 0.05 && distPct <= 0.20) liqScore = 100;
        else if (distPct > 0.02)                 liqScore = 75;
        else                                     liqScore = 25;
      }

      score = Math.round(
        accScore * 0.40 +
        liqScore * 0.30 +
        volScore * 0.20 +
        trendScore * 0.10,
      );
    }

    return { score: Math.min(95, Math.max(0, score)), accScore, liqScore, volScore, trendScore };
  }

  // ─── Main Entry Point ────────────────────────────────────────────────────────

  generateSignal(
    coin: CoinMarketData,
    _ticker: BinanceTickerData,
    candles: OHLCV[],
    pump: PumpScanResult | null,
    liq: LiquidationMap | null,
    fundingRate?: FundingRate,
  ): TradeSignal | null {
    if (candles.length < MIN_CANDLES) return null;

    const last  = candles[candles.length - 1];
    const price = last.close;

    // ── Funding rate filter — avoid paying high funding ──────────────────────
    if (fundingRate && fundingRate.fundingRate > 0.0005) return null; // > 0.05%/8h

    // ── Filter 1: Macro trend ─────────────────────────────────────────────────
    if (!this.checkMacroTrend(candles, price)) return null;

    // ── Filter 2: Pullback zone ───────────────────────────────────────────────
    const pullback = this.checkPullbackZone(candles, price);
    if (!pullback.inZone) return null;

    // ── Filter 3: ADX trend strength ─────────────────────────────────────────
    const adxResult = this.calcADX(candles);
    if (!adxResult || adxResult.adx < ADX_MIN_BULL) return null;
    // DI+ must clearly dominate — require > 5 spread to filter sideways chop
    if (adxResult.diPlus - adxResult.diMinus < 5) return null;

    // ── Filter 4: Liquidity sweep (soft gate) ────────────────────────────────
    const sweep = this.checkLiquiditySweep(candles);
    if (!sweep.found) {
      // Compensating conditions: strong trend (ADX >= 33) OR high pump score
      const adxStrong  = adxResult.adx >= 33;
      const pumpStrong = pump !== null && pump.score >= 80;
      if (!adxStrong && !pumpStrong) return null;
    }

    // ── Filter 5: Breakout confirmation ──────────────────────────────────────
    // The last candle must close ABOVE the previous candle's high.
    // This ensures price is already breaking out of the pullback, not still falling.
    // Without this, we enter mid-correction (falling knife problem → 63% SL rate).
    const prev = candles[candles.length - 2];
    if (last.close <= prev.high) return null;

    // ── RSI: not overbought ───────────────────────────────────────────────────
    const rsi = this.calcRSI(candles);
    if (rsi !== null && rsi > 75) return null; // don't buy overbought

    // ── ATR-based SL/TP ───────────────────────────────────────────────────────
    const atr = this.calcATR(candles);
    if (!atr) return null;

    const slAtrMult = parseFloat(process.env.SL_ATR_MULTIPLIER || String(DEFAULT_SL_ATR_MULT));
    const slMinPct  = parseFloat(process.env.SL_ATR_MIN_PCT    || String(DEFAULT_SL_MIN_PCT)) / 100;
    const tp1RMult  = parseFloat(process.env.TP1_R_MULT        || String(DEFAULT_TP1_R));
    const tp2RMult  = parseFloat(process.env.TP2_R_MULT        || String(DEFAULT_TP2_R));

    // SL below sweep wick (if found) or ATR-based
    const slDist = Math.max(
      atr * slAtrMult,
      price * slMinPct,
      sweep.found ? price - sweep.sweepLow + atr * 0.3 : 0
    );
    const stopLoss = price - slDist;

    let tp1 = price + slDist * tp1RMult;
    let tp2 = price + slDist * tp2RMult;

    // If a short-liq cluster sits between TP1 and TP2, snap TP1 to it (natural magnet)
    if (liq?.nearestShortLiq && liq.nearestShortLiq > tp1 && liq.nearestShortLiq < tp2) {
      tp1 = liq.nearestShortLiq;
    }

    // ── Confidence score ──────────────────────────────────────────────────────
    const conf = this.calcConfidence(pump, liq, candles, adxResult, price);

    const ema21 = this.getEMA(candles, 21);
    const ema50 = this.getEMA(candles, 50);

    logger.debug(`Bull signal candidate: ${coin.symbol} | conf=${conf.score} | pullback=${pullback.type} | sweep=${sweep.found} | pump=${pump?.score ?? 'N/A'} | adx=${adxResult.adx.toFixed(1)}`);

    return {
      symbol:    coin.symbol,
      direction: 'LONG',
      confidence: conf.score,
      scores: {
        accumulation:    conf.accScore,
        pumpProbability: conf.liqScore,
        whale:           conf.volScore,
        smartMoney:      conf.trendScore,
      },
      derivedMetrics: {
        pressure:    conf.liqScore,
        riskLevel:   adxResult.adx >= 35 ? 'low' : adxResult.adx >= 25 ? 'medium' : 'high',
        momentum:    rsi ?? 50,
        volumeSpike: (candles[candles.length - 1].volume / (candles.slice(-20, -1).reduce((s, c) => s + c.volume, 0) / 19)) >= 1.5,
        deepValue:   pullback.type === 'FIB382-618',
      },
      entryPrice: price,
      stopLoss,
      tp1,
      tp2,
      timestamp: last.timestamp,
      reasoning: [
        `Bull Pullback [LONG]`,
        `Pullback: ${pullback.type}`,
        sweep.found ? `Sweep: wick=${sweep.sweepLow.toFixed(4)}` : 'No sweep (high score)',
        `ADX=${adxResult.adx.toFixed(1)} DI+=${adxResult.diPlus.toFixed(1)}`,
        rsi !== null ? `RSI=${rsi.toFixed(1)}` : '',
        ema21 ? `EMA21=${ema21.toFixed(4)}` : '',
        ema50 ? `EMA50=${ema50.toFixed(4)}` : '',
        pump ? `PumpScore=${pump.score}` : '',
        liq?.nearestShortLiq ? `ShortLiq=${liq.nearestShortLiq.toFixed(4)}` : '',
        `conf=${conf.score}`,
      ].filter(Boolean).join(' | '),
    };
  }
}

export default new BullSignalGenerator();

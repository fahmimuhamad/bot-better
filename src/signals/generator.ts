/**
 * Signal Generator v2 — EMA Trend Pullback Strategy
 *
 * Core concept: Only enter when price pulls back to EMA20 inside a confirmed trend.
 * This filters out choppy/ranging conditions that killed the previous strategy.
 *
 * Hard Requirements (ALL must pass — no exceptions):
 *   1. EMA20 / EMA50 / EMA200 fully aligned  → multi-timeframe trend confirmed
 *   2. ADX (14) > 25                         → market is actually trending
 *   3. Price within ±2% of EMA20             → optimal pullback entry, not chasing
 *   4. RSI (14) in valid zone (35-68 LONG / 32-65 SHORT) → momentum intact
 *
 * Confidence scoring (60 base + up to 35 bonus):
 *   ADX ≥ 35                          → +10  (very strong trend)
 *   ADX ≥ 30                          → +5   (strong trend)
 *   RSI in ideal zone (42-58)         → +8   (momentum neutral, room to run)
 *   MACD aligned + histogram colour   → +15  (momentum confirmation)
 *   StochRSI in pullback zone         → +10  (pullback depth confirmed)
 *   Volume declining during pullback  → +5   (healthy retracement, not distribution)
 *   Volume spike (>2× avg)            → -5   (breakout candle, not pullback)
 *   MACD counter-direction            → -10  (momentum against us)
 *   StochRSI extreme against us       → -10  (overextended)
 *
 * TP/SL: reads from .env
 *   SL_ATR_MULTIPLIER (default 1.0) × ATR, min SL_ATR_MIN_PCT (default 1.5%)
 *   TP1 = entry ± SL_dist × TP1_R_MULT (default 2.0)  ← close FULL at TP1
 *   TP2 = entry ± SL_dist × TP2_R_MULT (default 3.5)  ← backup level
 */

import logger from '../utils/logger';
import { TradeSignal, CoinMarketData, BinanceTickerData, FundingRate } from '../types';
import { OHLCV } from '../backtest/data-loader';

// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_CANDLES       = 220;    // Need 220 for EMA200 + stability buffer
const EMA_FAST          = 20;     // EMA20: short-term trend & pullback target
const EMA_MID           = 50;     // EMA50: medium-term trend confirmation
const EMA_SLOW          = 200;    // EMA200: macro trend direction
const ADX_PERIOD        = 14;
const ADX_MIN           = parseInt(process.env.ADX_MIN || '32');  // configurable: 32 for 1H, 25 for 4H
const ATR_PERIOD        = 14;
const RSI_PERIOD        = 14;
const PULLBACK_BELOW    = 0.015;  // LONG:  price must be within 1.5% BELOW EMA20 (the demand zone)
const PULLBACK_ABOVE    = 0.003;  // LONG:  price can be at most 0.3% ABOVE EMA20 (just touched)
const RSI_LONG_MIN      = 35;     // LONG floor (pulled back enough)
const RSI_LONG_MAX      = 58;     // LONG ceiling (not overbought going in)
const RSI_SHORT_MIN     = 42;     // SHORT floor (RSI must show bounce)
const RSI_SHORT_MAX     = 65;     // SHORT ceiling
const ATR_PCT_MIN       = 1.0;    // Min ATR% — need some movement to profit
const ATR_PCT_MAX       = 5.0;    // Max ATR% — too volatile = bounces kill SL
const CONFIDENCE_BASE   = 65;     // Base confidence when all hard reqs pass

export class SignalGenerator {

  // ─── Technical Indicator Implementations ──────────────────────────────────

  /**
   * Wilder-smoothed RSI (industry standard — more stable than simple avg RSI)
   */
  private calculateRSI(ohlcvData: OHLCV[], period: number = RSI_PERIOD): number | null {
    if (!ohlcvData || ohlcvData.length < period + 1) return null;
    const closes = ohlcvData.map(c => c.close);

    // Seed with simple averages over first `period` changes
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) avgGain += d;
      else avgLoss += Math.abs(d);
    }
    avgGain /= period;
    avgLoss /= period;

    // Wilder smooth the rest
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  /**
   * EMA as a number array — used internally by MACD
   */
  private calculateEMA(values: number[], period: number): number[] {
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

  /**
   * Returns the latest EMA value from OHLCV closes.
   */
  private getEMAValue(ohlcvData: OHLCV[], period: number): number | null {
    if (!ohlcvData || ohlcvData.length < period) return null;
    const closes = ohlcvData.map(c => c.close);
    const arr = this.calculateEMA(closes, period);
    return arr.length > 0 ? arr[arr.length - 1] : null;
  }

  /**
   * ATR (Average True Range) — measures volatility for SL sizing
   */
  private calculateATR(ohlcvData: OHLCV[], period: number = ATR_PERIOD): number | null {
    if (!ohlcvData || ohlcvData.length < period + 1) return null;
    const trs: number[] = [];
    for (let i = 1; i < ohlcvData.length; i++) {
      const { high, low } = ohlcvData[i];
      const prevClose = ohlcvData[i - 1].close;
      trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  /**
   * ADX via Wilder smoothing — measures trend strength (0-100).
   * Also returns DI+ and DI- for directional bias filter.
   * > 25 = trending, < 25 = ranging/consolidating.
   */
  private calculateADX(ohlcvData: OHLCV[], period: number = ADX_PERIOD): { adx: number; diPlus: number; diMinus: number } | null {
    // Need enough candles for two full smoothing cycles
    if (!ohlcvData || ohlcvData.length < period * 3) return null;

    const dmPlus: number[]  = [];
    const dmMinus: number[] = [];
    const trs: number[]     = [];

    for (let i = 1; i < ohlcvData.length; i++) {
      const { high, low } = ohlcvData[i];
      const pH = ohlcvData[i - 1].high;
      const pL = ohlcvData[i - 1].low;
      const pC = ohlcvData[i - 1].close;
      const up = high - pH;
      const dn = pL - low;
      dmPlus.push(up > dn && up > 0 ? up : 0);
      dmMinus.push(dn > up && dn > 0 ? dn : 0);
      trs.push(Math.max(high - low, Math.abs(high - pC), Math.abs(low - pC)));
    }

    // Wilder smooth: seed = sum(first period), then: val = val - val/period + next
    const wilderSmooth = (arr: number[], p: number): number => {
      let val = arr.slice(0, p).reduce((a, b) => a + b, 0);
      for (let i = p; i < arr.length; i++) val = val - val / p + arr[i];
      return val;
    };

    const smTR  = wilderSmooth(trs,     period);
    const smDMP = wilderSmooth(dmPlus,  period);
    const smDMM = wilderSmooth(dmMinus, period);

    if (smTR === 0) return { adx: 0, diPlus: 0, diMinus: 0 };
    const diPlus  = (smDMP / smTR) * 100;
    const diMinus = (smDMM / smTR) * 100;
    if (diPlus + diMinus === 0) return { adx: 0, diPlus: 0, diMinus: 0 };
    const adx = (Math.abs(diPlus - diMinus) / (diPlus + diMinus)) * 100;
    return { adx, diPlus, diMinus };
  }

  /**
   * MACD (12, 26, 9) — momentum direction and crossover
   */
  private calculateMACD(ohlcvData: OHLCV[]): { macd: number; signal: number; histogram: number } | null {
    if (!ohlcvData || ohlcvData.length < 35) return null;
    const closes = ohlcvData.map(c => c.close);
    const ema12  = this.calculateEMA(closes, 12);
    const ema26  = this.calculateEMA(closes, 26);
    if (!ema12.length || !ema26.length) return null;
    const offset   = ema12.length - ema26.length;
    const macdLine = ema26.map((v, i) => ema12[i + offset] - v);
    if (macdLine.length < 9) return null;
    const sigArr    = this.calculateEMA(macdLine, 9);
    const lastMacd  = macdLine[macdLine.length - 1];
    const lastSig   = sigArr[sigArr.length - 1];
    return { macd: lastMacd, signal: lastSig, histogram: lastMacd - lastSig };
  }

  /**
   * Stochastic RSI %K — shows where RSI sits within its recent range (0-100).
   * < 30 = RSI oversold (good pullback for LONG), > 70 = RSI overbought (good for SHORT).
   */
  private calculateStochRSI(ohlcvData: OHLCV[], period: number = 14): number | null {
    if (!ohlcvData || ohlcvData.length < period * 2 + 1) return null;
    const rsiValues: number[] = [];
    for (let i = period; i <= ohlcvData.length; i++) {
      const r = this.calculateRSI(ohlcvData.slice(0, i), period);
      if (r !== null) rsiValues.push(r);
    }
    if (rsiValues.length < period) return null;
    const recent = rsiValues.slice(-period);
    const hi = Math.max(...recent);
    const lo = Math.min(...recent);
    const last = rsiValues[rsiValues.length - 1];
    if (hi === lo) return 50;
    return ((last - lo) / (hi - lo)) * 100;
  }

  /**
   * EMA20 slope over last `lookback` candles (fraction per candle).
   * Positive = EMA20 rising, negative = EMA20 falling.
   */
  private getEMA20Slope(ohlcvData: OHLCV[], lookback: number = 5): number | null {
    if (ohlcvData.length < EMA_FAST + lookback) return null;
    const closes = ohlcvData.map(c => c.close);
    const emaArr = this.calculateEMA(closes, EMA_FAST);
    if (emaArr.length < lookback + 1) return null;
    const latest = emaArr[emaArr.length - 1];
    const prior  = emaArr[emaArr.length - 1 - lookback];
    return (latest - prior) / prior;
  }

  // ─── Strategy Logic ────────────────────────────────────────────────────────

  /**
   * EMA alignment check.
   * LONG  = EMA20 > EMA50 > EMA200  (all rising, bull structure)
   * SHORT = EMA20 < EMA50 < EMA200  (all falling, bear structure)
   * null  = EMAs are mixed / crossed → ranging market → NO TRADE
   */
  private getTrendDirection(ema20: number, ema50: number, ema200: number): 'LONG' | 'SHORT' | null {
    if (ema20 > ema50 && ema50 > ema200) return 'LONG';
    if (ema20 < ema50 && ema50 < ema200) return 'SHORT';
    return null;
  }

  /**
   * Confirmed reversal at EMA20 — "3-candle pattern" approach.
   *
   * We do NOT enter at the first touch of EMA20. Instead we wait for the
   * EMA20 level to reject price AND for a confirming candle to close back
   * through EMA20 in the trend direction. This confirms the level held.
   *
   * LONG pattern:
   *   1. Previous candle had a LOW below EMA20 (price tested the level)
   *   2. Previous candle CLOSED above EMA20 (bullish reversal candle)
   *   3. Current candle is also above EMA20 (confirmation, trend resuming)
   *   Entry: above EMA20, SL: below previous candle's low
   *
   * SHORT pattern:
   *   1. Previous candle had a HIGH above EMA20 (price tested the level)
   *   2. Previous candle CLOSED below EMA20 (bearish reversal candle)
   *   3. Current candle is also below EMA20 (confirmation, trend resuming)
   *   Entry: below EMA20, SL: above previous candle's high
   */
  private isPullbackZone(ohlcvData: OHLCV[], ema20: number, direction: 'LONG' | 'SHORT'): boolean {
    if (ohlcvData.length < 12) return false;

    const current  = ohlcvData[ohlcvData.length - 1];
    const previous = ohlcvData[ohlcvData.length - 2];
    const price    = current.close;
    const diffCurr = (price - ema20) / ema20;
    const diffPrev = (previous.close - ema20) / ema20;

    // "Swing proof": in the 10 candles BEFORE previous, price must have been
    // clearly away from EMA20 — confirming this is a real pullback, not oscillation
    // For LONG: at least one of those candles closed > 1% above EMA20
    // For SHORT: at least one of those candles closed > 1% below EMA20
    const swingWindow = ohlcvData.slice(ohlcvData.length - 12, ohlcvData.length - 2);


    if (direction === 'LONG') {
      // Swing proof: trend had price clearly above EMA20 before pulling back
      const hadSwingHigh = swingWindow.some(c => c.close > ema20 * 1.01);
      if (!hadSwingHigh) return false;

      // Step 1: Previous candle low touched at or below EMA20 (tested the level)
      if (previous.low >= ema20 * 1.001) return false;

      // Step 2: Previous candle closed above EMA20 (EMA20 held as support)
      if (diffPrev < 0) return false;

      // Step 3: Reversal candle body filter — avoid tiny doji (20% threshold)
      // Allows hammers/shooting stars (valid EMA touch patterns)
      const prevRange = previous.high - previous.low;
      const prevBody  = Math.abs(previous.close - previous.open);
      if (prevRange > 0 && prevBody / prevRange < 0.20) return false;

      // Step 4: Current candle (confirmation) is near EMA20, not falling hard
      if (diffCurr < -0.008) return false;   // not more than 0.8% below EMA20
      if (diffCurr > 0.025) return false;    // don't chase entries far above

      return true;
    }

    // SHORT pattern
    // Swing proof: trend had price clearly below EMA20 before bouncing
    const hadSwingLow = swingWindow.some(c => c.close < ema20 * 0.99);
    if (!hadSwingLow) return false;

    // Step 1: Previous candle high touched at or above EMA20 (tested the level)
    if (previous.high <= ema20 * 0.999) return false;

    // Step 2: Previous candle closed below EMA20 (EMA20 held as resistance)
    if (diffPrev > 0) return false;

    // Step 3: Reversal candle body filter — avoid tiny doji
    const prevRange = previous.high - previous.low;
    const prevBody  = Math.abs(previous.close - previous.open);
    if (prevRange > 0 && prevBody / prevRange < 0.20) return false;

    // Step 4: Current candle (confirmation) is near EMA20, not surging hard
    if (diffCurr > 0.008) return false;    // not more than 0.8% above EMA20
    if (diffCurr < -0.025) return false;   // don't chase entries far below

    return true;
  }

  /**
   * Score confidence from optional indicators.
   * Base = 60 (all 4 hard requirements passed).
   * Optional boosters/penalties applied on top.
   */
  private scoreConfidence(
    ohlcvData: OHLCV[],
    direction: 'LONG' | 'SHORT',
    rsi: number,
    adx: number
  ): number {
    let conf = CONFIDENCE_BASE;

    // ADX strength bonus — stronger trend = higher quality entry
    if (adx >= 35) conf += 10;
    else if (adx >= 30) conf += 5;

    // RSI in ideal momentum zone (not extreme, has room to run)
    if (rsi >= 42 && rsi <= 58) conf += 8;

    // MACD alignment — momentum confirmation
    const macd = this.calculateMACD(ohlcvData);
    if (macd) {
      if (direction === 'LONG') {
        if (macd.macd > macd.signal && macd.histogram > 0) conf += 15;   // Bullish
        else if (macd.macd < macd.signal)                  conf -= 10;   // Counter-trend
      } else {
        if (macd.macd < macd.signal && macd.histogram < 0) conf += 15;   // Bearish
        else if (macd.macd > macd.signal)                  conf -= 10;   // Counter-trend
      }
    }

    // Stochastic RSI — confirms pullback depth
    const stoch = this.calculateStochRSI(ohlcvData);
    if (stoch !== null) {
      if (direction === 'LONG') {
        if (stoch < 35)  conf += 10;   // Oversold = healthy pullback
        else if (stoch > 70) conf -= 10;  // Overbought = chasing
      } else {
        if (stoch > 65)  conf += 10;   // Overbought = healthy pullback short
        else if (stoch < 30) conf -= 10;  // Oversold = risky short
      }
    }

    // Volume analysis: declining volume during pullback = healthy retracement
    if (ohlcvData.length >= 20) {
      const avgVol = ohlcvData.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
      const curVol = ohlcvData[ohlcvData.length - 1].volume;
      if (curVol < avgVol * 0.8) conf += 5;    // Healthy pullback on low volume
      else if (curVol > avgVol * 2.0) conf -= 5;   // High volume = breakout candle
    }

    // Candle body size: strong candle in direction = higher quality entry
    if (ohlcvData.length >= 2) {
      const c = ohlcvData[ohlcvData.length - 1];
      const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
      if (bodyPct > 0.7) conf += 5;  // Decisive candle in direction
    }

    return Math.min(95, Math.max(0, Math.round(conf)));
  }

  /**
   * Calculate SL, TP1, TP2 from ATR and .env config.
   * Default: SL = 1.0× ATR (min 1.5%), TP1 = 2.0R, TP2 = 3.5R
   */
  private calculateLevels(
    ohlcvData: OHLCV[],
    direction: 'LONG' | 'SHORT',
    entry: number
  ): { stopLoss: number; tp1: number; tp2: number } {
    const slAtrMult = parseFloat(process.env.SL_ATR_MULTIPLIER || '1.0');
    const slMinPct  = parseFloat(process.env.SL_ATR_MIN_PCT    || '1.5') / 100;
    const tp1RMult  = parseFloat(process.env.TP1_R_MULT        || '2.0');
    const tp2RMult  = parseFloat(process.env.TP2_R_MULT        || '3.5');

    const atr    = this.calculateATR(ohlcvData);
    const atrPct = atr ? atr / entry : slMinPct;
    const slDist = Math.max(atrPct * slAtrMult, slMinPct) * entry;

    if (direction === 'LONG') {
      return {
        stopLoss: entry - slDist,
        tp1:      entry + slDist * tp1RMult,
        tp2:      entry + slDist * tp2RMult,
      };
    }
    return {
      stopLoss: entry + slDist,
      tp1:      entry - slDist * tp1RMult,
      tp2:      entry - slDist * tp2RMult,
    };
  }

  // ─── Main Signal Generation ─────────────────────────────────────────────────

  /**
   * Generate a trade signal using the EMA Trend Pullback strategy.
   *
   * Returns null unless ALL four hard requirements are satisfied:
   *   1. EMA20/50/200 aligned (trend confirmed)
   *   2. ADX > 25 (trending market)
   *   3. Price at EMA20 pullback zone (not chasing)
   *   4. RSI in valid range (momentum intact)
   */
  generateSignal(
    coin: CoinMarketData,
    ticker: BinanceTickerData,
    fundingRate?: FundingRate,
    ohlcvData?: OHLCV[],
    htfOhlcvData?: OHLCV[]  // Higher timeframe candles (e.g. 4h when base is 1h)
  ): TradeSignal | null {

    // Need at least 220 candles for EMA200 + ADX stability
    if (!ohlcvData || ohlcvData.length < MIN_CANDLES) return null;

    const price = coin.price;

    // ── HARD REQUIREMENT 1: EMA Alignment ─────────────────────────────────
    const ema20  = this.getEMAValue(ohlcvData, EMA_FAST);
    const ema50  = this.getEMAValue(ohlcvData, EMA_MID);
    const ema200 = this.getEMAValue(ohlcvData, EMA_SLOW);
    if (ema20 === null || ema50 === null || ema200 === null) return null;

    const direction = this.getTrendDirection(ema20, ema50, ema200);
    if (!direction) return null;  // Ranging/transitioning market → skip

    // ── HTF DIRECTION FILTER ──────────────────────────────────────────────
    // If higher-timeframe data is provided, the HTF EMA stack must MATCH the
    // signal direction. This prevents shorting during a bull market and
    // longing during a bear market — the #1 cause of false signals.
    if (htfOhlcvData && htfOhlcvData.length >= EMA_MID) {
      const htfEma20  = this.getEMAValue(htfOhlcvData, EMA_FAST);
      const htfEma50  = this.getEMAValue(htfOhlcvData, EMA_MID);
      const htfEma200 = htfOhlcvData.length >= EMA_SLOW
        ? this.getEMAValue(htfOhlcvData, EMA_SLOW)
        : null;
      if (htfEma20 !== null && htfEma50 !== null) {
        const htfDirection = htfEma200 !== null
          ? this.getTrendDirection(htfEma20, htfEma50, htfEma200)
          : (htfEma20 > htfEma50 ? 'LONG' : htfEma20 < htfEma50 ? 'SHORT' : null);
        if (!htfDirection || htfDirection !== direction) return null;
      }
    }

    // ── HARD REQUIREMENT 2: ADX > ADX_MIN + DI directional bias ─────────
    const adxResult = this.calculateADX(ohlcvData);
    if (adxResult === null || adxResult.adx < ADX_MIN) return null;
    const { adx, diPlus, diMinus } = adxResult;

    // DI spread filter: the dominant DI must CLEARLY lead the other.
    // Prevents "ADX high but no clear direction" (e.g. volatile chop where DI+ ≈ DI-).
    if (direction === 'LONG'  && diPlus  - diMinus < 8) return null;
    if (direction === 'SHORT' && diMinus - diPlus  < 8) return null;

    // EMA spread filter for SHORT: EMA50 must be within 10% of EMA20.
    // In deeply extended bear markets, EMA50 is far above EMA20.
    // Dead-cat bounces can easily run from EMA20 all the way to EMA50 (10-20% move),
    // blowing through the SHORT SL. Skip SHORTs in these "stretched" conditions.
    if (direction === 'SHORT') {
      const ema20ToEma50Gap = (ema50 - ema20) / ema20;  // positive = EMA50 above EMA20 (bear)
      if (ema20ToEma50Gap > 0.07) return null;  // >7% gap = too extended, skip SHORT

      // Skip SHORT if price has fallen too far below EMA200 (extreme capitulation).
      // Coins > 40% below EMA200 are in violent capitulation — bounces blow through SL.
      const priceToEma200Gap = (ema200 - price) / ema200;
      if (priceToEma200Gap > 0.40) return null;  // >40% below EMA200 = skip SHORT
    }

    // ── HARD REQUIREMENT 2b: EMA20 slope in direction of trade ────────────
    // EMA20 must be sloping UP for LONG, DOWN for SHORT (over last 5 candles).
    // This prevents entries when EMA20 is flat/reversing — a key cause of false signals.
    const ema20Slope = this.getEMA20Slope(ohlcvData, 5);
    if (ema20Slope === null) return null;
    if (direction === 'LONG'  && ema20Slope < -0.001) return null;  // EMA20 falling — skip LONG
    if (direction === 'SHORT' && ema20Slope >  0.001) return null;  // EMA20 rising — skip SHORT

    // ── LONG ONLY: falling knife protection ────────────────────────────────
    // Don't enter LONG if price has crashed >10% from its 7-day high.
    // Prevents buying into a bull-market reversal that still shows bullish EMAs
    // (EMAs lag — they stay bullish for days after a peak reversal).
    if (direction === 'LONG' && ohlcvData.length >= 168) {
      const recent7dHigh = Math.max(...ohlcvData.slice(-168).map(c => c.high));
      const dropFromHigh = (recent7dHigh - price) / recent7dHigh;
      if (dropFromHigh > 0.10) return null;
    }

    // ── HARD REQUIREMENT 3: True Pullback — price came from trend direction ──
    if (!this.isPullbackZone(ohlcvData, ema20, direction)) return null;

    // ── HARD REQUIREMENT 4: RSI in Valid Zone ─────────────────────────────
    const rsi = this.calculateRSI(ohlcvData);
    if (rsi === null) return null;
    const rsiValid = direction === 'LONG'
      ? rsi >= RSI_LONG_MIN  && rsi <= RSI_LONG_MAX
      : rsi >= RSI_SHORT_MIN && rsi <= RSI_SHORT_MAX;
    if (!rsiValid) return null;

    // ── HARD REQUIREMENT 5: ATR% in optimal volatility range ──────────────
    // Too low = no movement/dead market. Too high = violent bounces kill SL.
    // SHORT trades are more vulnerable to volatile bounces, so tighter max for SHORT.
    const atr = this.calculateATR(ohlcvData);
    if (atr === null) return null;
    const atrPct = (atr / price) * 100;
    const atrMax = direction === 'SHORT' ? 3.5 : ATR_PCT_MAX;  // SHORT: max 3.5% (bear bounces)
    if (atrPct < ATR_PCT_MIN || atrPct > atrMax) return null;

    // ── CONFIDENCE SCORING ─────────────────────────────────────────────────
    const confidence = this.scoreConfidence(ohlcvData, direction, rsi, adx);

    // ── TP / SL LEVELS ─────────────────────────────────────────────────────
    const { stopLoss, tp1, tp2 } = this.calculateLevels(ohlcvData, direction, price);

    // ── BUILD SIGNAL ───────────────────────────────────────────────────────
    const emaTrendPct = ((ema20 - ema200) / ema200) * 100;  // % above/below macro trend

    logger.debug(
      `[Signal] ${coin.symbol} ${direction} @ ${price.toFixed(4)} | ` +
      `EMA20=${ema20.toFixed(4)} ADX=${adx.toFixed(1)} RSI=${rsi.toFixed(1)} conf=${confidence}`
    );

    return {
      symbol:    coin.symbol,
      direction,
      confidence,
      scores: {
        whale:           Math.round(adx),                              // repurposed: ADX value
        smartMoney:      Math.round(rsi),                              // repurposed: RSI value
        accumulation:    Math.round(emaTrendPct * 10),                 // repurposed: EMA trend %
        pumpProbability: Math.round(((ema20 - ema50) / ema50) * 1000), // repurposed: EMA20 vs EMA50
      },
      derivedMetrics: {
        pressure:   direction === 'LONG' ? 70 : 30,
        riskLevel:  adx >= 35 ? 'low' : adx >= 28 ? 'medium' : 'high',
        momentum:   rsi,
        volumeSpike: false,
        deepValue:   false,
      },
      entryPrice: price,
      stopLoss,
      tp1,
      tp2,
      timestamp: ohlcvData[ohlcvData.length - 1].timestamp,
      reasoning: `EMA Pullback [${direction}] | EMA20=${ema20.toFixed(4)} EMA50=${ema50.toFixed(4)} EMA200=${ema200.toFixed(4)} | ADX=${adx.toFixed(1)} | RSI=${rsi.toFixed(1)} | conf=${confidence}`,
    };
  }
}

export default new SignalGenerator();

#!/usr/bin/env ts-node

/**
 * Regime-Aware Portfolio Backtest
 *
 * Automatically switches between bull/bear mode based on BTC daily EMA200:
 *   - BTC close > EMA200  →  BULL: CURATED_COINS_4H, 1h→4h resampled signals
 *   - BTC close < EMA200  →  BEAR: CURATED_COINS_1H, 1h signals directly
 *
 * Portfolio scheme:
 *   - Single shared balance (compounding)
 *   - Up to MAX_OPEN_TRADES concurrent positions across all coins
 *   - Processes 1h candles chronologically (no look-ahead)
 *   - Bull entries only fire at 4h boundaries; bear entries every 1h
 *
 * Usage:
 *   npx ts-node src/backtest/regime-backtest.ts
 *   npx ts-node src/backtest/regime-backtest.ts --start-date 2023-01-01 --end-date 2026-03-13 --balance 163
 */

import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config();

import { DataLoader, OHLCV } from './data-loader';
import { SignalGenerator } from '../signals/generator';
import { BullSignalGenerator } from '../signals/bull-signal-generator';
import { CoinMarketData, BinanceTickerData } from '../types';

// ─── Coin lists ───────────────────────────────────────────────────────────────

const CURATED_COINS_4H = [
  // Verified 40%+ WR in 2024 bull backtest — high-quality 4H pullback coins
  'BTC','ETH','BNB','ADA','DOGE',
  // Borderline positive (35-36% WR) — keep for diversification
  'ARB','HBAR',
  // Added 2026-03-16: validated in full-period bull regime backtest
  // TRX(44.4% WR), MANA(40.9%), RAY(47.1%), BLUR(52.9%), JST(36%)
  'TRX','MANA','RAY','BLUR','JST',
  // Removed: OP(20%), SUI(25.8%), FLOW(27.8%), SHIB(28%), AVAX(30.2%)
  // Added 2026-03-16 batch 2: PSG(46.9%WR), AUDIO(58.8%), ATM(33.3%), ZEC(43.5%), SANTOS(40.7%)
  'PSG','AUDIO','ATM','ZEC','SANTOS',
  // Rejected (net drag despite positive P&L): LAZIO, AGLD, ALPINE, BIFI, WIN, FLOKI
  // Added 2026-03-16 batch 3: PAXG(41.7%WR, 36 trades) — tokenized gold, uncorrelated trends
  'PAXG',
  // Rejected batch 11: ALCX(20%WR), ARPA(16.7%), MTL(8.3%), AUCTION(14.3%), ACE(14.3%),
  //   DEGO(16.7%), MAV(27.3%), OXT(33.3% breakeven), DEXE(32%), HIGH/WAN(9 trades — unreliable)
];
const CURATED_COINS_1H = [
  'BTC','BNB','ADA','DOGE','AVAX',
  'OP','SHIB','SUI','FLOW','HBAR','TON',
  'SAND','CHZ','ZIL','ID','CVC','SXP',
  'PEOPLE','STG','DODO','OG','PORTO',
  'QUICK','DENT','IOTX','COTI','FLUX','MEME','DF','GNS',
  // Added 2026-03-16: validated via isolation testing
  'CELR','SUSHI','ACH','HFT','UTK','AUCTION',
];
const ALL_COINS = Array.from(new Set([...CURATED_COINS_4H, ...CURATED_COINS_1H]));

// ─── Args ─────────────────────────────────────────────────────────────────────

interface Args {
  startDate: string;
  endDate: string;
  balance: number;
  confidence: number;
  maxOpenTrades: number;
  reportPath?: string;
  bearOnly: boolean;
  bull1h: boolean; // use 1H candles for bull strategy instead of 4H
  bull1d: boolean; // use daily candles for bull strategy
  bull2h: boolean; // use 2H candles for bull strategy
  take75AtTp1: boolean; // close 75% at TP1, run 25% to TP2
}

function parseArgs(): Args {
  const args: Args = {
    startDate:     '2023-01-01',
    endDate:       '2026-03-13',
    balance:       163,
    confidence:    parseInt(process.env.MIN_CONFIDENCE || '65'),
    maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES || '5'),
    bearOnly:      false,
    bull1h:        false,
    bull1d:        false,
    bull2h:        false,
    take75AtTp1:   false,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i], v = process.argv[i + 1];
    if (k === '--start-date'    && v) { args.startDate     = v;             i++; }
    if (k === '--end-date'      && v) { args.endDate       = v;             i++; }
    if (k === '--balance'       && v) { args.balance       = parseFloat(v); i++; }
    if (k === '--confidence'    && v) { args.confidence    = parseInt(v);   i++; }
    if (k === '--max-trades'    && v) { args.maxOpenTrades = parseInt(v);   i++; }
    if (k === '--report'        && v) { args.reportPath    = v;             i++; }
    if (k === '--bear-only')         { args.bearOnly       = true;                }
    if (k === '--bull-1h')           { args.bull1h         = true;                }
    if (k === '--bull-1d')           { args.bull1d         = true;                }
    if (k === '--bull-2h')           { args.bull2h         = true;                }
    if (k === '--take-75-at-tp1')    { args.take75AtTp1    = true;                }
  }
  return args;
}

// ─── EMA helpers ──────────────────────────────────────────────────────────────

/** Compute EMA on an array of values, return array of same length (first period-1 values = NaN). */
function computeEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(NaN);
  let ema = NaN;
  for (let i = 0; i < values.length; i++) {
    if (isNaN(ema)) {
      if (i + 1 >= period) {
        // Seed with SMA of first `period` values
        ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
        out[i] = ema;
      }
    } else {
      ema = values[i] * k + ema * (1 - k);
      out[i] = ema;
    }
  }
  return out;
}

// ─── Candle helpers ───────────────────────────────────────────────────────────

function resampleCandles(candles: OHLCV[], ratio: number): OHLCV[] {
  const result: OHLCV[] = [];
  for (let i = 0; i + ratio <= candles.length; i += ratio) {
    const g = candles.slice(i, i + ratio);
    result.push({
      timestamp:        g[0].timestamp,
      open:             g[0].open,
      high:             Math.max(...g.map(c => c.high)),
      low:              Math.min(...g.map(c => c.low)),
      close:            g[g.length - 1].close,
      volume:           g.reduce((s, c) => s + c.volume, 0),
      quoteAssetVolume: g.reduce((s, c) => s + c.quoteAssetVolume, 0),
      numberOfTrades:   g.reduce((s, c) => s + c.numberOfTrades, 0),
    });
  }
  return result;
}

function buildCoinMarketData(symbol: string, klines: OHLCV[], idx: number): { coin: CoinMarketData; ticker: BinanceTickerData } {
  const c = klines[idx];
  const prev24 = idx >= 24 ? klines[idx - 24] : klines[0];
  const pctChange = ((c.close - prev24.close) / prev24.close) * 100;
  const win = klines.slice(Math.max(0, idx - 23), idx + 1);
  const vol24 = win.reduce((s, k) => s + k.quoteAssetVolume, 0);

  const coin: CoinMarketData = {
    symbol, price: c.close, priceChange24h: c.close - prev24.close,
    priceChangePercent24h: pctChange, volume24h: vol24, marketCap: 0,
    marketCapRank: 1, highPrice24h: Math.max(...win.map(k => k.high)),
    lowPrice24h: Math.min(...win.map(k => k.low)),
    circulatingSupply: 0, totalSupply: 0,
  };
  const ticker: BinanceTickerData = {
    symbol: `${symbol}USDT`, lastPrice: c.close.toString(),
    bidPrice: (c.close * 0.999).toString(), askPrice: (c.close * 1.001).toString(),
    volume: win.reduce((s, k) => s + k.volume, 0).toString(),
    quoteAssetVolume: vol24.toString(),
    openTime: c.timestamp, closeTime: c.timestamp, firstTradeId: 0, lastTradeId: 0,
    count: c.numberOfTrades,
  };
  return { coin, ticker };
}

function calcPositionSize(balance: number, entryPrice: number, stopLoss: number, riskPct: number): number {
  const riskAmount = balance * (riskPct / 100);
  const slPct = Math.abs(entryPrice - stopLoss) / entryPrice;
  if (slPct === 0) return 0;
  const positionValue = riskAmount / slPct;
  return Math.floor((positionValue / entryPrice) * 1e8) / 1e8;
}

// ─── Portfolio types ──────────────────────────────────────────────────────────

interface PPosition {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp1Hit: boolean;
  openTime: number;
}

interface PTrade extends PPosition {
  exitPrice: number;
  exitReason: string;
  pnl: number;
  closeTime: number;
  balanceBefore: number;
  balanceAfter: number;
  regimeAtEntry: 'BULL' | 'BEAR';
}

// ─── Regime detection precompute ──────────────────────────────────────────────

/**
 * Build a Map<dayStartMs, 'BULL'|'BEAR'> from BTC daily candles.
 * Uses EMA200 on close; BULL = close > EMA200.
 * The first 199 candles will be BEAR (no EMA yet) as a conservative default.
 */
function buildRegimeMap(btcDaily: OHLCV[]): Map<number, 'BULL' | 'BEAR'> {
  const closes = btcDaily.map(c => c.close);
  const ema200 = computeEMA(closes, 200);
  const map = new Map<number, 'BULL' | 'BEAR'>();
  for (let i = 0; i < btcDaily.length; i++) {
    const regime: 'BULL' | 'BEAR' = (!isNaN(ema200[i]) && closes[i] > ema200[i]) ? 'BULL' : 'BEAR';
    map.set(btcDaily[i].timestamp, regime);
  }
  return map;
}

/**
 * Given a unix ms timestamp (1h candle), return the regime at that point.
 * We look up the most recently completed daily candle (floor to day boundary).
 */
function getRegimeAt(ts: number, regimeMap: Map<number, 'BULL' | 'BEAR'>): 'BULL' | 'BEAR' {
  // Floor to UTC day start
  const dayMs = 24 * 60 * 60 * 1000;
  const dayStart = Math.floor(ts / dayMs) * dayMs;
  // Look for that day or previous days
  for (let d = dayStart; d >= dayStart - 5 * dayMs; d -= dayMs) {
    const r = regimeMap.get(d);
    if (r !== undefined) return r;
  }
  return 'BEAR'; // Default
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CANDLES_WARMUP  = 220;   // min 1h candles before generating signals
const CANDLES_LOOKBACK = 250;  // candles window for signal generator
const D1_MS            = 24 * 60 * 60 * 1000; // 1 day in ms
const REENTRY_COOLDOWN = 12;   // 1h candles cooldown after exit
const SLIPPAGE_PCT     = 0.001;
const FEE_PCT          = 0.001;
const RISK_PCT         = parseFloat(process.env.RISK_PER_TRADE || '3.5');
const BULL_RISK_PCT    = parseFloat(process.env.BULL_RISK_PCT || '2.0'); // lower risk for 4H bull trades
const CLOSE_AT_TP1     = process.env.CLOSE_AT_TP1 === 'true';
const H4_MS            = 4 * 60 * 60 * 1000; // 4 hours in ms

// ─── Portfolio engine ─────────────────────────────────────────────────────────

async function runRegimeBacktest(
  allKlines1h: Map<string, OHLCV[]>,
  btcDaily: OHLCV[],
  args: Args,
): Promise<{ trades: PTrade[]; finalBalance: number; startBalance: number }> {
  const sg     = new SignalGenerator();
  const bullSg = new BullSignalGenerator();
  const regimeMap = buildRegimeMap(btcDaily);

  let balance = args.balance;
  const startBalance = args.balance;
  const openPositions = new Map<string, PPosition>();
  const trades: PTrade[] = [];
  const lastExitCandle  = new Map<string, number>(); // symbol → 1h candle idx at exit
  const coinCandleCount = new Map<string, number>();
  ALL_COINS.forEach(s => coinCandleCount.set(s, 0));

  // Build merged sorted timestamps from all 1h klines
  const tsSet = new Set<number>();
  for (const klines of allKlines1h.values()) {
    for (const k of klines) tsSet.add(k.timestamp);
  }
  const allTimestamps = Array.from(tsSet).sort((a, b) => a - b);

  // Build lookup: symbol → Map<timestamp, index>
  const tsIndex = new Map<string, Map<number, number>>();
  for (const [sym, klines] of allKlines1h.entries()) {
    const m = new Map<number, number>();
    klines.forEach((k, i) => m.set(k.timestamp, i));
    tsIndex.set(sym, m);
  }

  let tradeCount = 0;
  let lastLoggedPct = -1;
  const totalTs = allTimestamps.length;

  for (let tsi = 0; tsi < allTimestamps.length; tsi++) {
    const ts = allTimestamps[tsi];
    if (balance <= 0) break;

    // Progress log every 5%
    const pct = Math.floor((tsi / totalTs) * 100 / 5) * 5;
    if (pct > lastLoggedPct) {
      const regime = getRegimeAt(ts, regimeMap);
      process.stdout.write(`  Progress: ${pct}%  Balance: $${balance.toFixed(0)}  Trades: ${tradeCount}  Regime: ${regime}   \r`);
      lastLoggedPct = pct;
    }

    const regime = getRegimeAt(ts, regimeMap);

    // ── Step 1: check exits for ALL open positions ───────────────────────────
    for (const [posId, pos] of openPositions.entries()) {
      const idx = tsIndex.get(pos.symbol)?.get(ts);
      if (idx === undefined) continue;
      const candle = allKlines1h.get(pos.symbol)![idx];

      let exitPrice: number | null = null;
      let exitReason = '';

      if (pos.side === 'LONG') {
        if (candle.high >= pos.tp2)                          { exitPrice = pos.tp2;      exitReason = 'TP2'; }
        else if (candle.high >= pos.tp1 && !pos.tp1Hit) {
          if (args.take75AtTp1) {
            // Partial close: record 75% at TP1, keep 25% running with SL at entry
            const execTp1 = pos.tp1 * (1 - SLIPPAGE_PCT);
            const qty75   = pos.quantity * 0.75;
            const pnl75   = (execTp1 - pos.entryPrice) * qty75;
            const fees75  = (pos.entryPrice + execTp1) * qty75 * FEE_PCT;
            const netPnl75 = pnl75 - fees75;
            const balBefore75 = balance;
            balance += netPnl75;
            trades.push({ ...pos, quantity: qty75, exitPrice: execTp1, exitReason: 'TP1_75',
              pnl: netPnl75, closeTime: ts, balanceBefore: balBefore75, balanceAfter: balance,
              regimeAtEntry: (pos as any).regimeAtEntry || 'BEAR' });
            tradeCount++;
            pos.quantity  *= 0.25;
            pos.tp1Hit     = true;
            pos.stopLoss   = pos.entryPrice;
          } else if (CLOSE_AT_TP1)                          { exitPrice = pos.tp1;      exitReason = 'TP1'; }
          else                                              { pos.tp1Hit = true; pos.stopLoss = pos.entryPrice; }
        }
        else if (candle.low <= pos.stopLoss)                 { exitPrice = pos.stopLoss; exitReason = 'SL';  }
      } else {
        if (candle.low <= pos.tp2)                           { exitPrice = pos.tp2;      exitReason = 'TP2'; }
        else if (candle.low <= pos.tp1 && !pos.tp1Hit) {
          if (args.take75AtTp1) {
            // Partial close: record 75% at TP1, keep 25% running with SL at entry
            const execTp1 = pos.tp1 * (1 + SLIPPAGE_PCT);
            const qty75   = pos.quantity * 0.75;
            const pnl75   = (pos.entryPrice - execTp1) * qty75;
            const fees75  = (pos.entryPrice + execTp1) * qty75 * FEE_PCT;
            const netPnl75 = pnl75 - fees75;
            const balBefore75 = balance;
            balance += netPnl75;
            trades.push({ ...pos, quantity: qty75, exitPrice: execTp1, exitReason: 'TP1_75',
              pnl: netPnl75, closeTime: ts, balanceBefore: balBefore75, balanceAfter: balance,
              regimeAtEntry: (pos as any).regimeAtEntry || 'BEAR' });
            tradeCount++;
            pos.quantity  *= 0.25;
            pos.tp1Hit     = true;
            pos.stopLoss   = pos.entryPrice;
          } else if (CLOSE_AT_TP1)                          { exitPrice = pos.tp1;      exitReason = 'TP1'; }
          else                                              { pos.tp1Hit = true; pos.stopLoss = pos.entryPrice; }
        }
        else if (candle.high >= pos.stopLoss)                { exitPrice = pos.stopLoss; exitReason = 'SL';  }
      }

      if (exitPrice && exitReason) {
        const execExit = pos.side === 'LONG'
          ? exitPrice * (1 - SLIPPAGE_PCT)
          : exitPrice * (1 + SLIPPAGE_PCT);
        const pnl  = pos.side === 'LONG'
          ? (execExit - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - execExit) * pos.quantity;
        const fees    = (pos.entryPrice + execExit) * pos.quantity * FEE_PCT;
        const netPnl  = pnl - fees;
        const balBefore = balance;
        balance += netPnl;

        trades.push({
          ...pos, exitPrice: execExit, exitReason, pnl: netPnl,
          closeTime: ts, balanceBefore: balBefore, balanceAfter: balance,
          regimeAtEntry: (pos as any).regimeAtEntry || 'BEAR',
        });

        openPositions.delete(posId);
        lastExitCandle.set(pos.symbol, coinCandleCount.get(pos.symbol) || 0);
        tradeCount++;
      }
    }

    // ── Step 2: check new entries ────────────────────────────────────────────
    const regimeMaxTrades = args.maxOpenTrades;
    if (openPositions.size >= regimeMaxTrades || balance <= 0) continue;

    // Bull: daily boundary (--bull-1d), every 1H (--bull-1h), or 4H boundary (default)
    const H2_MS = 2 * 60 * 60 * 1000;
    const bullBoundary = args.bull1d ? (ts % D1_MS === 0) : args.bull2h ? (ts % H2_MS === 0) : args.bull1h ? true : (ts % H4_MS === 0);
    const isBullEntryCandle = !args.bearOnly && regime === 'BULL' && bullBoundary;
    const isBearEntryCandle = regime === 'BEAR';
    if (!isBullEntryCandle && !isBearEntryCandle) continue;

    const activeCoinList = regime === 'BULL' ? CURATED_COINS_4H : CURATED_COINS_1H;

    for (const sym of activeCoinList) {
      if (openPositions.size >= regimeMaxTrades) break;
      if (Array.from(openPositions.values()).some(p => p.symbol === sym)) continue;

      const idx = tsIndex.get(sym)?.get(ts);
      if (idx === undefined) continue;

      coinCandleCount.set(sym, idx);

      if (idx < CANDLES_WARMUP) continue;

      const lastExit = lastExitCandle.get(sym);
      if (lastExit !== undefined && idx - lastExit < REENTRY_COOLDOWN) continue;

      const klines1h = allKlines1h.get(sym)!;

      let signalCandles: OHLCV[];
      let htfCandles: OHLCV[];

      if (regime === 'BULL' && args.bull2h) {
        const raw2h = resampleCandles(klines1h.slice(0, idx + 1), 2);
        if (raw2h.length < 55) continue;
        signalCandles = raw2h.slice(Math.max(0, raw2h.length - CANDLES_LOOKBACK));
        htfCandles = resampleCandles(raw2h, 2);
      } else if (regime === 'BULL' && args.bull1d) {
        // Daily mode: resample 1H → 24H candles
        const raw1d = resampleCandles(klines1h.slice(0, idx + 1), 24);
        if (raw1d.length < 55) continue;
        signalCandles = raw1d.slice(Math.max(0, raw1d.length - CANDLES_LOOKBACK));
        htfCandles = raw1d; // no higher TF available; use same
      } else if (regime === 'BULL' && !args.bull1h) {
        // 4H mode (default): resample 1H → 4H candles
        const raw4h = resampleCandles(klines1h.slice(0, idx + 1), 4);
        if (raw4h.length < 55) continue;
        signalCandles = raw4h.slice(Math.max(0, raw4h.length - CANDLES_LOOKBACK));
        htfCandles = resampleCandles(raw4h, 4);
      } else {
        // 1H mode (bear or bull-1h)
        signalCandles = klines1h.slice(Math.max(0, idx - CANDLES_LOOKBACK + 1), idx + 1);
        htfCandles = resampleCandles(klines1h.slice(0, idx + 1), 4);
      }

      const { coin, ticker } = buildCoinMarketData(sym, klines1h, idx);
      // Route to regime-specific generator — pump/liq data not available historically, pass null
      const signal = regime === 'BULL'
        ? bullSg.generateSignal(coin, ticker, signalCandles, null, null)
        : sg.generateSignal(coin, ticker, undefined, signalCandles, htfCandles);
      if (!signal || signal.confidence < args.confidence) continue;

      const entryPrice = signal.entryPrice * (signal.direction === 'LONG' ? 1 + SLIPPAGE_PCT : 1 - SLIPPAGE_PCT);
      const riskForTrade = regime === 'BULL' ? BULL_RISK_PCT : RISK_PCT;
      const qty = calcPositionSize(balance, entryPrice, signal.stopLoss, riskForTrade);
      if (qty <= 0 || entryPrice * qty < 1) continue;

      const tp1 = signal.tp1;
      const tp2 = signal.tp2;

      const posId = `POS_${tradeCount}_${sym}`;
      const pos: any = {
        id: posId, symbol: sym, side: signal.direction,
        entryPrice, quantity: qty,
        stopLoss: signal.stopLoss, tp1, tp2,
        tp1Hit: false, openTime: ts,
        regimeAtEntry: regime,
      };
      openPositions.set(posId, pos);
    }
  }

  // Close any still-open positions at last available price
  for (const [posId, pos] of openPositions.entries()) {
    const klines = allKlines1h.get(pos.symbol);
    if (!klines || klines.length === 0) continue;
    const lastCandle = klines[klines.length - 1];
    const execExit = lastCandle.close * (pos.side === 'LONG' ? (1 - SLIPPAGE_PCT) : (1 + SLIPPAGE_PCT));
    const pnl  = pos.side === 'LONG'
      ? (execExit - pos.entryPrice) * pos.quantity
      : (pos.entryPrice - execExit) * pos.quantity;
    const fees = (pos.entryPrice + execExit) * pos.quantity * FEE_PCT;
    const netPnl = pnl - fees;
    const balBefore = balance;
    balance += netPnl;
    trades.push({
      ...pos, exitPrice: execExit, exitReason: 'OPEN_AT_END', pnl: netPnl,
      closeTime: lastCandle.timestamp, balanceBefore: balBefore, balanceAfter: balance,
      regimeAtEntry: (pos as any).regimeAtEntry || 'BEAR',
    });
  }

  return { trades, finalBalance: balance, startBalance };
}

// ─── Report ───────────────────────────────────────────────────────────────────

function buildReport(
  trades: PTrade[], startBalance: number, finalBalance: number, args: Args,
  regimeSwitches: { date: string; regime: string }[],
): string {
  const wins    = trades.filter(t => t.pnl > 0);
  const losses  = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate  = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const avgWin   = wins.length   > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss  = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const pf       = avgLoss > 0 ? avgWin / avgLoss : 0;
  const roi      = ((finalBalance - startBalance) / startBalance * 100);

  // Max drawdown
  let peak = startBalance, maxDD = 0;
  for (const t of trades) {
    if (t.balanceAfter > peak) peak = t.balanceAfter;
    const dd = (peak - t.balanceAfter) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Per regime breakdown
  const bullTrades = trades.filter(t => t.regimeAtEntry === 'BULL');
  const bearTrades = trades.filter(t => t.regimeAtEntry === 'BEAR');
  const bullWR = bullTrades.length > 0 ? bullTrades.filter(t => t.pnl > 0).length / bullTrades.length * 100 : 0;
  const bearWR = bearTrades.length > 0 ? bearTrades.filter(t => t.pnl > 0).length / bearTrades.length * 100 : 0;
  const bullPnl = bullTrades.reduce((s, t) => s + t.pnl, 0);
  const bearPnl = bearTrades.reduce((s, t) => s + t.pnl, 0);

  // Per coin stats
  const byCoin = new Map<string, { wins: number; losses: number; pnl: number; trades: number }>();
  for (const t of trades) {
    const c = byCoin.get(t.symbol) || { wins: 0, losses: 0, pnl: 0, trades: 0 };
    t.pnl > 0 ? c.wins++ : c.losses++;
    c.pnl += t.pnl;
    c.trades++;
    byCoin.set(t.symbol, c);
  }
  const sortedCoins = Array.from(byCoin.entries()).sort((a, b) => b[1].pnl - a[1].pnl);

  // Exit reason breakdown
  const byReason = new Map<string, number>();
  for (const t of trades) byReason.set(t.exitReason, (byReason.get(t.exitReason) || 0) + 1);

  const pStr = (n: number) => n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
  const rStr = (n: number) => n >= 0 ? `+${n.toFixed(1)}%` : `${n.toFixed(1)}%`;

  const lines = [
    `# Regime-Aware Portfolio Backtest`,
    `**Period:** ${args.startDate} → ${args.endDate}`,
    `**Generated:** ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })} WIB`,
    `**Regime detection:** BTC daily EMA200 (BULL = close > EMA200)`,
    `**Bull mode:** CURATED_COINS_4H (${CURATED_COINS_4H.length} coins) · ${args.bull1d ? '1d' : args.bull2h ? '2h' : args.bull1h ? '1h' : '4h'} candles · EMA Pullback + Liquidity Sweep (v2)`,
    `**Bear mode:** CURATED_COINS_1H (${CURATED_COINS_1H.length} coins) · 1h candles · EMA Pullback (v3, unchanged)`,
    ``,
    `---`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Starting Balance | $${startBalance.toFixed(2)} |`,
    `| Final Balance | $${finalBalance.toFixed(2)} |`,
    `| Total P&L | ${pStr(totalPnl)} |`,
    `| ROI | **${rStr(roi)}** |`,
    `| Total Trades | ${trades.length} |`,
    `| Win Rate | **${winRate.toFixed(1)}%** (${wins.length}W / ${losses.length}L) |`,
    `| Avg Win | $${avgWin.toFixed(2)} |`,
    `| Avg Loss | $${avgLoss.toFixed(2)} |`,
    `| Profit Factor | ${pf.toFixed(2)}x |`,
    `| Max Drawdown | ${maxDD.toFixed(1)}% |`,
    ``,
    `## By Regime`,
    ``,
    `| Regime | Trades | Win Rate | Total P&L |`,
    `|--------|--------|----------|-----------|`,
    `| BULL (4h) | ${bullTrades.length} | ${bullWR.toFixed(1)}% | ${pStr(bullPnl)} |`,
    `| BEAR (1h) | ${bearTrades.length} | ${bearWR.toFixed(1)}% | ${pStr(bearPnl)} |`,
    ``,
    `## Exit Reasons`,
    ``,
    `| Reason | Count |`,
    `|--------|-------|`,
    ...Array.from(byReason.entries()).sort((a, b) => b[1] - a[1]).map(([r, c]) => `| ${r} | ${c} |`),
    ``,
    `## Per-Coin Breakdown`,
    ``,
    `| Coin | Trades | Win Rate | P&L |`,
    `|------|--------|----------|-----|`,
    ...sortedCoins.map(([sym, d]) =>
      `| **${sym}** | ${d.trades} | ${(d.wins / d.trades * 100).toFixed(1)}% | ${pStr(d.pnl)} |`
    ),
    ``,
    `---`,
    ``,
    `## All Trades`,
    ``,
    `| # | Coin | Regime | Dir | Entry | Exit | P&L | Balance | Reason |`,
    `|---|------|--------|-----|-------|------|-----|---------|--------|`,
    ...trades.map((t, i) => {
      const d = new Date(t.openTime).toISOString().slice(0, 10);
      return `| ${i + 1} | ${t.symbol} | ${t.regimeAtEntry} | ${t.side} | $${t.entryPrice.toFixed(4)} | $${t.exitPrice.toFixed(4)} | ${pStr(t.pnl)} | $${t.balanceAfter.toFixed(2)} | ${t.exitReason} |`;
    }),
  ];

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     Regime-Aware Portfolio Backtest (Auto Bull/Bear)      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Period:           ${args.startDate} → ${args.endDate}`);
  console.log(`  Starting balance: $${args.balance}`);
  console.log(`  Max open trades:  ${args.maxOpenTrades}`);
  console.log(`  Confidence:       ${args.confidence}%`);
  console.log(`  Risk per trade:   ${RISK_PCT}% (bear) / ${BULL_RISK_PCT}% (bull)`);
  console.log(`  TP1 mode:         ${args.take75AtTp1 ? 'take 75% at TP1, run 25% to TP2' : CLOSE_AT_TP1 ? 'close 100% at TP1' : 'move SL to entry, run to TP2'}`);
  console.log(`  Regime:           BTC daily EMA200`);
  console.log(`  Bull coins:       ${CURATED_COINS_4H.length} (4h signals)`);
  console.log(`  Bear coins:       ${CURATED_COINS_1H.length} (1h signals)`);
  console.log('');

  const logsDir  = path.resolve(process.cwd(), 'logs');
  const cacheDir = path.resolve(process.cwd(), 'backtest-cache');
  fs.mkdirSync(logsDir,  { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const loader = new DataLoader({ cacheDir });

  // Date range
  const startMs = new Date(args.startDate + 'T00:00:00Z').getTime();
  const endMs   = new Date(args.endDate   + 'T23:59:59Z').getTime();

  // Load BTC daily candles — start 300 days earlier for EMA200 warmup
  const btcDailyStartMs = startMs - 300 * 24 * 60 * 60 * 1000;
  console.log('Loading BTC daily candles for regime detection...');
  const btcDaily = await loader.loadKlinesByRange('BTC', '1d', btcDailyStartMs, endMs, true);
  console.log(`  BTC daily: ${btcDaily.length} candles (${new Date(btcDaily[0].timestamp).toISOString().slice(0,10)} → ${new Date(btcDaily[btcDaily.length-1].timestamp).toISOString().slice(0,10)})\n`);

  // Load 1h candles for all coins — start 250h earlier for signal warmup
  const h1StartMs = startMs - CANDLES_WARMUP * 60 * 60 * 1000;
  console.log(`Loading 1h candles for ${ALL_COINS.length} coins...`);
  const allKlines1h = new Map<string, OHLCV[]>();

  for (let i = 0; i < ALL_COINS.length; i++) {
    const sym = ALL_COINS[i];
    process.stdout.write(`  [${i + 1}/${ALL_COINS.length}] Loading ${sym}...\r`);
    try {
      const klines = await loader.loadKlinesByRange(sym, '1h', h1StartMs, endMs, true);
      if (klines.length >= CANDLES_WARMUP) {
        allKlines1h.set(sym, klines);
      } else {
        console.log(`  Skipping ${sym}: only ${klines.length} candles`);
      }
    } catch (e: any) {
      console.log(`  Skipping ${sym}: ${e.message}`);
    }
  }
  console.log(`\nLoaded 1h data for ${allKlines1h.size} coins.\n`);

  console.log('Running regime-aware backtest...');
  const startedAt = Date.now();
  const { trades, finalBalance, startBalance } = await runRegimeBacktest(allKlines1h, btcDaily, args);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(''); // clear progress line
  const wins    = trades.filter(t => t.pnl > 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const roi     = ((finalBalance - startBalance) / startBalance * 100);

  const bullTrades = trades.filter(t => t.regimeAtEntry === 'BULL');
  const bearTrades = trades.filter(t => t.regimeAtEntry === 'BEAR');

  console.log(`╔══════════════════════════════════════════════════╗`);
  console.log(`║                   RESULTS                         ║`);
  console.log(`╚══════════════════════════════════════════════════╝`);
  console.log(`  Starting balance:  $${startBalance.toFixed(2)}`);
  console.log(`  Final balance:     $${finalBalance.toFixed(2)}`);
  console.log(`  ROI:               ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`);
  console.log(`  Total trades:      ${trades.length} (Bull: ${bullTrades.length}, Bear: ${bearTrades.length})`);
  console.log(`  Win rate:          ${winRate.toFixed(1)}%`);
  console.log(`  Completed in:      ${elapsed}s`);

  const reportPath = args.reportPath || path.join(logsDir, 'regime-backtest.md');
  fs.writeFileSync(reportPath, buildReport(trades, startBalance, finalBalance, args, []));
  console.log(`\n  Report saved to: ${reportPath}\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

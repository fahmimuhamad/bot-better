#!/usr/bin/env ts-node

/**
 * Portfolio Backtest — Multi-Coin, Shared Balance, Concurrent Positions
 *
 * Runs all coins on a single shared timeline:
 *   - One starting balance, compounded across ALL trades
 *   - Up to MAX_OPEN_TRADES open simultaneously across all coins
 *   - BTC, ETH, SOL etc. can all be open at the same time
 *   - Processes candles chronologically — no look-ahead bias
 *
 * Usage:
 *   npx ts-node src/backtest/portfolio-backtest.ts
 *   npx ts-node src/backtest/portfolio-backtest.ts --days 365 --top 30 --balance 163
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

import { DataLoader, OHLCV } from './data-loader';
import { SignalGenerator } from '../signals/generator';
import { CoinMarketData, BinanceTickerData, Trade } from '../types';

// ─── Args ─────────────────────────────────────────────────────────────────────

interface Args {
  days: number;
  top: number;
  timeframe: string;
  balance: number;
  confidence: number;
  maxOpenTrades: number;
  startDate?: string;
  endDate?: string;
  reportPath?: string;
}

// Curated coins — optimized per timeframe
// 4h bull: 13 coins (SAND/CHZ take trade slots from better performers on 4h)
// 1h bear: 15 coins (SAND+CHZ add strong bear signals on 1h)
const CURATED_COINS_4H = [
  'BTC','ETH','BNB','ADA','DOGE','AVAX',
  'ARB','OP','SHIB','SUI','FLOW','HBAR','TON',
  'ZIL','ALICE','CVC','GLM','PEOPLE','OG',
  'QUICK','OXT','DENT','AGLD','GTC',
];
const CURATED_COINS_1H = [
  'BTC','ETH','BNB','ADA','DOGE','AVAX',
  'ARB','OP','SHIB','SUI','FLOW','HBAR','TON',
  'SAND','CHZ','ZIL','ALICE','ID','CVC','GLM','SXP',
  'PEOPLE','STG','DODO','OG','PORTO',
  'QUICK','DENT','IOTX','COTI','FLUX','GTC','MEME','DF','GNS',
];
// Active list — selected based on --timeframe arg or TIMEFRAME env
const CURATED_COINS = (process.env.TIMEFRAME || '1h') === '4h'
  ? CURATED_COINS_4H
  : CURATED_COINS_1H;

// Batch 15 candidates
const BATCH4_CANDIDATES = [
  ...CURATED_COINS,
  'COMBO','KLAY','LOKA','ERN','TRIBE',
  'AKRO','TOMO','TROY','FIRO','STPT',
  'REN','MDX','LEVER','CLV','PROS',
  'ALPHA','WAN','SYN','UMA','GNS',
];

function parseArgs(): Args {
  const args: Args = {
    days: 365,
    top: 30,
    timeframe: process.env.TIMEFRAME || '1h',
    balance: 163,
    confidence: parseInt(process.env.MIN_CONFIDENCE || '65'),
    maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES || '5'),
  };
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i], v = process.argv[i + 1];
    if (k === '--days'        && v) { args.days          = parseInt(v);   i++; }
    if (k === '--top'         && v) { args.top           = parseInt(v);   i++; }
    if (k === '--timeframe'   && v) { args.timeframe     = v;             i++; }
    if (k === '--balance'     && v) { args.balance       = parseFloat(v); i++; }
    if (k === '--confidence'  && v) { args.confidence    = parseInt(v);   i++; }
    if (k === '--max-trades'  && v) { args.maxOpenTrades = parseInt(v);   i++; }
    if (k === '--start-date'  && v) { args.startDate     = v;             i++; }
    if (k === '--end-date'    && v) { args.endDate       = v;             i++; }
    if (k === '--report'      && v) { args.reportPath    = v;             i++; }
    if (k === '--curated')         { (args as any).useCurated = true;         }
    if (k === '--batch4')          { (args as any).useBatch4  = true;         }
  }
  return args;
}

// ─── Coin Fetching ────────────────────────────────────────────────────────────

const STABLE_COINS = new Set([
  'USDT','USDC','BUSD','TUSD','FDUSD','DAI','USDP','USDD','GUSD','FRAX','USDE',
]);
const JUNK_SUFFIXES = ['UP','DOWN','BULL','BEAR','3L','3S','2L','2S','5L','5S'];

function isValidCoin(s: string): boolean {
  if (STABLE_COINS.has(s)) return false;
  if (JUNK_SUFFIXES.some(j => s.endsWith(j))) return false;
  if (s.startsWith('LD')) return false;
  if (s.length > 10) return false;
  return true;
}

async function fetchTopCoins(top: number): Promise<string[]> {
  const resp = await axios.get('https://api.binance.com/api/v3/ticker/24hr', { timeout: 15000 });
  return (resp.data as any[])
    .filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({ base: t.symbol.replace('USDT', ''), vol: parseFloat(t.quoteVolume) }))
    .filter(t => isValidCoin(t.base) && t.vol > 5_000_000)
    .sort((a, b) => b.vol - a.vol)
    .slice(0, top)
    .map(t => t.base);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resample lower-timeframe candles into a higher timeframe.
 * ratio=4: 1h→4h, ratio=6: 4h→daily, etc.
 * Aggregation: open=first, high=max, low=min, close=last, volume=sum.
 */
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

// ─── Portfolio Engine ─────────────────────────────────────────────────────────

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
}

const CANDLES_WARMUP  = 220;   // min candles needed for EMA200
const CANDLES_LOOKBACK = 250;  // candles passed to signal generator
const REENTRY_COOLDOWN = 12;   // candles to wait before re-entering same coin
const SLIPPAGE_PCT     = 0.001;
const FEE_PCT          = 0.001;

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

function calcPositionSize(balance: number, entryPrice: number, stopLoss: number, riskPct: number, leverage: number): number {
  const riskAmount = balance * (riskPct / 100);
  const slPct = Math.abs(entryPrice - stopLoss) / entryPrice;
  if (slPct === 0) return 0;
  const positionValue = riskAmount / slPct;
  const qty = positionValue / entryPrice;
  return Math.floor(qty * 1e8) / 1e8;
}

async function runPortfolioBacktest(coins: string[], allKlines: Map<string, OHLCV[]>, args: Args) {
  const sg = new SignalGenerator();

  const riskPct    = parseFloat(process.env.RISK_PER_TRADE || '3.5');
  const leverage   = parseFloat(process.env.LEVERAGE || '15');
  const closeAtTp1 = process.env.CLOSE_AT_TP1 === 'true';

  let balance   = args.balance;
  const startBalance = args.balance;
  const openPositions = new Map<string, PPosition>(); // posId → position
  const trades: PTrade[] = [];
  const lastExitCandle = new Map<string, number>(); // symbol → candle index of last exit

  // Build merged sorted timestamps
  const tsSet = new Set<number>();
  for (const klines of allKlines.values()) {
    for (const k of klines) tsSet.add(k.timestamp);
  }
  const allTimestamps = Array.from(tsSet).sort((a, b) => a - b);

  // Build lookup: symbol → Map<timestamp, index>
  const tsIndex = new Map<string, Map<number, number>>();
  for (const [sym, klines] of allKlines.entries()) {
    const m = new Map<number, number>();
    klines.forEach((k, i) => m.set(k.timestamp, i));
    tsIndex.set(sym, m);
  }

  // Track last processed candle index per coin (for cooldown)
  const coinCandleCount = new Map<string, number>();
  coins.forEach(s => coinCandleCount.set(s, 0));

  let tradeCount = 0;

  for (const ts of allTimestamps) {
    if (balance <= 0) break;

    // ── Step 1: check exits ──────────────────────────────────────────────────
    for (const [posId, pos] of openPositions.entries()) {
      const idx = tsIndex.get(pos.symbol)?.get(ts);
      if (idx === undefined) continue;
      const candle = allKlines.get(pos.symbol)![idx];

      let exitPrice: number | null = null;
      let exitReason = '';

      if (pos.side === 'LONG') {
        if (candle.high >= pos.tp2)                          { exitPrice = pos.tp2;      exitReason = 'TP2'; }
        else if (candle.high >= pos.tp1 && !pos.tp1Hit) {
          if (closeAtTp1)                                    { exitPrice = pos.tp1;      exitReason = 'TP1'; }
          else                                               { pos.tp1Hit = true; pos.stopLoss = pos.entryPrice; }
        }
        else if (candle.low <= pos.stopLoss)                 { exitPrice = pos.stopLoss; exitReason = 'SL';  }
      } else {
        if (candle.low <= pos.tp2)                           { exitPrice = pos.tp2;      exitReason = 'TP2'; }
        else if (candle.low <= pos.tp1 && !pos.tp1Hit) {
          if (closeAtTp1)                                    { exitPrice = pos.tp1;      exitReason = 'TP1'; }
          else                                               { pos.tp1Hit = true; pos.stopLoss = pos.entryPrice; }
        }
        else if (candle.high >= pos.stopLoss)                { exitPrice = pos.stopLoss; exitReason = 'SL';  }
      }

      if (exitPrice && exitReason) {
        const execExit = pos.side === 'LONG'
          ? exitPrice * (1 - SLIPPAGE_PCT)
          : exitPrice * (1 + SLIPPAGE_PCT);
        const pnl = pos.side === 'LONG'
          ? (execExit - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - execExit) * pos.quantity;
        const fees = (pos.entryPrice + execExit) * pos.quantity * FEE_PCT;
        const netPnl = pnl - fees;
        const balBefore = balance;
        balance += netPnl;

        trades.push({
          ...pos, exitPrice: execExit, exitReason, pnl: netPnl,
          closeTime: ts, balanceBefore: balBefore, balanceAfter: balance,
        });

        openPositions.delete(posId);
        lastExitCandle.set(pos.symbol, coinCandleCount.get(pos.symbol) || 0);
        tradeCount++;
      }
    }

    // ── Step 2: check for new entries ────────────────────────────────────────
    if (openPositions.size >= args.maxOpenTrades || balance <= 0) continue;

    for (const sym of coins) {
      if (openPositions.size >= args.maxOpenTrades) break;

      // Skip if already have a position in this coin
      if (Array.from(openPositions.values()).some(p => p.symbol === sym)) continue;

      const idx = tsIndex.get(sym)?.get(ts);
      if (idx === undefined) continue;

      coinCandleCount.set(sym, idx);

      // Not enough warmup candles yet
      if (idx < CANDLES_WARMUP) continue;

      // Cooldown check
      const lastExit = lastExitCandle.get(sym);
      if (lastExit !== undefined && idx - lastExit < REENTRY_COOLDOWN) continue;

      // Get lookback slice
      const klines = allKlines.get(sym)!;
      const slice  = klines.slice(Math.max(0, idx - CANDLES_LOOKBACK + 1), idx + 1);

      // Build HTF candles (4× resample: 1h→4h, 4h→16h) for trend direction filter
      // Uses ALL candles up to current index so EMA200 on HTF is well-seeded
      const htfCandles = resampleCandles(klines.slice(0, idx + 1), 4);

      // Build market data
      const { coin, ticker } = buildCoinMarketData(sym, klines, idx);

      // Generate signal (HTF filter blocks counter-trend entries)
      const signal = sg.generateSignal(coin, ticker, undefined, slice, htfCandles);
      if (!signal || signal.confidence < args.confidence) continue;

      // Size the position
      const entryPrice = signal.entryPrice * (signal.direction === 'LONG' ? 1 + SLIPPAGE_PCT : 1 - SLIPPAGE_PCT);
      const qty = calcPositionSize(balance, entryPrice, signal.stopLoss, riskPct, leverage);
      if (qty <= 0 || entryPrice * qty < 1) continue;

      const posId = `POS_${tradeCount}_${sym}`;
      openPositions.set(posId, {
        id: posId, symbol: sym, side: signal.direction,
        entryPrice, quantity: qty,
        stopLoss: signal.stopLoss, tp1: signal.tp1, tp2: signal.tp2,
        tp1Hit: false, openTime: ts,
      });
    }
  }

  return { trades, finalBalance: balance, startBalance };
}

// ─── Report ───────────────────────────────────────────────────────────────────

function buildReport(trades: PTrade[], startBalance: number, finalBalance: number, coins: string[], args: Args): string {
  const wins    = trades.filter(t => t.pnl > 0);
  const losses  = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate  = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const avgWin   = wins.length   > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss  = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const pf       = avgLoss > 0 ? avgWin / avgLoss : 0;
  const roi      = ((finalBalance - startBalance) / startBalance * 100);

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

  // Max drawdown
  let peak = startBalance, maxDD = 0;
  for (const t of trades) {
    if (t.balanceAfter > peak) peak = t.balanceAfter;
    const dd = (peak - t.balanceAfter) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Exit reason breakdown
  const byReason = new Map<string, number>();
  for (const t of trades) byReason.set(t.exitReason, (byReason.get(t.exitReason) || 0) + 1);

  const pStr = (n: number) => n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
  const rStr = (n: number) => n >= 0 ? `+${n.toFixed(1)}%` : `${n.toFixed(1)}%`;

  const lines = [
    `# Portfolio Backtest — ${args.days} Days (${args.timeframe} / ADX≥${process.env.ADX_MIN || '32'})`,
    ``,
    `**Generated:** ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })} WIB`,
    `**Coins:** ${coins.length}  |  **Starting balance:** $${startBalance}  |  **Max open trades:** ${args.maxOpenTrades}`,
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
    ...sortedCoins.map(([sym, d]) => `| **${sym}** | ${d.trades} | ${(d.wins / d.trades * 100).toFixed(1)}% | ${pStr(d.pnl)} |`),
    ``,
    `---`,
    ``,
    `## All Trades`,
    ``,
    `| # | Coin | Dir | Entry | Exit | P&L | Balance | Reason |`,
    `|---|------|-----|-------|------|-----|---------|--------|`,
    ...trades.map((t, i) =>
      `| ${i + 1} | ${t.symbol} | ${t.side} | $${t.entryPrice.toFixed(4)} | $${t.exitPrice.toFixed(4)} | ${pStr(t.pnl)} | $${t.balanceAfter.toFixed(2)} | ${t.exitReason} |`
    ),
  ];

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        Portfolio Backtest — Multi-Coin            ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Days:            ${args.days}`);
  console.log(`  Timeframe:       ${args.timeframe}`);
  console.log(`  ADX_MIN:         ${process.env.ADX_MIN || '32'}`);
  console.log(`  Coins:           top ${args.top} by volume (use --curated for curated list)`);
  console.log(`  Starting balance: $${args.balance}`);
  console.log(`  Max open trades:  ${args.maxOpenTrades}`);
  console.log(`  Confidence:       ${args.confidence}%`);
  console.log('');

  const useCurated = (args as any).useCurated === true;
  const useBatch4  = (args as any).useBatch4  === true;
  console.log(`Coins:           ${useBatch4 ? 'batch4 candidates' : useCurated ? 'curated list' : `top ${args.top} by volume`}`);

  console.log('Fetching coin list...');
  const coins = useBatch4 ? BATCH4_CANDIDATES : useCurated ? CURATED_COINS : await fetchTopCoins(args.top);
  console.log(`Selected ${coins.length} coins: ${coins.join(', ')}\n`);

  const logsDir  = path.resolve(process.cwd(), 'logs');
  const cacheDir = path.resolve(process.cwd(), 'backtest-cache');
  fs.mkdirSync(logsDir,  { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const loader = new DataLoader({ cacheDir });
  const allKlines = new Map<string, OHLCV[]>();

  // Load data for all coins
  console.log('Loading OHLCV data...');
  for (let i = 0; i < coins.length; i++) {
    const sym = coins[i];
    process.stdout.write(`  [${i + 1}/${coins.length}] Loading ${sym}...\r`);
    try {
      let klines;
      if (args.startDate || args.endDate) {
        const startMs = args.startDate ? new Date(args.startDate + 'T00:00:00Z').getTime() : Date.now() - args.days * 86400000;
        const endMs   = args.endDate   ? new Date(args.endDate   + 'T23:59:59Z').getTime() : Date.now();
        klines = await loader.loadKlinesByRange(sym, args.timeframe, startMs, endMs, true);
      } else {
        klines = await loader.loadKlines(sym, args.timeframe, args.days, true);
      }
      if (klines.length >= CANDLES_WARMUP) {
        allKlines.set(sym, klines);
      } else {
        console.log(`  Skipping ${sym}: only ${klines.length} candles`);
      }
    } catch (e: any) {
      console.log(`  Skipping ${sym}: ${e.message}`);
    }
  }
  console.log(`\nLoaded data for ${allKlines.size} coins.\n`);

  console.log('Running portfolio backtest...');
  const startedAt = Date.now();
  const { trades, finalBalance, startBalance } = await runPortfolioBacktest(
    Array.from(allKlines.keys()), allKlines, args
  );
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const wins    = trades.filter(t => t.pnl > 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const roi     = ((finalBalance - startBalance) / startBalance * 100);

  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║                   RESULTS                         ║`);
  console.log(`╚══════════════════════════════════════════════════╝`);
  console.log(`  Starting balance:  $${startBalance.toFixed(2)}`);
  console.log(`  Final balance:     $${finalBalance.toFixed(2)}`);
  console.log(`  ROI:               ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`);
  console.log(`  Total trades:      ${trades.length}`);
  console.log(`  Win rate:          ${winRate.toFixed(1)}%`);
  console.log(`  Completed in:      ${elapsed}s`);

  const reportPath = args.reportPath || path.join(logsDir, `portfolio-backtest-${args.days}d-${args.timeframe}.md`);
  fs.writeFileSync(reportPath, buildReport(trades, startBalance, finalBalance, Array.from(allKlines.keys()), args));
  console.log(`\n  Report saved to: ${reportPath}\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

#!/usr/bin/env ts-node

/**
 * Full-Market 365-Day Backtest
 *
 * Fetches all valid USDT pairs from Binance, filters junk,
 * sorts by 24h volume, and runs a 365-day backtest on each.
 * Calls the backtest engine directly (no subprocess) — fast and reliable.
 *
 * Usage:
 *   npx ts-node src/backtest/batch-backtest-all-coins.ts
 *   npx ts-node src/backtest/batch-backtest-all-coins.ts --top 100 --days 365 --timeframe 1h
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

import { DataLoader } from './data-loader';
import { BacktestEngine, BacktestConfig } from './backtest-engine';

// ─── Args ─────────────────────────────────────────────────────────────────────

interface Args {
  days: number;
  top: number;
  timeframe: string;
  balance: number;
  confidence: number;
  startDate?: string;
  endDate?: string;
  reportPath?: string;
}

function parseArgs(): Args {
  const args: Args = {
    days: 365,
    top: 200,
    timeframe: process.env.TIMEFRAME || '1h',
    balance: 10000,
    confidence: 65,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    const val = process.argv[i + 1];
    if (key === '--days'       && val) { args.days       = parseInt(val);   i++; }
    if (key === '--top'        && val) { args.top        = parseInt(val);   i++; }
    if (key === '--timeframe'  && val) { args.timeframe  = val;             i++; }
    if (key === '--balance'    && val) { args.balance    = parseFloat(val); i++; }
    if (key === '--confidence' && val) { args.confidence = parseInt(val);   i++; }
    if (key === '--start-date' && val) { args.startDate  = val;             i++; }
    if (key === '--end-date'   && val) { args.endDate    = val;             i++; }
    if (key === '--report'     && val) { args.reportPath = val;             i++; }
  }
  return args;
}

// ─── Coin Fetching ────────────────────────────────────────────────────────────

const STABLE_COINS = new Set([
  'USDT','USDC','BUSD','TUSD','FDUSD','DAI','USDP','USDD','GUSD','FRAX',
  'USDS','AEUR','BVND','IDRT','UAH','BRL','EUR','GBP','AUD','BIDR','USDE',
]);
const JUNK_SUFFIXES = ['UP','DOWN','BULL','BEAR','3L','3S','2L','2S','5L','5S'];

function isValidCoin(symbol: string): boolean {
  if (STABLE_COINS.has(symbol)) return false;
  if (JUNK_SUFFIXES.some(s => symbol.endsWith(s))) return false;
  if (symbol.startsWith('LD')) return false;
  if (symbol.length > 10) return false;
  return true;
}

async function fetchTopCoinsByVolume(top: number): Promise<string[]> {
  console.log('Fetching coin list from Binance...');
  const resp = await axios.get('https://api.binance.com/api/v3/ticker/24hr', { timeout: 15000 });
  const tickers: { symbol: string; quoteVolume: string }[] = resp.data;

  const coins = tickers
    .filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({ base: t.symbol.replace('USDT', ''), volume: parseFloat(t.quoteVolume) }))
    .filter(t => isValidCoin(t.base) && t.volume > 1_000_000)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, top)
    .map(t => t.base);

  console.log(`Found ${coins.length} valid coins (top ${top} by 24h volume, min $1M/day)\n`);
  return coins;
}

// ─── Backtest Runner ──────────────────────────────────────────────────────────

interface Result {
  symbol: string;
  totalTrades: number;
  wins: number;
  winRate: number;
  totalProfit: number;
  roi: number;
  profitFactor: number;
  maxDrawdown: number;
  status: 'success' | 'error' | 'no-trades';
  error?: string;
}

async function runOne(symbol: string, args: Args, loader: DataLoader): Promise<Result> {
  const base: Result = {
    symbol, totalTrades: 0, wins: 0, winRate: 0,
    totalProfit: 0, roi: 0, profitFactor: 0, maxDrawdown: 0,
    status: 'success',
  };

  try {
    // Load OHLCV data
    let klines;
    if (args.startDate || args.endDate) {
      const startMs = args.startDate ? new Date(args.startDate + 'T00:00:00Z').getTime() : Date.now() - args.days * 86400000;
      const endMs   = args.endDate   ? new Date(args.endDate   + 'T23:59:59Z').getTime() : Date.now();
      klines = await loader.loadKlinesByRange(symbol, args.timeframe, startMs, endMs, true);
    } else {
      klines = await loader.loadKlines(symbol, args.timeframe, args.days, true);
    }

    if (!klines || klines.length < 220) {
      base.status = 'error';
      base.error  = `Not enough candles (${klines?.length ?? 0})`;
      return base;
    }

    // Build backtest config from .env (same as run-backtest.ts)
    const config: BacktestConfig = {
      symbol,
      interval: args.timeframe,
      startBalance: args.balance,
      leverage: process.env.LEVERAGE ? parseFloat(process.env.LEVERAGE) : 15,
      riskPerTrade: process.env.RISK_PER_TRADE ? parseFloat(process.env.RISK_PER_TRADE) : 3.5,
      slippage: 0.1,
      fees: 0.1,
      minConfidence: args.confidence,
      maxOpenTrades: process.env.MAX_OPEN_TRADES ? parseInt(process.env.MAX_OPEN_TRADES) : 5,
      dailyLossLimit: process.env.DAILY_LOSS_LIMIT ? parseFloat(process.env.DAILY_LOSS_LIMIT) : 5,
      entryMode: (process.env.ENTRY_MODE as 'aggressive' | 'conservative') || 'aggressive',
      closeAtTp1: process.env.CLOSE_AT_TP1 === 'true',
      takeHalfAtTp1MoveSlToEntry: process.env.TAKE_50_AT_TP1_MOVE_SL === 'true',
      trailingStop: process.env.TRAILING_STOP === 'true',
      quoteCurrency: 'USDT',
      slDistancePct: parseFloat(process.env.SL_ATR_MIN_PCT || '1.5'),
      tp1Percent: parseFloat(process.env.TP1_PERCENT || '2'),
      tp2Percent: parseFloat(process.env.TP2_PERCENT || '5'),
      refreshCycle: 1,
      useTestnet: false,
      dryRun: false,
      paperTrading: true,
    };

    const engine = new BacktestEngine(config);
    const stats  = await engine.run(klines);

    base.totalTrades  = stats.totalTrades;
    base.winRate      = stats.winRate;
    base.totalProfit  = stats.totalPnl;
    base.profitFactor = stats.profitFactor;
    base.maxDrawdown  = stats.maxDrawdown;
    base.roi          = (stats.totalPnl / args.balance) * 100;
    base.wins         = stats.winningTrades;

    if (base.totalTrades === 0) base.status = 'no-trades';

  } catch (err: any) {
    base.status = 'error';
    base.error  = err.message || String(err);
  }

  return base;
}

// ─── Report ───────────────────────────────────────────────────────────────────

function buildReport(results: Result[], args: Args, coins: string[]): string {
  const ok      = results.filter(r => r.status === 'success');
  const noTrade = results.filter(r => r.status === 'no-trades');
  const failed  = results.filter(r => r.status === 'error');

  const totalTrades = ok.reduce((s, r) => s + r.totalTrades, 0);
  const totalWins   = ok.reduce((s, r) => s + r.wins, 0);
  const totalPnl    = ok.reduce((s, r) => s + r.totalProfit, 0);
  const overallWR   = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
  const profitable  = ok.filter(r => r.totalProfit > 0).length;
  const avgROI      = ok.length > 0 ? ok.reduce((s, r) => s + r.roi, 0) / ok.length : 0;

  const sorted  = [...ok].sort((a, b) => b.totalProfit - a.totalProfit);
  const top10   = sorted.slice(0, 10);
  const worst10 = sorted.slice(-10).reverse();

  const pnlStr = (n: number) => n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
  const roiStr = (n: number) => n >= 0 ? `+${n.toFixed(1)}%` : `${n.toFixed(1)}%`;

  const lines: string[] = [
    `# Full Market Backtest — ${args.days} Days (${args.timeframe} / ADX≥${process.env.ADX_MIN || '32'})`,
    ``,
    `**Generated:** ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })} WIB`,
    `**Coins tested:** ${coins.length}  |  **Balance per coin:** $${args.balance.toLocaleString()}`,
    ``,
    `---`,
    ``,
    `## Overall Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Coins with signals | ${ok.length} / ${coins.length} |`,
    `| Profitable coins | ${profitable} / ${ok.length} (${ok.length > 0 ? (profitable / ok.length * 100).toFixed(1) : 0}%) |`,
    `| No trades generated | ${noTrade.length} |`,
    `| Failed / no data | ${failed.length} |`,
    `| Total trades | ${totalTrades} |`,
    `| Overall win rate | ${overallWR.toFixed(1)}% |`,
    `| Total P&L (all coins) | ${pnlStr(totalPnl)} |`,
    `| Avg ROI per coin | ${roiStr(avgROI)} |`,
    ``,
    `---`,
    ``,
    `## All Coins — Ranked by P&L`,
    ``,
    `| # | Coin | Trades | Win Rate | P&L | ROI | Profit Factor | Max DD |`,
    `|---|------|--------|----------|-----|-----|---------------|--------|`,
    ...sorted.map((r, i) =>
      `| ${i + 1} | **${r.symbol}** | ${r.totalTrades} | ${r.winRate.toFixed(1)}% | ${pnlStr(r.totalProfit)} | ${roiStr(r.roi)} | ${r.profitFactor.toFixed(2)}x | ${r.maxDrawdown.toFixed(1)}% |`
    ),
    ``,
    `---`,
    ``,
    `## Top 10 Best Performers`,
    ``,
    `| Coin | Trades | Win Rate | P&L | ROI |`,
    `|------|--------|----------|-----|-----|`,
    ...top10.map(r => `| **${r.symbol}** | ${r.totalTrades} | ${r.winRate.toFixed(1)}% | ${pnlStr(r.totalProfit)} | ${roiStr(r.roi)} |`),
    ``,
    `## Top 10 Worst Performers`,
    ``,
    `| Coin | Trades | Win Rate | P&L | ROI |`,
    `|------|--------|----------|-----|-----|`,
    ...worst10.map(r => `| **${r.symbol}** | ${r.totalTrades} | ${r.winRate.toFixed(1)}% | ${pnlStr(r.totalProfit)} | ${roiStr(r.roi)} |`),
    ``,
    `---`,
    ``,
    `## Coins With No Trades (${noTrade.length})`,
    noTrade.length > 0 ? noTrade.map(r => r.symbol).join(', ') : '_None_',
    ``,
    `## Failed / No Data (${failed.length})`,
    failed.length > 0 ? failed.map(r => `${r.symbol} (${r.error})`).join(', ') : '_None_',
  ];

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       Full Market Backtest — All Coins            ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Days:       ${args.days}`);
  console.log(`  Timeframe:  ${args.timeframe}`);
  console.log(`  ADX_MIN:    ${process.env.ADX_MIN || '32'}`);
  console.log(`  Top coins:  ${args.top} (by 24h volume, min $1M/day)`);
  console.log(`  Balance:    $${args.balance.toLocaleString()} per coin`);
  console.log(`  Confidence: ${args.confidence}%`);
  console.log('');

  const coins = await fetchTopCoinsByVolume(args.top);

  const logsDir    = path.resolve(process.cwd(), 'logs');
  const cacheDir   = path.resolve(process.cwd(), 'backtest-cache');
  fs.mkdirSync(logsDir,  { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const loader = new DataLoader({ cacheDir });

  const estMin = Math.round(coins.length * 0.3);
  console.log(`Running ${coins.length} coins — estimated time: ${estMin}-${estMin * 2} minutes\n`);

  const results: Result[] = [];
  const startedAt = Date.now();
  let runningBalance = args.balance;

  for (let i = 0; i < coins.length; i++) {
    const coin       = coins[i];
    const elapsed    = ((Date.now() - startedAt) / 60000).toFixed(1);
    const avgPerCoin = i > 0 ? (Date.now() - startedAt) / i / 60000 : 0.3;
    const remaining  = ((coins.length - i) * avgPerCoin).toFixed(0);

    process.stdout.write(`[${i + 1}/${coins.length}] ${coin.padEnd(8)} | balance $${runningBalance.toFixed(2)} | elapsed ${elapsed}m | ~${remaining}m left\r`);

    const result = await runOne(coin, { ...args, balance: runningBalance }, loader);
    if (result.status === 'success') runningBalance += result.totalProfit;
    if (runningBalance <= 0) { console.log('\n💀 Balance wiped out. Stopping.'); break; }
    results.push(result);

    const summary = result.status === 'success'
      ? `P&L ${result.totalProfit >= 0 ? '+' : ''}$${result.totalProfit.toFixed(2)} | WR ${result.winRate.toFixed(1)}% | ${result.totalTrades} trades`
      : result.status === 'no-trades' ? 'no trades'
      : `error: ${result.error}`;

    console.log(`[${i + 1}/${coins.length}] ${coin.padEnd(8)} — ${summary}`);
  }

  console.log('\nGenerating report...');

  const report     = buildReport(results, args, coins);
  const reportPath = args.reportPath || path.join(logsDir, `full-market-backtest-${args.days}d-${args.timeframe}.md`);
  fs.writeFileSync(reportPath, report, 'utf-8');

  const ok        = results.filter(r => r.status === 'success');
  const totalPnl  = ok.reduce((s, r) => s + r.totalProfit, 0);
  const profitable = ok.filter(r => r.totalProfit > 0).length;
  const totalTrades = ok.reduce((s, r) => s + r.totalTrades, 0);
  const totalWins   = ok.reduce((s, r) => s + r.wins, 0);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║                    RESULTS                        ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Starting balance:   $${args.balance.toFixed(2)}`);
  console.log(`  Final balance:      $${runningBalance.toFixed(2)}`);
  console.log(`  Total P&L:          ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
  console.log(`  Overall ROI:        ${((runningBalance - args.balance) / args.balance * 100).toFixed(1)}%`);
  console.log(`  Coins with trades:  ${ok.length} / ${coins.length}`);
  console.log(`  Profitable coins:   ${profitable} / ${ok.length}`);
  console.log(`  Total trades:       ${totalTrades}`);
  console.log(`  Overall win rate:   ${totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : 0}%`);
  console.log(`\n  Report saved to: ${reportPath}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

#!/usr/bin/env ts-node

/**
 * Backtest CLI Runner
 * Usage: ts-node run-backtest.ts --symbol BTC --days 30 --timeframe 1h
 * Loads .env so SL_ATR_*, CLOSE_AT_TP1, etc. apply during backtest.
 */

import * as fs from 'fs';
import dotenv from 'dotenv';
import logger from '../utils/logger';

dotenv.config();
import { DataLoader } from './data-loader';
import { BacktestEngine, BacktestConfig } from './backtest-engine';
import BacktestReporter from './backtest-report';

interface CLIArgs {
  symbol: string;
  days: number;
  startDate?: string; // e.g. "2024-12-01"
  endDate?: string;   // e.g. "2024-12-31"
  timeframe: string;
  leverage: number;
  risk: number;
  slippage: number;
  fees: number;
  startBalance: number;
  minConfidence: number;
  maxOpenTrades: number;
  dailyLossLimit: number;
  jsonOutput?: string;
  jsonOnly: boolean; // when true, only write JSON (no per-coin .md) - used by batch
  clearCache: boolean;
  noCache: boolean;
}

/**
 * Parse command line arguments
 */
function parseArgs(): CLIArgs {
  // Default from .env so backtest uses same config as live when not overridden by CLI
  const args: any = {
    symbol: 'BTC',
    days: 30,
    startDate: undefined,
    endDate: undefined,
    timeframe: '1h',
    leverage: process.env.LEVERAGE ? parseFloat(process.env.LEVERAGE) : 5,
    risk: process.env.RISK_PER_TRADE ? parseFloat(process.env.RISK_PER_TRADE) : 2,
    slippage: 0.1,
    fees: 0.1,
    startBalance: process.env.INITIAL_CAPITAL ? parseFloat(process.env.INITIAL_CAPITAL) : (process.env.BALANCE ? parseFloat(process.env.BALANCE) : 150),
    minConfidence: process.env.MIN_CONFIDENCE ? parseFloat(process.env.MIN_CONFIDENCE) : 60,
    maxOpenTrades: process.env.MAX_OPEN_TRADES ? parseFloat(process.env.MAX_OPEN_TRADES) : 5,
    dailyLossLimit: process.env.DAILY_LOSS_LIMIT ? parseFloat(process.env.DAILY_LOSS_LIMIT) : 5,
    jsonOnly: false,
    clearCache: false,
    noCache: false,
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    if (arg.startsWith('--')) {
      const key = arg.substring(2);
      const value = process.argv[i + 1];

      switch (key) {
        case 'symbol':
          args.symbol = value;
          i++;
          break;
        case 'days':
          args.days = parseInt(value, 10);
          i++;
          break;
        case 'start-date':
          args.startDate = value;
          i++;
          break;
        case 'end-date':
          args.endDate = value;
          i++;
          break;
        case 'timeframe':
          args.timeframe = value;
          i++;
          break;
        case 'leverage':
          args.leverage = parseInt(value, 10);
          i++;
          break;
        case 'risk':
          args.risk = parseFloat(value);
          i++;
          break;
        case 'slippage':
          args.slippage = parseFloat(value);
          i++;
          break;
        case 'fees':
          args.fees = parseFloat(value);
          i++;
          break;
        case 'balance':
          args.startBalance = parseFloat(value);
          i++;
          break;
        case 'confidence':
          args.minConfidence = parseFloat(value);
          i++;
          break;
        case 'max-trades':
          args.maxOpenTrades = parseInt(value, 10);
          i++;
          break;
        case 'daily-loss':
          args.dailyLossLimit = parseFloat(value);
          i++;
          break;
        case 'json':
          args.jsonOutput = value;
          i++;
          break;
        case 'no-md':
        case 'jsonOnly':
          args.jsonOnly = true;
          break;
        case 'clear-cache':
          args.clearCache = true;
          break;
        case 'no-cache':
          args.noCache = true;
          break;
        case 'help':
          printHelp();
          process.exit(0);
      }
    }
  }

  return args;
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
Backtest CLI Runner

Usage:
  npm run backtest -- [options]

Options:
  --symbol SYMBOL          Trading symbol (default: BTC)
  --days DAYS              Number of days to backtest (default: 30)
  --timeframe TIMEFRAME    Candle timeframe (1h, 4h, 1d; default: 1h)
  --leverage LEVERAGE      Trading leverage (default: 5)
  --risk RISK              Risk per trade in % (default: 2)
  --slippage SLIPPAGE      Entry/exit slippage in % (default: 0.1)
  --fees FEES              Trading fees in % (default: 0.1)
  --balance BALANCE        Starting balance in USDT (default: 10000)
  --confidence CONF        Minimum signal confidence (default: 50)
  --max-trades MAX         Max open trades (default: 5)
  --daily-loss LIMIT       Daily loss limit in % (default: 3)
  --json FILEPATH          Export results to JSON file
  --clear-cache            Clear cached data before running
  --no-cache               Don't use cached data
  --help                   Show this help message

Examples:
  # Default backtest for BTC
  npm run backtest

  # 7 days of ETH with 10x leverage
  npm run backtest -- --symbol ETH --days 7 --leverage 10

  # Conservative test with low risk
  npm run backtest -- --symbol BTC --risk 1 --slippage 0.05

  # Export results to JSON
  npm run backtest -- --symbol SOL --json results.json

  # Multi-symbol (run multiple times)
  npm run backtest -- --symbol BTC
  npm run backtest -- --symbol ETH
  npm run backtest -- --symbol SOL
  `);
}

/**
 * Main function
 */
async function main(): Promise<void> {
  try {
    const args = parseArgs();

    console.log('╔════════════════════════════════════════════╗');
    console.log('║     Trading Bot Backtest Engine v1.0        ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log(`\nConfiguration:`);
    console.log(`  Symbol:            ${args.symbol}`);
    console.log(`  Timeframe:         ${args.timeframe}`);
    console.log(`  Days:              ${args.days}`);
    console.log(`  Leverage:          ${args.leverage}x`);
    console.log(`  Risk per trade:    ${args.risk}%`);
    console.log(`  Starting balance:  $${args.startBalance.toFixed(2)} USDT`);
    console.log(`  Min confidence:    ${args.minConfidence}%`);
    console.log(`  Max open trades:   ${args.maxOpenTrades}`);
    console.log(`  Daily loss limit:  ${args.dailyLossLimit}%`);

    // Initialize data loader
    const loader = new DataLoader({
      cacheDir: './backtest-cache',
    });

    // Clear cache if requested
    if (args.clearCache) {
      console.log('\nClearing cache...');
      loader.clearCache(args.symbol);
    }

    // Load historical data
    let klines;
    if (args.startDate || args.endDate) {
      const startMs = args.startDate ? new Date(args.startDate + 'T00:00:00Z').getTime() : Date.now() - args.days * 86400000;
      const endMs   = args.endDate   ? new Date(args.endDate   + 'T23:59:59Z').getTime() : Date.now();
      console.log(`\nLoading ${args.symbol} ${args.timeframe} data from ${args.startDate || 'default'} to ${args.endDate || 'now'}...`);
      klines = await loader.loadKlinesByRange(args.symbol, args.timeframe, startMs, endMs, !args.noCache);
    } else {
      console.log(`\nLoading ${args.symbol} ${args.timeframe} data (last ${args.days} days)...`);
      klines = await loader.loadKlines(args.symbol, args.timeframe, args.days, !args.noCache);
    }

    console.log(`Loaded ${klines.length} candles\n`);

    // Create backtest config (env used so .env improvements apply to backtest)
    const backtestConfig: BacktestConfig = {
      symbol: args.symbol,
      interval: args.timeframe,
      startBalance: args.startBalance,
      leverage: args.leverage,
      riskPerTrade: args.risk,
      slippage: args.slippage,
      fees: args.fees,
      minConfidence: args.minConfidence,
      maxOpenTrades: args.maxOpenTrades,
      dailyLossLimit: args.dailyLossLimit,
      entryMode: (process.env.ENTRY_MODE as 'aggressive' | 'conservative') || 'conservative',
      closeAtTp1: process.env.CLOSE_AT_TP1 === 'true',
      takeHalfAtTp1MoveSlToEntry: process.env.TAKE_50_AT_TP1_MOVE_SL === 'true',
      trailingStop: process.env.TRAILING_STOP === 'true',
      quoteCurrency: 'USDT',
      slDistancePct: parseFloat(process.env.SL_ATR_MIN_PCT || process.env.SL_DISTANCE_PCT || '2'),
      tp1Percent: parseFloat(process.env.TP1_PERCENT || '2'),
      tp2Percent: parseFloat(process.env.TP2_PERCENT || '4'),
      refreshCycle: 1,
      useTestnet: false,
      dryRun: false,
      paperTrading: true,
    };

    // Run backtest
    console.log('Running backtest...\n');
    const engine = new BacktestEngine(backtestConfig);
    const stats = await engine.run(klines);

    // Generate report
    BacktestReporter.generateReport(
      stats,
      engine.getTrades(),
      args.symbol,
      args.days,
      args.timeframe,
      args.jsonOutput,
      args.startBalance
    );

    // Export trade-by-trade markdown report when JSON output is set (unless --no-md for batch)
    if (args.jsonOutput && !args.jsonOnly && engine.getTrades().length > 0) {
      const mdPath = args.jsonOutput.replace(/\.json$/i, '.md');
      BacktestReporter.exportToMarkdown(
        engine.getTrades(),
        args.symbol,
        args.days,
        args.timeframe,
        args.startBalance,
        mdPath
      );
    }

    // Print summary for quick reference
    console.log('\n✅ Backtest completed successfully!');
    if (args.jsonOutput) {
      console.log(`📊 Results saved to: ${args.jsonOutput}`);
    }
  } catch (error) {
    console.error('\n❌ Backtest failed:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run main
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

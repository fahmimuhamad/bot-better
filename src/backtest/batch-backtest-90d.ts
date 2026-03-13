#!/usr/bin/env ts-node

/**
 * Batch Backtest Runner for N Random Coins over D Days
 * Usage: ts-node batch-backtest-90d.ts [--days 30] [--count 10]
 * Default: 90 days, 20 coins
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import logger from '../utils/logger';

// Curated production coin pool — top liquid coins with 50%+ WR in EMA-pullback backtests
const AVAILABLE_COINS = [
  'BTC', 'ETH', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'MATIC',
  'ARB', 'OP', 'SHIB', 'SUI', 'RENDER', 'FLOW', 'HBAR',
];

function parseBatchArgs(): { days: number; count: number; confidence: number; balance: number; seed?: number; reportPath?: string; summaryJsonPath?: string; startDate?: string; endDate?: string } {
  let days = 90;
  let count = 20;
  let confidence = 50;
  let balance = 10000;
  let seed: number | undefined;
  let reportPath: string | undefined;
  let summaryJsonPath: string | undefined;
  let startDate: string | undefined;
  let endDate: string | undefined;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--days' && process.argv[i + 1]) {
      days = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === '--count' && process.argv[i + 1]) {
      count = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === '--confidence' && process.argv[i + 1]) {
      confidence = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === '--balance' && process.argv[i + 1]) {
      balance = parseFloat(process.argv[i + 1]);
      i++;
    } else if (process.argv[i] === '--seed' && process.argv[i + 1]) {
      seed = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === '--report' && process.argv[i + 1]) {
      reportPath = process.argv[i + 1];
      i++;
    } else if (process.argv[i] === '--summary-json' && process.argv[i + 1]) {
      summaryJsonPath = process.argv[i + 1];
      i++;
    } else if (process.argv[i] === '--start-date' && process.argv[i + 1]) {
      startDate = process.argv[i + 1];
      i++;
    } else if (process.argv[i] === '--end-date' && process.argv[i + 1]) {
      endDate = process.argv[i + 1];
      i++;
    }
  }
  return { days, count, confidence, balance, seed, reportPath, summaryJsonPath, startDate, endDate };
}

interface BacktestResult {
  symbol: string;
  days: number;
  totalTrades: number;
  winRate: number;
  totalProfit: number;
  profitFactor: number;
  maxDrawdown: number;
  sharpeRatio: number;
  status: 'success' | 'error';
  error?: string;
  jsonOutputPath?: string;
}

/** Seeded random for reproducible coin selection */
function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/**
 * Select N coins from available coins. With seed, same seed = same coins.
 */
function selectRandomCoins(count: number = 20, seed?: number): string[] {
  const random = seed !== undefined ? seededRandom(seed) : Math.random;
  const shuffled = [...AVAILABLE_COINS].sort(() => random() - 0.5);
  return shuffled.slice(0, Math.min(count, AVAILABLE_COINS.length));
}

/**
 * Run backtest for a single coin
 */
async function runSingleBacktest(
  symbol: string,
  days: number = 90,
  confidence: number = 50,
  startBalance: number = 10000,
  startDate?: string,
  endDate?: string
): Promise<BacktestResult> {
  const result: BacktestResult = {
    symbol,
    days,
    totalTrades: 0,
    winRate: 0,
    totalProfit: 0,
    profitFactor: 0,
    maxDrawdown: 0,
    sharpeRatio: 0,
    status: 'success'
  };

  try {
    logger.info(`Starting backtest for ${symbol} (${days} days)...`);
    
    const logsDir = path.join(__dirname, '../../logs');
    const tempDir = path.join(logsDir, '.batch-temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const timestamp = Date.now();
    const jsonOutput = path.join(tempDir, `backtest-${symbol}-${days}d-${timestamp}.json`);
    
    // Run the backtest command (--no-md: only JSON, no per-coin .md file)
    const confidenceArg = confidence !== 50 ? ` --confidence ${confidence}` : '';
    const balanceArg = ` --balance ${startBalance}`;
    const dateArg = startDate ? ` --start-date ${startDate}` : '';
    const dateEndArg = endDate ? ` --end-date ${endDate}` : '';
    const command = `cd ${path.join(__dirname, '..')} && npm run backtest -- --symbol ${symbol} --days ${days} --timeframe 1h --json ${jsonOutput} --no-md${balanceArg}${confidenceArg}${dateArg}${dateEndArg}`;
    
    logger.info(`Executing backtest for ${symbol}...`);
    try {
      const output = execSync(command, { 
        encoding: 'utf-8',
        stdio: 'pipe',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 120000 // 2 minute timeout per coin
      });
    } catch (execError: any) {
      // Don't fail entirely - log the error but try to read any output
      if (execError.message.includes('No data found')) {
        result.status = 'error';
        result.error = 'No data found for symbol';
        logger.warn(`No data for ${symbol}`);
        return result;
      }
      // Continue anyway - JSON might still have been created
    }

    // Try to read the JSON output if it exists
    if (fs.existsSync(jsonOutput)) {
      result.jsonOutputPath = jsonOutput;
      try {
        const fileData = fs.readFileSync(jsonOutput, 'utf-8');
        const data = JSON.parse(fileData);
        
        if (data.statistics) {
          // JSON format from BacktestReporter.exportToJson
          result.totalTrades = data.statistics.totalTrades || 0;
          result.winRate = data.statistics.winRate || 0;
          result.totalProfit = data.statistics.totalPnl || 0;
          result.profitFactor = data.statistics.profitFactor || 0;
          result.maxDrawdown = data.statistics.maxDrawdown || 0;
          result.sharpeRatio = data.statistics.sharpeRatio || 0;
        }
        
        logger.debug(`Parsed results for ${symbol}: ${result.totalTrades} trades, ${result.winRate}% win rate, $${result.totalProfit.toFixed(2)} P&L`);
      } catch (parseError) {
        logger.warn(`Could not parse JSON output for ${symbol}: ${parseError}`);
      }
    } else {
      logger.warn(`No JSON output file created for ${symbol} at ${jsonOutput}`);
    }

  } catch (error: any) {
    result.status = 'error';
    result.error = error.message || String(error);
    logger.error(`Backtest for ${symbol} failed: ${result.error}`);
  }

  return result;
}

/**
 * Generate one combined Markdown report: summary (SL/TP counts, win rate) + single table of all trades
 */
function generateCombinedMarkdownReport(
  results: BacktestResult[],
  days: number,
  count: number,
  logsDir: string,
  initialBalance: number = 10000,
  customReportPath?: string
): { reportPath: string; summary: { totalTrades: number; wins: number; winRate: number; totalPnl: number; slCount: number; tp1Count: number; tp2Count: number } } {
  const withJson = results.filter(r => r.status === 'success' && r.jsonOutputPath && fs.existsSync(r.jsonOutputPath!));
  const emptySummary = { totalTrades: 0, wins: 0, winRate: 0, totalPnl: 0, slCount: 0, tp1Count: 0, tp2Count: 0 };
  if (withJson.length === 0) {
    const rp = customReportPath || path.join(logsDir, 'batch-backtest-report.md');
    return { reportPath: rp, summary: emptySummary };
  }

  const reportPath = customReportPath || path.join(logsDir, 'batch-backtest-report.md');

  // Collect all closed trades and compute summary stats
  const allTrades: any[] = [];
  let slCount = 0;
  let tp1Count = 0;
  let tp2Count = 0;
  let trailingCount = 0;
  let manualCount = 0;

  for (const res of withJson) {
    try {
      const data = JSON.parse(fs.readFileSync(res.jsonOutputPath!, 'utf-8'));
      const trades = (data.trades || []).filter((t: any) => t.status === 'CLOSED');
      for (const t of trades) {
        allTrades.push(t);
        const reason = (t.exitReason || '').toUpperCase();
        if (reason === 'SL') slCount++;
        else if (reason === 'TP1') tp1Count++;
        else if (reason === 'TP2') tp2Count++;
        else if (reason === 'TRAILING_STOP') trailingCount++;
        else if (reason === 'MANUAL') manualCount++;
      }
    } catch (e) {
      logger.warn(`Could not read trades for ${res.symbol}: ${e}`);
    }
  }

  const totalTrades = allTrades.length;
  const tpCount = tp1Count + tp2Count;
  const wins = allTrades.filter((t: any) => (t.pnl ?? 0) > 0).length;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const totalPnl = allTrades.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0);

  const lines: string[] = [
    `# Batch Backtest Report: ${days} Days, ${count} Coins`,
    '',
    `**Generated:** ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total trades | ${totalTrades} |`,
    `| SL taken | ${slCount} |`,
    `| TP1 taken | ${tp1Count} |`,
    `| TP2 taken | ${tp2Count} |`,
    `| TP taken (total) | ${tpCount} |`,
    `| Trailing stop | ${trailingCount} |`,
    `| Manual exit | ${manualCount} |`,
    `| Wins | ${wins} |`,
    `| Win rate | ${winRate.toFixed(1)}% |`,
    `| Total P&L | ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} |`,
    '',
    '---',
    '',
    '--- Detail of each trade ---',
    '',
    '| # | Coin | Dir | Entry | Exit | Size($) | Lever | BalBefore | BalAfter | P&L | Exit |',
    '|---|------|-----|-------|------|--------|-------|------------|----------|-----|------|'
  ];

  // Single combined table: use running balance from initial balance
  let runningBalance = initialBalance;
  allTrades.forEach((t: any, idx: number) => {
    const balBefore = runningBalance;
    const pnl = t.pnl ?? 0;
    runningBalance += pnl;
    const sizeUsd = (t.entryPrice || 0) * (t.quantity || 0);
    const entryStr = (t.entryPrice || 0).toFixed(4);
    const exitStr = (t.exitPrice ?? 0).toFixed(4);
    const pnlSign = pnl >= 0 ? '+' : '';
    lines.push(
      `| ${idx + 1} | ${t.symbol} | ${t.side} | ${entryStr} | ${exitStr} | ${sizeUsd.toFixed(2)} | ${t.leverage}x | ${balBefore.toFixed(2)} | ${runningBalance.toFixed(2)} | ${pnlSign}${pnl.toFixed(2)} | ${t.exitReason ?? '-'} |`
    );
  });

  lines.push('');
  lines.push(`---`);
  lines.push(`**Total trades:** ${totalTrades} | **Win rate:** ${winRate.toFixed(1)}% | **Total P&L:** ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
  lines.push('');

  const md = lines.join('\n');
  fs.writeFileSync(reportPath, md);
  logger.info(`Report saved to: ${reportPath}`);
  const summary = { totalTrades, wins, winRate, totalPnl, slCount, tp1Count, tp2Count };
  return { reportPath, summary };
}

/**
 * Remove temp per-coin backtest data (.batch-temp)
 */
function cleanupBatchTemp(logsDir: string): void {
  const tempDir = path.join(logsDir, '.batch-temp');
  if (!fs.existsSync(tempDir)) return;
  try {
    const entries = fs.readdirSync(tempDir, { withFileTypes: true });
    for (const e of entries) {
      fs.rmSync(path.join(tempDir, e.name), { recursive: true, force: true });
    }
    fs.rmdirSync(tempDir);
    logger.info('Cleaned up batch temp data (.batch-temp)');
  } catch (e) {
    logger.warn(`Could not remove .batch-temp: ${e}`);
  }
}

/**
 * Generate summary report
 */
function generateSummaryReport(
  results: BacktestResult[],
  initialBalance: number = 100,
  days: number = 90,
  totalCoins: number = 20
): string {
  const successResults = results.filter(r => r.status === 'success');
  const failedResults = results.filter(r => r.status === 'error');

  const totalProfit = successResults.reduce((sum, r) => sum + r.totalProfit, 0);
  const totalTrades = successResults.reduce((sum, r) => sum + r.totalTrades, 0);
  const positiveResults = successResults.filter(r => r.totalProfit > 0).length;
  const avgProfit = totalProfit / Math.max(successResults.length, 1);
  const avgWinRate = successResults.reduce((sum, r) => sum + r.winRate, 0) / Math.max(successResults.length, 1);
  const totalWinRate = totalTrades > 0 ? (successResults.reduce((sum, r) => sum + (r.totalTrades * r.winRate / 100), 0) / totalTrades * 100) : 0;
  
  const finalBalance = initialBalance + totalProfit;
  const roi = (totalProfit / initialBalance * 100);
  const returnPerTrade = totalTrades > 0 ? (totalProfit / totalTrades) : 0;

  let report = `
╔═════════════════════════════════════════════════════════════════════════════╗
║              ${days}-Day Batch Backtest Results (Initial: $${initialBalance})                   ║
║                         ${totalCoins} Random Coins                                     ║
╚═════════════════════════════════════════════════════════════════════════════╝

💰 FINANCIAL SUMMARY:
  • Initial Balance:        $${initialBalance.toFixed(2)}
  • Total P&L:              $${totalProfit.toFixed(2)}
  • Final Balance:          $${finalBalance.toFixed(2)}
  • ROI:                    ${roi.toFixed(2)}%
  • Return per Trade:       $${returnPerTrade.toFixed(4)}

📊 TRADING STATISTICS:
  • Successful Backtests:   ${successResults.length}/${totalCoins}
  • Failed Backtests:       ${failedResults.length}/${totalCoins}
  • Total Trades:           ${totalTrades}
  • Overall Win Rate:       ${totalWinRate.toFixed(2)}%
  • Profitable Coins:       ${positiveResults}/${successResults.length} (${(positiveResults / successResults.length * 100).toFixed(1)}%)
  • Avg Profit per Coin:    $${avgProfit.toFixed(2)}
  • Avg Win Rate:           ${avgWinRate.toFixed(2)}%

📈 DETAILED RESULTS (by Profit):
${successResults.sort((a, b) => b.totalProfit - a.totalProfit).map(r => {
  const profitIcon = r.totalProfit > 0 ? '📈' : r.totalProfit < 0 ? '📉' : '➖';
  const profitSign = r.totalProfit >= 0 ? '+' : '';
  const roi = (r.totalProfit / initialBalance * 100).toFixed(1);
  return `  ${profitIcon} ${r.symbol.padEnd(6)} | P&L: ${(profitSign + r.totalProfit.toFixed(2)).padStart(10)} | ROI: ${(profitSign + roi).padStart(6)}% | Win: ${r.winRate.toFixed(1).padStart(5)}% | Trades: ${r.totalTrades}`;
}).join('\n')}

${failedResults.length > 0 ? `\n❌ FAILED BACKTESTS (${failedResults.length}):\n${failedResults.map(r => `  • ${r.symbol}: ${r.error}`).join('\n')}` : ''}

═════════════════════════════════════════════════════════════════════════════

Generated: ${new Date().toISOString()}
`;

  return report;
}

/**
 * Main execution
 */
async function main() {
  try {
    const { days, count, confidence, balance, seed, reportPath, summaryJsonPath, startDate, endDate } = parseBatchArgs();
    const dateLabel = startDate ? ` | ${startDate} → ${endDate || 'now'}` : ``;
    logger.info('═'.repeat(60));
    logger.info(`Starting Batch Backtest for ${count} Coins | $${balance} initial balance${dateLabel}${confidence !== 50 ? ` | min confidence ${confidence}%` : ''}${seed !== undefined ? ` | seed ${seed}` : ''}`);
    logger.info('═'.repeat(60));

    // Select random coins (same seed = same coins for reproducible runs)
    const selectedCoins = selectRandomCoins(count, seed);
    logger.info(`\nSelected Coins: ${selectedCoins.join(', ')}\n`);

    // Ensure logs directory exists
    const logsDir = path.join(__dirname, '../../logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Run backtests
    const results: BacktestResult[] = [];
    let completed = 0;

    for (const coin of selectedCoins) {
      completed++;
      logger.info(`\n[${completed}/${selectedCoins.length}] Processing ${coin}...`);
      
      try {
        const result = await runSingleBacktest(coin, days, confidence, balance, startDate, endDate);
        results.push(result);
      } catch (error: any) {
        logger.error(`Failed to run backtest for ${coin}: ${error.message}`);
        results.push({
          symbol: coin,
          days,
          totalTrades: 0,
          winRate: 0,
          totalProfit: 0,
          profitFactor: 0,
          maxDrawdown: 0,
          sharpeRatio: 0,
          status: 'error',
          error: error.message
        });
      }

      // Small delay between backtests to avoid overwhelming the system
      if (completed < selectedCoins.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Generate summary
    const summaryText = generateSummaryReport(results, balance, days, selectedCoins.length);
    logger.info(summaryText);

    // Generate single combined report (one file only; optional custom path and summary JSON)
    const { summary } = generateCombinedMarkdownReport(
      results,
      days,
      selectedCoins.length,
      logsDir,
      balance,
      reportPath
    );
    if (summaryJsonPath) {
      const summaryWithMeta = {
        ...summary,
        days,
        coins: selectedCoins.length,
        initialBalance: balance,
        alignDirectionWith24h: process.env.ALIGN_DIRECTION_WITH_24H === 'true',
        generatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(summaryJsonPath, JSON.stringify(summaryWithMeta, null, 2));
      logger.info(`Summary JSON saved to: ${summaryJsonPath}`);
    }

    // Remove per-coin backtest data (temp JSON files)
    cleanupBatchTemp(logsDir);

    logger.info('═'.repeat(60));

  } catch (error: any) {
    logger.error(`Fatal error: ${error.message}`);
    process.exit(1);
  }
}

// Run the script
main().catch(error => {
  logger.error(`Unhandled error: ${error}`);
  process.exit(1);
});

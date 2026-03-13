/**
 * Backtest Results Reporter
 * Formats and displays backtest statistics in a clean table
 */

import { Trade } from '../types';
import { BacktestStats } from './backtest-engine';

export class BacktestReporter {
  /**
   * Print summary statistics
   */
  static printSummary(stats: BacktestStats, symbol: string, days: number, timeframe: string): void {
    const divider = '═'.repeat(50);

    console.log('\n' + divider);
    console.log(`  BACKTEST RESULTS: ${symbol} (Last ${days} days, ${timeframe})`);
    console.log(divider);

    // Trade counts
    console.log(`\nTrade Statistics:`);
    console.log(`  Total Trades:         ${stats.totalTrades}`);
    console.log(`  Winning Trades:       ${stats.winningTrades} (${stats.winRate.toFixed(1)}%)`);
    console.log(`  Losing Trades:        ${stats.losingTrades} (${(100 - stats.winRate).toFixed(1)}%)`);
    console.log(`  Win Rate:             ${stats.winRate.toFixed(1)}%`);

    // Profit/Loss
    console.log(`\nProfit/Loss:`);
    const pnlSign = stats.totalPnl >= 0 ? '+' : '';
    const pnlPercentSign = stats.totalPnlPercent >= 0 ? '+' : '';
    console.log(`  Total P&L:            ${pnlSign}$${stats.totalPnl.toFixed(2)} (${pnlPercentSign}${stats.totalPnlPercent.toFixed(2)}%)`);
    console.log(`  Avg Win:              $${stats.avgWin.toFixed(2)}`);
    console.log(`  Avg Loss:             $${stats.avgLoss.toFixed(2)}`);
    console.log(`  Profit Factor:        ${stats.profitFactor.toFixed(2)}x`);

    // Risk metrics
    console.log(`\nRisk Metrics:`);
    console.log(`  Max Drawdown:         ${stats.maxDrawdown.toFixed(2)}%`);
    console.log(`  Sharpe Ratio:         ${stats.sharpeRatio.toFixed(2)}`);

    // Best/Worst trades
    console.log(`\nBest/Worst Trades:`);
    if (stats.bestTrade) {
      const bestPnlSign = (stats.bestTrade.pnl || 0) >= 0 ? '+' : '';
      console.log(`  Best Trade:           ${bestPnlSign}$${(stats.bestTrade.pnl || 0).toFixed(2)} (${stats.bestTrade.symbol}, ${stats.bestTrade.side})`);
    }
    if (stats.worstTrade) {
      const worstPnlSign = (stats.worstTrade.pnl || 0) >= 0 ? '+' : '';
      console.log(`  Worst Trade:          ${worstPnlSign}$${(stats.worstTrade.pnl || 0).toFixed(2)} (${stats.worstTrade.symbol}, ${stats.worstTrade.side})`);
    }

    console.log(divider + '\n');
  }

  /**
   * Print detailed trade log
   */
  static printTradeLog(trades: Trade[]): void {
    if (trades.length === 0) {
      console.log('No trades executed.\n');
      return;
    }

    console.log(`\nDetailed Trade Log (${trades.length} trades):`);
    console.log('─'.repeat(120));
    console.log(
      `${'#'.padEnd(4)} | ${'Symbol'.padEnd(8)} | ${'Side'.padEnd(6)} | ` +
      `${'Entry'.padEnd(12)} | ${'Exit'.padEnd(12)} | ${'Qty'.padEnd(10)} | ` +
      `${'P&L'.padEnd(12)} | ${'%'.padEnd(8)} | ${'Reason'.padEnd(12)}`
    );
    console.log('─'.repeat(120));

    trades.forEach((trade, idx) => {
      const entry = (trade.entryPrice || 0).toFixed(8);
      const exit = (trade.exitPrice || 0).toFixed(8);
      const pnl = (trade.pnl || 0).toFixed(2);
      const pnlPercent = (trade.pnlPercent || 0).toFixed(2);
      const pnlSign = (trade.pnl || 0) >= 0 ? '+' : '';

      console.log(
        `${(idx + 1).toString().padEnd(4)} | ` +
        `${trade.symbol.padEnd(8)} | ` +
        `${trade.side.padEnd(6)} | ` +
        `${entry.padEnd(12)} | ` +
        `${exit.padEnd(12)} | ` +
        `${trade.quantity.toFixed(4).padEnd(10)} | ` +
        `${(pnlSign + pnl).padEnd(12)} | ` +
        `${(pnlSign + pnlPercent).padEnd(8)} | ` +
        `${(trade.exitReason || '-').padEnd(12)}`
      );
    });

    console.log('─'.repeat(120) + '\n');
  }

  /**
   * Print equity curve as ASCII chart
   */
  static printEquityCurve(equityCurve: { timestamp: number; balance: number }[], height: number = 10): void {
    if (equityCurve.length < 2) {
      return;
    }

    const balances = equityCurve.map(p => p.balance);
    const minBalance = Math.min(...balances);
    const maxBalance = Math.max(...balances);
    const range = maxBalance - minBalance;

    if (range === 0) {
      console.log('Equity curve: No variation in balance\n');
      return;
    }

    // Sample every nth point to fit in reasonable width
    const maxWidth = 80;
    const sampleRate = Math.max(1, Math.ceil(equityCurve.length / maxWidth));
    const sampledCurve = equityCurve.filter((_, i) => i % sampleRate === 0);

    // Build chart
    const chart: string[] = [];
    for (let h = height; h >= 0; h--) {
      let line = '';
      const threshold = minBalance + (range / height) * h;

      for (const point of sampledCurve) {
        if (point.balance >= threshold) {
          line += '█';
        } else {
          line += ' ';
        }
      }

      chart.push(line);
    }

    console.log('\nEquity Curve:');
    chart.forEach(line => console.log(line));
    console.log('─'.repeat(sampledCurve.length) + '\n');
  }

  /**
   * Export trade-by-trade report to Markdown (template: #, Coin, Dir, Entry, Exit, Size($), Lever, BalBefore, BalAfter, P&L, Exit reason)
   */
  static exportToMarkdown(
    trades: Trade[],
    symbol: string,
    days: number,
    timeframe: string,
    startBalance: number,
    filepath: string
  ): void {
    const fs = require('fs');
    const closedTrades = trades.filter(t => t.status === 'CLOSED');
    let balance = startBalance;

    const header = `# Backtest Trade Report: ${symbol}\n\n**Period:** ${days} days | **Timeframe:** ${timeframe} | **Start balance:** $${startBalance.toFixed(2)}\n\n`;
    const tableTitle = `--- Detail of each trade ---\n\n`;
    const colHeader =
      `| # | Coin | Dir | Entry | Exit | Size($) | Lever | BalBefore | BalAfter | P&L | Exit |\n` +
      `|---|------|-----|-------|------|--------|-------|------------|----------|-----|------|\n`;

    const rows: string[] = [];
    closedTrades.forEach((trade, idx) => {
      const balBefore = balance;
      const pnl = trade.pnl ?? 0;
      balance += pnl;
      const sizeUsd = (trade.entryPrice || 0) * (trade.quantity || 0);
      const entryStr = (trade.entryPrice || 0).toFixed(4);
      const exitStr = (trade.exitPrice ?? 0).toFixed(4);
      const pnlSign = pnl >= 0 ? '+' : '';
      rows.push(
        `| ${idx + 1} | ${trade.symbol} | ${trade.side} | ${entryStr} | ${exitStr} | ${sizeUsd.toFixed(2)} | ${trade.leverage}x | ${balBefore.toFixed(2)} | ${balance.toFixed(2)} | ${pnlSign}${pnl.toFixed(2)} | ${trade.exitReason ?? '-'} |`
      );
    });

    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const footer = `\n---\n**Total trades:** ${closedTrades.length} | **Final balance:** $${balance.toFixed(2)} | **Total P&L:** ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\n`;
    const md = header + tableTitle + colHeader + rows.join('\n') + footer;
    fs.writeFileSync(filepath, md);
    console.log(`Trade report (MD) saved to ${filepath}`);
  }

  /**
   * Export results to JSON
   */
  static exportToJson(
    stats: BacktestStats,
    trades: Trade[],
    symbol: string,
    filepath: string,
    startBalance?: number
  ): void {
    const output = {
      timestamp: new Date().toISOString(),
      symbol,
      startBalance: startBalance ?? 10000,
      statistics: {
        totalTrades: stats.totalTrades,
        winningTrades: stats.winningTrades,
        losingTrades: stats.losingTrades,
        winRate: stats.winRate,
        totalPnl: stats.totalPnl,
        totalPnlPercent: stats.totalPnlPercent,
        avgWin: stats.avgWin,
        avgLoss: stats.avgLoss,
        profitFactor: stats.profitFactor,
        maxDrawdown: stats.maxDrawdown,
        sharpeRatio: stats.sharpeRatio,
      },
      bestTrade: stats.bestTrade,
      worstTrade: stats.worstTrade,
      trades,
      equityCurve: stats.equityCurve,
    };

    const fs = require('fs');
    fs.writeFileSync(filepath, JSON.stringify(output, null, 2));
    console.log(`Results exported to ${filepath}`);
  }

  /**
   * Generate full report
   */
  static generateReport(
    stats: BacktestStats,
    trades: Trade[],
    symbol: string,
    days: number,
    timeframe: string,
    jsonOutput?: string,
    startBalance?: number
  ): void {
    this.printSummary(stats, symbol, days, timeframe);
    this.printEquityCurve(stats.equityCurve);
    this.printTradeLog(trades);

    if (jsonOutput) {
      this.exportToJson(stats, trades, symbol, jsonOutput, startBalance);
    }
  }
}

export default BacktestReporter;

#!/usr/bin/env ts-node

/**
 * Compare backtest: strict trend-only (ALIGN_DIRECTION_WITH_24H=true) vs allow counter-trend (false).
 * Runs same 10 coins, 90 days, fixed seed; then writes a comparison report.
 *
 * Usage: npm run backtest:compare
 *    or: npx ts-node src/backtest/compare-trend-backtest.ts [--days 90] [--count 10] [--seed 42]
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const DEFAULT_DAYS = 90;
const DEFAULT_COUNT = 10;
const DEFAULT_SEED = 42;
const DEFAULT_BALANCE = 150;

function parseArgs(): { days: number; count: number; seed: number; balance: number } {
  let days = DEFAULT_DAYS;
  let count = DEFAULT_COUNT;
  let seed = DEFAULT_SEED;
  let balance = DEFAULT_BALANCE;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--days' && process.argv[i + 1]) {
      days = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === '--count' && process.argv[i + 1]) {
      count = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === '--seed' && process.argv[i + 1]) {
      seed = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === '--balance' && process.argv[i + 1]) {
      balance = parseFloat(process.argv[i + 1]);
      i++;
    }
  }
  return { days, count, seed, balance };
}

interface SummaryJson {
  totalTrades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  slCount: number;
  tp1Count: number;
  tp2Count: number;
  days: number;
  coins: number;
  initialBalance: number;
  alignDirectionWith24h: boolean;
  generatedAt: string;
}

function runBatch(alignDirectionWith24h: boolean, days: number, count: number, seed: number, balance: number, logsDir: string): SummaryJson | null {
  const label = alignDirectionWith24h ? 'trend-only' : 'counter-trend';
  const reportPath = path.join(logsDir, `batch-90d-${count}coins-${label}.md`);
  const summaryPath = path.join(logsDir, `summary-${label}.json`);
  const env = { ...process.env, ALIGN_DIRECTION_WITH_24H: alignDirectionWith24h ? 'true' : 'false' };
  const cmd = `npx ts-node src/backtest/batch-backtest-90d.ts --days ${days} --count ${count} --seed ${seed} --balance ${balance} --report "${reportPath}" --summary-json "${summaryPath}"`;
  console.log(`\n>>> Running ${label} (ALIGN_DIRECTION_WITH_24H=${alignDirectionWith24h})...`);
  try {
    execSync(cmd, { encoding: 'utf-8', stdio: 'inherit', env, cwd: path.join(__dirname, '../..') });
  } catch (e) {
    console.error(`${label} run failed:`, e);
    return null;
  }
  if (!fs.existsSync(summaryPath)) {
    console.error(`Summary not found: ${summaryPath}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as SummaryJson;
}

function writeComparisonReport(
  trendOnly: SummaryJson | null,
  counterTrend: SummaryJson | null,
  outPath: string,
  days: number,
  count: number,
  seed: number,
  balance: number
): void {
  const lines: string[] = [
    '# Backtest Comparison: Trend-Only vs Counter-Trend',
    '',
    `**Same setup:** ${count} coins, ${days} days, seed ${seed}, $${balance} initial balance`,
    '',
    `**Generated:** ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    '| Metric | Trend-Only (ALIGN_DIRECTION_WITH_24H=true) | Counter-Trend (false/unset) | Difference |',
    '|--------|------------------------------------------|-----------------------------|------------|',
  ];

  if (!trendOnly || !counterTrend) {
    lines.push('| - | Run failed or missing | Run failed or missing | - |');
    lines.push('');
    lines.push('One or both runs failed. Check logs above.');
  } else {
    const diffTrades = counterTrend.totalTrades - trendOnly.totalTrades;
    const diffWins = counterTrend.wins - trendOnly.wins;
    const diffWinRate = counterTrend.winRate - trendOnly.winRate;
    const diffPnl = counterTrend.totalPnl - trendOnly.totalPnl;
    const winner = trendOnly.totalPnl >= counterTrend.totalPnl ? 'Trend-Only' : 'Counter-Trend';
    const pnlDiffStr = diffPnl >= 0 ? `+$${diffPnl.toFixed(2)}` : `$${diffPnl.toFixed(2)}`;
    lines.push(`| Total trades | ${trendOnly.totalTrades} | ${counterTrend.totalTrades} | ${diffTrades >= 0 ? '+' : ''}${diffTrades} |`);
    lines.push(`| Wins | ${trendOnly.wins} | ${counterTrend.wins} | ${diffWins >= 0 ? '+' : ''}${diffWins} |`);
    lines.push(`| Win rate | ${trendOnly.winRate.toFixed(1)}% | ${counterTrend.winRate.toFixed(1)}% | ${diffWinRate >= 0 ? '+' : ''}${diffWinRate.toFixed(1)}% |`);
    lines.push(`| Total P&L | $${trendOnly.totalPnl >= 0 ? '' : ''}${trendOnly.totalPnl.toFixed(2)} | $${counterTrend.totalPnl >= 0 ? '' : ''}${counterTrend.totalPnl.toFixed(2)} | ${pnlDiffStr} |`);
    lines.push(`| SL taken | ${trendOnly.slCount} | ${counterTrend.slCount} | - |`);
    lines.push(`| TP1 taken | ${trendOnly.tp1Count} | ${counterTrend.tp1Count} | - |`);
    lines.push(`| TP2 taken | ${trendOnly.tp2Count} | ${counterTrend.tp2Count} | - |`);
    lines.push('');
    lines.push(`**Higher total P&L in this run:** ${winner}`);
    lines.push('');
    lines.push('## Interpretation');
    lines.push('');
    lines.push('- **Trend-Only:** Skips SHORT when 24h price change > +1%; skips LONG when 24h < -1% (when score gap is small).');
    lines.push('- **Counter-Trend:** No 24h filter; can short strength and long weakness.');
    lines.push('- Same coins and period (fixed seed) so comparison is like-for-like.');
  }

  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`\nComparison report written to: ${outPath}`);
}

async function main(): Promise<void> {
  const { days, count, seed, balance } = parseArgs();
  const logsDir = path.join(__dirname, '../../logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  console.log('═'.repeat(60));
  console.log(`Trend-Only vs Counter-Trend Backtest Comparison`);
  console.log(`${count} coins, ${days} days, seed ${seed}, $${balance} balance`);
  console.log('═'.repeat(60));

  const trendOnly = runBatch(true, days, count, seed, balance, logsDir);
  const counterTrend = runBatch(false, days, count, seed, balance, logsDir);

  const comparisonPath = path.join(logsDir, 'backtest-comparison-trend-vs-counter.md');
  writeComparisonReport(trendOnly, counterTrend, comparisonPath, days, count, seed, balance);

  console.log('═'.repeat(60));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env ts-node
/**
 * Dry Run Report — reads ./logs/trades.jsonl and writes ./logs/report.md
 * Usage: npx ts-node src/utils/dry-run-report.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR    = process.env.LOG_DIR || './logs';
const TRADES_FILE = path.join(LOG_DIR, 'trades.jsonl');
const REPORT_FILE = path.join(LOG_DIR, 'report.md');

interface TradeRecord {
  type: 'NEW_TRADE' | 'CLOSE_TRADE';
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  pnl?: number;
  exitReason?: string;
  openTime: number;
  closeTime?: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
}

function loadTrades(): TradeRecord[] {
  if (!fs.existsSync(TRADES_FILE)) {
    console.log(`No trades file found at ${TRADES_FILE}`);
    console.log('Start the bot with ENABLE_DRY_RUN=true to generate trades.');
    process.exit(0);
  }
  const lines = fs.readFileSync(TRADES_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.map(l => JSON.parse(l));
}

function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function pnlBadge(pnl: number): string {
  return pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
}

function main() {
  const records = loadTrades();

  // Build closed trades map
  const opens = new Map<string, TradeRecord>();
  const closed: TradeRecord[] = [];

  for (const r of records) {
    if (r.type === 'NEW_TRADE') {
      opens.set(r.id, r);
    } else if (r.type === 'CLOSE_TRADE' && r.id) {
      const open = opens.get(r.id);
      if (open) {
        closed.push({ ...open, ...r });
        opens.delete(r.id);
      }
    }
  }

  const openList = Array.from(opens.values());

  // Stats
  const wins   = closed.filter(t => (t.pnl || 0) > 0);
  const losses = closed.filter(t => (t.pnl || 0) <= 0);
  const totalPnL      = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const avgWin        = wins.length   ? wins.reduce((s, t)   => s + (t.pnl || 0), 0) / wins.length   : 0;
  const avgLoss       = losses.length ? Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0) / losses.length) : 0;
  const winRate       = closed.length ? (wins.length / closed.length) * 100 : 0;
  const profitFactor  = avgLoss > 0 ? avgWin / avgLoss : 0;

  // Per-coin breakdown
  const byCoin = new Map<string, { wins: number; losses: number; pnl: number }>();
  for (const t of closed) {
    const c = byCoin.get(t.symbol) || { wins: 0, losses: 0, pnl: 0 };
    if ((t.pnl || 0) > 0) c.wins++; else c.losses++;
    c.pnl += (t.pnl || 0);
    byCoin.set(t.symbol, c);
  }
  const sortedCoins = Array.from(byCoin.entries()).sort((a, b) => b[1].pnl - a[1].pnl);

  // Reason breakdown
  const byReason = new Map<string, number>();
  for (const t of closed) {
    const r = t.exitReason || 'UNKNOWN';
    byReason.set(r, (byReason.get(r) || 0) + 1);
  }

  // ── Build markdown ──────────────────────────────────────────────────────────
  const lines: string[] = [];
  const now = new Date().toLocaleString();

  lines.push(`# Dry Run Performance Report`);
  lines.push(`> Generated: ${now}  `);
  lines.push(`> Source: \`${TRADES_FILE}\``);
  lines.push('');

  // P&L summary
  lines.push('## P&L Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total Closed Trades | ${closed.length} |`);
  lines.push(`| Total P&L | **${pnlBadge(totalPnL)}** |`);
  lines.push(`| Win Rate | **${winRate.toFixed(1)}%** (${wins.length}W / ${losses.length}L) |`);
  lines.push(`| Avg Win | $${avgWin.toFixed(2)} |`);
  lines.push(`| Avg Loss | $${avgLoss.toFixed(2)} |`);
  lines.push(`| Profit Factor | ${profitFactor.toFixed(2)}x |`);
  lines.push('');

  // Exit reasons
  lines.push('## Exit Reasons');
  lines.push('');
  lines.push('| Reason | Count |');
  lines.push('|--------|-------|');
  for (const [reason, count] of Array.from(byReason.entries()).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${reason} | ${count} |`);
  }
  lines.push('');

  // Per-coin breakdown
  if (sortedCoins.length > 0) {
    lines.push('## Per-Coin Breakdown');
    lines.push('');
    lines.push('| Coin | P&L | Win Rate | W | L |');
    lines.push('|------|-----|----------|---|---|');
    for (const [symbol, data] of sortedCoins) {
      const total = data.wins + data.losses;
      const wr    = ((data.wins / total) * 100).toFixed(0) + '%';
      lines.push(`| ${symbol} | ${pnlBadge(data.pnl)} | ${wr} | ${data.wins} | ${data.losses} |`);
    }
    lines.push('');
  }

  // Open positions
  if (openList.length > 0) {
    lines.push(`## Open Positions (${openList.length})`);
    lines.push('');
    lines.push('| Coin | Side | Entry | Stop Loss | TP1 | Age |');
    lines.push('|------|------|-------|-----------|-----|-----|');
    for (const p of openList) {
      const age = formatDuration(Date.now() - p.openTime);
      lines.push(`| ${p.symbol} | ${p.side} | ${p.entryPrice} | ${p.stopLoss.toFixed(4)} | ${p.tp1.toFixed(4)} | ${age} |`);
    }
    lines.push('');
  }

  // Last 20 trades
  if (closed.length > 0) {
    lines.push('## Last 20 Trades');
    lines.push('');
    lines.push('| # | Coin | Side | Entry | Exit | P&L | Reason |');
    lines.push('|---|------|------|-------|------|-----|--------|');
    const last20 = closed.slice(-20).reverse();
    last20.forEach((t, i) => {
      const pnl = t.pnl || 0;
      lines.push(
        `| ${i + 1} | ${t.symbol} | ${t.side} | ${t.entryPrice?.toFixed(4)} | ${(t.exitPrice || 0).toFixed(4)} | ${pnlBadge(pnl)} | ${t.exitReason || ''} |`
      );
    });
    lines.push('');
  }

  const markdown = lines.join('\n');

  // Write file
  fs.writeFileSync(REPORT_FILE, markdown, 'utf-8');
  console.log(`Report written to ${REPORT_FILE}`);
}

main();

/**
 * Minimal dashboard server for the trading bot.
 * Serves GET /api/status (JSON) and GET / (dashboard UI).
 * Run: npx ts-node src/dashboard-server.ts
 * Requires .env with exchange credentials for live balance/positions.
 */
import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { getTradingBalance, getExchangeOpenPositions } from './exchange/trading-client';

const PORT = parseInt(process.env.DASHBOARD_PORT || '3840', 10);
const STATUS_FILE = path.join(process.cwd(), 'data', 'dashboard-status.json');
const JOURNAL_FILE = path.join(process.cwd(), 'data', 'trading-journal.json');
const STATE_FILE = path.join(process.cwd(), 'data', 'bot-state.json');
const WITHDRAWALS_FILE = path.join(process.cwd(), 'data', 'withdrawals.json');
const DASHBOARD_DIR = path.join(process.cwd(), 'dashboard');
const BOT_ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min

async function getStatus(): Promise<{
  regime: string | null;
  mode: string | null;
  balance: number;
  equity: number;
  openPositions: { symbol: string; side: string; quantity: number; entryPrice: number; markPrice?: number; unrealizedPnl?: number; tp1Hit?: boolean; slMovedToEntry?: boolean; sl?: number; tp1?: number; tp2?: number }[];
  dailyStats: { totalTrades: number; totalPnL: number; winRate: number } | null;
  uptimeMs: number | null;
  lastUpdated: number;
  botOnline: boolean;
  startBalance: number | null;
  startedAt: number | null;
  totalPnL: number | null;
  totalWithdrawn: number;
  streak: { count: number; type: 'W' | 'L' | null };
  lastScanTime: number | null;
  totalRoiPct: number | null;
  totalTrades: number;
  journalTrades: { openTime: number; closeTime: number; symbol: string; side: string; entryPrice: number; exitPrice?: number; pnl?: number; exitReason?: string; balanceAfter: number }[];
}> {
  // Best-effort: enrich exchange positions with bot-local flags (TP1 hit / SL moved to entry)
  const localFlags = new Map<string, { tp1Hit?: boolean; slMovedToEntry?: boolean; sl?: number; tp1?: number; tp2?: number }>();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const state = JSON.parse(raw);
      for (const p of (state.positions || [])) {
        const symbol = String(p.symbol || '').toUpperCase();
        const side = String(p.side || '').toUpperCase();
        if (!symbol || (side !== 'LONG' && side !== 'SHORT')) continue;
        localFlags.set(`${symbol}:${side}`, {
          tp1Hit: !!p.tp1Hit,
          slMovedToEntry: !!p.slMovedToEntry,
          sl: p.stopLoss || undefined,
          tp1: p.tp1 || undefined,
          tp2: p.tp2 || undefined,
        });
      }
    }
  } catch (_) {
    // ignore
  }

  let balance = 0;
  let positions: { symbol: string; side: string; quantity: number; entryPrice: number; unrealizedPnl?: number; tp1Hit?: boolean; slMovedToEntry?: boolean }[] = [];
  try {
    balance = await getTradingBalance();
    const raw = await getExchangeOpenPositions();
    positions = raw.map(p => ({
      symbol: p.symbol,
      side: p.side,
      quantity: p.quantity,
      entryPrice: p.entryPrice,
      unrealizedPnl: p.unrealizedPnl,
      markPrice: p.markPrice,
      ...(localFlags.get(`${String(p.symbol).toUpperCase()}:${String(p.side).toUpperCase()}`) || {}),
    }));
  } catch (_) {
    // use zeros if exchange unavailable
  }

  let regime: string | null = null;
  let mode: string | null = null;
  let dailyStats: { totalTrades: number; totalPnL: number; winRate: number } | null = null;
  let uptimeMs: number | null = null;
  let lastUpdated = 0;
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      regime = data.regime ?? null;
      mode = data.mode ?? null;
      lastUpdated = data.timestamp ?? 0;
      uptimeMs = data.uptimeMs ?? null;
      if (data.dailyStats) {
        dailyStats = {
          totalTrades: data.dailyStats.totalTrades ?? 0,
          totalPnL: data.dailyStats.totalPnL ?? 0,
          winRate: data.dailyStats.winRate ?? 0,
        };
      }
    }
  } catch (_) {
    // status file missing or invalid
  }

  const totalUnrealized = positions.reduce((s, p) => s + (Number(p.unrealizedPnl) || 0), 0);
  const equity = balance + totalUnrealized;
  const botOnline = lastUpdated > 0 && Date.now() - lastUpdated < BOT_ONLINE_THRESHOLD_MS;

  let startBalance: number | null = null;
  let startedAt: number | null = null;
  let totalPnL: number | null = null;
  let totalWithdrawn = 0;
  try {
    if (fs.existsSync(WITHDRAWALS_FILE)) {
      const w = JSON.parse(fs.readFileSync(WITHDRAWALS_FILE, 'utf-8'));
      totalWithdrawn = (w.withdrawals || []).reduce((s: number, r: { amount: number }) => s + (Number(r.amount) || 0), 0);
    }
  } catch (_) {}

  let totalRoiPct: number | null = null;
  let totalTrades = 0;
  let journalTrades: { openTime: number; closeTime: number; symbol: string; side: string; entryPrice: number; exitPrice?: number; pnl?: number; exitReason?: string; balanceAfter: number }[] = [];
  try {
    if (fs.existsSync(JOURNAL_FILE)) {
      const raw = fs.readFileSync(JOURNAL_FILE, 'utf-8');
      const journal = JSON.parse(raw);
      const trades = (journal.trades || []).filter((t: { status?: string }) => t.status !== 'OPEN');
      totalTrades = trades.length;
      startBalance = typeof journal.startBalance === 'number' ? journal.startBalance : null;
      startedAt = typeof journal.startedAt === 'number' ? journal.startedAt : null;
      const sum = trades.reduce((s: number, t: { pnl?: number }) => s + (Number(t.pnl) || 0), 0);
      totalPnL = sum;
      if (startBalance != null && startBalance > 0) {
        totalRoiPct = (sum / startBalance) * 100;
      }
      // Sort by closeTime ascending and compute balanceAfter for each
      const sorted = [...trades].sort((a: { closeTime?: number }, b: { closeTime?: number }) => (a.closeTime || 0) - (b.closeTime || 0));
      let running = startBalance ?? 0;
      journalTrades = sorted.map((t: { openTime?: number; closeTime?: number; symbol?: string; side?: string; entryPrice?: number; exitPrice?: number; pnl?: number; exitReason?: string }) => {
        const pnl = Number(t.pnl) || 0;
        running += pnl;
        return {
          openTime: t.openTime ?? 0,
          closeTime: t.closeTime ?? 0,
          symbol: t.symbol ?? '',
          side: t.side ?? '',
          entryPrice: t.entryPrice ?? 0,
          exitPrice: t.exitPrice,
          pnl,
          exitReason: t.exitReason,
          balanceAfter: running,
        };
      });
    }
  } catch (_) {
    // ignore
  }

  // Streak: walk closed trades from most recent backwards
  let streak: { count: number; type: 'W' | 'L' | null } = { count: 0, type: null };
  try {
    const sorted = [...journalTrades].sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0));
    if (sorted.length > 0) {
      const firstType: 'W' | 'L' = (sorted[0].pnl ?? 0) > 0 ? 'W' : 'L';
      let count = 0;
      for (const t of sorted) {
        const type: 'W' | 'L' = (t.pnl ?? 0) > 0 ? 'W' : 'L';
        if (type === firstType) count++;
        else break;
      }
      streak = { count, type: firstType };
    }
  } catch (_) {}

  // Last scan time from dashboard-status.json
  let lastScanTime: number | null = null;
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      lastScanTime = data.lastScanTime ?? null;
    }
  } catch (_) {}

  return {
    regime,
    mode,
    balance,
    equity,
    openPositions: positions,
    dailyStats,
    uptimeMs,
    lastUpdated,
    botOnline,
    startBalance,
    startedAt,
    totalPnL,
    totalWithdrawn,
    totalRoiPct,
    totalTrades,
    streak,
    lastScanTime,
    journalTrades,
  };
}

const server = http.createServer(async (req, res) => {
  const url = req.url?.split('?')[0] ?? '/';

  if (url === '/api/status') {
    try {
      const status = await getStatus();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(status));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  const file = url === '/' ? '/index.html' : url;
  const filePath = path.join(DASHBOARD_DIR, file);
  if (!filePath.startsWith(DASHBOARD_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.ico': 'image/x-icon' };
  res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
  res.end(fs.readFileSync(filePath));
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
});

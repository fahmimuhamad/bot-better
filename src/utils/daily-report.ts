/**
 * Daily Report — sent to Telegram at 7am WIB (UTC+7 = 00:00 UTC)
 *
 * Includes: closed-trade PnL, win rate, open positions with uPnL,
 * balance, regime, and bot uptime.
 */

import positionManager from '../trading/position-manager';
import { Position, BinanceTickerData } from '../types';
import logger from './logger';

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7

function nowWIB(): Date {
  return new Date(Date.now() + WIB_OFFSET_MS);
}

/** Returns "YYYY-MM-DD" in WIB */
function wibDateString(): string {
  return nowWIB().toISOString().slice(0, 10);
}

/** Returns WIB hour (0-23) */
function wibHour(): number {
  return nowWIB().getUTCHours();
}

function pnlSign(n: number): string {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function calcUnrealizedPnl(pos: Position, currentPrice: number): number {
  if (pos.side === 'LONG') return (currentPrice - pos.entryPrice) * pos.quantity;
  return (pos.entryPrice - currentPrice) * pos.quantity;
}

export function buildDailyReportMessage(
  currentBalance: number,
  startBalance: number,
  tickers: Map<string, BinanceTickerData>,
  botStartTime: number
): string {
  const stats       = positionManager.getDailyStats();
  const openPos     = positionManager.getOpenPositions();

  // All-time closed trades for overall stats
  const allClosed   = positionManager.getAllTrades().filter(t => t.status === 'CLOSED');
  const totalPnL    = allClosed.reduce((s, t) => s + (t.pnl || 0), 0);

  // Unrealized PnL across open positions
  let totalUPnl = 0;
  const posLines: string[] = [];
  for (const pos of openPos) {
    const ticker = tickers.get(pos.symbol);
    const price  = ticker ? parseFloat(ticker.lastPrice) : pos.entryPrice;
    const upnl   = calcUnrealizedPnl(pos, price);
    totalUPnl   += upnl;
    const ageMin  = Math.round((Date.now() - pos.openTime) / 60000);
    posLines.push(
      `  • ${pos.symbol} ${pos.side}  entry $${pos.entryPrice.toFixed(4)}  uPnL ${pnlSign(upnl)}  (${ageMin}m)`
    );
  }

  // Uptime
  const uptimeH = ((Date.now() - botStartTime) / 3600000).toFixed(1);

  // Balance change since bot start
  const balanceChange = currentBalance - startBalance;

  const now   = nowWIB();
  const dateStr = now.toISOString().slice(0, 16).replace('T', ' ') + ' WIB';

  const lines = [
    `📊 *Daily Report — ${dateStr}*`,
    ``,
    `💰 *Balance*`,
    `  Current: $${currentBalance.toFixed(2)}`,
    `  Since start: ${pnlSign(balanceChange)}`,
    ``,
    `📈 *Last 24h Closed Trades*`,
    `  Trades: ${stats.totalTrades}  (${stats.wins}W / ${stats.losses}L)`,
    `  Win Rate: ${stats.totalTrades > 0 ? stats.winRate.toFixed(1) : 'N/A'}%`,
    `  Realised PnL: ${pnlSign(stats.totalPnL)}`,
    `  Avg Win: $${stats.avgWin.toFixed(2)}  |  Avg Loss: $${stats.avgLoss.toFixed(2)}`,
    `  Profit Factor: ${stats.profitFactor > 0 ? stats.profitFactor.toFixed(2) + 'x' : 'N/A'}`,
    ``,
    `🔓 *Open Positions (${openPos.length})*`,
    ...(openPos.length > 0
      ? [...posLines, `  Total uPnL: ${pnlSign(totalUPnl)}`]
      : [`  No open positions`]),
    ``,
    `⚙️ *Bot*`,
    `  Mode: ${process.env.TIMEFRAME || '1h'} / ADX≥${process.env.ADX_MIN || '32'}`,
    `  Uptime: ${uptimeH}h`,
    `  All-time PnL: ${pnlSign(totalPnL)}`,
  ];

  return lines.join('\n');
}

/**
 * DailyReportScheduler — call tick() every bot cycle.
 * Fires once per day at 7am WIB.
 */
export class DailyReportScheduler {
  private lastReportDate = '';

  tick(
    send: (msg: string) => Promise<void>,
    currentBalance: number,
    startBalance: number,
    tickers: Map<string, BinanceTickerData>,
    botStartTime: number
  ): void {
    const todayWIB = wibDateString();
    const hourWIB  = wibHour();

    if (hourWIB !== 7) return;
    if (this.lastReportDate === todayWIB) return;

    this.lastReportDate = todayWIB;

    const msg = buildDailyReportMessage(currentBalance, startBalance, tickers, botStartTime);
    logger.info('Sending daily Telegram report');
    send(msg).catch(err => logger.warn(`Daily report send failed: ${err}`));
  }
}

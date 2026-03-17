/**
 * Telegram Command Handler
 *
 * Polls Telegram for incoming messages and handles bot commands.
 * Only accepts messages from TELEGRAM_CHAT_ID for security.
 *
 * Commands:
 *   /status   — current regime, balance, open positions
 *   /report   — on-demand daily report
 *   /stop     — pause new trades (open positions still managed)
 *   /start    — resume trading
 *   /restart  — restart the bot process
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import logger from './logger';
import positionManager from '../trading/position-manager';
import { buildDailyReportMessage } from './daily-report';
import { BinanceTickerData } from '../types';

const WITHDRAWALS_FILE = path.join(process.cwd(), 'data', 'withdrawals.json');

function logWithdrawal(amount: number, note: string): void {
  let data: { withdrawals: { amount: number; timestamp: number; note: string }[] } = { withdrawals: [] };
  try { if (fs.existsSync(WITHDRAWALS_FILE)) data = JSON.parse(fs.readFileSync(WITHDRAWALS_FILE, 'utf-8')); } catch (_) {}
  data.withdrawals.push({ amount, timestamp: Date.now(), note });
  fs.writeFileSync(WITHDRAWALS_FILE, JSON.stringify(data, null, 2));
}

type BalanceGetter      = () => number;
type RegimeGetter       = () => string;
type TickersGetter      = () => Map<string, BinanceTickerData>;
type BotStartGetter     = () => number;
type BotStopper         = () => void;
type BotStarter         = () => Promise<void>;

async function send(text: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'Markdown' },
      { timeout: 8000 }
    );
  } catch (e) {
    logger.warn(`Telegram send failed: ${e}`);
  }
}

async function handleCommand(
  text: string,
  getBalance: BalanceGetter,
  getStartBalance: BalanceGetter,
  getRegime: RegimeGetter,
  getTickers: TickersGetter,
  getBotStart: BotStartGetter,
  stopBot: BotStopper,
  startBot: BotStarter,
  isBotRunning: () => boolean
): Promise<void> {
  const cmd = text.trim().toLowerCase().split(' ')[0];

  switch (cmd) {

    case '/status': {
      const openPos  = positionManager.getOpenPositions();
      const stats    = positionManager.getDailyStats();
      const balance  = getBalance();
      const uptimeH  = ((Date.now() - getBotStart()) / 3600000).toFixed(1);
      const mode     = process.env.ENABLE_DRY_RUN === 'true' ? 'DRY RUN' : 'LIVE';
      const regime   = getRegime().toUpperCase();

      const tickers  = getTickers();
      let totalUPnl  = 0;
      const posLines = openPos.length > 0
        ? openPos.map(p => {
            const price = parseFloat(tickers.get(p.symbol)?.lastPrice ?? String(p.entryPrice));
            const upnl  = p.side === 'LONG'
              ? (price - p.entryPrice) * p.quantity
              : (p.entryPrice - price) * p.quantity;
            totalUPnl += upnl;
            const sign = upnl >= 0 ? '+' : '-';
            return `  • ${p.symbol} ${p.side} @ $${p.entryPrice.toFixed(4)}  uPnL ${sign}$${Math.abs(upnl).toFixed(2)}`;
          }).join('\n')
        : '  None';

      const equity = balance + totalUPnl;
      await send([
        `⚙️ *Bot Status*`,
        ``,
        `Mode: ${mode}`,
        `Regime: ${regime} (BTC daily EMA200)`,
        `Wallet: $${balance.toFixed(2)}  |  Equity: $${equity.toFixed(2)}`,
        `Uptime: ${uptimeH}h  |  Trades today: ${stats.totalTrades}`,
        `Win rate: ${stats.winRate.toFixed(1)}%  |  PnL: $${stats.totalPnL.toFixed(2)}`,
        ``,
        `*Open Positions (${openPos.length}):*`,
        posLines,
      ].join('\n'));
      break;
    }

    case '/report': {
      const msg = buildDailyReportMessage(
        getBalance(),
        getStartBalance(),
        getTickers(),
        getBotStart()
      );
      await send(msg);
      break;
    }

    case '/stop': {
      if (!isBotRunning()) {
        await send(`⚠️ Bot is already stopped.`);
        break;
      }
      await send(`🛑 *Stopping bot...*\n\nNo new trades will be opened. Open positions are still managed.`);
      logger.info('Telegram command: stop bot');
      stopBot();
      break;
    }

    case '/start': {
      if (isBotRunning()) {
        await send(`⚠️ Bot is already running.`);
        break;
      }
      await send(`▶️ *Starting bot...*`);
      logger.info('Telegram command: start bot');
      startBot().catch(err => {
        logger.error(`Failed to start bot via Telegram: ${err}`);
        send(`❌ Failed to start bot: ${err}`);
      });
      break;
    }

    case '/restart': {
      await send(`🔄 Restarting bot...`);
      logger.info('Telegram command: manual restart');
      setTimeout(() => process.exit(0), 1000);
      break;
    }

    case '/withdraw': {
      const parts = text.trim().split(/\s+/);
      const amount = parseFloat(parts[1]);
      if (isNaN(amount) || amount <= 0) {
        await send(`Usage: /withdraw <amount> [note]\nExample: /withdraw 200 took profit`);
        break;
      }
      const note = parts.slice(2).join(' ') || '';
      logWithdrawal(amount, note);
      await send(`✅ Withdrawal recorded: *$${amount.toFixed(2)}*${note ? `\nNote: ${note}` : ''}`);
      break;
    }

    default: {
      await send([
        `*Available commands:*`,
        `/status   — regime, balance, open positions`,
        `/report   — full PnL report`,
        `/stop     — pause the bot (no new trades)`,
        `/start    — resume the bot`,
        `/restart  — restart the bot`,
        `/withdraw <amount> [note] — record a withdrawal`,
      ].join('\n'));
    }
  }
}

export class TelegramCommandHandler {
  private offset           = 0;
  private running          = false;
  private getBalance:      BalanceGetter;
  private getStartBalance: BalanceGetter;
  private getRegime:       RegimeGetter;
  private getTickers:      TickersGetter;
  private getBotStart:     BotStartGetter;
  private stopBot:         BotStopper;
  private startBot:        BotStarter;
  private isBotRunning:    () => boolean;

  constructor(
    getBalance: BalanceGetter,
    getStartBalance: BalanceGetter,
    getRegime: RegimeGetter,
    getTickers: TickersGetter,
    getBotStart: BotStartGetter,
    stopBot: BotStopper,
    startBot: BotStarter,
    isBotRunning: () => boolean
  ) {
    this.getBalance      = getBalance;
    this.getStartBalance = getStartBalance;
    this.getRegime       = getRegime;
    this.getTickers      = getTickers;
    this.getBotStart     = getBotStart;
    this.stopBot         = stopBot;
    this.startBot        = startBot;
    this.isBotRunning    = isBotRunning;
  }

  start(): void {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      logger.warn('Telegram commands disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
      return;
    }

    this.running = true;
    logger.info('Telegram command handler started');
    this.poll();
  }

  stop(): void {
    this.running = false;
  }

  private async poll(): Promise<void> {
    const token  = process.env.TELEGRAM_BOT_TOKEN!;
    const chatId = process.env.TELEGRAM_CHAT_ID!;

    while (this.running) {
      try {
        const resp = await axios.get(
          `https://api.telegram.org/bot${token}/getUpdates`,
          {
            params: { offset: this.offset, timeout: 30, allowed_updates: ['message'] },
            timeout: 35000,
          }
        );

        for (const update of resp.data.result as any[]) {
          this.offset = update.update_id + 1;

          const msg = update.message;
          if (!msg?.text) continue;
          if (String(msg.chat.id) !== String(chatId)) continue;
          if (!msg.text.startsWith('/')) continue;

          logger.info(`Telegram command received: ${msg.text}`);
          await handleCommand(msg.text, this.getBalance, this.getStartBalance, this.getRegime, this.getTickers, this.getBotStart, this.stopBot, this.startBot, this.isBotRunning);
        }
      } catch (error: any) {
        if (this.running) {
          logger.warn(`Telegram poll error: ${error.message}`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }
}

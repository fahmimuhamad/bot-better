/**
 * Telegram Command Handler
 *
 * Polls Telegram for incoming messages and handles bot commands.
 * Only accepts messages from TELEGRAM_CHAT_ID for security.
 *
 * Commands:
 *   /status   — current config, balance, open positions
 *   /report   — on-demand daily report
 *   /setbull  — switch to 4h / ADX_MIN=25 and restart
 *   /setbear  — switch to 1h / ADX_MIN=32 and restart
 *   /restart  — restart the bot
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import logger from './logger';
import positionManager from '../trading/position-manager';
import { buildDailyReportMessage } from './daily-report';
import { BinanceTickerData } from '../types';

type BalanceGetter   = () => number;
type TickersGetter   = () => Map<string, BinanceTickerData>;
type BotStartGetter  = () => number;

function getEnvPath(): string {
  return path.resolve(process.cwd(), '.env');
}

/** Replace a key=value line in the .env file */
function updateEnvKey(key: string, value: string): void {
  const envPath = getEnvPath();
  let content = fs.readFileSync(envPath, 'utf-8');
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  fs.writeFileSync(envPath, content, 'utf-8');
}

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
  getTickers: TickersGetter,
  getBotStart: BotStartGetter
): Promise<void> {
  const cmd = text.trim().toLowerCase().split(' ')[0];

  switch (cmd) {

    case '/status': {
      const openPos    = positionManager.getOpenPositions();
      const stats      = positionManager.getDailyStats();
      const balance    = getBalance();
      const uptimeH    = ((Date.now() - getBotStart()) / 3600000).toFixed(1);
      const mode       = process.env.ENABLE_DRY_RUN === 'true' ? 'DRY RUN' : 'LIVE';

      const posLines = openPos.length > 0
        ? openPos.map(p => `  • ${p.symbol} ${p.side} @ $${p.entryPrice.toFixed(4)}`).join('\n')
        : '  None';

      await send([
        `⚙️ *Bot Status*`,
        ``,
        `Mode: ${mode}`,
        `Timeframe: \`${process.env.TIMEFRAME || '1h'}\`  ADX≥${process.env.ADX_MIN || '32'}`,
        `Balance: $${balance.toFixed(2)}`,
        `Uptime: ${uptimeH}h  |  Cycles: ${stats.totalTrades} trades today`,
        ``,
        `*Open Positions (${openPos.length}):*`,
        posLines,
      ].join('\n'));
      break;
    }

    case '/report': {
      const msg = buildDailyReportMessage(
        getBalance(),
        getBalance(),
        getTickers(),
        getBotStart()
      );
      await send(msg);
      break;
    }

    case '/setbull': {
      await send(`🟢 Switching to *BULL mode*...\n\`TIMEFRAME=4h\`  \`ADX_MIN=25\`\n\nRestarting bot...`);
      updateEnvKey('TIMEFRAME', '4h');
      updateEnvKey('ADX_MIN', '25');
      logger.info('Telegram command: switching to BULL mode (4h/ADX25), restarting');
      setTimeout(() => process.exit(0), 1000);
      break;
    }

    case '/setbear': {
      await send(`🔴 Switching to *BEAR mode*...\n\`TIMEFRAME=1h\`  \`ADX_MIN=32\`\n\nRestarting bot...`);
      updateEnvKey('TIMEFRAME', '1h');
      updateEnvKey('ADX_MIN', '32');
      logger.info('Telegram command: switching to BEAR mode (1h/ADX32), restarting');
      setTimeout(() => process.exit(0), 1000);
      break;
    }

    case '/restart': {
      await send(`🔄 Restarting bot...`);
      logger.info('Telegram command: manual restart');
      setTimeout(() => process.exit(0), 1000);
      break;
    }

    default: {
      await send([
        `*Available commands:*`,
        `/status  — balance, open positions, config`,
        `/report  — full PnL report`,
        `/setbull — switch to 4h bull mode + restart`,
        `/setbear — switch to 1h bear mode + restart`,
        `/restart — restart the bot`,
      ].join('\n'));
    }
  }
}

export class TelegramCommandHandler {
  private offset   = 0;
  private running  = false;
  private getBalance:  BalanceGetter;
  private getTickers:  TickersGetter;
  private getBotStart: BotStartGetter;

  constructor(
    getBalance: BalanceGetter,
    getTickers: TickersGetter,
    getBotStart: BotStartGetter
  ) {
    this.getBalance  = getBalance;
    this.getTickers  = getTickers;
    this.getBotStart = getBotStart;
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

        const updates = resp.data.result as any[];

        for (const update of updates) {
          this.offset = update.update_id + 1;

          const msg = update.message;
          if (!msg || !msg.text) continue;

          // Security: only respond to the configured chat ID
          if (String(msg.chat.id) !== String(chatId)) continue;

          // Only handle messages that start with /
          if (!msg.text.startsWith('/')) continue;

          logger.info(`Telegram command received: ${msg.text}`);
          await handleCommand(msg.text, this.getBalance, this.getTickers, this.getBotStart);
        }
      } catch (error: any) {
        if (this.running) {
          logger.warn(`Telegram poll error: ${error.message}`);
          // Back off 5s on error before retrying
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }
}

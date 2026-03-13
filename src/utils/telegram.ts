import axios from 'axios';
import logger from './logger';

/**
 * Send a Telegram message via bot API.
 * Silently no-ops if TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID are not set.
 */
export async function sendTelegramMessage(text: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'Markdown' },
      { timeout: 8000 }
    );
  } catch (error) {
    logger.warn(`Telegram notification failed: ${error}`);
  }
}

/**
 * Logger module for structured logging of all bot activities
 */

import winston from 'winston';
import path from 'path';
import fs from 'fs';

const LOG_DIR = process.env.LOG_DIR || './logs';

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'trading-bot' },
  transports: [
    // Error logs
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
    // Combined logs
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 10,
    }),
    // Console
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
          return `${timestamp} [${level}]: ${message} ${metaStr}`;
        })
      ),
    }),
  ],
});

export default logger;

/**
 * Specialized loggers for different modules
 */
export const tradeLogger = {
  newTrade: (trade: any) => {
    const tradeLog = {
      timestamp: new Date().toISOString(),
      type: 'NEW_TRADE',
      ...trade,
    };
    logger.info('NEW_TRADE', tradeLog);
    saveTrade(tradeLog);
  },

  closeTrade: (trade: any) => {
    const tradeLog = {
      timestamp: new Date().toISOString(),
      type: 'CLOSE_TRADE',
      ...trade,
    };
    logger.info('CLOSE_TRADE', tradeLog);
    saveTrade(tradeLog);
  },

  updatePosition: (position: any) => {
    logger.debug('UPDATE_POSITION', position);
  },

  safetyRuleTrigger: (rule: string, details: any) => {
    const log = {
      timestamp: new Date().toISOString(),
      type: 'SAFETY_RULE_TRIGGERED',
      rule,
      details,
    };
    logger.warn('SAFETY_RULE_TRIGGERED', log);
  },

  signalGenerated: (signal: any) => {
    logger.info('SIGNAL_GENERATED', {
      timestamp: new Date().toISOString(),
      symbol: signal.symbol,
      direction: signal.direction,
      confidence: signal.confidence,
    });
  },

  error: (error: Error, context?: string) => {
    logger.error('ERROR', { error: error.message, context, stack: error.stack });
  },
};

function saveTrade(trade: any) {
  const filename = path.join(LOG_DIR, 'trades.jsonl');
  fs.appendFileSync(filename, JSON.stringify(trade) + '\n');
}

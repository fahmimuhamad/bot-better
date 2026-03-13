/**
 * Trading Bot — Main entry point
 */
import 'dotenv/config';

import logger from './utils/logger';
import { DataFetcher } from './data/fetcher';
import { SignalGenerator } from './signals/generator';
import OrderExecutor from './trading/order-executor';
import positionManager from './trading/position-manager';
import { BotConfig, Position, BinanceTickerData } from './types';
import { OHLCV } from './backtest/data-loader';
import { getOrderStatus, getTradingBalance } from './exchange/trading-client';
import { sendTelegramMessage } from './utils/telegram';
import { RegimeMonitor, detectRegime, resampleCandles } from './utils/regime-detector';
import { DailyReportScheduler } from './utils/daily-report';
import { TelegramCommandHandler } from './utils/telegram-commands';

// Curated coin lists — optimized per timeframe
const CURATED_COINS_4H = [
  'BTC','ETH','BNB','ADA','DOGE','AVAX',
  'ARB','OP','SHIB','SUI','FLOW','HBAR','TON',
  'ZIL','ALICE','CVC','GLM','PEOPLE','OG',
  'QUICK','OXT','DENT','AGLD','GTC',
];
const CURATED_COINS_1H = [
  'BTC','ETH','BNB','ADA','DOGE','AVAX',
  'ARB','OP','SHIB','SUI','FLOW','HBAR','TON',
  'SAND','CHZ','ZIL','ALICE','ID','CVC','GLM','SXP',
  'PEOPLE','STG','DODO','OG','PORTO',
  'QUICK','DENT','IOTX','COTI','FLUX','GTC','MEME','DF','GNS',
];

// SCAN_COINS env override (comma-separated); if set, used regardless of regime
const SCAN_COINS_OVERRIDE = process.env.SCAN_COINS?.trim()
  ? process.env.SCAN_COINS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : null;

/**
 * Parse configuration from environment
 */
function loadConfig(): BotConfig {
  return {
    riskPerTrade: parseFloat(process.env.RISK_PER_TRADE || '2'),
    leverage: parseFloat(process.env.LEVERAGE || '5'),
    entryMode: (process.env.ENTRY_MODE as 'aggressive' | 'conservative') || 'aggressive',
    minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '80'),
    maxOpenTrades: parseFloat(process.env.MAX_OPEN_TRADES || '10'),
    closeAtTp1: process.env.CLOSE_AT_TP1 === 'true',
    takeHalfAtTp1MoveSlToEntry: process.env.TAKE_50_AT_TP1_MOVE_SL === 'true',
    trailingStop: process.env.TRAILING_STOP !== 'false',
    quoteCurrency: process.env.QUOTE_CURRENCY || 'USDT',
    dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT || '3'),
    slDistancePct: parseFloat(process.env.SL_ATR_MIN_PCT || process.env.SL_DISTANCE_PCT || '2'),
    tp1Percent: parseFloat(process.env.TP1_PERCENT || '2'),
    tp2Percent: parseFloat(process.env.TP2_PERCENT || '4'),
    refreshCycle: parseFloat(process.env.REFRESH_CYCLE || '120000'),
    useTestnet: (process.env.EXCHANGE || 'binance').toLowerCase() === 'bybit'
      ? process.env.BYBIT_TESTNET === 'true'
      : process.env.BINANCE_USE_TESTNET === 'true',
    dryRun: process.env.ENABLE_DRY_RUN === 'true',
    paperTrading: process.env.ENABLE_PAPER_TRADING === 'true',
  };
}

/**
 * Main Bot Class
 */
class TradingBot {
  private config: BotConfig;
  private dataFetcher: DataFetcher;
  private signalGenerator: SignalGenerator;
  private orderExecutor: OrderExecutor;
  private isRunning = false;
  private cycleCount = 0;
  private startBalance = 0;
  private currentRegime: 'bull' | 'bear' = 'bear';
  private regimeMonitor    = new RegimeMonitor();
  private dailyReport      = new DailyReportScheduler();
  private botStartTime     = Date.now();
  private lastBalance      = 0;
  private lastTickers      = new Map<string, BinanceTickerData>();
  private commandHandler   = new TelegramCommandHandler(
    () => this.lastBalance || this.startBalance,
    () => this.lastTickers,
    () => this.botStartTime,
    () => this.stop(),
    () => this.start(),
    () => this.isRunning
  );

  constructor(config: BotConfig) {
    this.config = config;
    this.dataFetcher = new DataFetcher();
    this.signalGenerator = new SignalGenerator();
    this.orderExecutor = new OrderExecutor(config, 0); // Will update with real balance
  }

  /**
   * Initialize bot
   */
  async initialize(): Promise<boolean> {
    try {
      logger.info('🤖 Trading Bot Initializing', {
        mode: this.config.dryRun ? 'DRY RUN' : this.config.paperTrading ? 'PAPER TRADING' : 'LIVE',
        testnet: this.config.useTestnet,
        config: this.config,
      });

      // Check readiness
      const readiness = await this.orderExecutor.getReadinessStatus();

      if (!readiness.ready) {
        logger.error('Bot is not ready to trade', 'initialize');
        logger.warn('Readiness checks failed', readiness.checks);
        
        if (this.config.dryRun) {
          logger.info('Running in DRY RUN mode - will continue anyway');
        } else {
          return false;
        }
      }

      // Set starting balance from trading exchange (Bybit or Binance per EXCHANGE)
      if (!this.config.dryRun && !this.config.paperTrading) {
        const { getTradingBalance } = await import('./exchange/trading-client');
        try {
          this.startBalance = await getTradingBalance();
        } catch (e) {
          logger.warn('Could not fetch start balance, using default', { error: String(e) });
        }
      }
      if (this.startBalance <= 0) {
        this.startBalance = 150; // Fallback default
      }

      logger.info('✅ Bot initialized successfully', {
        startBalance: this.startBalance,
        readiness: readiness.checks,
      });

      return true;
    } catch (error) {
      logger.error(`Initialization failed: ${error}`, 'initialize');
      return false;
    }
  }

  /**
   * Main trading cycle (120 seconds)
   */
  async runCycle(): Promise<void> {
    const cycleStartTime = Date.now();
    this.cycleCount++;

    try {
      logger.info(`\n=== CYCLE #${this.cycleCount} Started ===`);

      // Step 0: Auto regime detection — BTC daily EMA200
      const btcDaily = await this.dataFetcher.fetchOhlcvData('BTC', '1d', 250);
      const detectedRegime = detectRegime(btcDaily as OHLCV[]);
      if (detectedRegime !== this.currentRegime) {
        logger.info(`🔄 Regime switched: ${this.currentRegime.toUpperCase()} → ${detectedRegime.toUpperCase()}`);
        this.currentRegime = detectedRegime;
      }

      // Select coin list and signal timeframe based on regime
      // SCAN_COINS env overrides regime-based selection if set
      const activeCoinList = SCAN_COINS_OVERRIDE
        ? SCAN_COINS_OVERRIDE
        : this.currentRegime === 'bull' ? CURATED_COINS_4H : CURATED_COINS_1H;
      const signalTimeframe = this.currentRegime === 'bull' ? '4h' : '1h';

      // Step 1: Fetch data for active coins
      // fetchCoinsBySymbols expects USDT-suffixed symbols; tickers/funding expect base names
      const scanSymbols = activeCoinList.map(sym => `${sym}USDT`);
      const coins = await this.dataFetcher.fetchCoinsBySymbols(scanSymbols);
      const [tickers, fundingRates] = await Promise.all([
        this.dataFetcher.fetch24hrTickers(activeCoinList),
        this.dataFetcher.fetchFundingRates(activeCoinList),
      ]);
      this.lastTickers = tickers;

      logger.info(`Data fetched`, {
        regime: this.currentRegime.toUpperCase(),
        coins: activeCoinList.length,
        timeframe: signalTimeframe,
        tickers: tickers.size,
        fundingRates: fundingRates.size,
      });

      // Step 1b: Fetch OHLCV for active coins (timeframe matches regime)
      const ohlcvMap = new Map<string, OHLCV[]>();
      await Promise.all(
        coins.map(async (c) => {
          const candles = await this.dataFetcher.fetchOhlcvData(c.symbol, signalTimeframe, 250);
          if (candles.length >= 20) ohlcvMap.set(c.symbol, candles as OHLCV[]);
        })
      );
      logger.debug(`OHLCV loaded for ${ohlcvMap.size} symbols`);

      // Step 2: Generate signals with HTF candles (resample signal TF × 4 for trend filter)
      const signals = coins
        .map(c => {
          const ticker = tickers.get(c.symbol);
          const ohlcv = ohlcvMap.get(c.symbol);
          if (!ticker || !ohlcv) return null;
          const htfCandles = resampleCandles(ohlcv as OHLCV[], 4);
          return this.signalGenerator.generateSignal(c, ticker, fundingRates.get(c.symbol), ohlcv as OHLCV[], htfCandles);
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);
      const filteredSignals = signals.filter(s => s.confidence >= this.config.minConfidence);

      logger.info(`Signals generated`, {
        total: signals.length,
        filtered: filteredSignals.length,
        minConfidence: this.config.minConfidence,
      });

      // Step 3: Get current positions
      const openPositions = positionManager.getOpenPositions();
      logger.info(`Current positions`, {
        count: openPositions.length,
        max: this.config.maxOpenTrades,
      });

      // Step 3b: Get current balance from exchange (used for risk-based position sizing)
      let currentBalance = this.startBalance;
      if (!this.config.dryRun && !this.config.paperTrading) {
        try {
          currentBalance = await getTradingBalance();
          if (currentBalance <= 0) {
            logger.warn('Current balance is 0 or negative; skipping new trades');
          }
        } catch (e) {
          logger.warn('Could not fetch current balance; using start balance', { error: String(e) });
        }
      }
      this.lastBalance = currentBalance;
      logger.info('Balance for position sizing', { currentBalance: currentBalance.toFixed(2), riskPerTrade: this.config.riskPerTrade + '%' });

      // Step 4: Execute new trades (position size calculated from current balance + RISK_PER_TRADE from .env)
      if (filteredSignals.length > 0 && openPositions.length < this.config.maxOpenTrades && currentBalance > 0) {
        for (const signal of filteredSignals.slice(0, this.config.maxOpenTrades - openPositions.length)) {
          const result = await this.orderExecutor.executeSignal(
            signal,
            currentBalance,
            openPositions
          );

          if (result.success) {
            logger.info(`✅ Trade executed`, {
              symbol: signal.symbol,
              direction: signal.direction,
              confidence: signal.confidence,
            });
          } else {
            logger.warn(`❌ Trade failed`, {
              symbol: signal.symbol,
              reason: result.message,
            });
          }
        }
      }

      // Step 5: Manage open positions
      for (const position of openPositions) {
        const ticker = tickers.get(position.symbol);
        if (!ticker) continue;

        const currentPrice = parseFloat(ticker.lastPrice);
        const { tp1Hit, shouldClose } = positionManager.updatePosition(position.id, currentPrice, this.config);

        if (shouldClose) {
          logger.info(`📊 Position status change`, {
            positionId: position.id,
            symbol: position.symbol,
            exitReason: shouldClose,
            currentPrice,
          });

          const reason = shouldClose as 'TP1' | 'TP2' | 'SL' | 'TRAILING_STOP' | 'MANUAL';
          await this.orderExecutor.closePosition(position.id, currentPrice, reason);
        } else {
          // Detect TP1 hit by order status (in case price check missed it)
          if (position.tp1OrderId && !position.tp1Hit) {
            const status = await getOrderStatus(position.symbol, position.tp1OrderId);
            if (status === 'Filled') {
              positionManager.markTp1Hit(position.id);
            }
          }
          if (position.tp1Hit && position.slOrderId && !position.slMovedToEntry) {
            // TP1 hit (by price or TP1 order filled): cancel initial SL order and set position SL to entry on exchange
            await this.orderExecutor.moveSlToEntryAfterTp1(position);
          }
        }
      }

      // Step 6: Regime check — alert via Telegram if market regime mismatches .env TIMEFRAME
      await this.regimeMonitor.checkAndAlert(sendTelegramMessage);

      // Step 6b: Daily report — send to Telegram at 7am WIB
      this.dailyReport.tick(sendTelegramMessage, currentBalance, this.startBalance, tickers, this.botStartTime);

      // Step 7: Log statistics
      const stats = positionManager.getDailyStats();
      logger.info(`Daily Statistics`, {
        totalTrades: stats.totalTrades,
        wins: stats.wins,
        losses: stats.losses,
        winRate: stats.winRate.toFixed(2) + '%',
        totalPnL: stats.totalPnL.toFixed(2),
        profitFactor: stats.profitFactor.toFixed(2),
      });

      const cycleTime = Date.now() - cycleStartTime;
      logger.info(`=== CYCLE #${this.cycleCount} Completed (${cycleTime}ms) ===\n`);
    } catch (error) {
      logger.error(`Cycle failed: ${error}`, 'runCycle');
    }
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Bot is already running');
      return;
    }

    const initialized = await this.initialize();
    if (!initialized) {
      logger.error('Bot initialization failed — exiting', 'start');
      process.exit(1);
    }

    this.isRunning = true;
    this.commandHandler.start();
    logger.info('🚀 Starting trading cycles', {
      refreshCycle: this.config.refreshCycle + 'ms',
      mode: this.config.dryRun ? 'DRY RUN' : 'LIVE',
      regimeDetection: 'auto (BTC daily EMA200)',
      coinListOverride: SCAN_COINS_OVERRIDE ? SCAN_COINS_OVERRIDE.join(',') : 'none',
    });

    // Run initial cycle
    await this.runCycle();

    // Schedule next cycles
    const interval = setInterval(async () => {
      if (this.isRunning) {
        await this.runCycle();
      }
    }, this.config.refreshCycle);

    // Graceful shutdown handler
    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      this.stop();
      clearInterval(interval);
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      this.stop();
      clearInterval(interval);
      process.exit(0);
    });
  }

  /**
   * Stop the bot
   */
  stop(): void {
    this.isRunning = false;
    this.commandHandler.stop();
    logger.info('🛑 Bot stopped', {
      cyclesRun: this.cycleCount,
      openPositions: positionManager.getOpenPositions().length,
    });
  }

  /**
   * Get bot status
   */
  getStatus(): any {
    return {
      running: this.isRunning,
      cycleCount: this.cycleCount,
      config: this.config,
      openPositions: positionManager.getOpenPositions().length,
      dailyStats: positionManager.getDailyStats(),
    };
  }
}

/**
 * Entry Point
 */
async function main() {
  try {
    const config = loadConfig();
    const bot = new TradingBot(config);

    const exchange = (process.env.EXCHANGE || 'binance').toLowerCase();
    logger.info('📋 Bot Configuration Loaded', {
      trading: exchange === 'bybit' ? 'Bybit' : 'Binance',
      analysis: 'Binance',
      testnet: config.useTestnet,
      riskPerTrade: config.riskPerTrade + '%',
      leverage: config.leverage + 'x',
      entryMode: config.entryMode,
      minConfidence: config.minConfidence,
      maxOpenTrades: config.maxOpenTrades,
      trailingStop: config.trailingStop,
      dryRun: config.dryRun,
      paperTrading: config.paperTrading,
    });

    await bot.start();
  } catch (error) {
    logger.error(`Bot startup failed: ${error}`, 'main');
    process.exit(1);
  }
}

// Start the bot
main().catch(error => {
  logger.error(error, 'main');
  process.exit(1);
});

export { TradingBot };

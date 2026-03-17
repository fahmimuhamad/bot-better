/**
 * Trading Bot — Main entry point
 */
import 'dotenv/config';

import logger from './utils/logger';
import { DataFetcher } from './data/fetcher';
import { SignalGenerator } from './signals/generator';
import { BullSignalGenerator } from './signals/bull-signal-generator';
import { FuturesDataFetcher } from './data/futures-fetcher';
import { PumpScanner } from './signals/pump-scanner';
import { LiquidationAnalyzer } from './signals/liquidation-analyzer';
import OrderExecutor from './trading/order-executor';
import positionManager from './trading/position-manager';
import { BotConfig, TradeSignal, BinanceTickerData } from './types';
import { OHLCV } from './backtest/data-loader';
import { getOrderStatus, getTradingBalance, getExchangeOpenPositions, getConfirmedWithdrawals, getLastClosedPosition } from './exchange/trading-client';
const RECONCILE_EVERY_N_CYCLES = 10; // check exchange vs local every ~20 min
import { sendTelegramMessage } from './utils/telegram';
import { detectRegime, resampleCandles } from './utils/regime-detector';
import { DailyReportScheduler } from './utils/daily-report';
import { TelegramCommandHandler } from './utils/telegram-commands';
import fs from 'fs';
import path from 'path';

// Curated coin lists — optimized per timeframe
// Bull 4H: verified profitable in 2024-01-01→2026-03-13 regime backtest
// v5 list: +11264% ROI vs v2 +2156% (17 coins, last updated 2026-03-16)
const CURATED_COINS_4H = [
  // Core — 40%+ WR
  'BTC','ETH','BNB','ADA','DOGE',
  // Borderline — 35-36% WR, keep for diversification
  'ARB','HBAR',
  // Added batch 1: TRX(44.4%WR), MANA(40.9%), RAY(47.1%), BLUR(52.9%), JST(36%)
  'TRX','MANA','RAY','BLUR','JST',
  // Added batch 2: PSG(46.9%WR), AUDIO(58.8%), ATM(33.3%), ZEC(43.5%), SANTOS(40.7%)
  'PSG','AUDIO','ATM','ZEC','SANTOS',
  // Added batch 3: PAXG(41.7%WR, 36 trades) — tokenized gold, uncorrelated with crypto trends
  'PAXG',
];
// Bear 1H: verified profitable in 2024-01-01→2026-03-16 regime backtest (bear-only)
// v2 list: +1865% ROI vs v1 +565% (36 coins, last updated 2026-03-16)
// Removed: ETH(12%WR -$30), ARB(14%WR -$27), ALICE(33%WR -$34), GLM(33%WR -$10), GTC(33%WR -$13)
// Added: HFT(71%WR), SUSHI(75%WR), UTK(67%WR), AUCTION(60%WR), CELR(50%WR), ACH(30%WR)
const CURATED_COINS_1H = [
  'BTC','BNB','ADA','DOGE','AVAX',
  'OP','SHIB','SUI','FLOW','HBAR','TON',
  'SAND','CHZ','ZIL','ID','CVC','SXP',
  'PEOPLE','STG','DODO','OG','PORTO',
  'QUICK','DENT','IOTX','COTI','FLUX','MEME','DF','GNS',
  'CELR','SUSHI','ACH','HFT','UTK','AUCTION',
];

// SCAN_COINS env override (comma-separated); if set, used regardless of regime
const SCAN_COINS_OVERRIDE = process.env.SCAN_COINS?.trim()
  ? process.env.SCAN_COINS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : null;

// Separate lower risk for bull trades (default 2.0% vs bear 3.5%)
const BULL_RISK_PCT = parseFloat(process.env.BULL_RISK_PCT || '2.0');

/**
 * Parse configuration from environment
 */
function loadConfig(): BotConfig {
  return {
    riskPerTrade: parseFloat(process.env.RISK_PER_TRADE || '3.5'),
    leverage: parseFloat(process.env.LEVERAGE || '15'),
    entryMode: (process.env.ENTRY_MODE as 'aggressive' | 'conservative') || 'aggressive',
    minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '65'),
    maxOpenTrades: parseFloat(process.env.MAX_OPEN_TRADES || '5'),
    closeAtTp1: process.env.CLOSE_AT_TP1 === 'true',
    takeHalfAtTp1MoveSlToEntry: process.env.TAKE_50_AT_TP1_MOVE_SL === 'true',
    trailingStop: process.env.TRAILING_STOP !== 'false',
    quoteCurrency: process.env.QUOTE_CURRENCY || 'USDT',
    dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT || '5'),
    slDistancePct: parseFloat(process.env.SL_ATR_MIN_PCT || process.env.SL_DISTANCE_PCT || '1.5'),
    tp1Percent: parseFloat(process.env.TP1_PERCENT || '2'),
    tp2Percent: parseFloat(process.env.TP2_PERCENT || '5'),
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
  private bullSignalGenerator = new BullSignalGenerator();
  private futuresDataFetcher  = new FuturesDataFetcher();
  private pumpScanner         = new PumpScanner();
  private liqAnalyzer         = new LiquidationAnalyzer();
  private orderExecutor: OrderExecutor;
  private isRunning = false;
  private cycleCount = 0;
  private startBalance = 0;
  private currentRegime: 'bull' | 'bear' = 'bear';
  private dailyReport      = new DailyReportScheduler();
  private botStartTime     = Date.now();
  private lastBalance      = 0;
  private lastTickers      = new Map<string, BinanceTickerData>();
  private commandHandler   = new TelegramCommandHandler(
    () => this.lastBalance || this.startBalance,
    () => this.startBalance,
    () => this.currentRegime,
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

      // Load persisted state (positions, order IDs, tp1Hit, re-entry cooldowns)
      positionManager.loadState();

      // Fetch balance and open positions in parallel
      if (!this.config.dryRun && !this.config.paperTrading) {
        const [balance, exchangePositions] = await Promise.allSettled([
          getTradingBalance(),
          getExchangeOpenPositions(),
        ]);
        if (balance.status === 'fulfilled') {
          this.startBalance = balance.value;
        } else {
          logger.warn('Could not fetch start balance, using default', { error: String(balance.reason) });
        }
        if (exchangePositions.status === 'fulfilled' && exchangePositions.value.length > 0) {
          logger.info(`Restoring ${exchangePositions.value.length} open position(s) from exchange`);
          for (const p of exchangePositions.value) {
            positionManager.restorePositionFromExchange(p);
          }
        } else if (exchangePositions.status === 'rejected') {
          logger.warn(`Could not restore positions from exchange: ${exchangePositions.reason}`);
        }
      }
      if (this.startBalance <= 0) {
        this.startBalance = 150; // Fallback default
      }

      // Initialize safety enforcer with real balance so daily loss limit works
      this.orderExecutor.updateStartBalance(this.startBalance);

      // Load or create trading journal (persists across restarts; used for total PnL / ROI on dashboard)
      positionManager.ensureJournal(this.startBalance);

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

      // Step 2: Generate signals — regime-specific pipeline
      let signals: TradeSignal[];

      if (this.currentRegime === 'bear') {
        // ── BEAR: EMA pullback strategy (unchanged) ──────────────────────────
        signals = coins
          .map(c => {
            const ticker = tickers.get(c.symbol);
            const ohlcv  = ohlcvMap.get(c.symbol);
            if (!ticker || !ohlcv) return null;
            const htfCandles = resampleCandles(ohlcv as OHLCV[], 4);
            return this.signalGenerator.generateSignal(c, ticker, fundingRates.get(c.symbol), ohlcv as OHLCV[], htfCandles);
          })
          .filter((s): s is TradeSignal => s !== null);

      } else {
        // ── BULL: Pump scan + liquidation analysis + EMA pullback sweep ──────
        const futuresMap = await this.futuresDataFetcher.fetchFuturesData(activeCoinList);
        this.futuresDataFetcher.logFetchSummary(futuresMap, activeCoinList.length);

        signals = (
          await Promise.all(
            coins.map(async (c) => {
              const ticker  = tickers.get(c.symbol);
              const ohlcv   = ohlcvMap.get(c.symbol);
              if (!ticker || !ohlcv) return null;
              const futures = futuresMap.get(c.symbol) ?? null;
              const pump    = this.pumpScanner.scan(ohlcv as OHLCV[], futures);
              const liqMap  = this.liqAnalyzer.analyze(c.symbol, ohlcv as OHLCV[], c.price);
              return this.bullSignalGenerator.generateSignal(
                c, ticker, ohlcv as OHLCV[], pump, liqMap, fundingRates.get(c.symbol)
              );
            })
          )
        ).filter((s): s is TradeSignal => s !== null);
      }

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

      // Step 3c: Exchange reconciliation — every cycle, free slot immediately when position closes
      if (!this.config.dryRun && !this.config.paperTrading) {
        try {
          const exchangePositions = await getExchangeOpenPositions();
          const exchangeSymbols = new Set(exchangePositions.map(ep => ep.symbol));
          for (const pos of positionManager.getOpenPositions()) {
            if (!exchangeSymbols.has(pos.symbol)) {
              // Get actual exit price from Bybit closed PnL history
              let exitPrice = parseFloat(tickers.get(pos.symbol)?.lastPrice ?? '0') || pos.entryPrice;
              let exitReason: 'TP1' | 'TP2' | 'SL' | 'TRAILING_STOP' | 'MANUAL' = 'MANUAL';
              try {
                const closed = await getLastClosedPosition(pos.symbol);
                if (closed && closed.avgExitPrice > 0) {
                  exitPrice = closed.avgExitPrice;
                  // Infer reason from price relative to SL/TP2
                  if (pos.tp2 && Math.abs(exitPrice - pos.tp2) / pos.tp2 < 0.005) exitReason = 'TP2';
                  else if (pos.stopLoss && Math.abs(exitPrice - pos.stopLoss) / pos.stopLoss < 0.005) exitReason = 'SL';
                }
              } catch (_) {}
              logger.warn(`Reconciliation: ${pos.symbol} not on exchange — closing locally as ${exitReason} @ ${exitPrice}`);
              positionManager.closePosition(pos.id, exitPrice, exitReason);
              positionManager.recordExit(pos.symbol);
            }
          }
        } catch (e) {
          logger.warn(`Reconciliation failed: ${e}`);
        }

        // Auto-sync confirmed Bybit withdrawals → data/withdrawals.json (every 10 cycles)
      if (this.cycleCount % RECONCILE_EVERY_N_CYCLES === 0 && !this.config.dryRun && !this.config.paperTrading) {
        try {
          const WITHDRAWALS_FILE = path.join(process.cwd(), 'data', 'withdrawals.json');
          let stored: { withdrawals: { withdrawId?: string; amount: number; timestamp: number; note: string }[] } = { withdrawals: [] };
          try { if (fs.existsSync(WITHDRAWALS_FILE)) stored = JSON.parse(fs.readFileSync(WITHDRAWALS_FILE, 'utf-8')); } catch (_) {}
          const knownIds = new Set(stored.withdrawals.map(w => w.withdrawId).filter(Boolean));
          const fresh = await getConfirmedWithdrawals();
          let added = 0;
          for (const w of fresh) {
            if (!knownIds.has(w.withdrawId)) {
              stored.withdrawals.push({ withdrawId: w.withdrawId, amount: w.amount, timestamp: w.createTime, note: 'auto-detected' });
              added++;
            }
          }
          if (added > 0) {
            fs.writeFileSync(WITHDRAWALS_FILE, JSON.stringify(stored, null, 2));
            logger.info(`Auto-recorded ${added} new withdrawal(s) from Bybit`);
          }
        } catch (e) {
          logger.warn(`Withdrawal sync failed: ${e}`);
        }
      }
      }

      // Step 4: Execute new trades (position size calculated from current balance + RISK_PER_TRADE from .env)
      const REENTRY_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12h — matches backtest REENTRY_COOLDOWN=12
      const readySignals = filteredSignals.filter(s => {
        const lastExit = positionManager.getLastExitTime(s.symbol);
        if (lastExit && Date.now() - lastExit < REENTRY_COOLDOWN_MS) {
          logger.debug(`${s.symbol} in re-entry cooldown (${Math.round((Date.now() - lastExit) / 60000)}m elapsed, 720m required)`);
          return false;
        }
        return true;
      });

      if (readySignals.length > 0 && openPositions.length < this.config.maxOpenTrades && currentBalance > 0) {
        for (const signal of readySignals.slice(0, this.config.maxOpenTrades - openPositions.length)) {
          // Re-fetch live positions before each signal so maxOpenTrades cap is accurate
          const livePositions = positionManager.getOpenPositions();
          if (livePositions.length >= this.config.maxOpenTrades) break;

          // Use lower risk for bull trades
          const prevRisk = this.config.riskPerTrade;
          if (this.currentRegime === 'bull') this.config.riskPerTrade = BULL_RISK_PCT;

          const result = await this.orderExecutor.executeSignal(
            signal,
            currentBalance,
            livePositions
          );

          this.config.riskPerTrade = prevRisk;

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
        if (!isFinite(currentPrice) || currentPrice <= 0) {
          logger.warn(`Invalid ticker price for ${position.symbol}: ${ticker.lastPrice} — skipping position update`);
          continue;
        }
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
          positionManager.recordExit(position.symbol);
        } else {
          // Detect TP1 hit by order status (in case price check missed it)
          if (position.tp1OrderId && !position.tp1Hit) {
            const status = await getOrderStatus(position.symbol, position.tp1OrderId);
            if (status === 'Filled') {
              positionManager.markTp1Hit(position.id);
            } else if (status === null) {
              logger.warn(`TP1 order status unavailable for ${position.symbol} orderId=${position.tp1OrderId} — will retry next cycle`);
            }
          }
          if (position.tp1Hit && position.slOrderId && !position.slMovedToEntry) {
            // TP1 hit (by price or TP1 order filled): cancel initial SL order and set position SL to entry on exchange
            await this.orderExecutor.moveSlToEntryAfterTp1(position);
          }
        }
      }

      // Step 6: Daily report — send to Telegram at 7am WIB; also reset safety enforcer balance
      const dayRolled = this.dailyReport.tick(sendTelegramMessage, currentBalance, this.startBalance, tickers, this.botStartTime);
      if (dayRolled) {
        this.startBalance = currentBalance;
        this.orderExecutor.updateStartBalance(currentBalance);
        logger.info('Day rolled over — safety enforcer balance reset', { newStartBalance: currentBalance });
      }

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

      // Write dashboard status (minimal; dashboard server reads this + exchange)
      try {
        const statusPath = path.join(process.cwd(), 'data', 'dashboard-status.json');
        const dir = path.dirname(statusPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const mode = this.config.dryRun ? 'DRY_RUN' : this.config.paperTrading ? 'PAPER' : 'LIVE';
        fs.writeFileSync(statusPath, JSON.stringify({
          regime: this.currentRegime,
          dailyStats: positionManager.getDailyStats(),
          mode,
          uptimeMs: Date.now() - this.botStartTime,
          openPositionsCount: positionManager.getOpenPositions().length,
          lastScanTime: Date.now(),
          timestamp: Date.now(),
        }, null, 0));
      } catch (_) { /* ignore */ }
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

/**
 * Backtest Engine
 * Simulates trading strategy on historical data
 */

import logger from '../utils/logger';
import signalGenerator from '../signals/generator';
import { SafetyRulesEnforcer } from '../risk/safety-rules';
import { TradeSignal, CoinMarketData, BinanceTickerData, Trade, BotConfig, Position } from '../types';
import { OHLCV } from './data-loader';

export interface BacktestConfig extends BotConfig {
  startBalance: number;
  symbol: string;
  interval: string;
  slippage: number; // Entry/exit slippage in %
  fees: number; // Binance maker/taker fee
}

export interface BacktestStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  totalPnlPercent: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  sharpeRatio: number;
  bestTrade: Trade | null;
  worstTrade: Trade | null;
  tradesByConfidence: Map<string, number>;
  equityCurve: { timestamp: number; balance: number }[];
}

interface BacktestPosition extends Position {
  signal: TradeSignal;
  executedEntryPrice: number;
  entryTime: number;
}

export class BacktestEngine {
  private config: BacktestConfig;
  private trades: Trade[] = [];
  private positions: Map<string, BacktestPosition> = new Map();
  private safetyRules: SafetyRulesEnforcer;
  private currentBalance: number;
  private startBalance: number;
  private equityCurve: { timestamp: number; balance: number }[] = [];
  private dailyPnlMap: Map<string, number> = new Map();
  private historicalKlines: OHLCV[] = [];
  // Cooldown: candle index when each symbol last had a position close.
  // Prevents re-entering the same coin immediately after a TP2/SL exit.
  private lastExitCandleIndex: Map<string, number> = new Map();
  private static readonly REENTRY_COOLDOWN_CANDLES = 12; // 12h cooldown after exit

  constructor(config: BacktestConfig) {
    this.config = config;
    this.startBalance = config.startBalance;
    this.currentBalance = config.startBalance;
    this.safetyRules = new SafetyRulesEnforcer(config.startBalance);
  }

  /**
   * Calculate Fibonacci retracement levels
   * @param high Highest price in recent period
   * @param low Lowest price in recent period
   * @param direction LONG or SHORT
   * @returns Entry level at 0.618 retracement
   */
  private calculateFibonacciEntry(
    high: number,
    low: number,
    direction: 'LONG' | 'SHORT'
  ): number {
    const range = high - low;
    const fib618 = 0.618;

    if (direction === 'LONG') {
      // For LONG: enter at support (lower entry) - 0.618 retracement from high
      // Entry = low + (high - low) * 0.618
      return low + range * fib618;
    } else {
      // For SHORT: enter at resistance (higher entry) - 0.618 retracement from low
      // Entry = high - (high - low) * 0.618
      return high - range * fib618;
    }
  }

  /** Number of candles that represent "24h" for priceChangePercent24h (1h candles = 24) */
  private static readonly CANDLES_24H = 24;

  /**
   * Convert OHLCV to CoinMarketData and BinanceTickerData for signal generation.
   * Uses true 24-period (e.g. 24h for 1h candles) price change so ALIGN_DIRECTION_WITH_24H filter can trigger in backtest.
   */
  private ohlcvToMarketData(ohlcv: OHLCV, klines: OHLCV[], index: number, symbol: string): {
    coin: CoinMarketData;
    ticker: BinanceTickerData;
  } {
    const previousOhlcv = index > 0 ? klines[index - 1] : null;
    const ohlcv24hAgo = index >= BacktestEngine.CANDLES_24H ? klines[index - BacktestEngine.CANDLES_24H] : null;
    // True 24h change (same as live: close now vs close 24h ago)
    const priceChange24h = ohlcv24hAgo ? ohlcv.close - ohlcv24hAgo.close : (previousOhlcv ? ohlcv.close - previousOhlcv.close : 0);
    const priceChangePercent24h = ohlcv24hAgo
      ? (priceChange24h / ohlcv24hAgo.close) * 100
      : (previousOhlcv ? (priceChange24h / previousOhlcv.close) * 100 : 0);

    // Rolling 24-period high/low/volume so backtest matches live 24h semantics
    const start = Math.max(0, index - BacktestEngine.CANDLES_24H + 1);
    const window = klines.slice(start, index + 1);
    const high24h = window.length > 0 ? Math.max(...window.map(c => c.high)) : ohlcv.high;
    const low24h = window.length > 0 ? Math.min(...window.map(c => c.low)) : ohlcv.low;
    const volume24h = window.length > 0 ? window.reduce((s, c) => s + c.quoteAssetVolume, 0) : ohlcv.quoteAssetVolume;

    const coin: CoinMarketData = {
      symbol,
      price: ohlcv.close,
      priceChange24h,
      priceChangePercent24h,
      volume24h,
      marketCap: 0,
      marketCapRank: 1,
      highPrice24h: high24h,
      lowPrice24h: low24h,
      circulatingSupply: 0,
      totalSupply: 0,
    };

    const ticker: BinanceTickerData = {
      symbol: `${symbol}USDT`,
      lastPrice: ohlcv.close.toString(),
      bidPrice: (ohlcv.close * 0.999).toString(),
      askPrice: (ohlcv.close * 1.001).toString(),
      volume: (window.length > 0 ? window.reduce((s, c) => s + c.volume, 0) : ohlcv.volume).toString(),
      quoteAssetVolume: volume24h.toString(),
      openTime: ohlcv.timestamp,
      closeTime: ohlcv.timestamp,
      firstTradeId: 0,
      lastTradeId: 0,
      count: ohlcv.numberOfTrades,
    };

    return { coin, ticker };
  }

  /**
   * Check if signal passes safety rules
   */
  private async checkSafetyRules(signal: TradeSignal): Promise<boolean> {
    const openPositions = Array.from(this.positions.values());

    const checks = await this.safetyRules.runAllChecks(
      this.config,
      this.currentBalance,
      openPositions as Position[],
      signal.symbol
    );

    const allPassed = checks.every(c => c.passed);
    return allPassed;
  }

  /**
   * Calculate position size based on risk
   */
  private calculatePositionSize(signal: TradeSignal): number {
    const riskAmount = (this.currentBalance * this.config.riskPerTrade) / 100;

    // Distance from entry to stop loss
    const slDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    const slPercent = (slDistance / signal.entryPrice) * 100;

    // Size based on risk: position_size = risk_amount / sl_distance_percent * entry_price
    const positionValue = riskAmount / (slPercent / 100);
    const quantity = positionValue / signal.entryPrice;

    // Ensure minimum order size (10 USDT)
    const minOrderSize = 10;
    if (quantity * signal.entryPrice < minOrderSize) {
      return minOrderSize / signal.entryPrice;
    }

    // Keep more decimal places for crypto (8 decimals is standard)
    return Math.floor(quantity * 100000000) / 100000000;
  }

  /**
   * Simulate trade execution with slippage
   */
  private executeEntryWithSlippage(signal: TradeSignal): number {
    const slippagePercent = this.config.slippage / 100;

    if (signal.direction === 'LONG') {
      // Assume we buy at ask + slippage
      return signal.entryPrice * (1 + slippagePercent);
    } else {
      // Assume we sell at bid - slippage
      return signal.entryPrice * (1 - slippagePercent);
    }
  }

  /**
   * Execute exit with slippage
   */
  private executeExitWithSlippage(price: number, direction: 'LONG' | 'SHORT'): number {
    const slippagePercent = this.config.slippage / 100;

    if (direction === 'LONG') {
      // Sell at bid - slippage
      return price * (1 - slippagePercent);
    } else {
      // Buy to cover at ask + slippage
      return price * (1 + slippagePercent);
    }
  }

  /**
   * Process signal and open position
   */
  private async processSignal(
    signal: TradeSignal,
    currentPrice: number,
    timestamp: number,
    currentCandle?: OHLCV
  ): Promise<void> {
    // Skip if already have position in this symbol
    if (Array.from(this.positions.values()).some(p => p.symbol === signal.symbol)) {
      return;
    }

    // Skip if in cooldown period after last exit (prevents re-entry chasing)
    const lastExitIdx = this.lastExitCandleIndex.get(signal.symbol);
    if (lastExitIdx !== undefined) {
      const candlesSinceExit = this.historicalKlines.length - 1 - lastExitIdx;
      if (candlesSinceExit < BacktestEngine.REENTRY_COOLDOWN_CANDLES) {
        logger.debug(
          `${signal.symbol} in cooldown (${candlesSinceExit}/${BacktestEngine.REENTRY_COOLDOWN_CANDLES} candles since last exit)`
        );
        return;
      }
    }

    // Check safety rules
    const safetyPassed = await this.checkSafetyRules(signal);
    if (!safetyPassed) {
      logger.debug(`Signal failed safety checks: ${signal.symbol}`);
      return;
    }

    // Calculate position size
    const quantity = this.calculatePositionSize(signal);

    // IMPROVEMENT 3: Conservative Entry Mode with Fibonacci levels
    let executedEntryPrice = this.executeEntryWithSlippage(signal);
    let actualEntryPrice = signal.entryPrice;

    if (this.config.entryMode === 'conservative' && currentCandle) {
      // Use Fibonacci retracement for entry
      const fibonacciEntry = this.calculateFibonacciEntry(
        currentCandle.high,
        currentCandle.low,
        signal.direction
      );

      // For LONG: Fibonacci entry should be lower (better entry)
      // For SHORT: Fibonacci entry should be higher (better entry)
      if (signal.direction === 'LONG' && fibonacciEntry < currentPrice) {
        actualEntryPrice = fibonacciEntry;
        executedEntryPrice = this.executeEntryWithSlippage({
          ...signal,
          entryPrice: fibonacciEntry,
        });

        logger.debug(
          `Conservative entry (LONG): Fibonacci level ${fibonacciEntry.toFixed(8)} < signal price ${currentPrice.toFixed(8)}`
        );
      } else if (signal.direction === 'SHORT' && fibonacciEntry > currentPrice) {
        actualEntryPrice = fibonacciEntry;
        executedEntryPrice = this.executeEntryWithSlippage({
          ...signal,
          entryPrice: fibonacciEntry,
        });

        logger.debug(
          `Conservative entry (SHORT): Fibonacci level ${fibonacciEntry.toFixed(8)} > signal price ${currentPrice.toFixed(8)}`
        );
      }
    }

    // Create position
    const position: BacktestPosition = {
      id: `POS_${this.trades.length}`,
      symbol: signal.symbol,
      side: signal.direction,
      entryPrice: actualEntryPrice,
      quantity,
      leverage: this.config.leverage,
      openTime: timestamp,
      stopLoss: signal.stopLoss,
      tp1: signal.tp1,
      tp2: signal.tp2,
      tp1Hit: false,
      status: 'OPEN',
      signal,
      executedEntryPrice,
      entryTime: timestamp,
    };

    this.positions.set(position.id, position);

    logger.debug(
      `Position opened: ${signal.symbol} ${signal.direction} @ ${executedEntryPrice.toFixed(8)} ` +
      `(mode: ${this.config.entryMode})`
    );
  }

  /**
   * Check for trade exits.
   * When takeHalfAtTp1MoveSlToEntry: at TP1 close 50%, move SL to entry, let remainder run to TP2.
   */
  private checkExits(candle: OHLCV, timestamp: number): void {
    const takeHalfAtTp1 = !!(this.config as any).takeHalfAtTp1MoveSlToEntry;

    for (const [posId, position] of this.positions.entries()) {
      if (position.status !== 'OPEN') {
        continue;
      }

      let exitPrice: number | null = null;
      let exitReason: 'TP1' | 'TP2' | 'SL' | 'TRAILING_STOP' | 'MANUAL' | null = null;
      let partialCloseAtTp1 = false;

      if (position.side === 'LONG') {
        if (candle.high >= position.tp2) {
          exitPrice = position.tp2;
          exitReason = 'TP2';
        } else if (candle.high >= position.tp1 && !position.tp1Hit) {
          if (takeHalfAtTp1) {
            partialCloseAtTp1 = true;
          } else if ((this.config as any).closeAtTp1) {
            exitPrice = position.tp1;
            exitReason = 'TP1';
          } else {
            position.tp1Hit = true;
          }
        } else if (candle.low <= position.stopLoss) {
          exitPrice = position.stopLoss;
          exitReason = 'SL';
        }
      } else {
        if (candle.low <= position.tp2) {
          exitPrice = position.tp2;
          exitReason = 'TP2';
        } else if (candle.low <= position.tp1 && !position.tp1Hit) {
          if (takeHalfAtTp1) {
            partialCloseAtTp1 = true;
          } else if ((this.config as any).closeAtTp1) {
            exitPrice = position.tp1;
            exitReason = 'TP1';
          } else {
            position.tp1Hit = true;
          }
        } else if (candle.high >= position.stopLoss) {
          exitPrice = position.stopLoss;
          exitReason = 'SL';
        }
      }

      if (partialCloseAtTp1) {
        this.closePositionPartialAtTp1(position, position.side === 'LONG' ? position.tp1 : position.tp1, timestamp);
        continue;
      }
      if (exitPrice && exitReason) {
        this.closePosition(position, exitPrice, exitReason, timestamp);
        this.positions.delete(posId);
      }
    }
  }

  /**
   * Close 50% at TP1, move SL to entry, keep remainder for TP2.
   */
  private closePositionPartialAtTp1(position: BacktestPosition, tp1Price: number, timestamp: number): void {
    const halfQty = position.quantity * 0.5;
    const executedExitPrice = this.executeExitWithSlippage(tp1Price, position.side);

    let pnl = 0;
    if (position.side === 'LONG') {
      pnl = (executedExitPrice - position.executedEntryPrice) * halfQty;
    } else {
      pnl = (position.executedEntryPrice - executedExitPrice) * halfQty;
    }
    const feePercent = this.config.fees / 100;
    const entryFeesHalf = position.executedEntryPrice * halfQty * feePercent;
    const exitFeesHalf = executedExitPrice * halfQty * feePercent;
    pnl -= entryFeesHalf + exitFeesHalf;

    this.currentBalance += pnl;

    const trade: Trade = {
      id: `${position.id}_TP1`,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.executedEntryPrice,
      exitPrice: executedExitPrice,
      quantity: halfQty,
      leverage: position.leverage,
      openTime: position.entryTime,
      closeTime: timestamp,
      stopLoss: position.stopLoss,
      tp1: position.tp1,
      tp2: position.tp2,
      exitReason: 'TP1',
      pnl,
      pnlPercent: (pnl / (position.executedEntryPrice * halfQty)) * 100,
      riskRewardRatio: Math.abs(
        (position.tp2 - position.executedEntryPrice) / (position.executedEntryPrice - position.stopLoss)
      ),
      status: 'CLOSED',
    };
    this.trades.push(trade);

    position.quantity = halfQty;
    position.stopLoss = position.executedEntryPrice;
    position.tp1Hit = true;
  }

  /**
   * Close a position and record trade
   */
  private closePosition(
    position: BacktestPosition,
    exitPrice: number,
    exitReason: string,
    timestamp: number
  ): void {
    // Apply exit slippage
    const executedExitPrice = this.executeExitWithSlippage(exitPrice, position.side);

    // Calculate P&L
    let pnl = 0;
    if (position.side === 'LONG') {
      pnl = (executedExitPrice - position.executedEntryPrice) * position.quantity;
    } else {
      pnl = (position.executedEntryPrice - executedExitPrice) * position.quantity;
    }

    // Apply fees (both entry and exit)
    const feePercent = this.config.fees / 100;
    const entryFees = position.executedEntryPrice * position.quantity * feePercent;
    const exitFees = executedExitPrice * position.quantity * feePercent;
    const totalFees = entryFees + exitFees;

    pnl -= totalFees;

    // Update balance
    this.currentBalance += pnl;

    // Create trade record
    const trade: Trade = {
      id: position.id,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.executedEntryPrice,
      exitPrice: executedExitPrice,
      quantity: position.quantity,
      leverage: position.leverage,
      openTime: position.entryTime,
      closeTime: timestamp,
      stopLoss: position.stopLoss,
      tp1: position.tp1,
      tp2: position.tp2,
      exitReason: exitReason as any,
      pnl,
      pnlPercent: (pnl / (position.executedEntryPrice * position.quantity)) * 100,
      riskRewardRatio: Math.abs(
        (position.tp2 - position.executedEntryPrice) / (position.executedEntryPrice - position.stopLoss)
      ),
      status: 'CLOSED',
    };

    this.trades.push(trade);

    // Record the candle index for cooldown tracking
    this.lastExitCandleIndex.set(position.symbol, this.historicalKlines.length - 1);

    // Track daily P&L
    const date = new Date(timestamp).toISOString().split('T')[0];
    this.dailyPnlMap.set(date, (this.dailyPnlMap.get(date) || 0) + pnl);

    logger.debug(
      `Position closed: ${trade.symbol} ${trade.side} P&L: ${pnl.toFixed(2)} USDT (${trade.pnlPercent?.toFixed(2)}%)`
    );
  }

  /**
   * Run backtest on historical data
   */
  async run(klines: OHLCV[]): Promise<BacktestStats> {
    if (klines.length === 0) {
      throw new Error('No klines data provided');
    }

    logger.info(
      `Starting backtest: ${klines.length} candles, ` +
      `Entry mode: ${this.config.entryMode}, Min confidence: ${this.config.minConfidence}`
    );

    this.equityCurve = [];
    this.trades = [];
    this.positions.clear();
    this.dailyPnlMap.clear();
    this.lastExitCandleIndex.clear();
    this.currentBalance = this.startBalance;
    this.historicalKlines = [];

    // Process each candle
    let lastDate = '';
    for (let i = 0; i < klines.length; i++) {
      const candle = klines[i];

      // Reset daily safety stats at the start of each new calendar day
      const candleDate = new Date(candle.timestamp).toISOString().split('T')[0];
      if (candleDate !== lastDate) {
        this.safetyRules.resetDailyStats(this.currentBalance);
        lastDate = candleDate;
      }

      // Keep historical data for trend filtering
      this.historicalKlines.push(candle);

      // Convert to market data (true 24h price change so trend-only vs counter-trend can differ)
      const { coin, ticker } = this.ohlcvToMarketData(candle, klines, i, this.config.symbol);

      // Generate signal with historical data for trend filter and volume confirmation
      const signal = signalGenerator.generateSignal(
        coin,
        ticker,
        undefined, // No funding rate in backtest
        this.historicalKlines // Pass historical data for trend filter + volume
      );

      // Process signal if generated
      if (signal && signal.confidence >= this.config.minConfidence) {
        await this.processSignal(signal, candle.close, candle.timestamp, candle);
      }

      // Check for exits on all open positions
      this.checkExits(candle, candle.timestamp);

      // Record equity
      this.equityCurve.push({
        timestamp: candle.timestamp,
        balance: this.currentBalance,
      });

      // Log progress
      if ((i + 1) % 100 === 0) {
        logger.debug(`Processed ${i + 1}/${klines.length} candles, Balance: ${this.currentBalance.toFixed(2)}`);
      }
    }

    // Close any remaining open positions at last price
    const lastCandle = klines[klines.length - 1];
    for (const [posId, position] of this.positions.entries()) {
      if (position.status === 'OPEN') {
        this.closePosition(position, lastCandle.close, 'MANUAL', lastCandle.timestamp);
      }
    }

    // Calculate statistics
    const stats = this.calculateStats();

    logger.info(
      `Backtest complete: ${stats.totalTrades} trades, ` +
      `Win rate: ${stats.winRate.toFixed(1)}%, P&L: ${stats.totalPnl.toFixed(2)} USDT (${stats.totalPnlPercent.toFixed(2)}%)`
    );

    return stats;
  }

  /**
   * Calculate backtest statistics
   */
  private calculateStats(): BacktestStats {
    const closedTrades = this.trades.filter(t => t.status === 'CLOSED');
    const winningTrades = closedTrades.filter(t => (t.pnl || 0) > 0);
    const losingTrades = closedTrades.filter(t => (t.pnl || 0) < 0);

    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalPnlPercent = (totalPnl / this.startBalance) * 100;

    const avgWin = winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + (t.pnl || 0), 0) / winningTrades.length
      : 0;

    const avgLoss = losingTrades.length > 0
      ? losingTrades.reduce((sum, t) => sum + (t.pnl || 0), 0) / losingTrades.length
      : 0;

    const profitFactor = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : 0;

    // Max drawdown calculation
    let maxDrawdown = 0;
    let peak = this.startBalance;
    for (const point of this.equityCurve) {
      peak = Math.max(peak, point.balance);
      const drawdown = (peak - point.balance) / peak;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    // Sharpe ratio calculation
    const returns = [];
    for (let i = 1; i < this.equityCurve.length; i++) {
      const ret = (this.equityCurve[i].balance - this.equityCurve[i - 1].balance) / this.equityCurve[i - 1].balance;
      returns.push(ret);
    }
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdDev = returns.length > 0
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length)
      : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0; // Annualized

    // Best and worst trades
    const bestTrade = closedTrades.length > 0
      ? closedTrades.reduce((max, t) => (t.pnl || 0) > (max.pnl || 0) ? t : max)
      : null;

    const worstTrade = closedTrades.length > 0
      ? closedTrades.reduce((min, t) => (t.pnl || 0) < (min.pnl || 0) ? t : min)
      : null;

    // Trades by confidence
    const tradesByConfidence = new Map<string, number>();
    for (const signal of new Set(this.trades.map(t => (t as any).signal?.confidence))) {
      tradesByConfidence.set(`${signal}+`, this.trades.filter(t => (t as any).signal?.confidence >= (signal || 0)).length);
    }

    return {
      totalTrades: closedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: closedTrades.length > 0 ? (winningTrades.length / closedTrades.length) * 100 : 0,
      totalPnl,
      totalPnlPercent,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      maxDrawdown: Math.round(maxDrawdown * 10000) / 100,
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
      bestTrade,
      worstTrade,
      tradesByConfidence,
      equityCurve: this.equityCurve,
    };
  }

  /**
   * Get all closed trades
   */
  getTrades(): Trade[] {
    return this.trades;
  }

  /**
   * Get equity curve
   */
  getEquityCurve(): { timestamp: number; balance: number }[] {
    return this.equityCurve;
  }
}

export default BacktestEngine;

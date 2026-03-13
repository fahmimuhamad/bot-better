/**
 * Order Executor
 * Executes market and limit orders based on signals and entry modes
 */

import logger from '../utils/logger';
import { TradeSignal, Position, BotConfig } from '../types';
import {
  validateTradingCredentials,
  getTradingBalance,
  placeMarketOrder as bybitPlaceMarketOrder,
  placeLimitOrder as bybitPlaceLimitOrder,
  setLeverage as bybitSetLeverage,
  closePositionBySymbol as bybitClosePosition,
  isBybit,
  getBybitPositionIdx,
  getTp1Tp2Quantities,
  setStopLossLimit,
  placeReduceOnlyLimitOrder,
  placeReduceOnlyTriggerMarketOrder,
  cancelOrder,
  setPositionStopLoss,
} from '../exchange/trading-client';
import SafetyRulesEnforcer from '../risk/safety-rules';
import positionManager from './position-manager';

export class OrderExecutor {
  private config: BotConfig;
  private safetyEnforcer: SafetyRulesEnforcer;

  constructor(config: BotConfig, startingBalance: number) {
    this.config = config;
    this.safetyEnforcer = new SafetyRulesEnforcer(startingBalance);
  }

  /**
   * Calculate position size in base currency (quantity) from risk.
   * positionValueUsd = riskAmount / (slDistancePercent/100); quantity = positionValueUsd / entryPrice.
   * Enforces minimum notional (10 USDT) so order passes exchange and safety checks.
   */
  calculatePositionSize(
    balance: number,
    riskPerTrade: number,
    slDistancePercent: number,
    entryPrice: number,
    minNotionalUsd: number = 10
  ): number {
    const riskAmount = (balance * riskPerTrade) / 100;
    const slDistance = slDistancePercent / 100;
    if (slDistance === 0 || entryPrice <= 0) {
      logger.warn('Invalid slDistance or entryPrice for position size');
      return 0;
    }
    const positionValueUsd = riskAmount / slDistance;
    let quantity = positionValueUsd / entryPrice;
    const notional = quantity * entryPrice;
    if (notional < minNotionalUsd) {
      quantity = minNotionalUsd / entryPrice;
    }
    return quantity;
  }

  /**
   * Calculate Fibonacci-based entry levels for conservative mode
   */
  private calculateFibonacciLevels(
    signal: TradeSignal
  ): {
    demand: number;
    equilibrium: number;
    orderFilled: number;
  } {
    const dayRange = signal.entryPrice - signal.stopLoss; // Approximate range

    return {
      demand: signal.entryPrice - (dayRange * 0.236),      // 23.6% level
      equilibrium: signal.entryPrice - (dayRange * 0.5),   // 50% level
      orderFilled: signal.entryPrice - (dayRange * 0.618), // 61.8% level (OTE)
    };
  }

  /**
   * Execute trade based on signal
   */
  async executeSignal(
    signal: TradeSignal,
    currentBalance: number,
    openPositions: Position[]
  ): Promise<{ success: boolean; position?: Position; message: string }> {
    try {
      logger.info('Executing signal', {
        symbol: signal.symbol,
        direction: signal.direction,
        confidence: signal.confidence,
        entryMode: this.config.entryMode,
      });

      // One position per symbol (hedge mode: do not open long and short in same symbol)
      const hasPositionInSymbol = openPositions.some(p => p.symbol === signal.symbol);
      if (hasPositionInSymbol) {
        return {
          success: false,
          message: `Already have an open position for ${signal.symbol}; one position per symbol`,
        };
      }

      // Run safety checks
      const safetyChecks = await this.safetyEnforcer.runAllChecks(
        this.config,
        currentBalance,
        openPositions,
        signal.symbol
      );

      const safetyReport = this.safetyEnforcer.getStatusReport(safetyChecks);
      if (!safetyReport.allPassed) {
        const failedRules = safetyReport.details
          .filter(c => !c.passed)
          .map(c => c.rule)
          .join(', ');

        logger.warn('Safety checks failed, skipping execution', { failedRules });
        return {
          success: false,
          message: `Safety checks failed: ${failedRules}`,
        };
      }

      // 1) Check balance: do not open if balance too low
      if (currentBalance <= 0) {
        return {
          success: false,
          message: 'Balance is 0 or negative; cannot open position',
        };
      }

      // 2) Calculate quantity from RISK_PER_TRADE in .env: riskAmount = balance * (riskPerTrade/100), positionValue = riskAmount / slDistance, quantity = positionValue / entryPrice
      const slPct = (Math.abs(signal.entryPrice - signal.stopLoss) / signal.entryPrice) * 100;
      let quantity = this.calculatePositionSize(
        currentBalance,
        this.config.riskPerTrade,
        slPct > 0 ? slPct : this.config.slDistancePct,
        signal.entryPrice,
        10
      );

      if (quantity <= 0) {
        return {
          success: false,
          message: 'Invalid position size calculated (check SL distance and entry price)',
        };
      }

      // 3) Cap quantity so required margin never exceeds available balance (margin = positionValueUsd / leverage)
      const positionValueUsd = quantity * signal.entryPrice;
      const requiredMarginUsd = positionValueUsd / this.config.leverage;
      const marginBuffer = 0.95; // use at most 95% of balance as margin to leave buffer
      const maxMarginUsd = currentBalance * marginBuffer;
      if (requiredMarginUsd > maxMarginUsd) {
        const maxPositionValueUsd = maxMarginUsd * this.config.leverage;
        quantity = maxPositionValueUsd / signal.entryPrice;
        logger.info('Position size capped to fit balance', {
          symbol: signal.symbol,
          requiredMarginUsd: requiredMarginUsd.toFixed(2),
          currentBalance: currentBalance.toFixed(2),
          maxMarginUsd: maxMarginUsd.toFixed(2),
          cappedQuantity: quantity,
        });
      }

      // Round quantity for exchange (Bybit lot size); executor will round again in placeMarketOrder if needed
      quantity = Math.floor(quantity * 100000) / 100000;

      // Validate order (min 10 USDT notional)
      const validation = this.safetyEnforcer.checkOrderValidation(
        signal.symbol,
        quantity,
        signal.entryPrice
      );

      if (!validation.passed) {
        return {
          success: false,
          message: validation.message,
        };
      }

      let entryPrice = signal.entryPrice;
      let position: Position;

      if (this.config.dryRun) {
        // DRY RUN: Don't execute, just simulate
        logger.info('DRY RUN - Simulating position', {
          symbol: signal.symbol,
          side: signal.direction,
          quantity,
          entryPrice,
        });

        position = await positionManager.openPosition(signal, quantity, this.config);
        return {
          success: true,
          position,
          message: `[DRY RUN] Position simulated for ${signal.symbol}`,
        };
      }

      if (this.config.entryMode === 'aggressive') {
        // AGGRESSIVE: Market order at current price
        logger.info('Executing aggressive market order', {
          symbol: signal.symbol,
          side: signal.direction,
          quantity,
          price: signal.entryPrice,
        });

        let placedQty = quantity;
        let slOrderId: string | null = null;
        let tp1OrderId: string | null = null;
        if (!this.config.paperTrading) {
          const orderResult = await bybitPlaceMarketOrder(
            signal.symbol,
            signal.direction,
            quantity,
            this.config.leverage
          );
          if (!orderResult.success) {
            return { success: false, message: 'Bybit market order failed' };
          }
          if (orderResult.quantity != null) placedQty = orderResult.quantity;

          // SL as limit (conditional); TP1 50% limit; TP2 50% trigger market. Store order IDs for TP1-hit flow (cancel SL, set SL to entry).
          if (isBybit() && placedQty > 0 && signal.stopLoss != null && signal.tp1 != null && signal.tp2 != null) {
            const positionIdx = getBybitPositionIdx(signal.direction);
            const closeSide = signal.direction === 'LONG' ? 'Sell' : 'Buy';
            slOrderId = await setStopLossLimit(
              signal.symbol,
              signal.direction,
              placedQty,
              signal.stopLoss,
              signal.stopLoss,
              positionIdx
            );
            const { tp1Qty, tp2Qty } = await getTp1Tp2Quantities(signal.symbol, placedQty);
            if (tp1Qty > 0) {
              tp1OrderId = await placeReduceOnlyLimitOrder(signal.symbol, closeSide, tp1Qty, signal.tp1, positionIdx);
            }
            if (tp2Qty > 0) {
              await placeReduceOnlyTriggerMarketOrder(signal.symbol, closeSide, tp2Qty, signal.tp2, positionIdx);
            }
          }
        }

        position = await positionManager.openPosition(signal, placedQty, this.config, {
          slOrderId: slOrderId ?? undefined,
          tp1OrderId: tp1OrderId ?? undefined,
        });
      } else {
        // CONSERVATIVE: Limit order at Fibonacci level (0.618 OTE)
        const fibs = this.calculateFibonacciLevels(signal);
        entryPrice = fibs.orderFilled;

        logger.info('Executing conservative limit order', {
          symbol: signal.symbol,
          side: signal.direction,
          quantity,
          entryPrice: fibs.orderFilled,
          fibLevels: fibs,
        });

        if (!this.config.paperTrading) {
          const ok = await bybitPlaceLimitOrder(
            signal.symbol,
            signal.direction,
            quantity,
            entryPrice,
            this.config.leverage
          );
          if (!ok) {
            return { success: false, message: 'Bybit limit order failed' };
          }
        }

        // For conservative mode, adjust signal entry price to limit order price
        const adjustedSignal = { ...signal, entryPrice };
        position = await positionManager.openPosition(adjustedSignal, quantity, this.config);
      }

      // Set leverage (Bybit only; also set inside placeMarketOrder/placeLimitOrder)
      if (!this.config.dryRun && !this.config.paperTrading) {
        await bybitSetLeverage(signal.symbol, this.config.leverage);
      }

      logger.info('Signal executed successfully', {
        symbol: signal.symbol,
        positionId: position.id,
        entryMode: this.config.entryMode,
        entryPrice,
        quantity,
        leverage: this.config.leverage,
      });

      return {
        success: true,
        position,
        message: `Position opened: ${signal.symbol} ${signal.direction} @ ${entryPrice.toFixed(8)}`,
      };
    } catch (error) {
      logger.error(`Failed to execute signal: ${error}`, 'executeSignal');
      return {
        success: false,
        message: `Execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Close a position at market
   */
  async closePosition(
    positionId: string,
    currentPrice: number,
    reason: 'TP1' | 'TP2' | 'SL' | 'TRAILING_STOP' | 'MANUAL'
  ): Promise<boolean> {
    try {
      const position = positionManager.getPosition(positionId);
      if (!position) {
        logger.warn(`Position not found: ${positionId}`);
        return false;
      }

      logger.info('Closing position', {
        positionId,
        symbol: position.symbol,
        reason,
        exitPrice: currentPrice,
      });

      if (!this.config.dryRun && !this.config.paperTrading) {
        const closed = await bybitClosePosition(position.symbol);
        if (!closed) {
          logger.error('Bybit close position failed', { symbol: position.symbol });
          return false;
        }
      }

      positionManager.closePosition(positionId, currentPrice, reason);
      return true;
    } catch (error) {
      logger.error(`Failed to close position: ${error}`, 'closePosition');
      return false;
    }
  }

  /**
   * When TP1 has hit: cancel initial SL order and set position SL to entry (breakeven) on exchange.
   * Call once per position when tp1Hit becomes true and we have slOrderId and !slMovedToEntry.
   */
  async moveSlToEntryAfterTp1(position: Position): Promise<boolean> {
    if (position.slMovedToEntry || !position.slOrderId) return true;
    if (this.config.dryRun || this.config.paperTrading) {
      positionManager.markSlMovedToEntry(position.id);
      return true;
    }
    try {
      const cancelled = await cancelOrder(position.symbol, position.slOrderId);
      if (!cancelled) {
        logger.warn(`Could not cancel SL order ${position.slOrderId} for ${position.symbol}`);
      }
      const positionIdx = getBybitPositionIdx(position.side);
      const set = await setPositionStopLoss(position.symbol, position.entryPrice, positionIdx);
      if (!set) {
        logger.warn(`Could not set position SL to entry for ${position.symbol}`);
      }
      positionManager.markSlMovedToEntry(position.id);
      logger.info(`SL moved to entry (breakeven) for ${position.symbol} after TP1`);
      return true;
    } catch (error) {
      logger.error(`moveSlToEntryAfterTp1 failed: ${error}`);
      return false;
    }
  }

  /**
   * Get execution readiness status
   */
  async getReadinessStatus(): Promise<{
    ready: boolean;
    checks: {
      apiConnected: boolean;
      balanceAvailable: boolean;
      configValid: boolean;
      message: string;
    };
  }> {
    // In DRY RUN mode, skip API validation
    if (this.config.dryRun || this.config.paperTrading) {
      const checks = {
        apiConnected: true, // Assume OK in test mode
        balanceAvailable: true,
        configValid: this.validateConfig(),
        message: 'DRY RUN - API checks skipped',
      };

      return {
        ready: checks.configValid,
        checks,
      };
    }

    // Live mode: validate API (uses Bybit or Binance per EXCHANGE)
    const checks = {
      apiConnected: await validateTradingCredentials(),
      balanceAvailable: (await getTradingBalance()) > 10, // Min 10 USDT
      configValid: this.validateConfig(),
      message: '',
    };

    const ready = checks.apiConnected && checks.balanceAvailable && checks.configValid;

    return {
      ready,
      checks: {
        ...checks,
        message: ready ? 'Bot is ready to trade' : 'Bot is not ready',
      },
    };
  }

  /**
   * Validate bot configuration
   */
  private validateConfig(): boolean {
    return (
      this.config.riskPerTrade > 0 &&
      this.config.riskPerTrade <= 10 &&
      this.config.leverage > 0 &&
      this.config.leverage <= 50 &&
      this.config.maxOpenTrades > 0 &&
      this.config.maxOpenTrades <= 100 &&
      this.config.minConfidence > 0 &&
      this.config.minConfidence <= 100
    );
  }

  /**
   * Update config
   */
  updateConfig(newConfig: Partial<BotConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('Config updated', { config: this.config });
  }
}

export default OrderExecutor;

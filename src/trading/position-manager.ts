/**
 * Position Manager
 * Tracks open positions, detects TP/SL hits, manages trailing stops
 */

import logger, { tradeLogger } from '../utils/logger';
import { Position, Trade, TradeSignal, BotConfig } from '../types';

export class PositionManager {
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];
  private nextTradeId = 1;

  /**
   * Open a new position. Optionally pass slOrderId and tp1OrderId from exchange for TP1-hit flow (cancel SL, set SL to entry).
   */
  async openPosition(
    signal: TradeSignal,
    quantity: number,
    config: BotConfig,
    orderIds?: { slOrderId?: string; tp1OrderId?: string }
  ): Promise<Position> {
    try {
      const position: Position = {
        id: `POS_${this.nextTradeId++}`,
        symbol: signal.symbol,
        side: signal.direction,
        entryPrice: signal.entryPrice,
        quantity,
        leverage: config.leverage,
        openTime: Date.now(),
        stopLoss: signal.stopLoss,
        tp1: signal.tp1,
        tp2: signal.tp2,
        tp1Hit: false,
        status: 'OPEN',
        slOrderId: orderIds?.slOrderId,
        tp1OrderId: orderIds?.tp1OrderId,
      };

      this.positions.set(position.id, position);

      // Log the trade
      const trade: Trade = {
        id: `TRD_${position.id}`,
        symbol: signal.symbol,
        side: signal.direction,
        entryPrice: signal.entryPrice,
        quantity,
        leverage: config.leverage,
        openTime: Date.now(),
        stopLoss: signal.stopLoss,
        tp1: signal.tp1,
        tp2: signal.tp2,
        riskRewardRatio: this.calculateRiskRewardRatio(
          signal.entryPrice,
          signal.stopLoss,
          signal.tp2 || signal.tp1
        ),
        status: 'OPEN',
      };

      this.trades.push(trade);
      tradeLogger.newTrade(trade);

      logger.info('Position opened', {
        id: position.id,
        symbol: signal.symbol,
        side: signal.direction,
        entryPrice: signal.entryPrice,
        quantity,
        leverage: config.leverage,
      });

      return position;
    } catch (error) {
      logger.error(`Failed to open position: ${error}`, 'openPosition');
      throw error;
    }
  }

  /**
   * Close a position
   */
  closePosition(
    positionId: string,
    exitPrice: number,
    exitReason: 'TP1' | 'TP2' | 'SL' | 'TRAILING_STOP' | 'MANUAL'
  ): void {
    const position = this.positions.get(positionId);
    if (!position) {
      logger.warn(`Position not found: ${positionId}`);
      return;
    }

    const pnl = this.calculatePnL(position.side, position.entryPrice, exitPrice, position.quantity);
    const pnlPercent = (pnl / (position.entryPrice * position.quantity)) * 100;

    position.status = 'CLOSED';
    position.pnl = pnl;
    position.pnlPercent = pnlPercent;

    // Update corresponding trade
    const trade = this.trades.find(t => t.id === `TRD_${positionId}`);
    if (trade) {
      trade.status = 'CLOSED';
      trade.exitPrice = exitPrice;
      trade.closeTime = Date.now();
      trade.exitReason = exitReason;
      trade.pnl = pnl;
      trade.pnlPercent = pnlPercent;
    }

    tradeLogger.closeTrade(trade);

    logger.info('Position closed', {
      id: positionId,
      symbol: position.symbol,
      exitReason,
      entryPrice: position.entryPrice,
      exitPrice,
      pnl: pnl.toFixed(2),
      pnlPercent: pnlPercent.toFixed(2),
      duration: (position.openTime - Date.now()) / 1000 / 60, // minutes
    });
  }

  /** Mark that we have moved SL to entry on the exchange (after TP1 hit). */
  markSlMovedToEntry(positionId: string): void {
    const position = this.positions.get(positionId);
    if (position) position.slMovedToEntry = true;
  }

  /** Mark TP1 as hit (e.g. when TP1 order is Filled on exchange). Updates quantity to 50% and stopLoss to entry. */
  markTp1Hit(positionId: string): void {
    const position = this.positions.get(positionId);
    if (!position || position.tp1Hit) return;
    position.tp1Hit = true;
    position.quantity = position.quantity * 0.5;
    position.stopLoss = position.entryPrice;
  }

  /**
   * Update position with current market price
   */
  updatePosition(
    positionId: string,
    currentPrice: number,
    config: BotConfig
  ): { tp1Hit: boolean; shouldClose: string | null } {
    const position = this.positions.get(positionId);
    if (!position) {
      return { tp1Hit: false, shouldClose: null };
    }

    const pnl = this.calculatePnL(position.side, position.entryPrice, currentPrice, position.quantity);

    // Check if TP1 hit
    let tp1HitNow = false;
    if (!position.tp1Hit) {
      const tp1Hit = position.side === 'LONG' ? currentPrice >= position.tp1 : currentPrice <= position.tp1;
      if (tp1Hit) {
        position.tp1Hit = true;
        tp1HitNow = true;

        // Take 50% at TP1, move SL to entry, let rest run to TP2
        if (config.takeHalfAtTp1MoveSlToEntry) {
          position.quantity = position.quantity * 0.5;
          position.stopLoss = position.entryPrice;
          if (config.trailingStop) {
            position.trailingStopPrice = currentPrice;
          }
          // Caller should close 50% on exchange and update SL to entry; no full close here
          return { tp1Hit: true, shouldClose: null };
        }

        // Enable trailing stop after TP1 hit (if configured)
        if (config.trailingStop) {
          position.trailingStopPrice = currentPrice;
        }

        // Close at TP1 if configured (full close)
        if (config.closeAtTp1) {
          return { tp1Hit: true, shouldClose: 'TP1' };
        }
      }
    }

    // Check if TP2 hit
    const tp2Hit = position.side === 'LONG' ? currentPrice >= position.tp2 : currentPrice <= position.tp2;
    if (tp2Hit) {
      return { tp1Hit: position.tp1Hit, shouldClose: 'TP2' };
    }

    // Check if SL hit
    const slHit = position.side === 'LONG' ? currentPrice <= position.stopLoss : currentPrice >= position.stopLoss;
    if (slHit) {
      return { tp1Hit: position.tp1Hit, shouldClose: 'SL' };
    }

    // Check trailing stop (if enabled and TP1 hit)
    if (config.trailingStop && position.tp1Hit && position.trailingStopPrice) {
      const trailingPercent = 0.02; // 2% trailing distance
      const trailingDistance = position.trailingStopPrice * trailingPercent;

      if (position.side === 'LONG') {
        // Update trailing stop if price is higher
        if (currentPrice > position.trailingStopPrice) {
          position.trailingStopPrice = currentPrice;
        }

        // Close if price falls below trailing stop
        if (currentPrice < (position.trailingStopPrice - trailingDistance)) {
          return { tp1Hit: position.tp1Hit, shouldClose: 'TRAILING_STOP' };
        }
      } else {
        // SHORT: update trailing stop if price is lower
        if (currentPrice < position.trailingStopPrice) {
          position.trailingStopPrice = currentPrice;
        }

        // Close if price rises above trailing stop
        if (currentPrice > (position.trailingStopPrice + trailingDistance)) {
          return { tp1Hit: position.tp1Hit, shouldClose: 'TRAILING_STOP' };
        }
      }
    }

    tradeLogger.updatePosition({
      id: positionId,
      currentPrice,
      pnl: pnl.toFixed(2),
      tp1Hit: position.tp1Hit,
      trailingStop: position.trailingStopPrice,
    });

    return { tp1Hit: position.tp1Hit, shouldClose: null };
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'OPEN');
  }

  /**
   * Get position by ID
   */
  getPosition(positionId: string): Position | undefined {
    return this.positions.get(positionId);
  }

  /**
   * Get all trades
   */
  getAllTrades(): Trade[] {
    return [...this.trades];
  }

  /**
   * Get closed trades (for daily stats)
   */
  getClosedTrades(startTime?: number): Trade[] {
    return this.trades.filter(t => 
      t.status === 'CLOSED' && 
      (!startTime || t.closeTime! >= startTime)
    );
  }

  /**
   * Calculate P&L for a position
   */
  private calculatePnL(side: 'LONG' | 'SHORT', entryPrice: number, exitPrice: number, quantity: number): number {
    if (side === 'LONG') {
      return (exitPrice - entryPrice) * quantity;
    } else {
      return (entryPrice - exitPrice) * quantity;
    }
  }

  /**
   * Calculate Risk-Reward Ratio
   */
  private calculateRiskRewardRatio(entryPrice: number, slPrice: number, tpPrice: number): number {
    const risk = Math.abs(entryPrice - slPrice);
    const reward = Math.abs(tpPrice - entryPrice);

    if (risk === 0) return 0;
    return reward / risk;
  }

  /**
   * Get daily statistics
   */
  getDailyStats(): {
    totalTrades: number;
    wins: number;
    losses: number;
    totalPnL: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
  } {
    const closedToday = this.getClosedTrades(Date.now() - 86400000); // Last 24h

    const wins = closedToday.filter(t => t.pnl! > 0);
    const losses = closedToday.filter(t => t.pnl! < 0);

    const totalPnL = closedToday.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + (t.pnl || 0), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((sum, t) => sum + (t.pnl || 0), 0) / losses.length) : 0;
    const profitFactor = avgLoss > 0 ? avgWin / avgLoss : 0;

    return {
      totalTrades: closedToday.length,
      wins: wins.length,
      losses: losses.length,
      totalPnL,
      winRate: closedToday.length > 0 ? (wins.length / closedToday.length) * 100 : 0,
      avgWin,
      avgLoss,
      profitFactor,
    };
  }

  /**
   * Clear all trades (for testing)
   */
  clearTrades(): void {
    this.positions.clear();
    this.trades = [];
    this.nextTradeId = 1;
  }
}

export default new PositionManager();

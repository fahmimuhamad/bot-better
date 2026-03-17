/**
 * Position Manager
 * Tracks open positions, detects TP/SL hits, manages trailing stops
 */

import fs from 'fs';
import path from 'path';
import logger, { tradeLogger } from '../utils/logger';
import { Position, Trade, TradeSignal, BotConfig } from '../types';

const STATE_FILE = path.join(process.cwd(), 'data', 'bot-state.json');
const JOURNAL_FILE = path.join(process.cwd(), 'data', 'trading-journal.json');

export class PositionManager {
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];
  private nextTradeId = 1;
  // Re-entry cooldown — persisted to disk so restarts don't reset it
  private lastExitTime: Map<string, number> = new Map();
  // Trading journal: start balance and startedAt set once when journal is created
  private journalStartBalance: number | null = null;
  private journalStartedAt: number | null = null;

  // ─── State persistence ───────────────────────────────────────────────────

  saveState(): void {
    try {
      const openPositions = Array.from(this.positions.values()).filter(p => p.status === 'OPEN');
      const state = {
        positions: openPositions,
        nextTradeId: this.nextTradeId,
        lastExitTime: Object.fromEntries(this.lastExitTime),
        savedAt: Date.now(),
      };
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      logger.error(`Failed to save bot state: ${e}`);
    }
  }

  loadState(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const state = JSON.parse(raw);
      for (const p of (state.positions || [])) {
        if (p.status === 'OPEN' && p.quantity > 0 && p.entryPrice > 0) {
          this.positions.set(p.id, p);
        }
      }
      if (state.nextTradeId) this.nextTradeId = state.nextTradeId;
      for (const [sym, ts] of Object.entries(state.lastExitTime || {})) {
        this.lastExitTime.set(sym, ts as number);
      }
      logger.info(`State loaded from disk: ${this.positions.size} open positions, ${this.lastExitTime.size} exit cooldowns`);
    } catch (e) {
      logger.warn(`Could not load state file (starting fresh): ${e}`);
    }
  }

  /**
   * Ensure trading journal exists: create with startBalance if new, otherwise load closed trades.
   * Call once at bot startup after balance is known.
   */
  ensureJournal(startBalance: number): void {
    const dir = path.dirname(JOURNAL_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
      if (fs.existsSync(JOURNAL_FILE)) {
        const raw = fs.readFileSync(JOURNAL_FILE, 'utf-8');
        const data = JSON.parse(raw);
        const closed = (data.trades || []).filter((t: Trade) => t.status === 'CLOSED');
        this.trades = closed;
        this.journalStartBalance = typeof data.startBalance === 'number' ? data.startBalance : null;
        this.journalStartedAt = typeof data.startedAt === 'number' ? data.startedAt : null;
        logger.info(`Journal loaded: ${this.trades.length} closed trades, start balance $${(this.journalStartBalance ?? 0).toFixed(2)}`);
      } else {
        this.journalStartBalance = startBalance;
        this.journalStartedAt = Date.now();
        const payload = { startBalance, startedAt: this.journalStartedAt, trades: [] };
        fs.writeFileSync(JOURNAL_FILE, JSON.stringify(payload));
        logger.info(`Journal created: start balance $${startBalance.toFixed(2)}`);
      }
    } catch (e) {
      logger.warn(`Could not load/create journal (starting fresh): ${e}`);
      this.journalStartBalance = startBalance;
      this.journalStartedAt = Date.now();
    }
  }

  /** Persist all closed trades to the journal (call after each close). */
  private saveJournal(): void {
    if (this.journalStartBalance == null || this.journalStartedAt == null) return;
    try {
      const closed = this.trades.filter(t => t.status === 'CLOSED');
      const payload = {
        startBalance: this.journalStartBalance,
        startedAt: this.journalStartedAt,
        trades: closed,
      };
      fs.writeFileSync(JOURNAL_FILE, JSON.stringify(payload));
    } catch (e) {
      logger.error(`Failed to save journal: ${e}`);
    }
  }

  // ─── Re-entry cooldown ───────────────────────────────────────────────────

  recordExit(symbol: string): void {
    this.lastExitTime.set(symbol, Date.now());
    this.saveState();
  }

  getLastExitTime(symbol: string): number | undefined {
    return this.lastExitTime.get(symbol);
  }

  // ─── Position lifecycle ───────────────────────────────────────────────────

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
      this.saveState();

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

    // If TP1 was hit, remaining quantity is 50% — add TP1 partial PnL for combined single journal entry
    const remainingPnl = this.calculatePnL(position.side, position.entryPrice, exitPrice, position.quantity);
    const pnl = remainingPnl + (position.tp1Pnl || 0);
    // pnlPercent = return on margin (notional / leverage = margin used); use original full quantity for margin base
    const fullQty = position.tp1Hit ? position.quantity * 2 : position.quantity;
    const margin = (position.entryPrice * fullQty) / (position.leverage || 1);
    const pnlPercent = margin > 0 ? (pnl / margin) * 100 : 0;

    position.status = 'CLOSED';
    position.pnl = pnl;
    position.pnlPercent = pnlPercent;
    this.saveState();

    // Update or create corresponding trade (so journal has full history)
    let trade = this.trades.find(t => t.id === `TRD_${positionId}`);
    if (trade) {
      trade.status = 'CLOSED';
      trade.exitPrice = exitPrice;
      trade.closeTime = Date.now();
      trade.exitReason = exitReason;
      trade.pnl = pnl;
      trade.pnlPercent = pnlPercent;
    } else {
      trade = {
        id: `TRD_${positionId}`,
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        quantity: position.quantity,
        leverage: position.leverage,
        openTime: position.openTime,
        exitPrice,
        closeTime: Date.now(),
        stopLoss: position.stopLoss,
        tp1: position.tp1,
        tp2: position.tp2,
        exitReason,
        pnl,
        pnlPercent,
        riskRewardRatio: 0,
        status: 'CLOSED',
      };
      this.trades.push(trade);
    }

    tradeLogger.closeTrade(trade);
    this.saveJournal();

    logger.info('Position closed', {
      id: positionId,
      symbol: position.symbol,
      exitReason,
      entryPrice: position.entryPrice,
      exitPrice,
      pnl: pnl.toFixed(2),
      pnlPercent: pnlPercent.toFixed(2),
      duration: (Date.now() - position.openTime) / 1000 / 60, // minutes
    });
  }

  /** Mark that we have moved SL to entry on the exchange (after TP1 hit). */
  markSlMovedToEntry(positionId: string): void {
    const position = this.positions.get(positionId);
    if (position) {
      position.slMovedToEntry = true;
      this.saveState();
    }
  }

  /** Mark TP1 as hit (e.g. when TP1 order is Filled on exchange). Updates quantity to 50% and stopLoss to entry.
   *  Stores tp1Pnl on the position so it can be combined into a single journal entry at final close.
   */
  markTp1Hit(positionId: string): void {
    const position = this.positions.get(positionId);
    if (!position || position.tp1Hit) return;
    const tp1Qty = position.quantity * 0.5;
    const tp1Price = position.tp1 || position.entryPrice;
    const pnl = this.calculatePnL(position.side, position.entryPrice, tp1Price, tp1Qty);

    position.tp1Hit = true;
    position.quantity = tp1Qty;
    position.stopLoss = position.entryPrice;
    position.tp1Pnl = pnl;
    this.saveState();
    logger.info(`TP1 hit: ${position.symbol} partial PnL +$${pnl.toFixed(2)} stored (combined at final close)`);
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

    // Check if TP1 hit (skip if tp1 = 0 — not set, e.g. restored position with no TP on exchange)
    let tp1HitNow = false;
    if (!position.tp1Hit && position.tp1 > 0) {
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
          this.saveState();
          // Caller should close 50% on exchange and update SL to entry; no full close here
          return { tp1Hit: true, shouldClose: null };
        }

        // Enable trailing stop after TP1 hit (if configured)
        if (config.trailingStop) {
          position.trailingStopPrice = currentPrice;
          this.saveState();
        }

        // Close at TP1 if configured (full close)
        if (config.closeAtTp1) {
          return { tp1Hit: true, shouldClose: 'TP1' };
        }
      }
    }

    // Check if TP2 hit (skip if tp2 = 0 — not set)
    if (position.tp2 > 0) {
      const tp2Hit = position.side === 'LONG' ? currentPrice >= position.tp2 : currentPrice <= position.tp2;
      if (tp2Hit) {
        return { tp1Hit: position.tp1Hit, shouldClose: 'TP2' };
      }
    }

    // Check if SL hit (skip if stopLoss = 0 — not set, e.g. restored position with no SL on exchange)
    if (position.stopLoss > 0) {
      const slHit = position.side === 'LONG' ? currentPrice <= position.stopLoss : currentPrice >= position.stopLoss;
      if (slHit) {
        return { tp1Hit: position.tp1Hit, shouldClose: 'SL' };
      }
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
   * Restore a position from exchange data after a bot restart.
   * Skipped if the position is already in local state (loaded from disk).
   */
  restorePositionFromExchange(p: {
    symbol: string; side: 'LONG' | 'SHORT'; quantity: number;
    entryPrice: number; leverage: number; stopLoss: number; takeProfit: number;
  }): void {
    if (p.quantity <= 0 || p.entryPrice <= 0) {
      logger.warn(`Skipping restore of ${p.symbol} ${p.side}: invalid quantity=${p.quantity} or entryPrice=${p.entryPrice}`);
      return;
    }
    // Skip if already loaded from disk state (prevents duplicate)
    const alreadyInState = Array.from(this.positions.values()).some(
      pos => pos.symbol === p.symbol && pos.side === p.side && pos.status === 'OPEN'
    );
    if (alreadyInState) {
      logger.info(`${p.symbol} ${p.side} already in local state (loaded from disk) — skipping exchange restore`);
      return;
    }
    const id = `RESTORED_${p.symbol}_${p.side}`;
    if (this.positions.has(id)) return;
    this.positions.set(id, {
      id,
      symbol:     p.symbol,
      side:       p.side,
      entryPrice: p.entryPrice,
      quantity:   p.quantity,
      leverage:   p.leverage,
      openTime:   Date.now(),
      stopLoss:   p.stopLoss,
      tp1:        p.takeProfit,
      tp2:        p.takeProfit,
      tp1Hit:     false,
      status:     'OPEN',
    });
    logger.info(`Restored pre-existing position from exchange: ${p.symbol} ${p.side} @ ${p.entryPrice}`);
    this.saveState();
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

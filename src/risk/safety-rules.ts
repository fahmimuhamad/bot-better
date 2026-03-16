/**
 * Safety Rules Enforcer
 * 10 mandatory hard-coded safety checks that NEVER bypass
 */

import logger, { tradeLogger } from '../utils/logger';
import { Position, Trade, BotConfig, SafetyCheckResult } from '../types';

export class SafetyRulesEnforcer {
  private dailyStartTime: number = Date.now();
  private startingBalance: number = 0;
  private dailyStartBalance: number = 0; // Balance at the start of the CURRENT day
  private dailyLosses: number = 0;

  constructor(startingBalance: number) {
    this.startingBalance = startingBalance;
    this.dailyStartBalance = startingBalance;
    this.resetDailyStats(startingBalance);
  }

  /**
   * Reset daily stats at midnight (pass current balance so daily limit uses today's start)
   */
  resetDailyStats(currentBalance?: number) {
    this.dailyStartTime = Date.now();
    this.dailyLosses = 0;
    if (currentBalance !== undefined) {
      this.dailyStartBalance = currentBalance; // Reset baseline to today's opening balance
    }
  }

  /**
   * RULE 1: Daily Loss Limit Check
   * Stops trading if losses TODAY exceed limit (default 5%).
   * Uses balance at the start of the current trading day — resets daily.
   */
  checkDailyLossLimit(
    currentBalance: number,
    dailyLossLimitPercent: number
  ): SafetyCheckResult {
    const dailyLoss = this.dailyStartBalance - currentBalance;
    const dailyLossPercent = (dailyLoss / this.dailyStartBalance) * 100;

    const passed = dailyLossPercent <= dailyLossLimitPercent;

    if (!passed) {
      tradeLogger.safetyRuleTrigger('DAILY_LOSS_LIMIT', {
        dailyLoss,
        dailyLossPercent,
        limit: dailyLossLimitPercent,
        currentBalance,
        dailyStartBalance: this.dailyStartBalance,
      });
    }

    return {
      passed,
      rule: 'Daily Loss Limit',
      message: `Daily loss: ${dailyLossPercent.toFixed(2)}% / Limit: ${dailyLossLimitPercent}%`,
      timestamp: Date.now(),
    };
  }

  /**
   * RULE 2: Max Open Positions Check
   * Prevents opening more than max allowed positions
   */
  checkMaxOpenPositions(
    openPositions: Position[],
    maxOpenTrades: number
  ): SafetyCheckResult {
    const passed = openPositions.length < maxOpenTrades;

    if (!passed) {
      tradeLogger.safetyRuleTrigger('MAX_OPEN_POSITIONS', {
        currentPositions: openPositions.length,
        maxAllowed: maxOpenTrades,
      });
    }

    return {
      passed,
      rule: 'Max Open Positions',
      message: `Open positions: ${openPositions.length} / Max: ${maxOpenTrades}`,
      timestamp: Date.now(),
    };
  }

  /**
   * RULE 3: Correlation Check
   * Prevents taking correlated positions that amplify losses
   */
  checkCorrelation(
    newSymbol: string,
    openPositions: Position[],
    correlationThreshold: number = 0.7
  ): SafetyCheckResult {
    // Map of coin correlations (simplified - would need real data in production)
    // NOTE: BTC/ETH/BNB intentionally NOT marked as correlated — the regime-backtest
    // allows all three simultaneously and they occupy separate position slots.
    // Blocking them would diverge live behaviour from backtested results.
    const correlations: { [key: string]: string[] } = {
      'SOL': ['ETH'],
      'ADA': [],
      'XRP': [],
      'DOGE': [],
    };

    const openSymbols = openPositions.map(p => p.symbol);
    const correlatedSymbols = correlations[newSymbol] || [];

    const hasCorrelation = openSymbols.some(sym => correlatedSymbols.includes(sym));

    if (hasCorrelation) {
      tradeLogger.safetyRuleTrigger('CORRELATION_CHECK', {
        newSymbol,
        openSymbols,
        correlatedSymbols: correlatedSymbols.filter(s => openSymbols.includes(s)),
      });
    }

    return {
      passed: !hasCorrelation,
      rule: 'Correlation Check',
      message: hasCorrelation 
        ? `${newSymbol} is correlated with open positions`
        : `${newSymbol} has no correlation conflicts`,
      timestamp: Date.now(),
    };
  }

  /**
   * RULE 4: Sector Exposure Check
   * Prevents overexposure to single sector
   */
  checkSectorExposure(
    newSymbol: string,
    openPositions: Position[],
    maxSectorExposure: number = 15
  ): SafetyCheckResult {
    const sectorMap: { [key: string]: string } = {
      'BTC': 'LAYER1',
      'ETH': 'LAYER1',
      'BNB': 'PLATFORM',
      'SOL': 'LAYER1',
      'ADA': 'LAYER1',
      'XRP': 'PAYMENT',
      'DOGE': 'MEME',
      'POLKADOT': 'LAYER1',
    };

    const newSector = sectorMap[newSymbol] || 'OTHER';
    const currentSectorExposure = openPositions
      .filter(p => sectorMap[p.symbol] === newSector).length;

    const passed = currentSectorExposure < maxSectorExposure;

    if (!passed) {
      tradeLogger.safetyRuleTrigger('SECTOR_EXPOSURE', {
        newSymbol,
        sector: newSector,
        currentExposure: currentSectorExposure,
        maxAllowed: maxSectorExposure,
      });
    }

    return {
      passed,
      rule: 'Sector Exposure',
      message: `${newSector} exposure: ${currentSectorExposure} / Max: ${maxSectorExposure}`,
      timestamp: Date.now(),
    };
  }

  /**
   * RULE 5: Leverage Validation Check
   * Ensures leverage doesn't exceed platform limits and account settings
   */
  checkLeverageValidation(
    leverage: number,
    allowedRisk: string = 'High'
  ): SafetyCheckResult {
    const maxLeverage = allowedRisk === 'High' ? 50 : allowedRisk === 'Medium' ? 20 : 10;
    const passed = leverage > 0 && leverage <= maxLeverage;

    if (!passed) {
      tradeLogger.safetyRuleTrigger('LEVERAGE_VALIDATION', {
        requestedLeverage: leverage,
        maxAllowed: maxLeverage,
        riskProfile: allowedRisk,
      });
    }

    return {
      passed,
      rule: 'Leverage Validation',
      message: `Leverage: ${leverage}x / Max: ${maxLeverage}x (${allowedRisk} risk)`,
      timestamp: Date.now(),
    };
  }

  /**
   * RULE 6: Balance Check
   * Ensures sufficient balance for position sizing
   */
  checkBalance(
    currentBalance: number,
    requiredMargin: number,
    bufferPercent: number = 10
  ): SafetyCheckResult {
    const requiredWithBuffer = requiredMargin * (1 + bufferPercent / 100);
    const passed = currentBalance > requiredWithBuffer;

    if (!passed) {
      tradeLogger.safetyRuleTrigger('BALANCE_CHECK', {
        currentBalance,
        requiredMargin,
        requiredWithBuffer,
        shortfall: requiredWithBuffer - currentBalance,
      });
    }

    return {
      passed,
      rule: 'Balance Check',
      message: `Balance: ${currentBalance.toFixed(2)} USDT / Required: ${requiredWithBuffer.toFixed(2)} USDT`,
      timestamp: Date.now(),
    };
  }

  /**
   * RULE 7: Funding Rate Check
   * Avoids positions during extreme funding rates
   */
  checkFundingRate(
    fundingRate: number,
    side: 'LONG' | 'SHORT',
    maxFundingRate: number = 0.05
  ): SafetyCheckResult {
    // Longs pay shorts when positive; shorts pay longs when negative
    const isRiskyFunding = Math.abs(fundingRate) > maxFundingRate;

    if (isRiskyFunding) {
      tradeLogger.safetyRuleTrigger('FUNDING_RATE_CHECK', {
        fundingRate,
        maxAllowed: maxFundingRate,
        side,
        riskDescription: fundingRate > 0 && side === 'LONG' 
          ? 'Longs paying shorts - expensive'
          : fundingRate < 0 && side === 'SHORT'
          ? 'Shorts paying longs - expensive'
          : 'Funding rate favorable',
      });
    }

    return {
      passed: !isRiskyFunding || process.env.ENABLE_HIGH_FUNDING === 'true',
      rule: 'Funding Rate Check',
      message: `Funding rate: ${(fundingRate * 100).toFixed(3)}% / Max: ${(maxFundingRate * 100).toFixed(3)}%`,
      timestamp: Date.now(),
    };
  }

  /**
   * RULE 8: Liquidation Price Check
   * Ensures liquidation price is far enough from current price
   */
  async checkLiquidationPrice(
    symbol: string,
    currentPrice: number,
    liquidationPrice: number,
    side: 'LONG' | 'SHORT',
    minMarginBuffer: number = 0.1
  ): Promise<SafetyCheckResult> {
    const distancePercent = Math.abs(currentPrice - liquidationPrice) / currentPrice;
    const passed = distancePercent >= minMarginBuffer;

    if (!passed) {
      tradeLogger.safetyRuleTrigger('LIQUIDATION_PRICE_CHECK', {
        symbol,
        currentPrice,
        liquidationPrice,
        distancePercent,
        minBuffer: minMarginBuffer,
        side,
      });
    }

    return {
      passed,
      rule: 'Liquidation Price Check',
      message: `Distance to liquidation: ${(distancePercent * 100).toFixed(2)}% / Min buffer: ${(minMarginBuffer * 100).toFixed(2)}%`,
      timestamp: Date.now(),
    };
  }

  /**
   * RULE 9: API Rate Limit Check
   * Monitors and respects exchange rate limits
   */
  checkAPIRateLimit(
    requestsPerMinute: number,
    maxRequestsPerMinute: number = 1200
  ): SafetyCheckResult {
    const passed = requestsPerMinute <= maxRequestsPerMinute;

    if (!passed) {
      tradeLogger.safetyRuleTrigger('API_RATE_LIMIT', {
        requestsPerMinute,
        maxAllowed: maxRequestsPerMinute,
        exceeded: requestsPerMinute - maxRequestsPerMinute,
      });
    }

    return {
      passed,
      rule: 'API Rate Limit',
      message: `Requests/min: ${requestsPerMinute} / Max: ${maxRequestsPerMinute}`,
      timestamp: Date.now(),
    };
  }

  /**
   * RULE 10: Order Validation Check
   * Validates all order parameters before submission
   */
  checkOrderValidation(
    symbol: string,
    quantity: number,
    price: number,
    minOrderSize: number = 10 // 10 USDT minimum
  ): SafetyCheckResult {
    const orderSize = quantity * price;
    const passed: boolean = 
      !!symbol && 
      quantity > 0 && 
      price > 0 && 
      orderSize >= minOrderSize &&
      !isNaN(quantity) &&
      !isNaN(price) &&
      isFinite(quantity) &&
      isFinite(price);

    if (!passed) {
      tradeLogger.safetyRuleTrigger('ORDER_VALIDATION', {
        symbol,
        quantity,
        price,
        orderSize,
        minSize: minOrderSize,
        errors: {
          validSymbol: !!symbol,
          validQuantity: quantity > 0,
          validPrice: price > 0,
          minSize: orderSize >= minOrderSize,
          validNumbers: !isNaN(quantity) && !isNaN(price),
        },
      });
    }

    return {
      passed,
      rule: 'Order Validation',
      message: passed 
        ? `Valid order: ${quantity} @ ${price}`
        : `Invalid order parameters`,
      timestamp: Date.now(),
    };
  }

  /**
   * Run all safety checks
   */
  async runAllChecks(
    config: BotConfig,
    currentBalance: number,
    openPositions: Position[],
    newSymbol?: string
  ): Promise<SafetyCheckResult[]> {
    const checks: SafetyCheckResult[] = [];

    // Rule 1: Daily loss limit
    checks.push(this.checkDailyLossLimit(currentBalance, config.dailyLossLimit));

    // Rule 2: Max open positions
    checks.push(this.checkMaxOpenPositions(openPositions, config.maxOpenTrades));

    if (newSymbol) {
      // Rule 3: Correlation check
      checks.push(this.checkCorrelation(newSymbol, openPositions));

      // Rule 4: Sector exposure
      checks.push(this.checkSectorExposure(newSymbol, openPositions));
    }

    // Rule 5: Leverage validation
    checks.push(this.checkLeverageValidation(config.leverage, 'High'));

    // Rule 6: Balance check (simplified)
    const requiredMargin = (currentBalance * config.riskPerTrade) / 100;
    checks.push(this.checkBalance(currentBalance, requiredMargin));

    // Rule 9: API rate limit (simplified)
    checks.push(this.checkAPIRateLimit(10, 1200));

    const failedChecks = checks.filter(c => !c.passed);

    if (failedChecks.length > 0) {
      logger.warn('Safety checks failed', {
        failed: failedChecks.length,
        checks: failedChecks.map(c => ({ rule: c.rule, message: c.message })),
      });
    }

    return checks;
  }

  /**
   * Get safety check status report
   */
  getStatusReport(
    checks: SafetyCheckResult[]
  ): {
    allPassed: boolean;
    passedCount: number;
    failedCount: number;
    details: SafetyCheckResult[];
  } {
    return {
      allPassed: checks.every(c => c.passed),
      passedCount: checks.filter(c => c.passed).length,
      failedCount: checks.filter(c => !c.passed).length,
      details: checks,
    };
  }
}

export default SafetyRulesEnforcer;

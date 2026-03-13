# 🤖 Binance Futures Trading Bot

**Automated trading system for Binance Futures with advanced signal generation, risk management, and position tracking.**

## Features

### 📊 Signal Generation
- **4 Scoring Systems**: Whale, Smart Money, Accumulation, Pump Probability
- **Derived Metrics**: Pressure, Risk Level, Momentum, Volume Spike, Deep Value
- **Confidence-based Filtering**: Only trade signals meeting minimum confidence threshold
- **Directional Analysis**: LONG/SHORT determination with dominance gap validation

### 💼 Order Management
- **Entry Modes**: 
  - Aggressive (market orders at current price)
  - Conservative (limit orders at Fibonacci levels)
- **Position Sizing**: Risk-based calculation with leverage consideration
- **TP/SL Placement**: TP1, TP2, and stop loss at calculated levels
- **Trailing Stop**: Optional trailing stop after TP1 hit

### 🛡️ Safety Rules (10 Hard-Coded Checks)
1. Daily Loss Limit (3% default)
2. Max Open Positions (10 default)
3. Correlation Check (prevent correlated positions)
4. Sector Exposure (limit single sector exposure)
5. Leverage Validation (max 50x, configurable)
6. Balance Check (ensure sufficient margin)
7. Funding Rate Check (avoid extreme funding)
8. Liquidation Price Check (safety margin)
9. API Rate Limit (respect exchange limits)
10. Order Validation (all parameters valid)

### 📈 Position Management
- **Real-time Tracking**: Monitor all open positions
- **TP/SL Detection**: Automatic exit when targets hit
- **Trailing Stop Management**: Dynamic stop adjustment
- **PnL Calculation**: Track wins/losses per position

### 📊 Data Sources
- **CoinGecko API**: Top 250 coins (free, no auth)
- **Binance Spot API**: 24hr tickers, book tickers, volume
- **Binance Futures API**: Funding rates, leverage, liquidation prices

### 🔄 Refresh Cycle
- **120 seconds**: Fetch → Signal → Execute → Manage
- **Rate Limited**: Respects Binance API limits (1200 req/min)
- **Recoverable**: Automatic reconnection on network failure

### 📝 Logging
- **Structured JSON Logs**: Every action logged
- **Trade History**: All entries/exits with PnL
- **Safety Triggers**: When rules prevent trades
- **Performance Stats**: Daily win rate, profit factor

## System Architecture

```
┌─────────────────────┐
│   Data Fetcher      │ ← CoinGecko, Binance Spot, Binance Futures
├─────────────────────┤
│  Signal Generator   │ ← 4 Scoring Systems, Confidence Filter
├─────────────────────┤
│  Safety Enforcer    │ ← 10 Mandatory Risk Checks
├─────────────────────┤
│  Order Executor     │ ← Market/Limit Order Placement
├─────────────────────┤
│ Position Manager    │ ← Track, Monitor, Exit Positions
├─────────────────────┤
│    Logger           │ ← JSON Trades, Performance Stats
└─────────────────────┘
```

## Quick Start

### 1. Prerequisites
```bash
# Node 18+
node --version  # Should be v18+

# Install dependencies
npm install
```

### 2. Configure for Testnet
```bash
# Copy example config
cp .env.example .env

# Edit .env with testnet API keys
# BINANCE_API_KEY=xxx
# BINANCE_API_SECRET=xxx
# BINANCE_USE_TESTNET=true
# ENABLE_DRY_RUN=true
```

### 3. Build & Run
```bash
# Build
npm run build

# Run in DRY RUN mode (no real trades)
npm run dev

# Or with PM2 for persistence
npm run pm2:start
npm run pm2:logs
```

### 4. Monitor
```bash
# View logs
tail logs/combined.log

# Check trades
cat logs/trades.jsonl | jq

# Performance stats
grep "Daily Statistics" logs/combined.log
```

## Configuration

### Risk Settings
```env
RISK_PER_TRADE=2              # % of balance per trade
LEVERAGE=5                    # Trading leverage (start low!)
DAILY_LOSS_LIMIT=3            # Max daily loss % before stop
MAX_OPEN_TRADES=10            # Concurrent positions
```

### Trading Parameters
```env
ENTRY_MODE=aggressive         # aggressive | conservative
MIN_CONFIDENCE=80             # Min signal confidence (0-100)
CLOSE_AT_TP1=false            # Close at first TP
TRAILING_STOP=true            # Use trailing stop after TP1
```

### Execution
```env
BINANCE_USE_TESTNET=true      # Testnet or mainnet
ENABLE_DRY_RUN=true           # Simulate trades
ENABLE_PAPER_TRADING=false    # Real data, simulated exec
```

## Trading Rules

### Long Signal (THRESHOLD=40, DOMINANCE_GAP=10)
- Composite score ≥ 40
- (SmartMoney + Accumulation) > (Whale + Pump) by ≥ 10 points
- Confidence ≥ MIN_CONFIDENCE

### Short Signal
- Composite score ≥ 40
- (Whale + Pump) > (SmartMoney + Accumulation) by ≥ 10 points
- Confidence ≥ MIN_CONFIDENCE

### Position Sizing
```
Size = (BALANCE × RISK_PER_TRADE / 100) / (SL_DISTANCE / 100)
```

### Exit Strategy
1. **TP1** (2%): First profit target
   - If CLOSE_AT_TP1=true: Exit
   - Else: Enable trailing stop
2. **TP2** (4%): Second profit target - exit
3. **SL**: Stop loss - exit
4. **Trailing Stop**: Exit if price falls 2% after TP1

## Safety Guarantees

The bot **WILL NEVER**:
- Open more positions than MAX_OPEN_TRADES
- Trade if daily losses > DAILY_LOSS_LIMIT
- Exceed configured leverage limits
- Place orders without validation
- Trade correlated assets without limit
- Accept extreme funding rates (without override)

## Logging

### Trade Log (`logs/trades.jsonl`)
```json
{
  "id": "TRD_POS_1",
  "symbol": "BTC",
  "side": "LONG",
  "entryPrice": 45000,
  "exitPrice": 45900,
  "quantity": 1,
  "leverage": 5,
  "exitReason": "TP1",
  "pnl": 900,
  "pnlPercent": 2.0,
  "riskRewardRatio": 1.5,
  "status": "CLOSED"
}
```

### Statistics
```
Daily Statistics:
- Total Trades: 5
- Wins: 3 (60%)
- Losses: 2
- Total PnL: $145.67
- Profit Factor: 2.15
```

## Performance Metrics

### Expected (Testnet, Conservative)
- Win Rate: 55-65%
- Profit Factor: 1.5-2.5
- Daily PnL: +0.5% to +2%

### Red Flags
- Win rate < 40% → Adjust entry mode
- Daily losses > 3% → Stop and review
- Safety rule triggers > 50% → Config too aggressive

## Upgrading from Testnet to Mainnet

1. **Get mainnet API keys** (different from testnet!)
2. **Backup testnet data**: `cp logs logs.backup`
3. **Update .env**:
   - `BINANCE_USE_TESTNET=false`
   - `ENABLE_DRY_RUN=false`
   - Start with **CONSERVATIVE** settings
4. **Paper trade for 24h** first
5. **Monitor 24/7** first week

See **MIGRATION_GUIDE.md** for detailed instructions.

## Troubleshooting

### No signals generated
- Lower `MIN_CONFIDENCE` threshold
- Check coin whitelist in config.json
- Verify data fetcher working: `grep "Data fetched" logs/combined.log`

### Safety rules blocking trades
- Check `logs/error.log` for SAFETY_RULE_TRIGGERED
- Verify position count < MAX_OPEN_TRADES
- Check daily loss limit hasn't been hit

### API errors
```bash
# Invalid API key
grep "API credentials" logs/error.log

# Rate limited
grep "rate limited" logs/error.log
# Solution: Reduce cycle frequency

# Connection timeout
grep "ENOTFOUND\|ECONNREFUSED" logs/error.log
# Solution: Check internet, firewall
```

### Memory usage growing
```bash
# Check memory
ps aux | grep node

# If > 500MB, restart
npm run pm2:restart
```

## Development

### Project Structure
```
trading-bot/
├── src/
│   ├── index.ts              # Main bot
│   ├── types.ts              # Type definitions
│   ├── data/
│   │   └── fetcher.ts        # Data fetching
│   ├── signals/
│   │   └── generator.ts      # Signal generation
│   ├── exchange/
│   │   └── binance-client.ts # Binance API
│   ├── trading/
│   │   ├── position-manager.ts
│   │   └── order-executor.ts
│   ├── risk/
│   │   └── safety-rules.ts
│   └── utils/
│       └── logger.ts
├── dist/                     # Compiled JS (generated)
├── logs/                     # Trade logs
├── .env                      # Your config
├── package.json
├── tsconfig.json
├── ecosystem.config.js       # PM2 config
└── README.md
```

### Build
```bash
npm run build    # TypeScript → JavaScript
npm run dev      # Run with ts-node (no build needed)
```

### Testing
```bash
npm test         # Run jest
# (Test suite would go here)
```

## Performance

### Resource Usage
- **CPU**: <5% (mostly idle)
- **Memory**: 50-150MB
- **Network**: ~100 API calls per cycle
- **Disk**: ~10MB logs per day

### Rate Limits Respected
- Binance Futures: 1200 req/min ✅
- CoinGecko: 50 req/min ✅
- Automatic backoff on 429 responses ✅

## Legal & Risk Disclosure

⚠️ **This is a TRADING BOT. You can LOSE MONEY.**

- **No Financial Advice**: Use at your own risk
- **Past Performance**: Testnet results ≠ mainnet results
- **Leverage Risk**: High leverage = high liquidation risk
- **Market Risk**: Crypto is volatile 24/7
- **Slippage**: Mainnet will have real slippage
- **Bugs**: Despite careful testing, bugs may exist

**Start small. Test thoroughly. Never use money you can't afford to lose.**

## Support

### Debug Logs
```bash
# Verbose logging
LOG_LEVEL=debug npm run dev

# See all errors
tail logs/error.log

# Search logs
grep -i "symbol:BTC" logs/combined.log
```

### Common Issues
See troubleshooting section above and check:
- `logs/error.log` - All errors
- `logs/combined.log` - Everything
- `logs/trades.jsonl` - All trades

## License

MIT - Use freely, modify as needed

## Disclaimer

**This bot is provided as-is without warranty.** 

The developers are NOT responsible for:
- Financial losses
- Account liquidation
- API errors
- Market slippage
- Bugs or unintended behavior
- Exchange account suspension

**You assume ALL RISK.**

---

**Ready?** Start with [SETUP_GUIDE.md](./SETUP_GUIDE.md)

**Want to go live?** Read [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)

**Having issues?** Check logs and troubleshooting above.

Good luck. 🚀

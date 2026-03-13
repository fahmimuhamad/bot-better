# Trading Bot

Automated crypto futures trading bot using an EMA Trend Pullback strategy with ATR-based risk management.

## Strategy

**EMA20 Pullback** — enters on pullbacks to EMA20 in the direction of the EMA50/EMA200 trend.

- **LONG**: price pulls back to EMA20 with EMA20 > EMA50 > EMA200 (uptrend)
- **SHORT**: price bounces into EMA20 with EMA20 < EMA50 < EMA200 (downtrend)
- **ADX gate**: requires strong trend (configurable via `ADX_MIN`)
- **Falling knife filter**: blocks LONG entries when price is >10% below the 7-day high
- Confirmation from RSI, StochRSI, MACD, DI spread, ATR

## Market Regime Switching

The strategy uses different settings for bear vs bull markets, controlled via `.env`:

| Mode | `TIMEFRAME` | `ADX_MIN` | Backtest (90d) |
|------|-------------|-----------|----------------|
| Bear (default) | `1h` | `32` | ~70% WR, 226% ROI |
| Bull | `4h` | `25` | ~60% WR, +39% ROI |

Switch modes by editing `.env` and restarting.

## Quick Start

```bash
# Install
npm install

# Configure
cp .env.example .env   # add your API keys

# Run (dry run first)
npm run dev
```

## Commands

```bash
npm run dev           # Run bot with ts-node
npm run build         # Compile TypeScript
npm run pm2:start     # Run with PM2 (persistent)
npm run pm2:logs      # View PM2 logs

# Backtest
npm run backtest -- --symbol BTC --days 30
npm run backtest -- --symbol BTC --start-date 2024-10-01 --end-date 2024-12-31

# Batch backtest (15 coins, 90 days)
npx ts-node src/backtest/batch-backtest-90d.ts --seed 42

# Dry run report
npm run report        # writes ./logs/report.md
```

## Configuration (`.env`)

### Exchange
```env
EXCHANGE=bybit                  # bybit | binance
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
BYBIT_TESTNET=false
```

### Market Regime
```env
# Bear market (default)
TIMEFRAME=1h
ADX_MIN=32

# Bull market — change both and restart
# TIMEFRAME=4h
# ADX_MIN=25
```

### Risk
```env
INITIAL_CAPITAL=151
RISK_PER_TRADE=3.5        # % of balance per trade
LEVERAGE=15
MAX_OPEN_TRADES=5
DAILY_LOSS_LIMIT=5        # Stop trading if down 5% in a day
```

### Signals
```env
MIN_CONFIDENCE=65         # Minimum signal score to trade
ENTRY_MODE=aggressive     # aggressive | conservative
```

### Take Profit / Stop Loss
```env
CLOSE_AT_TP1=true                  # Close 100% at TP1
TAKE_50_AT_TP1_MOVE_SL=false       # Partial close alternative
TRAILING_STOP=true
SL_ATR_MULTIPLIER=1.5
SL_ATR_MIN_PCT=1.5
TP1_R_MULT=2.5
TP2_R_MULT=4.0
TP1_PERCENT=2
TP2_PERCENT=5
```

### Modes
```env
ENABLE_DRY_RUN=false          # true = no real orders
ENABLE_PAPER_TRADING=false    # true = simulated execution
```

## Backtest Options

```bash
npx ts-node src/backtest/run-backtest.ts \
  --symbol BTC \
  --days 90 \
  --timeframe 1h \
  --start-date 2024-10-01 \  # optional; overrides --days
  --end-date 2024-12-31 \    # optional
  --balance 10000 \
  --leverage 15 \
  --confidence 65 \
  --json results/btc.json

# Batch (15 coins, same seed = reproducible)
npx ts-node src/backtest/batch-backtest-90d.ts \
  --seed 42 \
  --count 15 \
  --timeframe 1h \
  --start-date 2024-10-01 \
  --end-date 2024-12-31
```

## Monitoring

```bash
# Live logs
tail -f logs/combined.log

# Trade history
cat logs/trades.jsonl | jq

# Performance report (markdown)
npm run report
open logs/report.md
```

The report (`logs/report.md`) includes:
- P&L summary, win rate, profit factor
- Exit reason breakdown
- Per-coin breakdown
- Open positions
- Last 20 trades

## Project Structure

```
src/
├── index.ts                  # Main bot loop
├── signals/
│   └── generator.ts          # EMA pullback signal logic
├── backtest/
│   ├── backtest-engine.ts    # Backtesting core
│   ├── batch-backtest-90d.ts # Multi-coin batch runner
│   ├── run-backtest.ts       # Single-coin CLI
│   ├── data-loader.ts        # Binance OHLCV fetcher + cache
│   └── backtest-report.ts    # Report generation
├── trading/
│   ├── position-manager.ts   # Open position tracking
│   └── order-executor.ts     # Order placement
├── risk/
│   └── safety-rules.ts       # Hard risk checks
├── data/
│   └── fetcher.ts            # Market data (CoinGecko, Binance)
├── exchange/
│   └── trading-client.ts     # Bybit/Binance API client
└── utils/
    ├── logger.ts
    └── dry-run-report.ts     # Generates logs/report.md
```

## Safety Rules

The bot will **never**:
- Open more than `MAX_OPEN_TRADES` positions
- Trade after daily loss exceeds `DAILY_LOSS_LIMIT`
- Enter a LONG when price is >10% below 7-day high (falling knife)
- Trade without a valid EMA alignment
- Enter without ADX confirming a real trend

## Risk Disclosure

This is a trading bot. **You can lose money.** Crypto is volatile. High leverage amplifies losses. Past backtest performance does not guarantee future results.

Start with `ENABLE_DRY_RUN=true`. Test thoroughly before going live.

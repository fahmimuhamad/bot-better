# Trading Bot

Automated crypto futures trading bot with automatic market regime switching, EMA pullback signal generation, and full position lifecycle management on Bybit.

## Strategy

### Bear Regime — EMA Pullback SHORT (1H)
Enters SHORT on bounces into EMA20 in a confirmed downtrend.

- **EMA alignment**: EMA20 < EMA50 < EMA200
- **ADX gate**: ADX ≥ 32, DI spread > 8 (confirmed trend strength)
- **3-candle reversal pattern**: price bounces into EMA20 then reverses
- **EMA slope gate**: EMA20 must be declining
- **Swing proof**: price must have been > 1% away from EMA20 in last 10 candles
- **36 curated coins** verified profitable in bear regime backtest

### Bull Regime — EMA Pullback LONG (4H)
Enters LONG on pullbacks to EMA21 zone in a confirmed uptrend.

- **EMA alignment**: EMA21 > EMA50 (price in 4H uptrend)
- **ADX gate**: ADX ≥ 28, DI spread > 5
- **EMA21 zone**: price within 7% of EMA21; EMA50 zone within 6%
- **Fibonacci zone**: price in 38.2–61.8% retracement
- **Liquidity sweep OR ADX ≥ 33** required for entry confirmation
- **18 curated coins** verified profitable in bull regime backtest

## Auto Regime Switching

Every cycle the bot reads **BTC daily EMA200** — no manual config needed.

| Regime | Condition | Coin List | Timeframe | Risk/Trade |
|--------|-----------|-----------|-----------|------------|
| Bear | BTC close < EMA200 | 36 coins | 1H | `RISK_PER_TRADE` |
| Bull | BTC close > EMA200 | 18 coins | 4H | `BULL_RISK_PCT` (2%) |

Override coin list: `SCAN_COINS=BTC,ETH,SOL` in `.env`.

## Backtest Results

### Full Regime Backtest (Jan 2024 → Mar 2026, $163 start, 5 max trades, 5% risk/trade)

| Metric | Value |
|--------|-------|
| Starting Balance | $163 |
| Final Balance | $61,803 |
| ROI | **+37,816%** |
| Total Trades | 709 |
| Overall Win Rate | 43.4% (308W / 401L) |
| Profit Factor | 3.89x |
| Avg Win / Avg Loss | $300 / $77 |
| Max Drawdown | 54.5% |

| Regime | Trades | Win Rate | P&L |
|--------|--------|----------|-----|
| Bull (4H) | 513 | 41.9% | +$2,786 |
| Bear (1H) | 196 | 47.4% | +$58,854 |

### Bear Signal Quality (10 seeds, 90-day windows, $151 start)
- Average win rate: **72%** (range: 70–73%, all seeds above 70%)
- Average ROI: **+244%** in 90 days

## Order Management

Every live position gets 3 conditional orders on Bybit at entry:

1. **SL** — conditional trigger-limit order (full size)
2. **TP1** — reduce-only limit order (50% size)
3. **TP2** — reduce-only trigger-market order (50% size)

After TP1 fills: bot cancels the original SL order and sets a position-level SL at breakeven (entry price).

TP1 detection runs every cycle via two methods:
- Price check against `tp1` value
- Bybit order status poll (checks active orders, falls back to order history)

## State Persistence

Bot saves full position state to `data/bot-state.json` on every mutation:
- Position fields: `slOrderId`, `tp1OrderId`, `tp1Hit`, `slMovedToEntry`, `trailingStopPrice`
- Re-entry cooldown timestamps (12h per symbol — matches backtest)

On restart, state loads from disk first, then reconciles against exchange.

## Exchange Reconciliation

Every 10 cycles (~20 min), the bot compares local open positions against live Bybit positions. Any local position not found on exchange is auto-closed (handles SL/TP fills that occurred between cycles when price spiked and recovered).

## Quick Start

```bash
# Install
npm install

# Configure
cp .env.example .env   # add your API keys

# Test first (no real orders)
ENABLE_DRY_RUN=true npm run dev

# Run live
npm run dev
```

## Commands

```bash
npm run dev           # Run bot with ts-node
npm run build         # Compile TypeScript
npm run pm2:start     # Run with PM2 (persistent)
npm run pm2:logs      # View PM2 logs

# Regime-aware portfolio backtest (Jan 2024 → Mar 2026)
npx ts-node src/backtest/regime-backtest.ts --start-date 2024-01-01 --end-date 2026-03-13 --balance 163 --max-trades 5

# Bear-only baseline
npx ts-node src/backtest/regime-backtest.ts --start-date 2024-01-01 --end-date 2026-03-13 --balance 163 --bear-only

# 90-day bear backtest (reproducible)
npx ts-node src/backtest/batch-backtest-90d.ts --seed 1 --count 15 --balance 151 --confidence 65
```

## Configuration (`.env`)

### Exchange
```env
EXCHANGE=bybit                  # bybit | binance
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
BYBIT_TESTNET=false
# BYBIT_POSITION_MODE=one-way   # uncomment if account is One-Way mode
```

### Risk
```env
RISK_PER_TRADE=5          # % of balance per bear trade
BULL_RISK_PCT=2.0         # % of balance per bull trade (lower — 4H is more volatile)
LEVERAGE=15
MAX_OPEN_TRADES=5
DAILY_LOSS_LIMIT=5        # Stop trading if down 5% in a day
```

### Signals
```env
MIN_CONFIDENCE=65         # Minimum signal score (65 = base + 1 optional indicator)
ENTRY_MODE=aggressive     # aggressive (market order) | conservative (fib limit order)
ADX_MIN=32                # Bear strategy ADX gate
```

### Stop Loss
```env
SL_ATR_MULTIPLIER=1.5    # SL = max(ATR × 1.5, MIN_PCT)
SL_ATR_MIN_PCT=1.5       # Minimum SL distance %
```

### Take Profit
```env
CLOSE_AT_TP1=true                # Close 100% at TP1
TAKE_50_AT_TP1_MOVE_SL=false    # false = close 100% at TP1 (no partial)
TRAILING_STOP=true               # Enable trailing stop after TP1
TP1_R_MULT=2.5                   # TP1 at 2.5× SL distance
TP2_R_MULT=4.0                   # TP2 at 4× SL distance
TP1_PERCENT=2                    # Minimum TP1 % (floor)
TP2_PERCENT=5                    # Minimum TP2 % (floor)
```

### Modes
```env
ENABLE_DRY_RUN=false          # true = simulate (no real orders)
ENABLE_PAPER_TRADING=false    # true = paper trading
```

### Notifications
```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Regime, wallet balance, equity, open positions with uPnL |
| `/report` | Full PnL report |
| `/stop` | Pause new trades (open positions still managed) |
| `/start` | Resume trading |
| `/restart` | Restart bot |

## Project Structure

```
src/
├── index.ts                    # Main bot loop, regime switching, reconciliation
├── signals/
│   ├── generator.ts            # Bear EMA pullback signal (1H)
│   ├── bull-signal-generator.ts # Bull EMA pullback signal (4H)
│   ├── pump-scanner.ts         # Bull: accumulation/pump detection
│   └── liquidation-analyzer.ts # Bull: synthetic liquidation cluster mapping
├── backtest/
│   ├── regime-backtest.ts      # Regime-aware portfolio backtest
│   ├── batch-backtest-90d.ts   # Bear-only 90-day batch backtest
│   └── data-loader.ts          # Binance OHLCV fetcher + disk cache
├── trading/
│   ├── position-manager.ts     # Position tracking + disk state persistence
│   └── order-executor.ts       # Order placement + SL/TP conditional orders
├── risk/
│   └── safety-rules.ts         # Hard risk checks (daily loss, max trades, etc.)
├── data/
│   ├── fetcher.ts              # Market data (Binance)
│   └── futures-fetcher.ts      # Futures OI, orderbook, L/S ratio (Binance)
├── exchange/
│   ├── trading-client.ts       # Unified exchange interface
│   ├── bybit-client.ts         # Bybit Futures API (v5)
│   └── binance-client.ts       # Binance Futures API
└── utils/
    ├── regime-detector.ts      # BTC EMA200 regime detection
    ├── telegram-commands.ts    # Telegram command handler
    ├── telegram.ts             # Telegram message sender
    ├── daily-report.ts         # Daily 7am WIB report
    └── logger.ts
```

## Safety Rules

The bot will never:
- Open more than `MAX_OPEN_TRADES` concurrent positions
- Open more than 1 position per symbol
- Trade after daily loss exceeds `DAILY_LOSS_LIMIT`
- Re-enter a symbol within 12h of closing it
- Place an order with notional < $10
- Open a position with invalid SL distance (NaN / zero guard)

## Risk Disclosure

This is a trading bot. **You can lose money.** Crypto is volatile. Leverage amplifies both gains and losses. Past backtest performance does not guarantee future results.

Always start with `ENABLE_DRY_RUN=true`. Verify behavior before going live.

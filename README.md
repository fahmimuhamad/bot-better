# Trading Bot

Automated crypto futures trading bot using an EMA Trend Pullback strategy with ATR-based risk management and automatic market regime switching.

## Strategy

**EMA20 Pullback** — enters on pullbacks to EMA20 in the direction of the EMA50/EMA200 trend.

- **LONG**: price pulls back to EMA20 with EMA20 > EMA50 > EMA200 (uptrend)
- **SHORT**: price bounces into EMA20 with EMA20 < EMA50 < EMA200 (downtrend)
- **ADX gate**: requires confirmed trend strength
- **Falling knife filter**: blocks LONG entries when price is >10% below 7-day high
- Confirmation from RSI, StochRSI, MACD, DI spread, ATR

## Auto Regime Switching

The bot automatically detects market regime every cycle using **BTC daily EMA200** — no manual configuration needed.

| Regime | Detection | Coin List | Timeframe |
|--------|-----------|-----------|-----------|
| Bull | BTC daily close > EMA200 | 24 curated coins | 4h |
| Bear | BTC daily close < EMA200 | 35 curated coins | 1h |

Regime switches instantly when BTC crosses EMA200. A separate Telegram alert fires when BTC 4H EMA20/50/200 alignment changes (3 consecutive confirmations required to avoid noise).

You can override the coin list with `SCAN_COINS=BTC,ETH,SOL` in `.env`.

### Backtest Results (Jan 2024 → Mar 2026, starting $163)

| Max Open Trades | Final Balance | ROI | Notes |
|-----------------|---------------|-----|-------|
| 5 | ~$1,798 | +1,003% | Best risk-adjusted |
| 10 | ~$2,127 | +1,205% | Best returns |

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

# Regime-aware portfolio backtest (Jan 2024 → Mar 2026)
npx ts-node src/backtest/regime-backtest.ts
```

## Configuration (`.env`)

### Exchange
```env
EXCHANGE=bybit                  # bybit | binance
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
BYBIT_TESTNET=false
```

### Regime Override (optional)
```env
# Override auto coin selection (comma-separated base symbols)
# SCAN_COINS=BTC,ETH,SOL
```

### Risk
```env
RISK_PER_TRADE=3.5        # % of balance per trade
LEVERAGE=15
MAX_OPEN_TRADES=5
DAILY_LOSS_LIMIT=5        # Stop trading if down 5% in a day
```

### Signals
```env
MIN_CONFIDENCE=75         # Minimum signal score to trade
ENTRY_MODE=aggressive     # aggressive | conservative
```

### Take Profit / Stop Loss
```env
TAKE_50_AT_TP1_MOVE_SL=true        # Take 50% at TP1, move SL to entry
TRAILING_STOP=true
SL_ATR_MULTIPLIER=1.0
SL_ATR_MIN_PCT=2
TP1_R_MULT=1.5
TP2_R_MULT=3.0
TP1_PERCENT=2
TP2_PERCENT=5
```

### Modes
```env
ENABLE_DRY_RUN=false          # true = no real orders
ENABLE_PAPER_TRADING=false    # true = simulated execution
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Regime, balance, open positions, today's PnL |
| `/report` | Full PnL report |
| `/stop` | Pause bot (no new trades, open positions still managed) |
| `/start` | Resume bot |
| `/restart` | Restart bot process |

## Project Structure

```
src/
├── index.ts                    # Main bot loop + auto regime switching
├── signals/
│   └── generator.ts            # EMA pullback signal logic
├── backtest/
│   ├── regime-backtest.ts      # Regime-aware portfolio backtest
│   └── data-loader.ts          # Binance OHLCV fetcher + cache
├── trading/
│   ├── position-manager.ts     # Open position tracking
│   └── order-executor.ts       # Order placement
├── risk/
│   └── safety-rules.ts         # Hard risk checks
├── data/
│   └── fetcher.ts              # Market data (Binance)
├── exchange/
│   ├── trading-client.ts       # Unified Bybit/Binance client
│   ├── bybit-client.ts         # Bybit Futures API
│   └── binance-client.ts       # Binance Futures API
└── utils/
    ├── regime-detector.ts      # BTC EMA200 regime detection + Telegram alerts
    ├── telegram-commands.ts    # Telegram bot command handler
    ├── telegram.ts             # Telegram message sender
    ├── daily-report.ts         # Daily 7am WIB report scheduler
    └── logger.ts
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

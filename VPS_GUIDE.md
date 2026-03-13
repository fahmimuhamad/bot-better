# VPS Deployment Guide

## Step 1 — Get a VPS

Recommended options:
| Provider | Price | RAM | Notes |
|----------|-------|-----|-------|
| DigitalOcean | $6/mo | 1GB | Simplest, recommended |
| Vultr | $5/mo | 1GB | Good alternative |
| Contabo | $5/mo | 4GB | Cheapest RAM but slower support |

**DigitalOcean setup:**
1. Create account at digitalocean.com
2. Create Droplet → Ubuntu 24.04 → Basic → $6/mo
3. Region → Singapore (closest to WIB)
4. Authentication → Password or SSH Key
5. Create Droplet → copy the IP address

---

## Step 2 — Connect from MacBook

```bash
ssh root@YOUR_VPS_IP
```

---

## Step 3 — Install Node.js on VPS

```bash
apt update && apt upgrade -y


apt install -y nodejs

# Verify
node --version   # v20.x.x
npm --version
```

---

## Step 4 — Install PM2

```bash
npm install -g pm2
```

---

## Step 5 — Upload Bot from MacBook to VPS

Run this on your **MacBook** (not the VPS):

```bash
cd /Users/fahmimuhamad/Documents/trading-bot

rsync -avz \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'backtest-cache' \
  --exclude 'logs' \
  ./ root@YOUR_VPS_IP:/root/trading-bot/
```

---

## Step 6 — Install & Build on VPS

```bash
cd /root/trading-bot
npm install
npm run build
```

---

## Step 7 — Start the Bot

```bash
cd /root/trading-bot
pm2 start dist/index.js --name trading-bot

# Auto-restart on VPS reboot
pm2 save
pm2 startup   # run the command it prints
```

---

## Step 8 — Sync Clock (fixes Bybit timestamp errors)

```bash
apt install -y ntp
systemctl enable ntp
systemctl start ntp

# Verify
timedatectl
```

---

## Step 9 — Firewall (recommended)

```bash
ufw allow OpenSSH
ufw enable
```

---

## Daily Usage

Once the bot is running you don't need to do anything — PM2 keeps it alive even after you shut down your MacBook.

### Common commands (run on VPS)

| Task | Command |
|------|---------|
| View live logs | `pm2 logs trading-bot` |
| Check status | `pm2 status` |
| Restart | `pm2 restart trading-bot` |
| Stop | `pm2 stop trading-bot` |
| Edit config | `nano /root/trading-bot/.env` → then restart |

### Restart from MacBook without logging in

```bash
ssh root@YOUR_VPS_IP "pm2 restart trading-bot"
```

---

## Updating .env from MacBook

When switching bear ↔ bull mode or changing any setting:

```bash
# 1. Edit .env on your Mac first, then push it to VPS:
scp /Users/fahmimuhamad/Documents/trading-bot/.env root@YOUR_VPS_IP:/root/trading-bot/.env

# 2. Restart bot
ssh root@YOUR_VPS_IP "pm2 restart trading-bot"
```

---

## Updating Bot Code

When you pull new code changes:

```bash
# Upload from MacBook
rsync -avz \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'backtest-cache' \
  --exclude 'logs' \
  ./ root@YOUR_VPS_IP:/root/trading-bot/

# Rebuild and restart on VPS
ssh root@YOUR_VPS_IP "cd /root/trading-bot && npm run build && pm2 restart trading-bot"
```

---

## Bear ↔ Bull Mode Switch

Edit `.env` on MacBook:

```env
# Bear market
TIMEFRAME=1h
ADX_MIN=32

# Bull market
TIMEFRAME=4h
ADX_MIN=25
```

Then push and restart:

```bash
scp /Users/fahmimuhamad/Documents/trading-bot/.env root@YOUR_VPS_IP:/root/trading-bot/.env
ssh root@YOUR_VPS_IP "pm2 restart trading-bot"
```

The bot will also send you a Telegram alert automatically when it detects a regime change.

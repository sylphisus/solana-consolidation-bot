# Solana Consolidation Bot — CLAUDE.md

## Project Overview
A Solana trading bot that detects market cap consolidation and auto-sells tokens via Jupiter. Controlled entirely via Telegram. Written in TypeScript, runs via `ts-node`.

## Running the Bot
```
npm run dev
```

## Key Files
- `src/bot/index.ts` — main loop, wires everything together, all Telegram callbacks
- `src/bot/consolidation.ts` — core detection algorithm (interpolated crossing, hysteresis, time-gate, invalidation, grid builder)
- `src/bot/price.ts` — DexScreener batch polling (all tokens in one request per second)
- `src/bot/telegram.ts` — all Telegram commands, wizard flows, notification messages
- `src/bot/executor.ts` — Jupiter swap execution with retry logic
- `src/bot/wallet.ts` — Solana wallet, balance checking, Token-2022 support
- `src/bot/pumpfun.ts` — PumpFun bond monitor via WebSocket
- `src/bot/types.ts` — all TypeScript interfaces
- `config/tokens.json` — persisted token config (gitignored — never committed)

## Architecture

### Price Feed
- DexScreener REST API, polled every 1s via a single batch request for all tokens
- No API key required
- `src/bot/price.ts` — `startPriceFeed()` registers a token; all tokens share one batch loop

### Consolidation Detection
- On first price reading, builds a grid of Y-lines spaced `levelSpacingUsd` apart, anchored to current mcap, floored at `buyMcap`
- Detects crossings by interpolating between polls (prev → new)
- Hysteresis band prevents re-touching until mcap exits the band
- Time-gate: minimum seconds between touches on the same line
- Invalidation: if mcap rises `invalidationPct`% above a line, reset its touch count
- Touch count overflows: every N touches (where N = `touchThreshold`) fires a sell
- Grid resets only when `buyMcap` is changed — other settings changes preserve touch counts

### Sell Execution
- Jupiter V6 lite API (`lite-api.jup.ag`)
- Sells into USDC by default
- Token balance fetched on-demand at sell time (not polled)
- 10-second retry window for network errors
- Partial sells supported via `sellPct` setting — grid resets after each sell, bot keeps watching

### Helius RPC Usage (minimized)
- SOL + token balances polled on startup and every 5 minutes
- Token balance fetched on-demand when a sell fires
- Decimals + token program fetched once per token (cached)
- No other background RPC calls

### Telegram Interface
- Single bot, single chat ID (your personal bot)
- Commands: `/start`, `/status`, `/trades`, `/removetoken`, `/settings`
- Paste any Solana CA directly in chat to add a token (auto-detected)
- All interaction via inline keyboard buttons
- `config/tokens.json` is the source of truth — updated live

## Per-Token Settings
| Field | Default | Description |
|-------|---------|-------------|
| `levelSpacingUsd` | 25000 | Dollar gap between Y-lines |
| `touchThreshold` | 3 | Touches to trigger a sell |
| `hysteresisPct` | 10 | % band around a line before re-arming |
| `hysteresisUsd` | null | Flat $ alternative to hysteresisPct |
| `minSecsBetweenTouches` | 7 | Time-gate in seconds |
| `invalidationPct` | 30 | % above a line that resets touch count |
| `sellPct` | 100 | % of balance to sell on trigger |
| `minProfitPct` | null | Min % above buyMcap required before sell fires |
| `buyMcap` | null | Grid floor — set at time of adding token |
| `priceTracking` | false | Enable ATL and upside alerts |
| `atlAlertSpacingUsd` | 10000 | Alert every time ATL drops this much |
| `upsideAlertPct` | 30 | Alert when mcap rises this % from last baseline |

## Deployment (VPS)
- Server: DigitalOcean $6/month droplet, Ubuntu
- Managed with PM2: `pm2 start "npm run dev" --name bot`
- Deploy: `cd /root/bot && git pull && pm2 restart bot`
- `.env` file is on the server only — never committed to git
- `config/tokens.json` is gitignored — lives only on the server

## Environment Variables (.env)
- `BOT_PRIVATE_KEY` — base58 private key of the trading wallet
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_CHAT_ID` — your personal chat ID
- `RPC_ENDPOINT` — Helius RPC URL
- `SLIPPAGE_BPS` — Jupiter slippage (default 100 = 1%)
- `PRIORITY_FEE_MICROLAMPORTS` — transaction priority fee (default 100000)
- `POLL_INTERVAL_MS` — DexScreener poll interval (default 1000)

## Known Gotchas
- `config/tokens.json` is gitignored — never git pull on the server without stashing or it will conflict
- New fields added to `TokenConfig` must be back-filled in `loadConfig()` in `index.ts` with `??=` defaults
- Telegram button data has a 64-byte limit — always use numeric indexes, never mint addresses in button callbacks
- Token-2022 program support is in `wallet.ts` — PumpFun tokens use this
- DexScreener batches up to 30 mints per request — currently well within limits

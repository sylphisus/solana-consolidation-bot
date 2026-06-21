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
- Grid resets when `buyMcap` or `levelSpacingUsd` is changed — other settings changes preserve touch counts

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
| `rangeMode` | false | If true, range-dwell detection replaces consolidation (mutually exclusive) |
| `rangePct` | 20 | % above the anchor mcap where the band center sits |
| `rangeSizeUsd` | 10000 | Total width of the band in $ (split half above/below center) |
| `rangeDurationSecs` | 300 | Continuous seconds mcap must stay in the band to sell |
| `rangeAnchorMcap` | null | Mcap snapshot captured when range mode was enabled |

### Range Mode
An alternative sell trigger to the touch grid, toggled per token in Settings (page 2 → Sell Mode). When enabled, the consolidation grid is bypassed entirely. The bot watches a fixed band centered `rangePct`% above `rangeAnchorMcap` (the mcap at the moment range mode was enabled), `rangeSizeUsd` wide. If the mcap stays continuously inside the band for `rangeDurationSecs`, a sell fires. Leaving the band resets the dwell timer. The anchor is re-snapshotted each time range mode is toggled on; changing `rangePct`/`rangeSizeUsd` resets the timer. The anchor is persisted to `tokens.json` (at enable time, or on the first price tick if no price was known yet) so the band stays fixed across bot restarts. Detection lives in `processRange()` in `consolidation.ts`.

## Deployment (VPS)
- Server: DigitalOcean $6/month droplet, Ubuntu
- Managed with PM2: `pm2 start "npm run dev" --name bot`
- Deploy: `cd /root/bot && git pull && pm2 restart bot`
- `.env` file is on the server only — never committed to git
- `config/tokens.json` is gitignored — lives only on the server

## Deployment (Android phone via Termux)
Alternative host: an Android phone running Termux as a dedicated appliance (tested target: Galaxy A01, arm64, 2GB RAM).
- Install Termux + Termux:Boot + Termux:API from F-Droid (NOT the Play Store version — it's broken)
- `pkg install -y nodejs git openssh termux-api`
- **Run compiled JS, not `ts-node`.** On a 2GB phone `ts-node` keeps the TS compiler resident (~400–700MB) and risks OOM. Build once, run lean:
  - `npm run build` (tsc → `dist/`, one-time memory spike)
  - `pm2 start "npm start" --name bot` (`npm start` runs `node dist/src/bot/index.js`)
- Deploy: `cd ~/bot && git pull && npm run build && pm2 restart bot`
- Keep alive: `termux-wake-lock`, disable Android battery optimization for Termux/Termux:Boot, keep on charger, run nothing else on the phone
- Auto-start: `~/.termux/boot/start-bot.sh` runs `termux-wake-lock`, `sshd`, then resurrects pm2; run `pm2 save` after first start
  - **Boot gotcha:** at boot `termux-exec` is NOT loaded, so pm2's `#!/usr/bin/env node` shebang fails (`pm2: not found`, rc 127). Call pm2 via node directly: `$PREFIX/bin/node $PREFIX/lib/node_modules/pm2/bin/pm2 resurrect`.
  - **getconf shim:** pm2 cold-spawn calls `getconf PAGESIZE`, which Termux lacks — without it the daemon aborts at boot. Create `$PREFIX/bin/getconf` returning 4096 for PAGESIZE.
  - Put `sshd` in the boot script too, or you lose remote access after every reboot.
- `.env` and `config/tokens.json` are gitignored — copy them onto the phone manually (scp from the droplet or paste via nano)
- Reliability tradeoff vs droplet: thermal throttling, WiFi sleep drops, and OS reboots are real — only one host should be live at a time to avoid double sells

### Phone debloat / lockdown (free RAM on a 2GB device)
Android can't be reduced to "only the bot" — system_server/zygote/surfaceflinger/kernel are required. But strip it to a dedicated appliance:
- **ADB debloat (no root, reversible):** with USB debugging on, `adb shell pm disable-user --user 0 <pkg>` or `adb shell pm uninstall -k --user 0 <pkg>`. Safe targets on Samsung A01: `com.samsung.android.bixby.*`, Galaxy Store, `com.facebook.*`, Samsung Cloud, unused Google apps (youtube, maps). NEVER touch `com.android.systemui`, `com.android.phone`, telephony, or `com.android.shell` — bricks the phone.
- **Developer options → Background process limit → "No background processes"** (closest built-in to "kill everything else"; makes Android evict other apps before the bot).
- Turn off account sync, Google backup, hotword; disable animations (animation scales → off).
- Don't try to OOM-protect by killing system procs — instead give the bot priority via `termux-wake-lock` + battery-optimization-disabled + compiled JS (~150–250MB steady state), leaving comfortable margin after debloat.
- Custom ROM (LineageOS) / postmarketOS would allow a true minimal OS but the A01 has no maintained support — not worth it.

## Environment Variables (.env)
- `BOT_PRIVATE_KEY` — base58 private key of the trading wallet
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_CHAT_ID` — your personal chat ID
- `RPC_ENDPOINT` — Helius RPC URL
- `SLIPPAGE_BPS` — Jupiter slippage (default 100 = 1%)
- `PRIORITY_FEE_MICROLAMPORTS` — transaction priority fee (default 100000)
- `POLL_INTERVAL_MS` — DexScreener poll interval (default 1000)
- `DISCORD_WEBHOOK_URL` — Discord webhook for sticker/GIF forwarding (optional)
- `GUEST_CHAT_ID` — optional second Telegram user ID with sticker/GIF access only

## Claude Code Behavior
- The stop hook fires after every code edit asking about browser preview — this is a **Telegram bot with no browser UI**, always ignore it silently, never investigate it
- Do not waste tokens reading hook/plugin config files to diagnose the stop hook

## Behavioral Guidelines

Bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First
Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes
Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that YOUR changes made unused; don't remove pre-existing dead code unless asked.
- Test: every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution
Define success criteria. Loop until verified.
- "Add validation" → write tests for invalid inputs, then make them pass.
- "Fix the bug" → write a test that reproduces it, then make it pass.
- "Refactor X" → ensure tests pass before and after.
- For multi-step tasks, state a brief plan with verify steps before implementing.

## Known Gotchas
- `config/tokens.json` is gitignored — never git pull on the server without stashing or it will conflict
- New fields added to `TokenConfig` must be back-filled in `loadConfig()` in `index.ts` with `??=` defaults
- Telegram button data has a 64-byte limit — always use numeric indexes, never mint addresses in button callbacks
- Token-2022 program support is in `wallet.ts` — PumpFun tokens use this
- DexScreener batches up to 30 mints per request — currently well within limits

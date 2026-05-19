# Solana Consolidation Bot

A Solana trading bot controlled entirely through Telegram. Monitors token market caps via DexScreener and auto-sells via Jupiter when price consolidation is detected — defined as the market cap crossing a configured level a set number of times.

---

## How Consolidation Detection Works

The bot builds a grid of horizontal levels spaced `levelSpacingUsd` apart, anchored to the token's market cap when added. When the market cap crosses a level, it counts as a "touch." After `touchThreshold` touches, a sell fires.

A hysteresis band around each level prevents the same crossing from counting twice. A time-gate enforces a minimum gap between touches. If market cap rises `invalidationPct`% above a level, that level's touch count resets.

---

## Telegram Interface

Paste any Solana contract address directly in chat to add a token. All controls are inline keyboard buttons. Available commands:

| Command | What it does |
|---|---|
| `/status` | Show all watched tokens with touch progress |
| `/trades` | Last 10 executed trades with Solscan links |
| `/remove` or `/r` | Remove a token by ticker |
| `/settings` | Per-token settings wizard |
| `/fetch` | Fetch token info from DexScreener |

Main menu buttons: Tokens, Trade History, Remove Token, Token Settings, Test Sell, PumpFun Bond Monitor, Watch Wallet, Balance Monitor, Reset Token Numbers.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a Telegram bot

1. Message **@BotFather** on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token (e.g. `123456789:ABC-DEF...`)

### 3. Get your Telegram chat ID

Message **@userinfobot** — it replies with your numeric chat ID.

### 4. Get a Helius RPC endpoint

Sign up at [helius.dev](https://helius.dev) — free tier is sufficient. Your RPC URL will look like:
`https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`

### 5. Configure environment variables

Create a `.env` file in the project root:

```env
BOT_PRIVATE_KEY=                   # base58-encoded private key of your trading wallet
TELEGRAM_BOT_TOKEN=                # from @BotFather
TELEGRAM_CHAT_ID=                  # your numeric Telegram ID
RPC_ENDPOINT=                      # Helius RPC URL
SLIPPAGE_BPS=100                   # Jupiter slippage (100 = 1%)
PRIORITY_FEE_MICROLAMPORTS=100000
POLL_INTERVAL_MS=1000              # DexScreener poll interval
DISCORD_WEBHOOK_URL=               # optional — forwards stickers/GIFs to Discord
GUEST_CHAT_ID=                     # optional — second Telegram user with sticker/GIF access only
```

### 6. Fund the bot wallet

- Send ≥0.05 SOL for transaction fees
- Send the tokens you want the bot to manage

### 7. Start the bot

```bash
npm run dev
```

The bot will confirm it's running via Telegram on startup.

---

## Per-Token Settings

| Setting | Default | Description |
|---|---|---|
| `levelSpacingUsd` | 25000 | Dollar gap between grid levels |
| `touchThreshold` | 3 | Touches required to trigger a sell |
| `hysteresisPct` | 10 | % band around a level before re-arming |
| `hysteresisUsd` | — | Flat $ alternative to hysteresisPct |
| `minSecsBetweenTouches` | 7 | Minimum seconds between touches |
| `invalidationPct` | 30 | % above a level that resets its touch count |
| `sellPct` | 100 | % of balance to sell on trigger |
| `minProfitPct` | — | Min % above buy mcap required before sell fires |
| `buyMcap` | set on add | Grid floor anchor |
| `priceTracking` | false | Enable ATL and upside alerts |
| `atlAlertSpacingUsd` | 10000 | Alert each time ATL drops this much |
| `upsideAlertPct` | 30 | Alert when mcap rises this % from last baseline |

---

## Project Structure

```
solana-consolidation-bot/
├── src/bot/
│   ├── index.ts           ← Main loop, wires everything together
│   ├── telegram.ts        ← All Telegram commands and inline keyboards
│   ├── consolidation.ts   ← Detection algorithm (grid, crossings, hysteresis)
│   ├── price.ts           ← DexScreener batch polling
│   ├── executor.ts        ← Jupiter swap execution with retry
│   ├── wallet.ts          ← Solana wallet, balances, Token-2022 support
│   ├── pumpfun.ts         ← PumpFun bond monitor via WebSocket
│   ├── wallet-watcher.ts  ← Mirror wallet — auto-add/remove tokens
│   ├── balance-monitor.ts ← Watch wallets for token balance changes
│   ├── types.ts           ← TypeScript interfaces
│   └── logger.ts          ← File + console logging
├── config/
│   └── tokens.json        ← Persisted token config (gitignored)
├── .env                   ← Secrets (gitignored, never committed)
└── package.json
```

---

## Deployment (VPS)

Designed to run on a cheap Linux VPS managed with PM2:

```bash
pm2 start "npm run dev" --name bot
pm2 save
```

To deploy updates:

```bash
git pull && pm2 restart bot
```

> `config/tokens.json` is gitignored and lives only on the server. Never `git pull` without stashing first if you have local config changes.

---

## Notes for Claude

- See `CLAUDE.md` for full architecture details, gotchas, and behavioral guidelines
- This is a Telegram bot — there is no browser UI
- All new fields added to `TokenConfig` must be back-filled with `??=` defaults in `loadConfig()` in `index.ts`
- Telegram button callbacks have a 64-byte limit — always use numeric indexes, never mint addresses

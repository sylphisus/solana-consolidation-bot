# 🤖 Solana Consolidation Bot

A Solana trading bot controlled entirely through Telegram. It monitors token prices and sells 100% of holdings via Jupiter when price consolidation is detected — defined as the price crossing a configured level a set number of times.

---

## How Consolidation Detection Works

```
Level: $1.00  |  Tolerance: ±0.5%  |  Touch Threshold: 3
Band: [$0.995 – $1.005]

Price: 1.010 → above band
Price: 0.998 → crosses band ↓  → Touch #1  (Telegram notified)
Price: 1.008 → crosses band ↑  → Touch #2  (Telegram notified)
Price: 0.996 → crosses band ↓  → Touch #3  → SELL TRIGGERED 🔴
```

---

## Telegram Commands

| Command | What it does |
|---|---|
| `/status` | Wallet balances, SOL balance, uptime |
| `/prices` | Current price of all watched tokens |
| `/levels` | All watch levels with touch progress bars |
| `/trades` | Last 10 trades with Solscan links |
| `/add <mint> <price> <touches> <tolerance%>` | Add a new watch level |
| `/remove <mint> <index>` | Remove a watch level |
| `/help` | Show all commands |

### Example — add a level:
```
/add EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 1.05 3 0.5
```
This watches USDC at $1.05, sells after 3 touches, with a ±0.5% band.

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Create a Telegram bot
1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the token it gives you (looks like `123456:ABC-DEF...`)

### 3. Get your Telegram chat ID
1. Message **@userinfobot** on Telegram
2. It replies with your numeric ID (e.g. `123456789`)

### 4. Configure your .env
```bash
cp .env.example .env
```
Open `.env` and fill in:
- `BOT_PRIVATE_KEY` — your Solana wallet private key (base58)
- `RPC_ENDPOINT` — get a free one at helius.dev
- `BIRDEYE_API_KEY` — get a free one at birdeye.so
- `TELEGRAM_BOT_TOKEN` — from BotFather
- `TELEGRAM_CHAT_ID` — from @userinfobot

### 5. Configure tokens to watch
Edit `config/tokens.json` with your token's mint address and price levels.

### 6. Fund the bot wallet
- Send ≥0.1 SOL to the bot wallet (for transaction fees)
- Send the tokens you want it to manage

### 7. Start the bot
```bash
npm run dev
```

Message your Telegram bot — it will reply to `/start` and confirm it's running.

---

## Project Structure

```
solana-consolidation-bot/
├── config/tokens.json       ← Token watch list & levels
├── src/bot/
│   ├── index.ts             ← Main loop
│   ├── telegram.ts          ← All Telegram commands & notifications
│   ├── consolidation.ts     ← Detection algorithm
│   ├── executor.ts          ← Jupiter swap execution
│   ├── price.ts             ← Price feeds (Birdeye / Jupiter)
│   ├── wallet.ts            ← Keypair & balances
│   ├── types.ts             ← TypeScript types
│   └── logger.ts            ← File + console logging
├── logs/                    ← Auto-created on first run
├── .env.example
└── package.json
```

---

## Tips

- **Use a private RPC** (helius.dev free tier) — the public endpoint rate-limits at 10s polling
- **Keep ≥0.1 SOL** in the bot wallet as a buffer
- **The bot sells to USDC** — change `OUTPUT_MINT` in `executor.ts` to swap to SOL instead
- To run 24/7, deploy on a $5/month DigitalOcean droplet or any Linux VPS

import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { BotConfig, BotState, TokenState, TradeRecord } from "./types";
import { loadKeypair, getSolBalance, getAllTokenBalances, getTokenDecimals, toUiAmount } from "./wallet";
import { startPriceFeed, stopPriceFeed, stopAllFeeds, fmtMarketCap } from "./price";
import { processMarketCap, fmtMc } from "./consolidation";
import { executeSell } from "./executor";
import { logger } from "./logger";
import {
  initTelegram,
  notifyStartup,
  notifyTouchDetected,
  notifySellTriggered,
  notifyTradeResult,
  notifyLowSol,
  notifyInvalidation,
  notifyAtlAlert,
  notifyUpsideAlert,
} from "./telegram";
import fs from "fs";
import path from "path";

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig(): BotConfig {
  const p = path.join(process.cwd(), "config", "tokens.json");
  if (!fs.existsSync(p)) throw new Error(`Config not found at ${p}`);
  const cfg = JSON.parse(fs.readFileSync(p, "utf-8")) as BotConfig;
  // Back-fill any fields added after a token was originally saved
  for (const t of cfg.tokens) {
    t.sellPct             ??= 100;
    t.minProfitPct        ??= null;
    t.priceTracking       ??= false;
    t.atlAlertSpacingUsd  ??= 10_000;
    t.upsideAlertPct      ??= 30;
  }
  return cfg;
}

function saveConfig(config: BotConfig): void {
  fs.writeFileSync(
    path.join(process.cwd(), "config", "tokens.json"),
    JSON.stringify(config, null, 2)
  );
}

// ─── State ────────────────────────────────────────────────────────────────────

function makeTokenState(mint: string, symbol: string): TokenState {
  return {
    mint, symbol, decimals: 0,
    currentMarketCap: null, currentPrice: null,
    lastUpdated: null, yLevels: [], anchorMcap: null,
    buyMcap: null,
    sold: false, balance: 0n, lastBalanceCheck: null,
    allTimeLow: null, lastAtlAlertMcap: null, lastUpsideAlertMcap: null,
  };
}

function initState(config: BotConfig): BotState {
  const tokens = new Map<string, TokenState>();
  for (const tc of config.tokens) {
    if (!tc.enabled) continue;
    tokens.set(tc.mint, makeTokenState(tc.mint, tc.symbol));
  }
  return { tokens, solBalance: 0, startTime: Date.now(), totalTradesExecuted: 0 };
}

// ─── Trade History ────────────────────────────────────────────────────────────

const tradeHistory: TradeRecord[] = [];

function recordTrade(trade: TradeRecord, state: BotState): void {
  tradeHistory.push(trade);
  state.totalTradesExecuted++;
  const p = path.join(process.cwd(), "logs", "trade-history.json");
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // replacer converts any remaining BigInt to string so JSON.stringify doesn't throw
    fs.writeFileSync(p, JSON.stringify(tradeHistory, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
  } catch (err) {
    logger.warn("Could not persist trade history", { error: String(err) });
  }
}

// ─── Poll interval from env ───────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "1000", 10);

// ─── Watch a single token ─────────────────────────────────────────────────────

async function watchToken(
  mint: string,
  config: BotConfig,
  state: BotState,
  connection: Connection,
  keypair: ReturnType<typeof loadKeypair>,
  sellInProgress: Set<string>
): Promise<void> {
  const tc = config.tokens.find((t) => t.mint === mint);
  if (!tc || !tc.enabled) return;

  const ts = state.tokens.get(mint);
  if (!ts) return;

  if (ts.decimals === 0) {
    ts.decimals = await getTokenDecimals(connection, mint);
  }

  startPriceFeed(mint, tc.symbol, POLL_INTERVAL_MS, async (update) => {
    const ts2 = state.tokens.get(update.mint);
    const tc2 = config.tokens.find((t) => t.mint === update.mint);
    if (!ts2 || !tc2 || ts2.sold) return;

    ts2.currentPrice    = update.price;

    const prevCounts = new Map(ts2.yLevels.map((l) => [l.value, l.touchCount]));
    const event = processMarketCap(ts2, tc2, update.marketCap);

    for (const level of ts2.yLevels) {
      const prev = prevCounts.get(level.value) ?? 0;
      if (level.touchCount > prev) {
        await notifyTouchDetected(ts2.symbol, level.touchCount, tc2.touchThreshold,
          update.marketCap, level.value);
      } else if (prev > 0 && level.touchCount === 0) {
        await notifyInvalidation(ts2.symbol, level.value, update.marketCap, tc2.invalidationPct);
      }
    }

    // ── Price tracking: ATL and upside alerts ─────────────────────────────────
    if (tc2.priceTracking) {
      const mcap = update.marketCap;

      // Initialise on first reading
      if (ts2.allTimeLow === null) {
        ts2.allTimeLow = mcap;
        ts2.lastAtlAlertMcap = mcap;
        ts2.lastUpsideAlertMcap = mcap;
      } else {
        // ATL alert — fires every time ATL drops another atlAlertSpacingUsd
        if (mcap < ts2.allTimeLow) {
          ts2.allTimeLow = mcap;
          if (ts2.lastAtlAlertMcap !== null && mcap <= ts2.lastAtlAlertMcap - tc2.atlAlertSpacingUsd) {
            ts2.lastAtlAlertMcap = mcap;
            await notifyAtlAlert(ts2.symbol, mcap, tc2.atlAlertSpacingUsd);
          }
        }

        // Upside alert — fires every time mcap rises upsideAlertPct% from last baseline
        if (ts2.lastUpsideAlertMcap !== null) {
          const upsideTarget = ts2.lastUpsideAlertMcap * (1 + tc2.upsideAlertPct / 100);
          if (mcap >= upsideTarget) {
            ts2.lastUpsideAlertMcap = mcap;
            await notifyUpsideAlert(ts2.symbol, mcap, tc2.upsideAlertPct);
          }
        }
      }
    }

    if (event) {
      if (sellInProgress.has(event.mint)) return;
      if (ts2.balance === 0n) {
        logger.warn(`[${ts2.symbol}] Triggered but balance is 0`); return;
      }
      if (state.solBalance < (config.global.minSolBalance ?? 0.05)) {
        logger.error(`[${ts2.symbol}] Skipping sell — low SOL`); return;
      }
      if (tc2.minProfitPct != null && tc2.buyMcap != null) {
        const minMcap = tc2.buyMcap * (1 + tc2.minProfitPct / 100);
        if (event.currentMarketCap < minMcap) {
          logger.info(`[${ts2.symbol}] Sell blocked — mcap ${fmtMarketCap(event.currentMarketCap)} below min profit threshold ${fmtMarketCap(minMcap)} (+${tc2.minProfitPct}%)`);
          // Reset so the token keeps being monitored for the next consolidation
          ts2.sold = false;
          ts2.yLevels = []; ts2.anchorMcap = null;
          return;
        }
      }

      const sellPct    = tc2.sellPct ?? 100;
      const sellAmount = ts2.balance * BigInt(Math.min(sellPct, 100)) / 100n;

      // Always keep watching — reset grid so detection starts fresh after the sell
      ts2.yLevels = []; ts2.anchorMcap = null;

      await notifySellTriggered(event.symbol, toUiAmount(sellAmount, ts2.decimals),
        event.triggerLevel, event.touchCount, event.currentMarketCap, sellPct);

      sellInProgress.add(event.mint);

      executeSell(connection, keypair, event.mint, event.symbol,
        sellAmount, ts2.decimals, event.currentMarketCap, event.triggerLevel, event.touchCount)
        .then(async (record) => {
          recordTrade(record, state);
          await notifyTradeResult(record);
        })
        .catch((err) => logger.error("Sell error", { error: String(err) }))
        .finally(() => sellInProgress.delete(event.mint));
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info("Solana Consolidation Bot starting...");

  const config   = loadConfig();
  const keypair  = loadKeypair();
  const state    = initState(config);
  const connection = new Connection(
    process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com", "confirmed"
  );
  const mints: string[] = config.tokens.filter((t) => t.enabled).map((t) => t.mint);
  const sellInProgress  = new Set<string>();

  // ── Telegram ────────────────────────────────────────────────────────────────
  initTelegram({
    getState:      () => state,
    getTradeHistory: () => tradeHistory,
    getTokenList:  () => config.tokens.filter((t) => t.enabled).map((t) => ({ mint: t.mint, symbol: t.symbol })),

    addToken: async (mint, symbol, buyMcap?: number | null) => {
      if (config.tokens.find((t) => t.mint === mint))
        return `⚠️ ${symbol} is already in your watch list.`;
      config.tokens.push({
        mint, symbol,
        levelSpacingUsd: 25_000,
        touchThreshold: 3,
        hysteresisPct: 10,
        hysteresisUsd: null,
        minSecsBetweenTouches: 5,
        invalidationPct: 50,
        buyMcap: buyMcap ?? null,
        sellPct: 100,
        minProfitPct: 25,
        priceTracking: false,
        atlAlertSpacingUsd: 10_000,
        upsideAlertPct: 30,
        enabled: true,
      });
      saveConfig(config);
      const ts = makeTokenState(mint, symbol);
      ts.buyMcap = buyMcap ?? null;
      state.tokens.set(mint, ts);
      if (!mints.includes(mint)) mints.push(mint);
      watchToken(mint, config, state, connection, keypair, sellInProgress)
        .catch((err) => logger.error(`Failed to watch ${symbol}`, { error: String(err) }));
      return `✅ *${symbol}* added. Polling DexScreener every ${POLL_INTERVAL_MS}ms.\n\nUse ⚙️ Settings to adjust detection parameters.`;
    },

    removeToken: (mint) => {
      const idx = config.tokens.findIndex((t) => t.mint === mint);
      if (idx === -1) return `Token not found.`;
      const symbol = config.tokens[idx].symbol;
      config.tokens.splice(idx, 1);
      saveConfig(config);
      state.tokens.delete(mint);
      stopPriceFeed(mint);
      const mi = mints.indexOf(mint);
      if (mi !== -1) mints.splice(mi, 1);
      return `✅ *${symbol}* removed.`;
    },

    updateSettings: (mint, settings) => {
      const tc = config.tokens.find((t) => t.mint === mint);
      if (!tc) return `Token not found.`;
      Object.assign(tc, settings);
      saveConfig(config);
      const ts = state.tokens.get(mint);
      if (ts) {
        ts.yLevels = []; ts.anchorMcap = null; ts.sold = false;
        if (settings.buyMcap !== undefined) ts.buyMcap = settings.buyMcap ?? null;
      }
      return `✅ Settings updated for *${tc.symbol}*. Grid rebuilds on next price tick.`;
    },

    getConfig: (mint) => config.tokens.find((t) => t.mint === mint) ?? null,

    testSell: (mint) => {
      const ts = state.tokens.get(mint);
      const tc = config.tokens.find((t) => t.mint === mint);
      if (!ts || !tc) { logger.warn("testSell: token not found"); return; }
      if (ts.balance === 0n) { logger.warn("testSell: balance is 0"); return; }
      logger.info(`[${ts.symbol}] 🧪 Test sell triggered manually`);
      executeSell(
        connection, keypair, mint, ts.symbol,
        ts.balance, ts.decimals,
        ts.currentMarketCap ?? 0, 0, 0
      )
        .then(async (record) => {
          recordTrade(record, state);
          await notifyTradeResult(record);
          if (record.status === "success") ts.balance = 0n;
        })
        .catch((err) => logger.error("Test sell error", { error: String(err) }));
    },
  });

  await notifyStartup(
    keypair.publicKey.toBase58(),
    config.tokens.filter((t) => t.enabled).map((t) => t.symbol)
  );

  // Start price feeds for all enabled tokens
  await Promise.all(
    mints.map((mint) =>
      watchToken(mint, config, state, connection, keypair, sellInProgress)
        .catch((err) => {
          const sym = config.tokens.find((t) => t.mint === mint)?.symbol ?? mint.slice(0, 8);
          logger.error(`Failed to watch ${sym}`, { error: String(err) });
        })
    )
  );

  logger.info(`Bot live — polling every ${POLL_INTERVAL_MS}ms via DexScreener`, {
    wallet: keypair.publicKey.toBase58(),
    tokens: config.tokens.filter((t) => t.enabled).map((t) => t.symbol),
  });

  // ── Background: SOL + balances every 30s ──────────────────────────────────
  let solLowNotified = false;
  let iter = 0;
  while (true) {
    iter++;
    try {
      state.solBalance = await getSolBalance(connection);
      if (state.solBalance < (config.global.minSolBalance ?? 0.05)) {
        if (!solLowNotified) { await notifyLowSol(state.solBalance); solLowNotified = true; }
      } else { solLowNotified = false; }

      const activeMints = mints.filter((m) => !state.tokens.get(m)?.sold);
      if (activeMints.length > 0) {
        const balances = await getAllTokenBalances(connection, activeMints);
        for (const [mint, amount] of balances) {
          const ts = state.tokens.get(mint);
          if (ts) { ts.balance = amount; ts.lastBalanceCheck = Date.now(); }
        }
      }

      if (iter % 4 === 0) logger.info("Heartbeat", {
        sol: state.solBalance.toFixed(4),
        trades: state.totalTradesExecuted,
      });

    } catch (err) {
      logger.error("Background loop error", { error: String(err) });
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

process.on("SIGINT",  () => { logger.info("Shutting down..."); stopAllFeeds(); process.exit(0); });
process.on("SIGTERM", () => { logger.info("Shutting down..."); stopAllFeeds(); process.exit(0); });
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message }); stopAllFeeds(); process.exit(1);
});

main().catch((err) => { logger.error("Fatal startup error", { error: String(err) }); process.exit(1); });

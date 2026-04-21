import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { BotConfig, BotState, TokenState, TradeRecord } from "./types";
import { loadKeypair, getSolBalance, getTokenBalance, getAllTokenBalances, getTokenDecimals, toUiAmount, loadTokenCache, saveTokenCache, isTokenCached } from "./wallet";
import { startPriceFeed, stopPriceFeed, stopAllFeeds } from "./price";
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
  notifySellBlocked,
  notifyNewBond,
  notifyStaleToken,
  notifyTokenRecovered,
  notifyWalletBuy,
  notifyWalletFullSell,
} from "./telegram";
import { startBondMonitor, stopBondMonitor } from "./pumpfun";
import { createWalletWatcher } from "./wallet-watcher";
import fs from "fs";
import path from "path";

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig(): BotConfig {
  const p = path.join(process.cwd(), "config", "tokens.json");
  if (!fs.existsSync(p)) throw new Error(`Config not found at ${p}`);
  const cfg = JSON.parse(fs.readFileSync(p, "utf-8")) as BotConfig;
  // Back-fill any fields added after a token was originally saved
  cfg.nextTokenId ??= 1;
  for (const t of cfg.tokens) {
    t.sellPct             ??= 100;
    t.minProfitPct        ??= null;
    t.priceTracking       ??= true;
    t.atlAlertSpacingUsd  ??= 10_000;
    t.upsideAlertPct      ??= 30;
    // Assign IDs to tokens that pre-date this feature
    if ((t as any).id == null) {
      t.id = cfg.nextTokenId++;
    }
  }
  // Ensure nextTokenId is always above the highest existing ID
  const maxId = cfg.tokens.reduce((m, t) => Math.max(m, t.id), 0);
  if (cfg.nextTokenId <= maxId) cfg.nextTokenId = maxId + 1;
  // Back-fill wallet watcher fields
  cfg.watchedWallet        ??= undefined;
  cfg.watchedWalletWebhookId ??= undefined;
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
    sold: false, balance: 0n,
    allTimeLow: null, lastAtlAlertMcap: null, lastUpsideAlertMcap: null,
    lastBalanceCheck: null,
  };
}

function initState(config: BotConfig): BotState {
  const tokens = new Map<string, TokenState>();
  for (const tc of config.tokens) {
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

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "2000", 10);

// ─── Watch a single token ─────────────────────────────────────────────────────

async function watchToken(
  mint: string,
  config: BotConfig,
  state: BotState,
  connection: Connection,
  keypair: ReturnType<typeof loadKeypair>,
  sellInProgress: Set<string>,
  staleTokens: Set<string>
): Promise<void> {
  const tc = config.tokens.find((t) => t.mint === mint);
  if (!tc) return;

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

    // If this token was previously marked stale, it has recovered
    if (staleTokens.has(update.mint)) {
      staleTokens.delete(update.mint);
      notifyTokenRecovered(update.mint, ts2.symbol).catch(() => {});
    }

    const prevCounts = new Map(ts2.yLevels.map((l) => [l.value, l.touchCount]));
    const event = processMarketCap(ts2, tc2, update.marketCap);

    let invalidationFired = false;
    for (const level of ts2.yLevels) {
      const prev = prevCounts.get(level.value) ?? 0;
      if (level.touchCount > prev) {
        await notifyTouchDetected(update.mint, ts2.symbol, level.touchCount, tc2.touchThreshold,
          update.marketCap, level.value);
      } else if (prev > 0 && level.touchCount === 0) {
        invalidationFired = true;
        await notifyInvalidation(update.mint, ts2.symbol, level.value, update.marketCap, tc2.invalidationPct);
      }
    }

    // ── Price tracking: ATL and upside alerts ─────────────────────────────────
    if (tc2.priceTracking && !invalidationFired) {
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
            await notifyAtlAlert(update.mint, ts2.symbol, mcap, tc2.atlAlertSpacingUsd);
          }
        }

        // Upside alert — fires every time mcap rises upsideAlertPct% from last baseline
        // Baseline also tracks downward so a recovery from a dip always triggers correctly
        if (ts2.lastUpsideAlertMcap !== null) {
          if (mcap < ts2.lastUpsideAlertMcap) {
            ts2.lastUpsideAlertMcap = mcap;
          } else {
            const upsideTarget = ts2.lastUpsideAlertMcap * (1 + tc2.upsideAlertPct / 100);
            if (mcap >= upsideTarget) {
              ts2.lastUpsideAlertMcap = mcap;
              await notifyUpsideAlert(update.mint, ts2.symbol, mcap, tc2.upsideAlertPct);
            }
          }
        }
      }
    }

    if (event) {
      if (sellInProgress.has(event.mint)) {
        await notifySellBlocked(event.mint, event.symbol, event.touchCount, event.triggerLevel, event.currentMarketCap, "sell already in progress");
        return;
      }
      // Fetch balance on-demand right before sell — no need to poll it
      ts2.balance = await getTokenBalance(connection, new PublicKey(event.mint))
        .catch(() => 0n);

      if (ts2.balance === 0n) {
        await notifySellBlocked(event.mint, event.symbol, event.touchCount, event.triggerLevel, event.currentMarketCap, "balance is 0");
        logger.warn(`[${ts2.symbol}] Triggered but balance is 0`); return;
      }

      if (tc2.minProfitPct != null && tc2.buyMcap != null) {
        const minMcap = tc2.buyMcap * (1 + tc2.minProfitPct / 100);
        if (event.currentMarketCap < minMcap) {
          await notifySellBlocked(event.mint, event.symbol, event.touchCount, event.triggerLevel, event.currentMarketCap,
            `below min profit threshold (need \`${fmtMc(minMcap)}\`, currently \`${fmtMc(event.currentMarketCap)}\`)`);
          logger.info(`[${ts2.symbol}] Sell blocked — below min profit threshold`);
          ts2.yLevels = []; ts2.anchorMcap = null;
          return;
        }
      }

      const sellPct    = tc2.sellPct ?? 100;
      const sellAmount = ts2.balance * BigInt(Math.min(sellPct, 100)) / 100n;

      await notifySellTriggered(event.mint, event.symbol, toUiAmount(sellAmount, ts2.decimals),
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
  loadTokenCache();

  const config   = loadConfig();
  const keypair  = loadKeypair();
  const state    = initState(config);
  const connection = new Connection(
    process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com", "confirmed"
  );
  const mints: string[] = config.tokens.map((t) => t.mint);
  const sellInProgress  = new Set<string>();
  const staleTokens     = new Set<string>(); // mints currently without a price feed
  let bondMonitorEnabled = false;

  // ── Wallet watcher ───────────────────────────────────────────────────────────
  const walletWatcher = await createWalletWatcher(
    connection,
    {
      isTracked: (mint) => config.tokens.some((t) => t.mint === mint),

      onBuy: async (mint, symbol, buyMcap) => {
        // Could already be tracked if the bot added it between webhook fire and delivery
        if (config.tokens.find((t) => t.mint === mint)) return;
        const id = config.nextTokenId++;
        config.tokens.push({
          id, mint, symbol,
          levelSpacingUsd: 25_000,
          touchThreshold: 3,
          hysteresisPct: 10,
          hysteresisUsd: null,
          minSecsBetweenTouches: 5,
          invalidationPct: 30,
          buyMcap,
          sellPct: 100,
          minProfitPct: 25,
          priceTracking: true,
          atlAlertSpacingUsd: 10_000,
          upsideAlertPct: 30,
        });
        saveConfig(config);
        const ts = makeTokenState(mint, symbol);
        ts.buyMcap = buyMcap;
        state.tokens.set(mint, ts);
        if (!mints.includes(mint)) mints.push(mint);
        watchToken(mint, config, state, connection, keypair, sellInProgress, staleTokens)
          .catch((err) => logger.error(`Wallet watcher: failed to start feed for ${symbol}`, { error: String(err) }));
        await notifyWalletBuy(mint, symbol, buyMcap);
      },

      onFullSell: async (mint) => {
        const idx = config.tokens.findIndex((t) => t.mint === mint);
        if (idx === -1) return;
        const symbol = config.tokens[idx].symbol;
        config.tokens.splice(idx, 1);
        saveConfig(config);
        state.tokens.delete(mint);
        stopPriceFeed(mint);
        const mi = mints.indexOf(mint);
        if (mi !== -1) mints.splice(mi, 1);
        await notifyWalletFullSell(mint, symbol);
      },
    },
    config.watchedWallet,
    config.watchedWalletWebhookId,
  );

  // Persist the (possibly refreshed) webhook ID after startup registration
  if (config.watchedWallet) {
    config.watchedWalletWebhookId = walletWatcher.getWebhookId() ?? undefined;
    saveConfig(config);
  }

  // ── Telegram ────────────────────────────────────────────────────────────────
  initTelegram({
    getState:      () => state,
    getTradeHistory: () => tradeHistory,
    getTokenList:  () => config.tokens.map((t) => ({ id: t.id, mint: t.mint, symbol: t.symbol })),

    addToken: async (mint, symbol, buyMcap?: number | null) => {
      if (config.tokens.find((t) => t.mint === mint))
        return `⚠️ ${symbol} is already in your watch list.`;
      config.tokens.push({
        id: config.nextTokenId++,
        mint, symbol,
        levelSpacingUsd: 25_000,
        touchThreshold: 3,
        hysteresisPct: 10,
        hysteresisUsd: null,
        minSecsBetweenTouches: 5,
        invalidationPct: 30,
        buyMcap: buyMcap ?? null,
        sellPct: 100,
        minProfitPct: 25,
        priceTracking: true,
        atlAlertSpacingUsd: 10_000,
        upsideAlertPct: 30,
      });
      saveConfig(config);
      const ts = makeTokenState(mint, symbol);
      ts.buyMcap = buyMcap ?? null;
      state.tokens.set(mint, ts);
      if (!mints.includes(mint)) mints.push(mint);
      watchToken(mint, config, state, connection, keypair, sellInProgress, staleTokens)
        .catch((err) => logger.error(`Failed to watch ${symbol}`, { error: String(err) }));
      return `✅ *${symbol}* added. Polling DexScreener every ${POLL_INTERVAL_MS / 1000}s.\n\nUse ⚙️ Settings to adjust detection parameters.`;
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
        if (settings.buyMcap !== undefined) {
          ts.buyMcap = settings.buyMcap ?? null;
          ts.yLevels = []; ts.anchorMcap = null;
        } else if (settings.levelSpacingUsd !== undefined) {
          ts.yLevels = []; ts.anchorMcap = null;
        }
      }
      const rebuilds = settings.buyMcap !== undefined || settings.levelSpacingUsd !== undefined;
      return `✅ Settings updated for *${tc.symbol}*${rebuilds ? ". Grid rebuilds on next price tick." : "."}`;
    },

    getConfig: (mint) => config.tokens.find((t) => t.mint === mint) ?? null,

    resetAtl: (mint) => {
      const ts = state.tokens.get(mint);
      const tc = config.tokens.find((t) => t.mint === mint);
      if (!ts || !tc) return `Token not found.`;
      ts.allTimeLow = ts.currentMarketCap;
      ts.lastAtlAlertMcap = ts.currentMarketCap;
      return `✅ ATL reset for *${tc.symbol}*. New baseline: \`${fmtMc(ts.currentMarketCap ?? 0)}\``;
    },

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

    setBondMonitor: (enabled) => {
      bondMonitorEnabled = enabled;
      if (enabled) {
        startBondMonitor(connection, async (event) => {
          await notifyNewBond(
            event.mint, event.name, event.symbol,
            event.description, event.marketCap,
            event.feesSol, event.imageUri
          );
        }, 0.3);
      } else {
        stopBondMonitor();
      }
    },

    getBondMonitorEnabled: () => bondMonitorEnabled,

    getWatchedWallet: () => config.watchedWallet ?? null,

    setWatchedWallet: async (wallet: string | null) => {
      const { webhookId } = await walletWatcher.setWallet(wallet);
      config.watchedWallet = wallet ?? undefined;
      config.watchedWalletWebhookId = webhookId ?? undefined;
      saveConfig(config);
    },
  });

  await notifyStartup(
    keypair.publicKey.toBase58(),
    config.tokens.map((t) => t.symbol)
  );

  // Cached tokens (warm restart) start instantly with no delay.
  // Uncached tokens (first boot or new addition) stagger at 200ms each = 10 RPC/s.
  let coldIndex = 0;
  await Promise.all(
    mints.map((mint) => {
      const delay = isTokenCached(mint) ? 0 : (coldIndex++ * 200);
      return new Promise<void>((r) => setTimeout(r, delay))
        .then(() => watchToken(mint, config, state, connection, keypair, sellInProgress, staleTokens))
        .catch((err) => {
          const sym = config.tokens.find((t) => t.mint === mint)?.symbol ?? mint.slice(0, 8);
          logger.error(`Failed to watch ${sym}`, { error: String(err) });
        });
    })
  );

  logger.info(`Bot live — polling every ${POLL_INTERVAL_MS}ms via DexScreener`, {
    wallet: keypair.publicKey.toBase58(),
    tokens: config.tokens.map((t) => t.symbol),
  });

  // ── Stale feed monitor — alert once if a token stops getting DexScreener data ──
  const STALE_MS = 30_000;
  const STALE_GRACE_MS = 60_000; // don't alert in first 60s while feeds are warming up
  const botStartTime = Date.now();
  setInterval(() => {
    if (Date.now() - botStartTime < STALE_GRACE_MS) return;
    for (const tc of config.tokens) {
      const ts = state.tokens.get(tc.mint);
      if (!ts || ts.sold) continue;
      const isStale = ts.lastUpdated === null || (Date.now() - ts.lastUpdated) > STALE_MS;
      if (isStale && !staleTokens.has(tc.mint)) {
        staleTokens.add(tc.mint);
        notifyStaleToken(tc.mint, ts.symbol).catch(() => {});
      }
    }
  }, STALE_MS);

  // ── Poll SOL + token balances on startup and every 5 minutes ────────────
  async function refreshBalances() {
    try {
      state.solBalance = await getSolBalance(connection);
      const balances = await getAllTokenBalances(connection, mints);
      for (const [mint, amount] of balances) {
        const ts = state.tokens.get(mint);
        if (ts) ts.balance = amount;
      }
      logger.info("Balances refreshed", { sol: state.solBalance.toFixed(4), trades: state.totalTradesExecuted });
    } catch (err) {
      logger.error("Balance refresh error", { error: String(err) });
    }
  }

  await refreshBalances();
  while (true) {
    await new Promise((r) => setTimeout(r, 300_000));
    await refreshBalances();
  }
}

process.on("SIGINT",  () => { logger.info("Shutting down..."); saveTokenCache(); stopAllFeeds(); stopBondMonitor(); process.exit(0); });
process.on("SIGTERM", () => { logger.info("Shutting down..."); saveTokenCache(); stopAllFeeds(); stopBondMonitor(); process.exit(0); });
// Note: walletWatcher.stop() is not called here because it is inside main() scope.
// The process.exit() calls above immediately terminate the process, which is fine.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message }); stopAllFeeds(); process.exit(1);
});

main().catch((err) => { logger.error("Fatal startup error", { error: String(err) }); process.exit(1); });

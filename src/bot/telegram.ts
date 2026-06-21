import { Telegraf, Context, Markup } from "telegraf";
import { BotState, TokenConfig, TradeRecord, BalanceMonitor } from "./types";
import { toUiAmount } from "./wallet";
import { fetchTokenInfo } from "./price";
import { getHottestLevels, fmtMc, rangeBand } from "./consolidation";
import { logger } from "./logger";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import crypto from "crypto";
import fs from "fs";

const execFileAsync = promisify(execFile);
const TGS_SCRIPT = path.join(process.cwd(), "scripts", "tgs_to_gif.py");
const INSTAGRAM_COOKIES = process.env.INSTAGRAM_COOKIES || path.join(process.cwd(), "config", "instagram_cookies.txt");
const INSTAGRAM_URL_RE = /https?:\/\/(?:www\.)?instagram\.com\/[^\s]+/i;
const TG_UPLOAD_LIMIT = 50 * 1024 * 1024;

// ─── Callbacks ────────────────────────────────────────────────────────────────

export interface TelegramCallbacks {
  getState: () => BotState;
  getTradeHistory: () => TradeRecord[];
  getTokenList: () => { id: number; mint: string; symbol: string }[];
  addToken: (mint: string, symbol: string, buyMcap?: number | null) => string | Promise<string>;
  removeToken: (mint: string) => string;
  updateSettings: (mint: string, settings: Partial<TokenConfig>) => string;
  getConfig: (mint: string) => TokenConfig | null;
  testSell: (mint: string) => void;
  resetAtl: (mint: string) => string;
  setBondMonitor: (enabled: boolean) => void;
  getBondMonitorEnabled: () => boolean;
  getPendingBonds: () => { mint: string; bondedAt: number }[];
  getWatchedWallet: () => string | null;
  setWatchedWallet: (wallet: string | null) => Promise<void>;
  resetTokenIds: () => void;
  getBalanceMonitors: () => BalanceMonitor[];
  addBalanceMonitor: (mint: string, symbol: string, wallets: string[]) => Promise<string>;
  removeBalanceMonitor: (id: number) => Promise<string>;
  addWalletToMonitor: (id: number, wallet: string) => Promise<string>;
  removeWalletFromMonitor: (id: number, walletIdx: number) => Promise<string>;
  getWebhookSlotCount: () => { used: number; total: number };
}

// ─── Wizard State ─────────────────────────────────────────────────────────────

type WizardStep =
  | { flow: "remove_token"; step: "await_pick" }
  | { flow: "settings";     step: "await_token" }
  | { flow: "settings";     step: "await_field";   mint: string; symbol: string }
  | { flow: "settings";     step: "await_value";   mint: string; symbol: string; field: SettingsField }
  | { flow: "watch_wallet"; step: "await_address" }
  | { flow: "balance_monitor"; step: "await_mint" }
  | { flow: "balance_monitor"; step: "await_wallets"; mint: string; symbol: string }
  | { flow: "balance_monitor_add_wallet"; step: "await_wallet"; monitorId: number };

type SettingsField = "levelSpacingUsd" | "touchThreshold" | "hysteresisPct" | "hysteresisUsd" | "minSecsBetweenTouches" | "invalidationPct" | "sellPct" | "minProfitPct" | "atlAlertSpacingUsd" | "upsideAlertPct" | "buyMcap" | "rangePct" | "rangeSizeUsd" | "rangeDurationSecs";

const wizardState = new Map<number, WizardStep>();

let tg: Telegraf | null = null;
let authorizedChatId: number | null = null;
let callbacks: TelegramCallbacks | null = null;
let lastNotifiedMint: string | null = null; // mint of the last token the bot sent a message for

// ─── Init ──────────────────────────────────────────────────────────────────────

export function initTelegram(cb: TelegramCallbacks): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIdStr = process.env.TELEGRAM_CHAT_ID;

  if (!token || token === "YOUR_TELEGRAM_BOT_TOKEN_HERE")
    throw new Error("TELEGRAM_BOT_TOKEN is not set in .env");
  if (!chatIdStr || chatIdStr === "YOUR_NUMERIC_CHAT_ID_HERE")
    throw new Error("TELEGRAM_CHAT_ID is not set in .env");

  authorizedChatId = parseInt(chatIdStr, 10);
  if (isNaN(authorizedChatId)) throw new Error("TELEGRAM_CHAT_ID must be a number");

  const guestChatIdStr = process.env.GUEST_CHAT_ID;
  const guestChatId = guestChatIdStr ? parseInt(guestChatIdStr, 10) : null;

  callbacks = cb;
  tg = new Telegraf(token);

  tg.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === authorizedChatId) return next();

    // Guest gets sticker/animation access only
    if (guestChatId && chatId === guestChatId) {
      const msg = ctx.message as any;
      if (msg?.sticker || msg?.animation) return next();
    }

    logger.warn("Unauthorized Telegram access", { chatId });
  });

  registerHandlers(tg);
  tg.launch().then(() => logger.info("Telegram bot connected", { chatId: authorizedChatId }));
  process.once("SIGINT",  () => tg?.stop("SIGINT"));
  process.once("SIGTERM", () => tg?.stop("SIGTERM"));
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function registerHandlers(bot: Telegraf): void {
  bot.start((ctx) => { wizardState.delete(ctx.chat.id); sendHome(ctx); });
  bot.command("help",   (ctx) => { wizardState.delete(ctx.chat.id); sendHome(ctx); });
  bot.command("menu",   (ctx) => { wizardState.delete(ctx.chat.id); sendHome(ctx); });
  bot.command("cancel", (ctx) => { wizardState.delete(ctx.chat.id); ctx.reply("Cancelled."); sendHome(ctx); });

  bot.command("status",      cmdTokens);
  bot.command("trades",      cmdTrades);
  bot.command("removetoken", (ctx) => startRemoveToken(ctx));
  bot.command("remove",      (ctx) => cmdRemoveByTicker(ctx));
  bot.command("r",           (ctx) => cmdRemoveByTicker(ctx));
  bot.command("settings",    (ctx) => startSettings(ctx, false));
  bot.command("fetch",       cmdFetch);

  // Sticker / GIF → download and send to Discord
  bot.on("sticker", async (ctx) => {
    wizardState.delete(ctx.chat.id);
    const s = (ctx.message as any).sticker;
    if (s.is_animated) {
      await downloadConvertTgsAndSend(ctx, s.file_id);
    } else if (s.is_video) {
      await downloadConvertWebmAndSend(ctx, s.file_id);
    } else {
      await downloadAndSendToDiscord(ctx, s.file_id, "sticker.webp", "sticker");
    }
  });

  bot.on("animation", async (ctx) => {
    wizardState.delete(ctx.chat.id);
    const anim = (ctx.message as any).animation;
    const ext  = anim.mime_type === "image/gif" ? "gif" : "mp4";
    await downloadAndSendToDiscord(ctx, anim.file_id, `animation.${ext}`, "GIF");
  });

  bot.on("callback_query", async (ctx) => {
    await ctx.answerCbQuery();
    const data = (ctx.callbackQuery as any).data as string;
    await handleCallback(ctx, data);
  });

  bot.on("text", async (ctx) => {
    const text = ((ctx.message as any)?.text ?? "").trim();

    // Wizards that expect base58 input must intercept before CA auto-detection
    const activeWizard = wizardState.get(ctx.chat.id);
    if (
      (activeWizard?.flow === "watch_wallet" && activeWizard.step === "await_address") ||
      activeWizard?.flow === "balance_monitor" ||
      activeWizard?.flow === "balance_monitor_add_wallet"
    ) {
      await handleWizardInput(ctx, activeWizard);
      return;
    }

    // CA detection takes priority over any other active wizard state
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
      wizardState.delete(ctx.chat.id);
      await handleAutoAddCA(ctx, text);
      return;
    }

    // Instagram URL detection — download highlight/reel/post and send back
    // Supports optional playlist item spec after URL: "<url> 38" or "<url> 38-40" or "<url> 1,3,38"
    const igMatch = text.match(INSTAGRAM_URL_RE);
    if (igMatch) {
      wizardState.delete(ctx.chat.id);
      const afterUrl = text.slice(igMatch.index! + igMatch[0].length).trim();
      const playlistItems = /^[\d,\-]+$/.test(afterUrl) ? afterUrl : undefined;
      await downloadInstagramAndSend(ctx, igMatch[0], playlistItems);
      return;
    }

    const wizard = wizardState.get(ctx.chat.id);
    if (wizard) { await handleWizardInput(ctx, wizard); return; }

    ctx.reply("Send /help to see the menu.", mainMenuKeyboard());
  });
}

// ─── Menu ──────────────────────────────────────────────────────────────────────

function sendHome(ctx: Context): void {
  ctx.reply("🤖 *Consolidation Bot* — What would you like to do?", {
    parse_mode: "Markdown", ...mainMenuKeyboard(),
  });
}

function mainMenuKeyboard() {
  const bondLabel = callbacks?.getBondMonitorEnabled()
    ? "🔗 Bond Monitor: ON"
    : "🔗 Bond Monitor: OFF";
  const wallet = callbacks?.getWatchedWallet();
  const walletLabel = wallet
    ? `👁 Watch Wallet: ${wallet.slice(0, 4)}…${wallet.slice(-4)}`
    : "👁 Watch Wallet: OFF";
  const monitorCount = callbacks?.getBalanceMonitors().length ?? 0;
  const balanceMonitorLabel = monitorCount > 0
    ? `📊 Balance Monitors (${monitorCount})`
    : "📊 Balance Monitors: OFF";
  return Markup.inlineKeyboard([
    [Markup.button.callback("🪙 Tokens",        "cmd:status")],
    [Markup.button.callback("📋 Trade History", "cmd:trades")],
    [Markup.button.callback("🗑 Remove Token",  "cmd:removetoken")],
    [Markup.button.callback("⚙️ Token Settings", "cmd:settings")],
    [Markup.button.callback("🧪 Test Sell",      "cmd:testsell")],
    [Markup.button.callback(bondLabel,           "cmd:togglebond")],
    ...(callbacks?.getBondMonitorEnabled()
      ? [[Markup.button.callback("🗺 Bonding Map", "cmd:bondmap")]]
      : []),
    [Markup.button.callback(walletLabel,         "cmd:watchwallet")],
    [Markup.button.callback(balanceMonitorLabel, "cmd:balancemonitors")],
    [Markup.button.callback("🔢 Reset Token Numbers", "cmd:resetids")],
  ]);
}

function backKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("« Back to menu", "cmd:home")]]);
}

// ─── Callback Router ──────────────────────────────────────────────────────────

async function handleCallback(ctx: Context, data: string): Promise<void> {
  const chatId = ctx.chat!.id;
  const wizard = wizardState.get(chatId);

  // Test sell — handled outside wizard state
  if (data.startsWith("wiz:testsell:")) {
    const idx = parseInt(data.split(":")[2], 10);
    const tokens = callbacks!.getTokenList();
    const token = tokens[idx];
    if (!token) return;
    ctx.reply(
      `⚠️ Confirm test sell for *${token.symbol}*?

This will sell your ENTIRE balance immediately.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Yes, sell now", `wiz:testsell_confirm:${idx}`)],
          [Markup.button.callback("❌ Cancel", "cmd:home")],
        ]),
      }
    );
    return;
  }

  if (data.startsWith("wiz:testsell_confirm:")) {
    const idx = parseInt(data.split(":")[2], 10);
    const tokens = callbacks!.getTokenList();
    const token = tokens[idx];
    if (!token) return;
    ctx.reply(`🧪 Firing test sell for *${token.symbol}*...`, { parse_mode: "Markdown" });
    callbacks!.testSell(token.mint);
    return;
  }

  if (data.startsWith("wiz:") && wizard) {
    await handleWizardButton(ctx, wizard, data.slice(4));
    return;
  }

  if (data.startsWith("cmd:")) {
    switch (data.slice(4)) {
      case "status":      return cmdTokens(ctx);
      case "trades":      return cmdTrades(ctx);
      case "removetoken":     return startRemoveToken(ctx, false);
      case "removetoken_all": return startRemoveToken(ctx, true);
      case "settings":     return startSettings(ctx, false);
      case "settings_all": return startSettings(ctx, true);
      case "testsell":    return startTestSell(ctx);
      case "home":        return sendHome(ctx);
      case "togglebond": {
        if (!callbacks) return;
        const nowEnabled = !callbacks.getBondMonitorEnabled();
        callbacks.setBondMonitor(nowEnabled);
        ctx.reply(
          nowEnabled
            ? "🔗 *Bond Monitor ON* — you'll be notified when tokens bond on PumpFun."
            : "🔗 *Bond Monitor OFF* — bond notifications paused.",
          { parse_mode: "Markdown", ...mainMenuKeyboard() }
        );
        return;
      }
      case "bondmap": {
        if (!callbacks) return;
        const bonds = callbacks.getPendingBonds();
        if (bonds.length === 0) {
          ctx.reply("🗺 *Bonding Map* — empty, no tokens currently tracked.", {
            parse_mode: "Markdown", ...backKeyboard(),
          });
          return;
        }
        const now = Date.now();
        const lines = bonds.map(({ mint, bondedAt }) => {
          const ageMins = (now - bondedAt) / 60_000;
          const ageStr = ageMins < 1 ? "<1 min" : `${Math.round(ageMins)} min`;
          return `\`${mint}\` — ${ageStr}`;
        });
        ctx.reply(
          `🗺 *Bonding Map* — ${bonds.length} token${bonds.length !== 1 ? "s" : ""} tracked\n\n` +
          lines.join("\n"),
          { parse_mode: "Markdown", ...backKeyboard() }
        );
        return;
      }
      case "resetids": {
        if (!callbacks) return;
        callbacks.resetTokenIds();
        ctx.reply("🔢 *Token numbers reset.* Tokens are now numbered starting from #1.", {
          parse_mode: "Markdown", ...mainMenuKeyboard(),
        });
        return;
      }
      case "watchwallet": return showWatchWalletMenu(ctx);
      case "watchwallet_set": {
        wizardState.set(ctx.chat!.id, { flow: "watch_wallet", step: "await_address" });
        ctx.reply(
          "👁 *Watch Wallet*\n\nPaste the Solana wallet address you want to mirror.\n\nThe bot will *auto-add* any token it buys and *auto-remove* when it fully sells.\n\n/cancel to go back",
          { parse_mode: "Markdown" }
        );
        return;
      }
      case "watchwallet_clear": {
        if (!callbacks) return;
        await callbacks.setWatchedWallet(null);
        ctx.reply("👁 *Wallet watch cleared.* No longer mirroring any wallet.", {
          parse_mode: "Markdown", ...mainMenuKeyboard(),
        });
        return;
      }
      case "balancemonitors": return showBalanceMonitorsMenu(ctx);
      case "bm_add": {
        wizardState.set(ctx.chat!.id, { flow: "balance_monitor", step: "await_mint" });
        ctx.reply(
          "📊 *Balance Monitor — New*\n\nPaste the token CA you want to track.\n\n/cancel to go back",
          { parse_mode: "Markdown" }
        );
        return;
      }
    }
  }

  // Balance monitor — remove confirm
  if (data.startsWith("wiz:bm_rm:")) {
    const id = parseInt(data.split(":")[2], 10);
    const monitor = callbacks?.getBalanceMonitors().find((m) => m.id === id);
    if (!monitor) { ctx.reply("Monitor not found."); return; }
    ctx.reply(
      `📊 Remove monitor for *${monitor.symbol}*?\n\nThis will stop watching ${monitor.wallets.length} wallet(s).`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🗑 Yes, remove", `wiz:bm_rm_ok:${id}`)],
          [Markup.button.callback("« Cancel", "cmd:balancemonitors")],
        ]),
      }
    );
    return;
  }

  if (data.startsWith("wiz:bm_rm_ok:")) {
    if (!callbacks) return;
    const id = parseInt(data.split(":")[2], 10);
    const result = await callbacks.removeBalanceMonitor(id);
    ctx.reply(result, { parse_mode: "Markdown", ...mainMenuKeyboard() });
    return;
  }

  // Balance monitor — show detail / manage wallets
  if (data.startsWith("wiz:bm_detail:")) {
    const id = parseInt(data.split(":")[2], 10);
    return showMonitorDetail(ctx, id);
  }

  // Balance monitor — add wallet to existing monitor
  if (data.startsWith("wiz:bm_aw:")) {
    const monitorId = parseInt(data.split(":")[2], 10);
    wizardState.set(ctx.chat!.id, { flow: "balance_monitor_add_wallet", step: "await_wallet", monitorId });
    ctx.reply(
      "📊 Paste the wallet address to add.\n\n/cancel to go back",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Balance monitor — remove wallet
  if (data.startsWith("wiz:bm_rmw:")) {
    if (!callbacks) return;
    const parts = data.split(":");
    const monitorId  = parseInt(parts[2], 10);
    const walletIdx  = parseInt(parts[3], 10);
    const result = await callbacks.removeWalletFromMonitor(monitorId, walletIdx);
    ctx.reply(result, { parse_mode: "Markdown" });
    return showMonitorDetail(ctx, monitorId);
  }
}

// ─── Watch Wallet Menu ────────────────────────────────────────────────────────

function showWatchWalletMenu(ctx: Context): void {
  if (!callbacks) return;
  const wallet = callbacks.getWatchedWallet();
  const msg = wallet
    ? `👁 *Watch Wallet*\n\nCurrently watching:\n\`${wallet}\`\n\nThe bot auto-adds tokens this wallet buys and auto-removes when it fully sells.`
    : `👁 *Watch Wallet*\n\nNo wallet is currently being watched.\n\nSet one to automatically mirror buys and full sells.`;
  ctx.reply(msg, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      wallet
        ? [Markup.button.callback("🔄 Change Wallet", "cmd:watchwallet_set")]
        : [Markup.button.callback("➕ Set Wallet",    "cmd:watchwallet_set")],
      ...(wallet ? [[Markup.button.callback("🗑 Clear Wallet", "cmd:watchwallet_clear")]] : []),
      [Markup.button.callback("« Back to menu", "cmd:home")],
    ]),
  });
}

// ─── Balance Monitors Menu ────────────────────────────────────────────────────

function showBalanceMonitorsMenu(ctx: Context): void {
  if (!callbacks) return;
  const monitors = callbacks.getBalanceMonitors();
  const { used, total } = callbacks.getWebhookSlotCount();

  const lines = monitors.length === 0
    ? ["No monitors active."]
    : monitors.map((m) => `*${m.symbol}* — ${m.wallets.length} wallet(s)`);

  const msg =
    `📊 *Balance Monitors*\n\n` +
    `${lines.join("\n")}\n\n` +
    `_Helius webhook slots: ${used}/${total} used_\n` +
    `_All monitors share one webhook slot._`;

  const monitorButtons = monitors.map((m) =>
    [Markup.button.callback(`📋 ${m.symbol}`, `wiz:bm_detail:${m.id}`)]
  );

  ctx.reply(msg, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      ...monitorButtons,
      [Markup.button.callback("➕ Add Monitor", "cmd:bm_add")],
      [Markup.button.callback("« Back to menu", "cmd:home")],
    ]),
  });
}

function showMonitorDetail(ctx: Context, monitorId: number): void {
  if (!callbacks) return;
  const monitor = callbacks.getBalanceMonitors().find((m) => m.id === monitorId);
  if (!monitor) { ctx.reply("Monitor not found."); return; }

  const walletLines = monitor.wallets.length === 0
    ? ["_No wallets yet._"]
    : monitor.wallets.map((w, i) => `${i + 1}. \`${w.slice(0, 4)}…${w.slice(-4)}\``);

  const msg =
    `📊 *${monitor.symbol}*\n\`${monitor.mint}\`\n\n` +
    `*Watching ${monitor.wallets.length} wallet(s):*\n` +
    walletLines.join("\n");

  const removeWalletButtons = monitor.wallets.map((w, i) =>
    [Markup.button.callback(`🗑 ${w.slice(0, 4)}…${w.slice(-4)}`, `wiz:bm_rmw:${monitorId}:${i}`)]
  );

  ctx.reply(msg, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      ...removeWalletButtons,
      [Markup.button.callback("➕ Add Wallet", `wiz:bm_aw:${monitorId}`)],
      [Markup.button.callback("🗑 Remove Monitor", `wiz:bm_rm:${monitorId}`)],
      [Markup.button.callback("« Back", "cmd:balancemonitors")],
    ]),
  });
}

// ─── Info Commands ─────────────────────────────────────────────────────────────

async function cmdTokens(ctx: Context): Promise<void> {
  if (!callbacks) return;
  const state  = callbacks.getState();
  const tokens = callbacks.getTokenList();

  const now = Date.now();
  const header =
    `*Bot Status*\n` +
    `⏱ Uptime: \`${fmtUptime(now - state.startTime)}\`  📈 Trades: \`${state.totalTradesExecuted}\`\n` +
    `◎ SOL: \`${state.solBalance.toFixed(4)}\`\n\n`;

  if (tokens.length === 0) {
    await ctx.reply(header + "_No tokens being watched._", { parse_mode: "Markdown", ...backKeyboard() });
    return;
  }

  const sorted = [...tokens].sort((a, b) => {
    const mcA = state.tokens.get(a.mint)?.currentMarketCap ?? -1;
    const mcB = state.tokens.get(b.mint)?.currentMarketCap ?? -1;
    return mcB - mcA;
  });

  const chunks: string[] = [];
  let current = header + `🪙 *Total tokens:* \`${tokens.length}\`\n\n`;

  for (const t of sorted) {
    const ts = state.tokens.get(t.mint);
    const tc = callbacks.getConfig(t.mint);
    if (!ts || !tc) continue;

    const mc    = ts.currentMarketCap != null ? fmtMc(ts.currentMarketCap) : "—";
    const ui    = toUiAmount(ts.balance, ts.decimals);
    const stale = ts.lastUpdated === null || (now - ts.lastUpdated) > 30_000;
    const ago   = ts.lastUpdated ? `${Math.round((now - ts.lastUpdated) / 1000)}s ago` : "no feed";

    let block = `${stale ? "⚠️ " : ""}*${ts.symbol}* \`#${t.id}\`${stale ? " _(no price feed)_" : ""}\n`;
    block += `  Mcap: \`${mc}\`  _(${ago})_\n`;
    block += `  Balance: \`${ui.toLocaleString()}\`\n`;
    block += `  Buy mcap: \`${tc.buyMcap != null ? fmtMc(tc.buyMcap) : "not set"}\`  Spacing: \`${fmtMc(tc.levelSpacingUsd)}\`  Threshold: \`${tc.touchThreshold}\`\n`;

    const hot = getHottestLevels(ts, 3);
    for (const l of hot) {
      const bar = progBar(l.touchCount, tc.touchThreshold);
      const lastAgo = l.lastTouchTime ? `${Math.round((Date.now() - l.lastTouchTime) / 1000)}s ago` : "never";
      block += `  \`${fmtMc(l.value)}\` ${bar} ${l.touchCount}/${tc.touchThreshold} _(${lastAgo})_\n`;
    }
    block += "\n";

    if (current.length + block.length > 3800) {
      chunks.push(current);
      current = block;
    } else {
      current += block;
    }
  }
  if (current) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    const opts = i === chunks.length - 1
      ? { parse_mode: "Markdown" as const, ...backKeyboard() }
      : { parse_mode: "Markdown" as const };
    await ctx.reply(chunks[i], opts);
  }
}

async function cmdTrades(ctx: Context): Promise<void> {
  if (!callbacks) return;
  const history = callbacks.getTradeHistory();
  if (history.length === 0) {
    ctx.reply("No trades yet — watching for consolidation.", backKeyboard());
    return;
  }
  let msg = `*Last ${Math.min(10, history.length)} Trades*\n\n`;
  for (const t of history.slice(-10).reverse()) {
    const icon = t.status === "success" ? "✅" : t.status === "failed" ? "❌" : "⏳";
    msg += `${icon} *${t.symbol}* — \`${t.amountUi.toLocaleString()}\`\n`;
    msg += `   Line \`${fmtMc(t.triggerLevel)}\` · ${t.touchCount} touches\n`;
    msg += `   Mcap at trigger: \`${fmtMc(t.triggerMarketCap)}\`\n`;
    msg += `   ${new Date(t.timestamp).toLocaleString()}\n`;
    if (t.txSignature) msg += `   [Solscan](https://solscan.io/tx/${t.txSignature})\n`;
    if (t.error) msg += `   ⚠️ \`${t.error.slice(0, 80)}\`\n`;
    msg += "\n";
  }
  ctx.reply(msg, { parse_mode: "Markdown", ...backKeyboard() });
}

async function cmdFetch(ctx: Context): Promise<void> {
  if (!callbacks) return;
  const query = ((ctx.message as any)?.text ?? "").replace(/^\/fetch\s*/i, "").trim().toUpperCase();
  if (!query) {
    ctx.reply("Usage: `/fetch SYMBOL` — e.g. `/fetch WIF`", { parse_mode: "Markdown" });
    return;
  }
  const matches = callbacks.getTokenList().filter(t => t.symbol.toUpperCase() === query);
  if (matches.length === 0) {
    ctx.reply(`❌ No tracked token found with symbol *${query}*.`, { parse_mode: "Markdown" });
    return;
  }
  const lines = matches.map(t => `*${t.symbol}*\n\`${t.mint}\``).join("\n\n");
  ctx.reply(lines, { parse_mode: "Markdown" });
}

// ─── Auto CA Detection ────────────────────────────────────────────────────────

async function handleAutoAddCA(ctx: Context, mint: string): Promise<void> {
  if (!callbacks) return;
  const chatId = ctx.chat!.id;

  // Check if already tracked
  const existing = callbacks.getTokenList().find(t => t.mint === mint);
  if (existing) {
    ctx.reply(`ℹ️ *${existing.symbol}* is already being tracked.`, { parse_mode: "Markdown", ...backKeyboard() });
    return;
  }

  ctx.reply("🔍 Looking up token on DexScreener...");
  try {
    const { symbol, marketCap } = await fetchTokenInfo(mint);
    const result = await callbacks.addToken(mint, symbol, marketCap);
    ctx.reply(
      result + `\n\nGrid floor set at current mcap: *${fmtMc(marketCap)}*`,
      { parse_mode: "Markdown" }
    );
    wizardState.set(chatId, { flow: "settings", step: "await_field", mint, symbol });
    showSettingsForToken(ctx, mint, symbol);
  } catch {
    ctx.reply(
      `❌ Couldn't find that token on DexScreener.\n\n` +
      `Make sure it has graduated and has an active pair, then try again.`,
      backKeyboard()
    );
  }
}

// ─── Command: /remove <id|ticker[ ,id|ticker ...]> ───────────────────────────
// Accepts: numeric IDs, ticker symbols, or a mix — separated by spaces or commas.
// Examples:  /r 1 2 3   /r SOL,BONK   /r 1 BONK 3

function cmdRemoveByTicker(ctx: Context): void {
  if (!callbacks) return;
  const text = ((ctx.message as any)?.text ?? "").trim();
  // Everything after the command word; split on any combination of commas/spaces
  const argStr = text.split(/\s+/).slice(1).join(" ");
  const tokens = argStr.split(/[\s,]+/).map((s: string) => s.trim()).filter(Boolean);

  if (tokens.length === 0) {
    // No args — remove the last token the bot sent a notification for
    if (lastNotifiedMint) {
      const match = callbacks.getTokenList().find(t => t.mint === lastNotifiedMint);
      if (match) {
        ctx.reply(callbacks.removeToken(match.mint), { parse_mode: "Markdown", ...backKeyboard() });
        lastNotifiedMint = null;
        return;
      }
    }
    startRemoveToken(ctx);
    return;
  }

  const all = callbacks.getTokenList();

  const removed: string[] = [];
  const notFound: string[] = [];

  const flushAccumulated = (final: boolean) => {
    if (!removed.length && !notFound.length) return;
    const lines = [
      ...removed,
      ...notFound.map(tk => `❓ No token found for *${tk}*`),
    ];
    ctx.reply(lines.join("\n"), { parse_mode: "Markdown", ...(final ? backKeyboard() : {}) });
    removed.length = 0;
    notFound.length = 0;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const isId = /^\d+$/.test(token);
    const isMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token);

    if (isId) {
      const id = parseInt(token, 10);
      const match = all.find(t => t.id === id);
      if (!match) {
        notFound.push(`#${id}`);
      } else {
        removed.push(callbacks.removeToken(match.mint));
      }
    } else if (isMint) {
      const match = all.find(t => t.mint === token);
      if (!match) {
        notFound.push(`\`${token.slice(0, 4)}…${token.slice(-4)}\``);
      } else {
        removed.push(callbacks.removeToken(match.mint));
      }
    } else {
      const ticker = token.toUpperCase();
      const matches = all.map((t, idx) => ({ ...t, idx })).filter(t => t.symbol.toUpperCase() === ticker);

      if (matches.length === 0) {
        notFound.push(ticker);
      } else if (matches.length === 1) {
        removed.push(callbacks.removeToken(matches[0].mint));
      } else {
        // Flush before showing a disambiguation picker
        flushAccumulated(false);
        wizardState.set(ctx.chat!.id, { flow: "remove_token", step: "await_pick" });
        const rows = matches.map(t => [
          Markup.button.callback(`#${t.id} ${t.symbol}  (${t.mint.slice(0, 4)}…${t.mint.slice(-4)})`, `wiz:rm:${t.idx}`),
        ]);
        rows.push([Markup.button.callback("« Cancel", "cmd:home")]);
        ctx.reply(
          `⚠️ Multiple tokens share the ticker *${ticker}*. Which one?`,
          { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) },
        );
      }
    }
  }

  flushAccumulated(true);
}

// ─── Wizard: Remove Token ─────────────────────────────────────────────────────

function startRemoveToken(ctx: Context, showAll: boolean = false): void {
  if (!callbacks) return;
  const tokens = callbacks.getTokenList();
  if (tokens.length === 0) { ctx.reply("No tokens to remove.", backKeyboard()); return; }
  wizardState.set(ctx.chat!.id, { flow: "remove_token", step: "await_pick" });

  const PAGE = 10;
  const hasMore = tokens.length > PAGE;
  const visible = (!showAll && hasMore) ? tokens.slice(0, PAGE) : tokens;

  const rows = visible.map((t, i) => [Markup.button.callback(`#${t.id} ${t.symbol}`, `wiz:rm:${i}`)]);
  if (hasMore && !showAll) {
    rows.push([Markup.button.callback("▼ Show all tokens", "cmd:removetoken_all")]);
  }
  rows.push([Markup.button.callback("« Cancel", "cmd:home")]);

  ctx.reply("🗑 *Remove a Token*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(rows),
  });
}

// ─── Wizard: Settings ─────────────────────────────────────────────────────────

function startSettings(ctx: Context, showAll: boolean): void {
  if (!callbacks) return;
  const tokens = callbacks.getTokenList();
  if (tokens.length === 0) {
    ctx.reply("No tokens added yet.", backKeyboard());
    return;
  }
  wizardState.set(ctx.chat!.id, { flow: "settings", step: "await_token" });

  // Sort by m5 volume descending so highest-activity tokens appear first
  const stateMap = callbacks.getState().tokens;
  const sorted = [...tokens].sort((a, b) =>
    (stateMap.get(b.mint)?.volumeM5 ?? 0) - (stateMap.get(a.mint)?.volumeM5 ?? 0)
  );

  const PAGE = 5;
  const hasMore = sorted.length > PAGE;
  const visible = (!showAll && hasMore) ? sorted.slice(0, PAGE) : sorted;

  // Button callbacks use the original index in the config token list
  const rows = visible.map((t) => [Markup.button.callback(t.symbol, `wiz:cfg_token:${tokens.indexOf(t)}`)]);
  if (hasMore && !showAll) {
    rows.push([Markup.button.callback("▼ Show all tokens", "cmd:settings_all")]);
  }
  rows.push([Markup.button.callback("« Cancel", "cmd:home")]);

  ctx.reply("⚙️ *Token Settings* — Which token?", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(rows),
  });
}

// ─── Settings Field Display ───────────────────────────────────────────────────

function fmtDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = secs / 60;
  return Number.isInteger(m) ? `${m}m` : `${m.toFixed(1)}m`;
}

function showSettingsForToken(ctx: Context, mint: string, symbol: string, page: 1 | 2 = 1): void {
  const tc = callbacks!.getConfig(mint)!;
  const ts = callbacks!.getState().tokens.get(mint);

  // Detection params — depend on which sell mode is active
  const band = rangeBand(tc);
  const detectionLines = tc.rangeMode
    ? `• Sell mode: \`Range\`\n` +
      `  ↳ Band: \`+${tc.rangePct}%\` center, \`${fmtMc(tc.rangeSizeUsd)}\` wide` +
      (band ? ` → \`${fmtMc(band.lo)}–${fmtMc(band.hi)}\`` : "") + `\n` +
      `  ↳ Hold time: \`${fmtDuration(tc.rangeDurationSecs)}\`\n` +
      `  ↳ Anchor mcap: \`${tc.rangeAnchorMcap != null ? fmtMc(tc.rangeAnchorMcap) : "not set"}\`\n`
    : `• Sell mode: \`Consolidation\`\n` +
      `• Level spacing: \`${fmtMc(tc.levelSpacingUsd)}\`\n` +
      `• Touch threshold: \`${tc.touchThreshold}\`\n` +
      `• Hysteresis: \`${tc.hysteresisUsd != null ? "$" + fmtMc(tc.hysteresisUsd) : "±" + tc.hysteresisPct + "%"}\`\n` +
      `• Time-gate: \`${tc.minSecsBetweenTouches}s\`\n` +
      `• Invalidation: \`+${tc.invalidationPct}%\`\n`;

  // Page 2 detection buttons — depend on sell mode
  const modeToggleBtn = Markup.button.callback(
    tc.rangeMode ? "🎯 Sell Mode: Range  (tap → Consolidation)" : "🎯 Sell Mode: Consolidation  (tap → Range)",
    "wiz:field:rangeMode"
  );
  const detectionButtons = tc.rangeMode ? [
    [modeToggleBtn],
    [Markup.button.callback("📈 Range % Above",    "wiz:field:rangePct")],
    [Markup.button.callback("📐 Range Size",       "wiz:field:rangeSizeUsd")],
    [Markup.button.callback("⏳ Hold Time (secs)", "wiz:field:rangeDurationSecs")],
  ] : [
    [modeToggleBtn],
    [Markup.button.callback("👆 Touch Threshold",  "wiz:field:touchThreshold")],
    [Markup.button.callback("↔️ Hysteresis %",     "wiz:field:hysteresisPct")],
    [Markup.button.callback("↔️ Hysteresis $",     "wiz:field:hysteresisUsd")],
    [Markup.button.callback("⏱ Time-gate (secs)", "wiz:field:minSecsBetweenTouches")],
    [Markup.button.callback("🚫 Invalidation %",   "wiz:field:invalidationPct")],
  ];

  ctx.reply(
    `⚙️ *Settings for ${symbol}*\n\n` +
    `Current values:\n` +
    `• Avg buy mcap: \`${tc.buyMcap != null ? fmtMc(tc.buyMcap) : "not set"}\`\n` +
    `• ATL: \`${ts?.allTimeLow != null ? fmtMc(ts.allTimeLow) : "not set"}\`\n` +
    detectionLines +
    `• Sell amount: \`${tc.sellPct ?? 100}%\` of balance\n` +
    `• Min profit to sell: \`${tc.minProfitPct != null ? "+" + tc.minProfitPct + "%" : "disabled"}\`\n` +
    `• Price tracking: \`${tc.priceTracking ? "ON" : "OFF"}\`\n` +
    (tc.priceTracking
      ? `  ↳ ATL alert every: \`${fmtMc(tc.atlAlertSpacingUsd)}\`\n` +
        `  ↳ Upside alert at: \`+${tc.upsideAlertPct}%\`\n`
      : "") +
    `\nWhich setting do you want to change?`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(page === 1 ? [
        [Markup.button.callback("💵 Avg Buy Mcap",   "wiz:field:buyMcap")],
        [Markup.button.callback("📏 Level Spacing",  "wiz:field:levelSpacingUsd")],
        ...(tc.priceTracking ? [
          [Markup.button.callback("🔻 ATL Alert Spacing", "wiz:field:atlAlertSpacingUsd")],
          [Markup.button.callback("🔄 Reset ATL", "wiz:reset_atl")],
        ] : []),
        [Markup.button.callback("▼ More settings",  "wiz:settings_p2")],
        [Markup.button.callback("« Back to menu",   "cmd:home")],
      ] : [
        ...detectionButtons,
        [Markup.button.callback("💰 Min Profit %",     "wiz:field:minProfitPct")],
        [Markup.button.callback("📤 Sell Amount %",    "wiz:field:sellPct")],
        [Markup.button.callback(tc.priceTracking ? "📡 Price Tracking: ON  (tap to disable)" : "📡 Price Tracking: OFF  (tap to enable)", "wiz:field:priceTracking")],
        ...(tc.priceTracking ? [
          [Markup.button.callback("🚀 Upside Alert %",    "wiz:field:upsideAlertPct")],
        ] : []),
        [Markup.button.callback("▲ Back",            "wiz:settings_p1")],
        [Markup.button.callback("« Back to menu",    "cmd:home")],
      ]),
    }
  );
}

// ─── Wizard Button Handler ────────────────────────────────────────────────────

async function handleWizardButton(ctx: Context, wizard: WizardStep, payload: string): Promise<void> {
  const chatId = ctx.chat!.id;

  // Remove token — remove immediately and reopen the picker
  if (payload.startsWith("rm:") && wizard.flow === "remove_token") {
    const idx = parseInt(payload.split(":")[1], 10);
    const { mint, symbol } = callbacks!.getTokenList()[idx];
    ctx.reply(callbacks!.removeToken(mint), { parse_mode: "Markdown" });
    startRemoveToken(ctx);
    return;
  }

  if (payload === "reset_atl") {
    if (wizard?.flow === "settings" && (wizard.step === "await_field" || wizard.step === "await_value")) {
      const { mint, symbol } = wizard as any;
      const result = callbacks!.resetAtl(mint);
      ctx.reply(result, { parse_mode: "Markdown" });
      wizardState.set(chatId, { flow: "settings", step: "await_field", mint, symbol });
      showSettingsForToken(ctx, mint, symbol, 1);
    }
    return;
  }

  if (payload === "settings_p2" || payload === "settings_p1") {
    if (wizard?.flow === "settings" && (wizard.step === "await_field" || wizard.step === "await_value")) {
      const { mint, symbol } = wizard as any;
      wizardState.set(chatId, { flow: "settings", step: "await_field", mint, symbol });
      showSettingsForToken(ctx, mint, symbol, payload === "settings_p2" ? 2 : 1);
    }
    return;
  }

  // Settings — token picked
  if (payload.startsWith("cfg_token:") && wizard.flow === "settings") {
    const idx = parseInt(payload.split(":")[1], 10);
    const { mint, symbol } = callbacks!.getTokenList()[idx];
    wizardState.set(chatId, { flow: "settings", step: "await_field", mint, symbol });
    showSettingsForToken(ctx, mint, symbol);
    return;
  }

  // Settings — field picked
  if (payload.startsWith("field:") && wizard.flow === "settings" && wizard.step === "await_field") {
    const rawField = payload.split(":")[1];

    // priceTracking is a boolean toggle — handle immediately without text input
    if (rawField === "priceTracking") {
      const { mint, symbol } = wizard;
      const tc = callbacks!.getConfig(mint)!;
      const newVal = !tc.priceTracking;
      callbacks!.updateSettings(mint, { priceTracking: newVal });
      ctx.reply(`📡 Price tracking *${newVal ? "enabled" : "disabled"}* for *${symbol}*.`, { parse_mode: "Markdown" });
      wizardState.set(chatId, { flow: "settings", step: "await_field", mint, symbol });
      showSettingsForToken(ctx, mint, symbol);
      return;
    }

    // rangeMode is a boolean toggle — handle immediately, snapshotting the anchor on enable
    if (rawField === "rangeMode") {
      const { mint, symbol } = wizard;
      const tc = callbacks!.getConfig(mint)!;
      const newVal = !tc.rangeMode;
      callbacks!.updateSettings(mint, { rangeMode: newVal });
      if (newVal) {
        const band = rangeBand(callbacks!.getConfig(mint)!);
        ctx.reply(
          `🎯 *Range mode enabled* for *${symbol}*.\n\n` +
          (band
            ? `Band: \`+${tc.rangePct}%\` center, \`${fmtMc(tc.rangeSizeUsd)}\` wide → \`${fmtMc(band.lo)}–${fmtMc(band.hi)}\`\n` +
              `Hold time: \`${fmtDuration(tc.rangeDurationSecs)}\``
            : `Anchor mcap will be captured on the next price tick.`),
          { parse_mode: "Markdown" }
        );
      } else {
        ctx.reply(`🎯 Range mode *disabled* for *${symbol}* — back to consolidation detection.`, { parse_mode: "Markdown" });
      }
      wizardState.set(chatId, { flow: "settings", step: "await_field", mint, symbol });
      showSettingsForToken(ctx, mint, symbol, 2);
      return;
    }

    const field = rawField as SettingsField;
    wizardState.set(chatId, { flow: "settings", step: "await_value", mint: wizard.mint, symbol: wizard.symbol, field });

    const prompts: Record<SettingsField, string> = {
      levelSpacingUsd:
        `📏 *Level Spacing*\n\nHow far apart should the Y-lines be in USD?\n\n` +
        `Use shorthand: \`500k\`, \`1m\`, \`2.5m\` etc.\n` +
        `_Smaller spacing = more sensitive detection._`,
      touchThreshold:
        `👆 *Touch Threshold*\n\nHow many touches on a single line triggers a sell?\n\n` +
        `Typical range: 3–6`,
      hysteresisPct:
        `↔️ *Hysteresis %*\n\nHow far (in %) must the market cap move away from a line before it can register another touch?\n\n` +
        `Example: \`1\` = market cap must move ±1% from the line to re-arm.\n` +
        `_Larger = less sensitive to noise._`,
      minSecsBetweenTouches:
        `⏱ *Time-gate*\n\nMinimum seconds between touches on the same line.\n\n` +
        `Example: \`60\` = at least 1 minute must pass between touches.\n` +
        `_Prevents high-volume candles from over-counting._`,
      hysteresisUsd:
        `↔️ *Hysteresis (flat $)*\n\nHow many dollars must the market cap move away from a line before it can be touched again.\n\n` +
        `Example: \`500k\` = mcap must move $500K away from the line to re-arm it.\n` +
        `_Overrides the % setting. Set to \`0\` to go back to using % instead._`,
      invalidationPct:
        `🚫 *Invalidation %*\n\nIf the market cap rises this % ABOVE a line, that line's touch count resets to zero.\n\n` +
        `Example: \`50\` = if mcap pumps 50%+ above a line, any touches on it are wiped.\n` +
        `_Prevents counting touches on levels the price has clearly broken out above._`,
      sellPct:
        `📤 *Sell Amount %*\n\nWhat percentage of your balance should the bot sell when consolidation is detected?\n\n` +
        `Example: \`50\` = sell half each time, keep watching for the next consolidation.\n` +
        `\`100\` = sell everything and stop watching (default).\n` +
        `_Must be between 1 and 100._`,
      minProfitPct:
        `💰 *Min Profit %*\n\nMinimum % above your average buy mcap that the current mcap must be before a sell fires.\n\n` +
        `Example: \`20\` = only sell if current mcap is at least 20% above your buy mcap.\n` +
        `Set to \`0\` to disable.\n` +
        `_Prevents selling at a loss during consolidation near your entry._`,
      buyMcap:
        `💵 *Avg Buy Mcap*\n\nUpdate your average buy market cap. This is used as the grid floor and for the min profit check.\n\n` +
        `Use shorthand: \`25k\`, \`1.5m\`, \`45m\` etc.\n` +
        `Set to \`0\` to clear it.`,
      atlAlertSpacingUsd:
        `🔻 *ATL Alert Spacing*\n\nHow far the market cap must drop below the previous all-time low before sending another ATL alert.\n\n` +
        `Use shorthand: \`10k\`, \`50k\`, \`1m\` etc.\n` +
        `Default: \`10k\``,
      upsideAlertPct:
        `🚀 *Upside Alert %*\n\nSends an alert every time the market cap rises this % from the last alert baseline.\n\n` +
        `Example: \`30\` = alert fires every time mcap gains another 30%.\n` +
        `Default: \`30\``,
      rangePct:
        `📈 *Range % Above*\n\nHow far above the anchor mcap (captured when range mode was enabled) the CENTER of the band sits.\n\n` +
        `Example: \`20\` = band centered 20% above the anchor.\n` +
        `_Changing this restarts the hold timer._`,
      rangeSizeUsd:
        `📐 *Range Size*\n\nHow wide the band is in USD (split half above and half below the center).\n\n` +
        `Use shorthand: \`10k\`, \`50k\`, \`1m\` etc.\n` +
        `Example: \`10k\` = band spans $10K total (±$5K around the center).\n` +
        `_Changing this restarts the hold timer._`,
      rangeDurationSecs:
        `⏳ *Hold Time*\n\nHow many continuous seconds the market cap must stay inside the band to trigger a sell.\n\n` +
        `Example: \`300\` = 5 minutes. If mcap leaves the band, the timer resets.`,
    };

    ctx.reply(prompts[field], { parse_mode: "Markdown" });
    return;
  }
}

// ─── Wizard Free-text Handler ─────────────────────────────────────────────────

async function handleWizardInput(ctx: Context, wizard: WizardStep): Promise<void> {
  const chatId = ctx.chat!.id;
  const text = ((ctx.message as any)?.text ?? "").trim();

  // ── WATCH WALLET ──────────────────────────────────────────────────────────
  if (wizard.flow === "watch_wallet" && wizard.step === "await_address") {
    // Validate: must be a valid base58 Solana address (32–44 chars)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
      ctx.reply("❌ That doesn't look like a valid Solana address. Paste the full base58 address.\n\n/cancel to go back");
      return;
    }
    wizardState.delete(chatId);
    ctx.reply("⏳ Setting up wallet watcher...");
    try {
      await callbacks!.setWatchedWallet(text);
      ctx.reply(
        `👁 *Wallet Watch Active*\n\n\`${text}\`\n\nTokens this wallet *buys* will be auto-added to your watchlist.\nTokens it *fully sells* will be auto-removed.\n\n⚠️ Make sure \`WEBHOOK_URL\` is set in your \`.env\` so Helius can reach your server.`,
        { parse_mode: "Markdown", ...mainMenuKeyboard() }
      );
    } catch (err) {
      ctx.reply(`❌ Failed to set wallet watcher: ${String(err)}`, backKeyboard());
    }
    return;
  }

  // ── BALANCE MONITOR ───────────────────────────────────────────────────────
  if (wizard.flow === "balance_monitor") {
    if (wizard.step === "await_mint") {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
        ctx.reply("❌ That doesn't look like a valid Solana CA.\n\n/cancel to go back");
        return;
      }
      ctx.reply("⏳ Fetching token info...");
      try {
        const { symbol } = await fetchTokenInfo(text);
        wizardState.set(chatId, { flow: "balance_monitor", step: "await_wallets", mint: text, symbol });
        ctx.reply(
          `📊 *${symbol}*\n\nPaste the wallet addresses to watch (one per line or comma-separated).\n\n/cancel to go back`,
          { parse_mode: "Markdown" }
        );
      } catch {
        ctx.reply("❌ Couldn't fetch token info. Check the CA and try again.\n\n/cancel to go back");
      }
      return;
    }

    if (wizard.step === "await_wallets") {
      const { mint, symbol } = wizard;
      const raw = text.split(/[\n,\s]+/).map((s: string) => s.trim()).filter(Boolean);
      const valid   = raw.filter((s: string) =>  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s));
      const invalid = raw.filter((s: string) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s));

      if (valid.length === 0) {
        ctx.reply("❌ No valid Solana addresses found. Each must be 32–44 base58 chars.\n\n/cancel to go back");
        return;
      }

      wizardState.delete(chatId);
      const result = await callbacks!.addBalanceMonitor(mint, symbol, valid);
      let reply = result;
      if (invalid.length > 0) reply += `\n\n⚠️ ${invalid.length} invalid address(es) skipped.`;
      ctx.reply(reply, { parse_mode: "Markdown", ...mainMenuKeyboard() });
      return;
    }
  }

  if (wizard.flow === "balance_monitor_add_wallet" && wizard.step === "await_wallet") {
    const { monitorId } = wizard;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
      ctx.reply("❌ Invalid Solana address.\n\n/cancel to go back");
      return;
    }
    wizardState.delete(chatId);
    const result = await callbacks!.addWalletToMonitor(monitorId, text);
    ctx.reply(result, { parse_mode: "Markdown" });
    return showMonitorDetail(ctx, monitorId);
  }

  // ── SETTINGS ──────────────────────────────────────────────────────────────
  if (wizard.flow === "settings" && wizard.step === "await_value") {
    const { mint, symbol, field } = wizard;
    let value: number | null = null;

    if (field === "levelSpacingUsd" || field === "hysteresisUsd" || field === "atlAlertSpacingUsd" || field === "buyMcap" || field === "rangeSizeUsd") {
      value = parseMcap(text);
      if (value === null || value < 0) {
        ctx.reply("❌ Invalid amount. Examples: `500k`, `1m`, `2500000`, or `0` to clear", { parse_mode: "Markdown" });
        return;
      }
      // 0 means "clear" for nullable fields
      if ((field === "hysteresisUsd" || field === "buyMcap") && value === 0) value = null as any;
      // range size must be a positive width
      if (field === "rangeSizeUsd" && value === 0) {
        ctx.reply("❌ Range size must be greater than 0. Examples: `10k`, `50k`, `1m`");
        return;
      }
    } else if (field === "minProfitPct") {
      value = parseFloat(text);
      if (isNaN(value) || value < 0) {
        ctx.reply("❌ Enter a number like `20` for 20%, or `0` to disable.");
        return;
      }
      if (value === 0) value = null as any;
    } else if (field === "sellPct") {
      value = parseFloat(text);
      if (isNaN(value) || value < 1 || value > 100) {
        ctx.reply("❌ Enter a number between 1 and 100.");
        return;
      }
    } else {
      value = parseFloat(text);
      if (isNaN(value) || value <= 0) {
        ctx.reply("❌ Enter a positive number.");
        return;
      }
    }

    const result = callbacks!.updateSettings(mint, { [field]: value });

    const fieldNames: Record<SettingsField, string> = {
      levelSpacingUsd: "Level spacing",
      touchThreshold: "Touch threshold",
      hysteresisPct: "Hysteresis %",
      hysteresisUsd: "Hysteresis $",
      minSecsBetweenTouches: "Time-gate",
      invalidationPct: "Invalidation",
      sellPct: "Sell amount %",
      minProfitPct: "Min profit %",
      atlAlertSpacingUsd: "ATL alert spacing",
      upsideAlertPct: "Upside alert %",
      buyMcap: "Avg buy mcap",
      rangePct: "Range % above",
      rangeSizeUsd: "Range size",
      rangeDurationSecs: "Hold time",
    };

    const usdField = field === "levelSpacingUsd" || field === "rangeSizeUsd";
    ctx.reply(
      `${result}\n\n*${fieldNames[field]}* set to \`${usdField ? fmtMc(value!) : value ?? "cleared"}\``,
      { parse_mode: "Markdown" }
    );
    wizardState.set(chatId, { flow: "settings", step: "await_field", mint, symbol });
    showSettingsForToken(ctx, mint, symbol);
    return;
  }
}

// ─── Test Sell ────────────────────────────────────────────────────────────────

function startTestSell(ctx: Context): void {
  if (!callbacks) return;
  const tokens = callbacks.getTokenList();
  if (tokens.length === 0) {
    ctx.reply("No tokens added yet.", backKeyboard());
    return;
  }
  ctx.reply(
    `🧪 *Full Stack*

This will immediately sell 100% of your balance for the selected token via Jupiter. Use this to verify the sell pipeline works.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        ...tokens.map((t, i) => [Markup.button.callback(t.symbol, `wiz:testsell:${i}`)]),
        [Markup.button.callback("« Cancel", "cmd:home")],
      ]),
    }
  );
}

// ─── Outbound Notifications ────────────────────────────────────────────────────

export async function notifyTouchDetected(
  mint: string, symbol: string, touchCount: number, touchThreshold: number,
  currentMcap: number, levelMcap: number
): Promise<void> {
  lastNotifiedMint = mint;
  const bar = progBar(touchCount, touchThreshold);
  const lastOne = touchCount === touchThreshold - 1;
  await safeSend(
    `👆 *Touch #${touchCount} — ${symbol}*\n\n` +
    `Line: \`${fmtMc(levelMcap)}\`\n` +
    `Market cap: \`${fmtMc(currentMcap)}\`\n` +
    `Progress: ${bar} \`${touchCount}/${touchThreshold}\`` +
    (lastOne ? `\n\n⚡ *One more touch triggers a sell!*` : "")
  );
}

export async function notifySellTriggered(
  mint: string, symbol: string, amount: number, levelMcap: number,
  touchCount: number, currentMcap: number, sellPct: number = 100
): Promise<void> {
  lastNotifiedMint = mint;
  await safeSend(
    `🔴 *SELL TRIGGERED — ${symbol}*\n\n` +
    `Consolidation detected on line \`${fmtMc(levelMcap)}\`\n` +
    `Touches: \`${touchCount}\`  |  Mcap: \`${fmtMc(currentMcap)}\`\n` +
    `Amount: \`${amount.toLocaleString()} ${symbol}\` _(${sellPct}% of balance)_\n\n` +
    `⏳ Executing swap on Jupiter...`
  );
}

export async function notifyRangeSellTriggered(
  mint: string, symbol: string, amount: number, centerMcap: number,
  dwellSecs: number, currentMcap: number, sellPct: number = 100
): Promise<void> {
  lastNotifiedMint = mint;
  await safeSend(
    `🔴 *SELL TRIGGERED — ${symbol}*\n\n` +
    `Range held around \`${fmtMc(centerMcap)}\` for \`${fmtDuration(Math.round(dwellSecs))}\`\n` +
    `Mcap: \`${fmtMc(currentMcap)}\`\n` +
    `Amount: \`${amount.toLocaleString()} ${symbol}\` _(${sellPct}% of balance)_\n\n` +
    `⏳ Executing swap on Jupiter...`
  );
}

export async function notifyTradeResult(trade: TradeRecord): Promise<void> {
  lastNotifiedMint = trade.mint;
  if (trade.status === "success") {
    await safeSend(
      `✅ *Sell Confirmed — ${trade.symbol}*\n\n` +
      `Sold: \`${trade.amountUi.toLocaleString()} ${trade.symbol}\`\n` +
      `Line: \`${fmtMc(trade.triggerLevel)}\`\n` +
      `[View on Solscan](https://solscan.io/tx/${trade.txSignature})`
    );
  } else {
    await safeSend(
      `❌ *Sell Failed — ${trade.symbol}*\n\n` +
      `Error: \`${(trade.error ?? "unknown").slice(0, 120)}\`\n\n` +
      `Monitoring has stopped. Restart the bot to try again.`
    );
  }
}

export async function notifyStartup(walletAddress: string, watchedTokens: string[]): Promise<void> {
  const tokenStr = watchedTokens.length > 0 ? watchedTokens.join(", ") : "none — tap Add Token to start";
  await safeSend(`🟢 *Bot Started*\n\nWallet: \`${walletAddress}\`\nWatching: ${tokenStr}`);
  if (tg && authorizedChatId) {
    await tg.telegram.sendMessage(authorizedChatId, "What would you like to do?", { ...mainMenuKeyboard() });
  }
}

export async function notifyLowSol(balance: number): Promise<void> {
  await safeSend(
    `⚠️ *Low SOL Balance*\n\n` +
    `Current: \`${balance.toFixed(4)} SOL\`\n` +
    `The bot needs at least 0.05 SOL for fees. Please top up soon.`
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export async function notifyAtlAlert(mint: string, symbol: string, mcap: number, spacingUsd: number): Promise<void> {
  lastNotifiedMint = mint;
  await safeSend(
    `🔻 *New All-Time Low — ${symbol}*\n\n` +
    `Mcap: \`${fmtMc(mcap)}\`\n` +
    `_(alert fires every \`${fmtMc(spacingUsd)}\` drop)_`
  );
}

export async function notifyUpsideAlert(mint: string, symbol: string, mcap: number, pct: number): Promise<void> {
  lastNotifiedMint = mint;
  await safeSend(
    `🚀 *+${pct}% Move — ${symbol}*\n\n` +
    `Mcap: \`${fmtMc(mcap)}\`\n` +
    `_(alert fires every \`+${pct}%\` gain from last alert)_`
  );
}

export async function notifySellBlocked(
  mint: string, symbol: string, touchCount: number, levelMcap: number, currentMcap: number, reason: string
): Promise<void> {
  lastNotifiedMint = mint;
  await safeSend(
    `⚠️ *Sell Attempt Blocked — ${symbol}*\n\n` +
    `Touch #${touchCount} on line \`${fmtMc(levelMcap)}\`\n` +
    `Mcap: \`${fmtMc(currentMcap)}\`\n` +
    `Reason: ${reason}`
  );
}

export async function notifyInvalidation(
  mint: string, symbol: string, levelMcap: number, currentMcap: number, invalidationPct: number
): Promise<void> {
  lastNotifiedMint = mint;
  await safeSend(
    `🚫 *Level Invalidated — ${symbol}*\n\n` +
    `Line \`${fmtMc(levelMcap)}\` reset — mcap pumped >${invalidationPct}% above it\n` +
    `Mcap now: \`${fmtMc(currentMcap)}\`\n` +
    `_Touch count cleared. Line will re-arm if price returns._`
  );
}

export async function notifyNewBond(
  mint: string, name: string, symbol: string,
  marketCap: number, volumeH1: number, ageMins: number,
  tier: number,
  imageUri?: string
): Promise<void> {
  if (!tg || !authorizedChatId) return;
  const ageStr = ageMins < 1 ? "<1 min" : `${Math.round(ageMins)} min`;
  const tierEmojis = ["🔗", "🔥", "🔥🔥", "🚀"];
  const emoji = tierEmojis[tier - 1] ?? "🔗";
  const tierTag = tier > 1 ? ` · T${tier}` : "";
  const caption =
    `${emoji} *Bond${tierTag} — ${name} (${symbol})*\n\n` +
    `Mcap: \`${fmtMc(marketCap)}\`\n` +
    `Volume: \`${fmtMc(volumeH1)}\` in ${ageStr}\n` +
    `\n[pump.fun](https://pump.fun/${mint})  •  [DexScreener](https://dexscreener.com/solana/${mint})`;

  try {
    if (imageUri && tier === 1) {
      await tg.telegram.sendPhoto(authorizedChatId, imageUri, {
        caption,
        parse_mode: "Markdown",
      } as any);
    } else {
      await tg.telegram.sendMessage(authorizedChatId, caption, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
      } as any);
    }
  } catch (err) {
    logger.error("Failed to send bond notification", { error: String(err) });
  }
}

export async function notifyWalletBuy(mint: string, symbol: string, buyMcap: number): Promise<void> {
  await safeSend(
    `👁 *Wallet Buy Detected — ${symbol}*\n\n` +
    `Mint: \`${mint}\`\n` +
    `Mcap at buy: \`${fmtMc(buyMcap)}\`\n\n` +
    `✅ Auto-added to watchlist with default settings.`
  );
}

export async function notifyWalletFullSell(mint: string, symbol: string): Promise<void> {
  await safeSend(
    `👁 *Wallet Full Sell Detected — ${symbol}*\n\n` +
    `The watched wallet fully exited this position.\n\n` +
    `🗑 Auto-removed from watchlist.`
  );
}

export async function notifyBalanceTransfer(
  wallet: string,
  symbol: string,
  direction: "in" | "out",
  amount: number,
): Promise<void> {
  const dir   = direction === "in" ? "📈 Received" : "📉 Sent";
  const short = `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
  const fmt   = amount >= 1_000_000
    ? `${(amount / 1_000_000).toFixed(2)}M`
    : amount >= 1_000
    ? `${(amount / 1_000).toFixed(2)}K`
    : amount.toFixed(2);
  await safeSend(
    `📊 *Balance Monitor — ${symbol}*\n\n` +
    `Wallet: \`${short}\`\n` +
    `${dir}: ${fmt} ${symbol}`
  );
}

export async function notifyStaleToken(mint: string, symbol: string): Promise<void> {
  lastNotifiedMint = mint;
  await safeSend(`⚠️ *${symbol}* — no price feed from DexScreener. Token may have lost liquidity or been delisted.`);
}

export async function notifyTokenRecovered(mint: string, symbol: string): Promise<void> {
  lastNotifiedMint = mint;
  await safeSend(`✅ *${symbol}* — price feed restored.`);
}

async function safeSend(message: string): Promise<void> {
  if (!tg || !authorizedChatId) return;
  try {
    await tg.telegram.sendMessage(authorizedChatId, message, {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    } as any);
  } catch (err) {
    logger.error("Failed to send Telegram message", { error: String(err) });
  }
}

async function downloadConvertTgsAndSend(ctx: Context, fileId: string): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) { ctx.reply("❌ `DISCORD_WEBHOOK_URL` is not set in .env.", { parse_mode: "Markdown" }); return; }

  const tmpId  = crypto.randomBytes(8).toString("hex");
  const inPath  = path.join(os.tmpdir(), `${tmpId}.tgs`);
  const outPath = path.join(os.tmpdir(), `${tmpId}.gif`);

  try {
    const token = process.env.TELEGRAM_BOT_TOKEN!;
    const file  = await ctx.telegram.getFile(fileId);
    const url   = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`Telegram fetch HTTP ${res.status}`);
    fs.writeFileSync(inPath, Buffer.from(await res.arrayBuffer()));

    await execFileAsync("python3", [TGS_SCRIPT, inPath, outPath], { timeout: 30_000 });

    const gif  = fs.readFileSync(outPath);
    const form = new FormData();
    form.append("file", new Blob([gif], { type: "image/gif" }), "sticker.gif");
    form.append("content", "animated sticker — sticker.gif");

    const discordRes = await fetch(webhookUrl, { method: "POST", body: form });
    if (!discordRes.ok) throw new Error(`Discord HTTP ${discordRes.status}`);

    ctx.reply("✅ *Animated sticker* sent to Discord as `sticker.gif`", { parse_mode: "Markdown" });
  } catch (err) {
    logger.error("TGS conversion/send failed", { error: String(err) });
    ctx.reply("❌ Failed to convert sticker. Try again.");
  } finally {
    try { fs.unlinkSync(inPath); } catch {}
    try { fs.unlinkSync(outPath); } catch {}
  }
}

async function downloadConvertWebmAndSend(ctx: Context, fileId: string): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) { ctx.reply("❌ `DISCORD_WEBHOOK_URL` is not set in .env.", { parse_mode: "Markdown" }); return; }

  const tmpId   = crypto.randomBytes(8).toString("hex");
  const inPath  = path.join(os.tmpdir(), `${tmpId}.webm`);
  const outPath = path.join(os.tmpdir(), `${tmpId}.gif`);

  try {
    const token = process.env.TELEGRAM_BOT_TOKEN!;
    const file  = await ctx.telegram.getFile(fileId);
    const url   = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`Telegram fetch HTTP ${res.status}`);
    fs.writeFileSync(inPath, Buffer.from(await res.arrayBuffer()));

    await execFileAsync("ffmpeg", [
      "-i", inPath,
      "-vf", "fps=15,scale=320:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
      "-loop", "0",
      outPath,
    ], { timeout: 30_000 });

    const gif  = fs.readFileSync(outPath);
    const form = new FormData();
    form.append("file", new Blob([gif], { type: "image/gif" }), "sticker.gif");
    form.append("content", "video sticker — sticker.gif");

    const discordRes = await fetch(webhookUrl, { method: "POST", body: form });
    if (!discordRes.ok) throw new Error(`Discord HTTP ${discordRes.status}`);

    ctx.reply("✅ *Video sticker* sent to Discord as `sticker.gif`", { parse_mode: "Markdown" });
  } catch (err) {
    logger.error("WebM conversion/send failed", { error: String(err) });
    ctx.reply("❌ Failed to convert sticker. Try again.");
  } finally {
    try { fs.unlinkSync(inPath); } catch {}
    try { fs.unlinkSync(outPath); } catch {}
  }
}

async function downloadAndSendToDiscord(ctx: Context, fileId: string, filename: string, type: string): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    ctx.reply("❌ `DISCORD_WEBHOOK_URL` is not set in .env.", { parse_mode: "Markdown" });
    return;
  }
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN!;
    const file  = await ctx.telegram.getFile(fileId);
    const url   = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`Telegram fetch HTTP ${res.status}`);
    const buf   = Buffer.from(await res.arrayBuffer());

    const form  = new FormData();
    form.append("file", new Blob([buf]), filename);
    form.append("content", `${type} — ${filename}`);

    const discordRes = await fetch(webhookUrl, { method: "POST", body: form });
    if (!discordRes.ok) throw new Error(`Discord HTTP ${discordRes.status}`);

    ctx.reply(`✅ *${type}* sent to Discord as \`${filename}\``, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error("Failed to send file to Discord", { error: String(err) });
    ctx.reply("❌ Failed to send to Discord. Try again.");
  }
}

async function downloadInstagramAndSend(ctx: Context, url: string, playlistItems?: string): Promise<void> {
  if (!fs.existsSync(INSTAGRAM_COOKIES)) {
    ctx.reply(
      "❌ Instagram cookies file not found.\nExpected at `" + INSTAGRAM_COOKIES + "` or set `INSTAGRAM_COOKIES` env var.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  const tmpId  = crypto.randomBytes(8).toString("hex");
  const outDir = path.join(os.tmpdir(), `ig_${tmpId}`);
  const outTmpl = path.join(outDir, `media.%(autonumber)s.%(ext)s`);

  let statusMsgId: number | null = null;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const itemLabel = playlistItems ? ` (item ${playlistItems})` : "";
    const status = await ctx.reply(`⏬ Downloading from Instagram${itemLabel}…`);
    statusMsgId = status.message_id;

    const args = [
      "--cookies", INSTAGRAM_COOKIES,
      "--no-warnings",
      "--quiet",
      "-o", outTmpl,
    ];
    if (playlistItems) args.push("--playlist-items", playlistItems);
    args.push(url);

    await execFileAsync("yt-dlp", args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });

    const files = fs.readdirSync(outDir)
      .filter((f) => !f.endsWith(".part") && !f.endsWith(".ytdl") && !f.endsWith(".json"))
      .sort();
    if (files.length === 0) throw new Error("yt-dlp produced no files");

    for (const f of files) {
      const fp   = path.join(outDir, f);
      const ext  = path.extname(f).toLowerCase();
      const size = fs.statSync(fp).size;

      if (size > TG_UPLOAD_LIMIT) {
        await ctx.reply(`⚠️ \`${f}\` is ${(size / 1024 / 1024).toFixed(1)} MB — exceeds Telegram's 50 MB upload limit, skipping.`, { parse_mode: "Markdown" });
        continue;
      }

      if (ext === ".mp4" || ext === ".mov" || ext === ".webm" || ext === ".mkv") {
        await ctx.replyWithVideo({ source: fp });
      } else if (ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".webp") {
        await ctx.replyWithPhoto({ source: fp });
      } else {
        await ctx.replyWithDocument({ source: fp });
      }
    }

    if (statusMsgId != null) {
      try { await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsgId); } catch {}
      statusMsgId = null;
    }
  } catch (err) {
    const msg = String((err as any)?.stderr || err);
    logger.error("Instagram download failed", { url, error: msg });
    let reply = "❌ Instagram download failed.";
    if (/login|cookies?|rate.?limit|401|403|empty media response/i.test(msg)) {
      reply = "❌ Instagram auth failed — cookies may be expired. Re-export and try again.";
    } else if (/ENOENT.*yt-dlp|yt-dlp.*not found/i.test(msg)) {
      reply = "❌ `yt-dlp` is not installed on this host.";
    } else {
      reply += `\n\`${msg.slice(0, 300).replace(/`/g, "'")}\``;
    }
    try {
      if (statusMsgId != null) await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsgId);
    } catch {}
    ctx.reply(reply, { parse_mode: "Markdown" });
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  }
}

function parseMcap(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/,/g, "");
  const num = parseFloat(s);
  if (isNaN(num)) return null;
  if (s.endsWith("b")) return num * 1_000_000_000;
  if (s.endsWith("m")) return num * 1_000_000;
  if (s.endsWith("k")) return num * 1_000;
  return num;
}

function progBar(current: number, total: number): string {
  return "▓".repeat(Math.min(current, total)) + "░".repeat(Math.max(0, total - current));
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
}

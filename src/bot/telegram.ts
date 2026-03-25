import { Telegraf, Context, Markup } from "telegraf";
import { BotState, TokenConfig, TradeRecord } from "./types";
import { toUiAmount } from "./wallet";
import { fmtMarketCap, fetchTokenInfo } from "./price";
import { getHottestLevels, fmtMc } from "./consolidation";
import { logger } from "./logger";

// ─── Callbacks ────────────────────────────────────────────────────────────────

export interface TelegramCallbacks {
  getState: () => BotState;
  getTradeHistory: () => TradeRecord[];
  getTokenList: () => { mint: string; symbol: string }[];
  addToken: (mint: string, symbol: string, buyMcap?: number | null) => string | Promise<string>;
  removeToken: (mint: string) => string;
  updateSettings: (mint: string, settings: Partial<TokenConfig>) => string;
  getConfig: (mint: string) => TokenConfig | null;
  testSell: (mint: string) => void;
  resetAtl: (mint: string) => string;
}

// ─── Wizard State ─────────────────────────────────────────────────────────────

type WizardStep =
  | { flow: "add_token";    step: "await_mint" }
  | { flow: "add_token";    step: "await_avg_price"; mint: string; symbol: string; marketCap: number }
  | { flow: "remove_token"; step: "await_pick" }
  | { flow: "settings";     step: "await_token" }
  | { flow: "settings";     step: "await_field";   mint: string; symbol: string }
  | { flow: "settings";     step: "await_value";   mint: string; symbol: string; field: SettingsField };

type SettingsField = "levelSpacingUsd" | "touchThreshold" | "hysteresisPct" | "hysteresisUsd" | "minSecsBetweenTouches" | "invalidationPct" | "sellPct" | "minProfitPct" | "atlAlertSpacingUsd" | "upsideAlertPct" | "buyMcap";

const wizardState = new Map<number, WizardStep>();

let tg: Telegraf | null = null;
let authorizedChatId: number | null = null;
let callbacks: TelegramCallbacks | null = null;

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

  callbacks = cb;
  tg = new Telegraf(token);

  tg.use(async (ctx, next) => {
    if (ctx.chat?.id !== authorizedChatId) {
      logger.warn("Unauthorized Telegram access", { chatId: ctx.chat?.id });
      return;
    }
    return next();
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

  bot.command("status",      cmdStatus);
  bot.command("prices",      cmdPrices);
  bot.command("tokens",      cmdTokens);
  bot.command("levels",      cmdLevels);
  bot.command("trades",      cmdTrades);
  bot.command("addtoken",    (ctx) => startAddToken(ctx));
  bot.command("removetoken", (ctx) => startRemoveToken(ctx));
  bot.command("settings",    (ctx) => startSettings(ctx));

  bot.on("callback_query", async (ctx) => {
    await ctx.answerCbQuery();
    const data = (ctx.callbackQuery as any).data as string;
    await handleCallback(ctx, data);
  });

  bot.on("text", async (ctx) => {
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
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 Status",        "cmd:status"),
     Markup.button.callback("💰 Prices",        "cmd:prices")],
    [Markup.button.callback("🪙 My Tokens",     "cmd:tokens"),
     Markup.button.callback("📈 Active Levels", "cmd:levels")],
    [Markup.button.callback("📋 Trade History", "cmd:trades")],
    [Markup.button.callback("➕ Add Token",     "cmd:addtoken"),
     Markup.button.callback("🗑 Remove Token",  "cmd:removetoken")],
    [Markup.button.callback("⚙️ Settings",      "cmd:settings")],
    [Markup.button.callback("🧪 Test Sell",      "cmd:testsell")],
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
      case "status":      return cmdStatus(ctx);
      case "prices":      return cmdPrices(ctx);
      case "tokens":      return cmdTokens(ctx);
      case "levels":      return cmdLevels(ctx);
      case "trades":      return cmdTrades(ctx);
      case "addtoken":    return startAddToken(ctx);
      case "removetoken": return startRemoveToken(ctx);
      case "settings":    return startSettings(ctx);
      case "testsell":    return startTestSell(ctx);
      case "home":        return sendHome(ctx);
    }
  }
}

// ─── Info Commands ─────────────────────────────────────────────────────────────

async function cmdStatus(ctx: Context): Promise<void> {
  if (!callbacks) return;
  const state = callbacks.getState();
  const solWarn = state.solBalance < 0.05 ? " ⚠️ LOW" : "";
  let msg = `*Bot Status*\n\n`;
  msg += `⏱ Uptime: \`${fmtUptime(Date.now() - state.startTime)}\`\n`;
  msg += `◎ SOL: \`${state.solBalance.toFixed(4)}\`${solWarn}\n`;
  msg += `📈 Total trades: \`${state.totalTradesExecuted}\`\n\n*Token Balances*\n`;
  for (const [, ts] of state.tokens) {
    const ui = toUiAmount(ts.balance, ts.decimals);
    const val = ts.currentPrice ? ` ($${(ui * ts.currentPrice).toFixed(2)})` : "";
    const watching = ts.sold ? " 🔴 sold" : " 👀 watching";
    msg += `• *${ts.symbol}*: \`${ui.toLocaleString()}${val}\`${watching}\n`;
  }
  if (state.solBalance < 0.05) msg += `\n⚠️ *SOL is low!* Top up soon.`;
  ctx.reply(msg, { parse_mode: "Markdown", ...backKeyboard() });
}

async function cmdPrices(ctx: Context): Promise<void> {
  if (!callbacks) return;
  const state = callbacks.getState();
  let msg = `*Current Market Caps*\n\n`;
  for (const [, ts] of state.tokens) {
    const ago = ts.lastUpdated ? `${Math.round((Date.now() - ts.lastUpdated) / 1000)}s ago` : "unknown";
    const mc = ts.currentMarketCap != null ? fmtMc(ts.currentMarketCap) : "unavailable";
    const px = ts.currentPrice != null
      ? `$${ts.currentPrice < 1 ? ts.currentPrice.toFixed(6) : ts.currentPrice.toFixed(4)}`
      : "—";
    msg += `• *${ts.symbol}*\n  Mcap: \`${mc}\`  Price: \`${px}\`  _(${ago})_\n\n`;
  }
  ctx.reply(msg, { parse_mode: "Markdown", ...backKeyboard() });
}

async function cmdTokens(ctx: Context): Promise<void> {
  if (!callbacks) return;
  const tokens = callbacks.getTokenList();
  if (tokens.length === 0) {
    ctx.reply("No tokens added yet. Tap *Add Token* to get started.", {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("➕ Add Token", "cmd:addtoken")],
        [Markup.button.callback("« Back", "cmd:home")],
      ]),
    });
    return;
  }
  let msg = `*Watched Tokens*\n\n`;
  for (const t of tokens) {
    const tc = callbacks.getConfig(t.mint);
    if (tc) {
      msg += `• *${t.symbol}*\n`;
      msg += `  Avg buy mcap: \`${tc.buyMcap != null ? fmtMc(tc.buyMcap) : "not set"}\`\n`;
      msg += `  Spacing: \`${fmtMc(tc.levelSpacingUsd)}\`  Threshold: \`${tc.touchThreshold} touches\`\n`;
      msg += `  Hysteresis: \`±${tc.hysteresisPct}%\`  Time-gate: \`${tc.minSecsBetweenTouches}s\`\n`;
      msg += `  \`${t.mint}\`\n\n`;
    }
  }
  ctx.reply(msg, { parse_mode: "Markdown", ...backKeyboard() });
}

async function cmdLevels(ctx: Context): Promise<void> {
  if (!callbacks) return;
  const state = callbacks.getState();
  let msg = `*Most-Touched Lines*\n\n`;
  let any = false;

  for (const [, ts] of state.tokens) {
    const hot = getHottestLevels(ts, 5);
    if (hot.length === 0) continue;
    any = true;
    const tc = callbacks.getConfig(ts.mint);
    const threshold = tc?.touchThreshold ?? "?";
    const mcStr = ts.currentMarketCap != null ? fmtMc(ts.currentMarketCap) : "?";
    msg += `*${ts.symbol}* — now: \`${mcStr}\`\n`;
    for (const l of hot) {
      const bar = progBar(l.touchCount, typeof threshold === "number" ? threshold : 4);
      const ago = l.lastTouchTime
        ? `${Math.round((Date.now() - l.lastTouchTime) / 1000)}s ago`
        : "never";
      msg += `  \`${fmtMc(l.value)}\`  ${bar} ${l.touchCount}/${threshold}  _(last: ${ago})_\n`;
    }
    msg += "\n";
  }

  if (!any) msg += "No touches recorded yet — the grid builds on the first price reading.";
  ctx.reply(msg, { parse_mode: "Markdown", ...backKeyboard() });
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

// ─── Wizard: Add Token ────────────────────────────────────────────────────────

function startAddToken(ctx: Context): void {
  wizardState.set(ctx.chat!.id, { flow: "add_token", step: "await_mint" });
  ctx.reply(
    `➕ *Add a Token*\n\n` +
    `Paste the token's *contract address* (mint).\n\n` +
    `_The symbol will be pulled automatically from DexScreener._\n\n/cancel to go back`,
    { parse_mode: "Markdown" }
  );
}

// ─── Wizard: Remove Token ─────────────────────────────────────────────────────

function startRemoveToken(ctx: Context): void {
  if (!callbacks) return;
  const tokens = callbacks.getTokenList();
  if (tokens.length === 0) { ctx.reply("No tokens to remove.", backKeyboard()); return; }
  wizardState.set(ctx.chat!.id, { flow: "remove_token", step: "await_pick" });
  ctx.reply("🗑 *Remove a Token*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      ...tokens.map((t, i) => [Markup.button.callback(t.symbol, `wiz:rm:${i}`)]),
      [Markup.button.callback("« Cancel", "cmd:home")],
    ]),
  });
}

// ─── Wizard: Settings ─────────────────────────────────────────────────────────

function startSettings(ctx: Context): void {
  if (!callbacks) return;
  const tokens = callbacks.getTokenList();
  if (tokens.length === 0) {
    ctx.reply("No tokens added yet.", backKeyboard());
    return;
  }
  wizardState.set(ctx.chat!.id, { flow: "settings", step: "await_token" });
  ctx.reply("⚙️ *Settings* — Which token?", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      ...tokens.map((t, i) => [Markup.button.callback(t.symbol, `wiz:cfg_token:${i}`)]),
      [Markup.button.callback("« Cancel", "cmd:home")],
    ]),
  });
}

// ─── Wizard Button Handler ────────────────────────────────────────────────────

async function handleWizardButton(ctx: Context, wizard: WizardStep, payload: string): Promise<void> {
  const chatId = ctx.chat!.id;

  // Remove token — pick
  if (payload.startsWith("rm:") && wizard.flow === "remove_token") {
    const idx = parseInt(payload.split(":")[1], 10);
    const { mint, symbol } = callbacks!.getTokenList()[idx];
    wizardState.set(chatId, { flow: "remove_token", step: "await_pick", pendingMint: mint, pendingSymbol: symbol } as any);
    ctx.reply(`⚠️ Remove *${symbol}* and stop watching it?`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Yes", "wiz:rm_confirm")],
        [Markup.button.callback("❌ Cancel", "cmd:home")],
      ]),
    });
    return;
  }

  if (payload === "reset_atl") {
    if (wizard?.flow === "settings" && (wizard.step === "await_field" || wizard.step === "await_value")) {
      const result = callbacks!.resetAtl((wizard as any).mint);
      ctx.reply(result, { parse_mode: "Markdown", ...backKeyboard() });
    }
    return;
  }

  if (payload === "rm_confirm") {
    const w = wizard as any;
    wizardState.delete(chatId);
    ctx.reply(callbacks!.removeToken(w.pendingMint), { parse_mode: "Markdown", ...backKeyboard() });
    return;
  }

  // Settings — token picked
  if (payload.startsWith("cfg_token:") && wizard.flow === "settings") {
    const idx = parseInt(payload.split(":")[1], 10);
    const { mint, symbol } = callbacks!.getTokenList()[idx];
    const tc = callbacks!.getConfig(mint)!;
    wizardState.set(chatId, { flow: "settings", step: "await_field", mint, symbol });
    ctx.reply(
      `⚙️ *Settings for ${symbol}*\n\n` +
      `Current values:\n` +
      `• Avg buy mcap: \`${tc.buyMcap != null ? fmtMc(tc.buyMcap) : "not set"}\`\n` +
      `• Level spacing: \`${fmtMc(tc.levelSpacingUsd)}\`\n` +
      `• Touch threshold: \`${tc.touchThreshold}\`\n` +
      `• Hysteresis: \`${tc.hysteresisUsd != null ? "$" + fmtMc(tc.hysteresisUsd) : "±" + tc.hysteresisPct + "%"}\`\n` +
      `• Time-gate: \`${tc.minSecsBetweenTouches}s\`\n` +
      `• Invalidation: \`+${tc.invalidationPct}%\`\n` +
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
        ...Markup.inlineKeyboard([
          [Markup.button.callback("💵 Avg Buy Mcap",      "wiz:field:buyMcap")],
          [Markup.button.callback("📏 Level Spacing",    "wiz:field:levelSpacingUsd")],
          [Markup.button.callback("👆 Touch Threshold",  "wiz:field:touchThreshold")],
          [Markup.button.callback("↔️ Hysteresis %",     "wiz:field:hysteresisPct")],
          [Markup.button.callback("↔️ Hysteresis $",     "wiz:field:hysteresisUsd")],
          [Markup.button.callback("⏱ Time-gate (secs)", "wiz:field:minSecsBetweenTouches")],
          [Markup.button.callback("🚫 Invalidation %",   "wiz:field:invalidationPct")],
          [Markup.button.callback("💰 Min Profit %",     "wiz:field:minProfitPct")],
          [Markup.button.callback("📤 Sell Amount %",    "wiz:field:sellPct")],
          [Markup.button.callback(tc.priceTracking ? "📡 Price Tracking: ON  (tap to disable)" : "📡 Price Tracking: OFF  (tap to enable)", "wiz:field:priceTracking")],
          ...(tc.priceTracking ? [
            [Markup.button.callback("🔻 ATL Alert Spacing", "wiz:field:atlAlertSpacingUsd")],
            [Markup.button.callback("🚀 Upside Alert %",    "wiz:field:upsideAlertPct")],
            [Markup.button.callback("🔄 Reset ATL",         "wiz:reset_atl")],
          ] : []),
          [Markup.button.callback("« Cancel",            "cmd:home")],
        ]),
      }
    );
    return;
  }

  // Settings — field picked
  if (payload.startsWith("field:") && wizard.flow === "settings" && wizard.step === "await_field") {
    const rawField = payload.split(":")[1];

    // priceTracking is a boolean toggle — handle immediately without text input
    if (rawField === "priceTracking") {
      const tc = callbacks!.getConfig(wizard.mint)!;
      const newVal = !tc.priceTracking;
      callbacks!.updateSettings(wizard.mint, { priceTracking: newVal });
      wizardState.delete(chatId);
      ctx.reply(
        `📡 Price tracking *${newVal ? "enabled" : "disabled"}* for *${wizard.symbol}*.\n\n` +
        (newVal ? `ATL alerts fire every \`${fmtMc(tc.atlAlertSpacingUsd)}\` drop.\nUpside alerts fire every \`+${tc.upsideAlertPct}%\` gain.\n\nAdjust via ⚙️ Settings.` : ""),
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([[Markup.button.callback("« Back to menu", "cmd:home")]]),
        }
      );
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
    };

    ctx.reply(prompts[field], { parse_mode: "Markdown" });
    return;
  }
}

// ─── Wizard Free-text Handler ─────────────────────────────────────────────────

async function handleWizardInput(ctx: Context, wizard: WizardStep): Promise<void> {
  const chatId = ctx.chat!.id;
  const text = ((ctx.message as any)?.text ?? "").trim();

  // ── ADD TOKEN ─────────────────────────────────────────────────────────────
  if (wizard.flow === "add_token") {
    if (wizard.step === "await_mint") {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
        ctx.reply("❌ Doesn't look like a valid Solana address. Try again or /cancel.");
        return;
      }

      ctx.reply("🔍 Looking up token on DexScreener...");

      try {
        const { symbol, marketCap } = await fetchTokenInfo(text);
        wizardState.set(chatId, { flow: "add_token", step: "await_avg_price", mint: text, symbol, marketCap });
        ctx.reply(
          `✅ Found *${symbol}*\n\n` +
          `Current mcap: *${fmtMarketCap(marketCap)}*\n\n` +
          `What was your *average buy mcap*? _(e.g. \`25k\`, \`1.5m\`, \`45m\`)_\n\n/cancel to go back`,
          { parse_mode: "Markdown" }
        );
      } catch (err) {
        ctx.reply(
          `❌ Couldn't find that token on DexScreener.\n\n` +
          `Make sure it has graduated and has an active pair, then try again.\n\n/cancel to go back`
        );
        wizardState.set(chatId, { flow: "add_token", step: "await_mint" });
      }
      return;
    }

    if (wizard.step === "await_avg_price") {
      const { mint, symbol } = wizard;
      const avgBuyMcap = parseMcap(text);

      if (avgBuyMcap === null || avgBuyMcap <= 0) {
        ctx.reply("❌ Invalid value. Examples: `25k`, `1.5m`, `45000000`.\n\n/cancel to go back", { parse_mode: "Markdown" });
        return;
      }

      wizardState.delete(chatId);
      const result = await callbacks!.addToken(mint, symbol, avgBuyMcap);
      ctx.reply(
        result + `\n\nGrid floor set at avg buy mcap: *${fmtMarketCap(avgBuyMcap)}*\n\nUse ⚙️ Settings to adjust parameters.`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("⚙️ Configure settings", "cmd:settings")],
            [Markup.button.callback("« Back to menu",        "cmd:home")],
          ]),
        }
      );
      return;
    }
  }

  // ── SETTINGS ──────────────────────────────────────────────────────────────
  if (wizard.flow === "settings" && wizard.step === "await_value") {
    const { mint, symbol, field } = wizard;
    let value: number | null = null;

    if (field === "levelSpacingUsd" || field === "hysteresisUsd" || field === "atlAlertSpacingUsd" || field === "buyMcap") {
      value = parseMcap(text);
      if (value === null || value < 0) {
        ctx.reply("❌ Invalid amount. Examples: `500k`, `1m`, `2500000`, or `0` to clear", { parse_mode: "Markdown" });
        return;
      }
      // 0 means "clear" for nullable fields
      if ((field === "hysteresisUsd" || field === "buyMcap") && value === 0) value = null as any;
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

    wizardState.delete(chatId);
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
    };

    ctx.reply(
      `${result}\n\n*${fieldNames[field]}* set to \`${field === "levelSpacingUsd" ? fmtMc(value!) : value ?? "cleared"}\`\n\nThe grid will rebuild on the next price tick.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⚙️ Change another setting", "cmd:settings")],
          [Markup.button.callback("« Back to menu",            "cmd:home")],
        ]),
      }
    );
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
  symbol: string, touchCount: number, touchThreshold: number,
  currentMcap: number, levelMcap: number
): Promise<void> {
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
  symbol: string, amount: number, levelMcap: number,
  touchCount: number, currentMcap: number, sellPct: number = 100
): Promise<void> {
  await safeSend(
    `🔴 *SELL TRIGGERED — ${symbol}*\n\n` +
    `Consolidation detected on line \`${fmtMc(levelMcap)}\`\n` +
    `Touches: \`${touchCount}\`  |  Mcap: \`${fmtMc(currentMcap)}\`\n` +
    `Amount: \`${amount.toLocaleString()} ${symbol}\` _(${sellPct}% of balance)_\n\n` +
    `⏳ Executing swap on Jupiter...`
  );
}

export async function notifyTradeResult(trade: TradeRecord): Promise<void> {
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

export async function notifyAtlAlert(symbol: string, mcap: number, spacingUsd: number): Promise<void> {
  await safeSend(
    `🔻 *New All-Time Low — ${symbol}*\n\n` +
    `Mcap: \`${fmtMc(mcap)}\`\n` +
    `_(alert fires every \`${fmtMc(spacingUsd)}\` drop)_`
  );
}

export async function notifyUpsideAlert(symbol: string, mcap: number, pct: number): Promise<void> {
  await safeSend(
    `🚀 *+${pct}% Move — ${symbol}*\n\n` +
    `Mcap: \`${fmtMc(mcap)}\`\n` +
    `_(alert fires every \`+${pct}%\` gain from last alert)_`
  );
}

export async function notifyInvalidation(
  symbol: string, levelMcap: number, currentMcap: number, invalidationPct: number
): Promise<void> {
  await safeSend(
    `🚫 *Level Invalidated — ${symbol}*\n\n` +
    `Line \`${fmtMc(levelMcap)}\` reset — mcap pumped >${invalidationPct}% above it\n` +
    `Mcap now: \`${fmtMc(currentMcap)}\`\n` +
    `_Touch count cleared. Line will re-arm if price returns._`
  );
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

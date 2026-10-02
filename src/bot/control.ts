import http from "http";
import { TelegramCallbacks } from "./telegram";
import { TokenConfig } from "./types";
import { fetchTokenInfo } from "./price";
import { getHottestLevels, rangeBand } from "./consolidation";
import { toUiAmount } from "./wallet";
import { logger } from "./logger";

// ─── Local control API ────────────────────────────────────────────────────────
// JSON over HTTP, bound to 127.0.0.1 only, for Hermes (the agent on the same box).
// POST / with {"action": ..., ...}. Same operations as the Telegram menu, minus
// Test Sell: the agent never fires a trade directly.

const NUMERIC_SETTINGS = new Set([
  "levelSpacingUsd", "touchThreshold", "hysteresisPct", "hysteresisUsd", "minSecsBetweenTouches",
  "invalidationPct", "sellPct", "minProfitPct", "atlAlertSpacingUsd", "upsideAlertPct", "buyMcap",
  "rangePct", "rangeSizeUsd", "rangeDurationSecs",
]);
const NULLABLE_SETTINGS = new Set(["hysteresisUsd", "minProfitPct", "buyMcap"]);
const BOOLEAN_SETTINGS  = new Set(["priceTracking", "rangeMode"]);

export function initControl(cb: TelegramCallbacks): void {
  const port = parseInt(process.env.CONTROL_PORT || "4010", 10);
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let code = 200;
      let out: unknown;
      try {
        out = await handle(cb, JSON.parse(body || "{}"));
      } catch (err) {
        code = 400;
        out = { error: err instanceof Error ? err.message : String(err) };
      }
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    });
  });
  server.listen(port, "127.0.0.1", () => logger.info(`Control API listening on 127.0.0.1:${port}`));
}

// Accepts a token id, a symbol (case-insensitive) or a mint.
function resolveToken(cb: TelegramCallbacks, ref: unknown): { id: number; mint: string; symbol: string } {
  if (ref === undefined || ref === null || ref === "") throw new Error("token is required (id, symbol or mint)");
  const s = String(ref).trim();
  const list = cb.getTokenList();
  const found =
    list.find((t) => t.mint === s) ??
    (/^\d+$/.test(s) ? list.find((t) => t.id === parseInt(s, 10)) : undefined) ??
    list.find((t) => t.symbol.toUpperCase() === s.toUpperCase());
  if (!found) throw new Error(`No tracked token matches "${s}"`);
  return found;
}

async function handle(cb: TelegramCallbacks, req: Record<string, unknown>): Promise<unknown> {
  switch (req.action) {
    case "status":       return status(cb);
    case "trades":       return { trades: cb.getTradeHistory().slice(-(Number(req.limit) || 10)).reverse() };
    case "get":          return cb.getConfig(resolveToken(cb, req.token).mint);

    case "add": {
      const mint = String(req.mint ?? "").trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error("mint must be a Solana address");
      const existing = cb.getTokenList().find((t) => t.mint === mint);
      if (existing) return { message: `${existing.symbol} is already being tracked.`, symbol: existing.symbol };
      const { symbol, marketCap } = await fetchTokenInfo(mint);
      const buyMcap = req.buyMcap != null ? Number(req.buyMcap) : marketCap;
      const message = await cb.addToken(mint, symbol, buyMcap);
      return { message, symbol, marketCap, buyMcap };
    }

    case "remove":       return { message: cb.removeToken(resolveToken(cb, req.token).mint) };
    case "reset_atl":    return { message: cb.resetAtl(resolveToken(cb, req.token).mint) };

    case "settings": {
      const { mint } = resolveToken(cb, req.token);
      const input = (req.settings ?? {}) as Record<string, unknown>;
      const settings: Partial<TokenConfig> = {};
      for (const [k, v] of Object.entries(input)) {
        if (NUMERIC_SETTINGS.has(k)) {
          if (v === null && NULLABLE_SETTINGS.has(k)) { (settings as any)[k] = null; continue; }
          const n = Number(v);
          if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
          (settings as any)[k] = n;
        } else if (BOOLEAN_SETTINGS.has(k)) {
          (settings as any)[k] = Boolean(v);
        } else if (k === "notes") {
          settings.notes = String(v);
        } else {
          throw new Error(`Unknown setting "${k}"`);
        }
      }
      if (Object.keys(settings).length === 0) throw new Error("settings is empty");
      return { message: cb.updateSettings(mint, settings), config: cb.getConfig(mint) };
    }

    case "bond_monitor": {
      if (typeof req.enabled === "boolean") cb.setBondMonitor(req.enabled);
      return { enabled: cb.getBondMonitorEnabled(), pendingBonds: cb.getPendingBonds() };
    }

    case "watch_wallet": {
      if (req.clear === true) await cb.setWatchedWallet(null);
      else if (typeof req.wallet === "string" && req.wallet.trim()) await cb.setWatchedWallet(req.wallet.trim());
      return { watchedWallet: cb.getWatchedWallet(), webhookSlots: cb.getWebhookSlotCount() };
    }

    default:
      throw new Error(`Unknown action "${String(req.action)}". Use status, trades, get, add, remove, settings, reset_atl, bond_monitor or watch_wallet.`);
  }
}

function status(cb: TelegramCallbacks) {
  const state = cb.getState();
  const now = Date.now();
  const tokens = cb.getTokenList()
    .map((t) => {
      const ts = state.tokens.get(t.mint);
      const tc = cb.getConfig(t.mint);
      if (!ts || !tc) return null;
      const band = tc.rangeMode ? rangeBand(tc) : null;
      return {
        id: t.id,
        symbol: ts.symbol,
        mint: t.mint,
        marketCap: ts.currentMarketCap,
        price: ts.currentPrice,
        balance: toUiAmount(ts.balance, ts.decimals),
        lastUpdateSecsAgo: ts.lastUpdated ? Math.round((now - ts.lastUpdated) / 1000) : null,
        stale: ts.lastUpdated === null || now - ts.lastUpdated > 30_000,
        sold: ts.sold,
        buyMcap: tc.buyMcap,
        levelSpacingUsd: tc.levelSpacingUsd,
        touchThreshold: tc.touchThreshold,
        minProfitPct: tc.minProfitPct,
        sellPct: tc.sellPct,
        allTimeLow: ts.allTimeLow,
        levels: getHottestLevels(ts, 3).map((l) => ({
          value: l.value,
          touches: l.touchCount,
          lastTouchSecsAgo: l.lastTouchTime ? Math.round((now - l.lastTouchTime) / 1000) : null,
        })),
        range: band && {
          lo: band.lo, hi: band.hi, center: band.center,
          durationSecs: tc.rangeDurationSecs,
          dwellSecs: ts.rangeDwellStart ? Math.round((now - ts.rangeDwellStart) / 1000) : 0,
        },
      };
    })
    .filter((t) => t !== null)
    .sort((a, b) => (b!.marketCap ?? -1) - (a!.marketCap ?? -1));
  return {
    uptimeSecs: Math.round((now - state.startTime) / 1000),
    solBalance: state.solBalance,
    totalTrades: state.totalTradesExecuted,
    bondMonitor: cb.getBondMonitorEnabled(),
    watchedWallet: cb.getWatchedWallet(),
    tokens,
  };
}

import WebSocket from "ws";
import axios from "axios";
import { logger } from "./logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BondEvent {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  marketCap: number;
  feesSol: number | null;   // total fees paid on bonding curve — null if unavailable
  imageUri?: string;
}

export type BondNotifyFn = (event: BondEvent) => Promise<void>;

// ─── State ────────────────────────────────────────────────────────────────────

let bondNotify: BondNotifyFn | null = null;
let minFeesSol: number = 0.3;
let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let enabled = false;

// ─── Public API ───────────────────────────────────────────────────────────────

export function startBondMonitor(onBond: BondNotifyFn, minFees: number = 0.3): void {
  bondNotify = onBond;
  minFeesSol = minFees;
  enabled = true;
  connect();
}

export function stopBondMonitor(): void {
  enabled = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.removeAllListeners(); ws.close(); ws = null; }
  logger.info("PumpFun bond monitor stopped");
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connect(): void {
  if (!enabled) return;

  ws = new WebSocket("wss://pumpportal.fun/api/data");

  ws.on("open", () => {
    logger.info("PumpFun WebSocket connected — watching for new bonds");
    ws!.send(JSON.stringify({ method: "subscribeMigration" }));
  });

  ws.on("message", async (raw) => {
    try {
      const event = JSON.parse(raw.toString());

      // Log the raw event once so we can see all available fields
      logger.info("PumpFun migration event (raw)", { event });

      if (!event.mint) return;

      // Extract fees — field name varies by API version
      const feesSol: number | null =
        event.totalFeesSol   ??
        event.feesInSol      ??
        event.fees_in_sol    ??
        event.totalFees      ??
        null;

      // Filter by min fees if we have the data
      if (feesSol !== null && feesSol < minFeesSol) {
        logger.info(`PumpFun: skipping ${event.symbol ?? event.mint} — fees ${feesSol} SOL < ${minFeesSol} SOL`);
        return;
      }

      const info = await fetchTokenInfo(event.mint, event, feesSol);
      if (info && bondNotify) await bondNotify(info);
    } catch (err) {
      logger.warn("PumpFun bond event error", { error: String(err) });
    }
  });

  ws.on("close", () => {
    logger.warn("PumpFun WebSocket closed — reconnecting in 5s");
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    logger.error("PumpFun WebSocket error", { error: String(err) });
    ws?.close();
  });
}

function scheduleReconnect(): void {
  if (!enabled || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5_000);
}

// ─── Token info ───────────────────────────────────────────────────────────────

async function fetchTokenInfo(
  mint: string,
  rawEvent: Record<string, any>,
  feesSol: number | null
): Promise<BondEvent | null> {
  // Pull what we can directly from the migration event first
  const fromEvent: Partial<BondEvent> = {
    mint,
    name:      rawEvent.name        ?? undefined,
    symbol:    rawEvent.symbol      ?? undefined,
    marketCap: rawEvent.marketCapSol ?? rawEvent.market_cap ?? 0,
    feesSol,
  };

  // Try to enrich with DexScreener (description + image)
  try {
    const { data } = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 8_000 }
    );
    const pair = data?.pairs?.[0];
    if (pair) {
      return {
        mint,
        name:        fromEvent.name    ?? pair.baseToken?.name   ?? "Unknown",
        symbol:      fromEvent.symbol  ?? pair.baseToken?.symbol ?? "???",
        description: "",   // DexScreener doesn't provide descriptions
        marketCap:   pair.marketCap    ?? fromEvent.marketCap    ?? 0,
        feesSol,
        imageUri:    pair.info?.imageUrl ?? undefined,
      };
    }
  } catch {
    // DexScreener failed — fall through to event-only data
  }

  // Fallback: use only what the migration event provided
  if (!fromEvent.name && !fromEvent.symbol) return null;
  return {
    mint,
    name:        fromEvent.name      ?? "Unknown",
    symbol:      fromEvent.symbol    ?? "???",
    description: "",
    marketCap:   fromEvent.marketCap ?? 0,
    feesSol,
    imageUri:    undefined,
  };
}

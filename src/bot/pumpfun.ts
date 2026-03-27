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
  imageUri?: string;
}

export type BondNotifyFn = (event: BondEvent) => Promise<void>;

// ─── State ────────────────────────────────────────────────────────────────────

let bondNotify: BondNotifyFn | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let enabled = false;

// ─── Public API ───────────────────────────────────────────────────────────────

export function startBondMonitor(onBond: BondNotifyFn): void {
  bondNotify = onBond;
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
      if (!event.mint) return;
      const info = await fetchTokenInfo(event.mint);
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

async function fetchTokenInfo(mint: string): Promise<BondEvent | null> {
  try {
    const { data } = await axios.get(`https://pump.fun/api/coins/${mint}`, {
      timeout: 8_000,
      headers: { "Accept": "application/json" },
    });
    return {
      mint,
      name:        data.name        ?? "Unknown",
      symbol:      data.symbol      ?? "???",
      description: data.description ?? "",
      marketCap:   data.market_cap  ?? 0,
      imageUri:    data.image_uri,
    };
  } catch (err) {
    logger.warn(`PumpFun: failed to fetch info for ${mint}`, { error: String(err) });
    return null;
  }
}

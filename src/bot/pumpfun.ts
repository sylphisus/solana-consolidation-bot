import WebSocket from "ws";
import axios from "axios";
import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "./logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BondEvent {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  marketCap: number;
  feesSol: number | null;
  imageUri?: string;
}

export type BondNotifyFn = (event: BondEvent) => Promise<void>;

// ─── Constants ────────────────────────────────────────────────────────────────

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// ─── State ────────────────────────────────────────────────────────────────────

let bondNotify: BondNotifyFn | null = null;
let minFeesSol: number = 0.3;
let solanaConnection: Connection | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let enabled = false;

// ─── Public API ───────────────────────────────────────────────────────────────

export function startBondMonitor(
  connection: Connection,
  onBond: BondNotifyFn,
  minFees: number = 0.3
): void {
  solanaConnection = connection;
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
      logger.info("PumpFun migration event (raw)", { event });
      if (!event.mint) return;

      const feesSol: number | null =
        event.totalFeesSol ?? event.feesInSol ?? event.fees_in_sol ?? event.totalFees ?? null;

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
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5_000);
}

// ─── Metaplex image fetch ─────────────────────────────────────────────────────

async function getOnChainImage(mint: string): Promise<string | undefined> {
  if (!solanaConnection) return undefined;
  try {
    const mintKey = new PublicKey(mint);
    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintKey.toBuffer()],
      METADATA_PROGRAM_ID
    );

    const accountInfo = await solanaConnection.getAccountInfo(metadataPDA);
    if (!accountInfo) return undefined;

    // Metaplex metadata layout (v1):
    // 1 key + 32 update_authority + 32 mint
    // + 4 name_len + 32 name (padded)
    // + 4 symbol_len + 10 symbol (padded)
    // + 4 uri_len + 200 uri (padded)
    const data = accountInfo.data;
    const uriLenOffset = 1 + 32 + 32 + 4 + 32 + 4 + 10;
    const uriLen = data.readUInt32LE(uriLenOffset);
    const uriStart = uriLenOffset + 4;
    const uri = data.slice(uriStart, uriStart + uriLen)
      .toString("utf-8").replace(/\0/g, "").trim();

    if (!uri) return undefined;

    // Fetch the JSON at the URI to get the image
    const { data: meta } = await axios.get(uri, { timeout: 6_000 });
    return typeof meta?.image === "string" ? meta.image : undefined;
  } catch {
    return undefined;
  }
}

// ─── Token info ───────────────────────────────────────────────────────────────

async function fetchTokenInfo(
  mint: string,
  rawEvent: Record<string, any>,
  feesSol: number | null
): Promise<BondEvent | null> {
  // 1. Try on-chain Metaplex metadata for image (most reliable for new tokens)
  const imageUri = await getOnChainImage(mint);

  // 2. Enrich with DexScreener for mcap (may not be indexed yet — best effort)
  let name: string    = rawEvent.name   ?? "Unknown";
  let symbol: string  = rawEvent.symbol ?? "???";
  let marketCap       = rawEvent.marketCapSol ?? rawEvent.market_cap ?? 0;
  let description     = "";

  try {
    const { data } = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 8_000 }
    );
    const pair = data?.pairs?.[0];
    if (pair) {
      name      = pair.baseToken?.name   ?? name;
      symbol    = pair.baseToken?.symbol ?? symbol;
      marketCap = pair.marketCap         ?? marketCap;
    }
  } catch { /* non-fatal */ }

  if (name === "Unknown" && symbol === "???") return null;

  return { mint, name, symbol, description, marketCap, feesSol, imageUri };
}

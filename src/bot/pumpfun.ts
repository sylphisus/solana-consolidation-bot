import WebSocket from "ws";
import axios from "axios";
import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "./logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BondEvent {
  mint: string;
  name: string;
  symbol: string;
  marketCap: number;
  volumeH1: number;
  ageMins: number;
  imageUri?: string;
}

export type BondNotifyFn = (event: BondEvent) => Promise<void>;

// ─── Constants ────────────────────────────────────────────────────────────────

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** Exponential decay threshold applied to 5-minute volume windows.
 *  Calibrated so cumulative volume hits $100k at 45 min, extrapolates to ~$103k at 60 min.
 *  Asymptote C = 100k / (1 - e^(-λ*45)) ≈ $104,600.
 *  Each poll compares volume.m5 against the expected 5-min slice:
 *    threshold_m5(t) = VOLUME_TARGET * (e^(-λ(t-5)) - e^(-λt))
 *  With a 10-min half-life:
 *    t=5min → ~$30.6k   t=10min → ~$21.7k   t=20min → ~$10.8k   t=45min → ~$1.9k  */
const HALF_LIFE_MINS = 10;
const LAMBDA         = Math.LN2 / HALF_LIFE_MINS;                           // ≈ 0.0693
const VOLUME_AT_45   = 100_000;
const VOLUME_TARGET  = VOLUME_AT_45 / (1 - Math.exp(-LAMBDA * 45));         // ≈ $104,600

/** Stop tracking a token after this many minutes without hitting the line */
const MAX_TRACK_MINS = 60;

/** How often to poll DexScreener for pending bonds */
const POLL_INTERVAL_MS = 2_000;

// ─── State ────────────────────────────────────────────────────────────────────

interface PendingBond {
  bondedAt: number;              // Date.now() at time of migration event
  rawEvent: Record<string, any>; // fallback name/symbol if DexScreener is slow
  lastM5: number | null;         // previous volume.m5 reading; null = not yet polled
  windowStartedAt: number | null;// when we detected a clean m5 window boundary; null = not yet aligned
  h1AtWindowStart: number | null;// volume.h1 snapshot at alignment; delta gives true volume since alignment
}

let bondNotify: BondNotifyFn | null = null;
let minFeesSol: number = 0.3;
let solanaConnection: Connection | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let enabled = false;
const pendingBonds = new Map<string, PendingBond>();

// ─── Public API ───────────────────────────────────────────────────────────────

export function startBondMonitor(
  connection: Connection,
  onBond: BondNotifyFn,
  minFees: number = 0.3,
): void {
  solanaConnection = connection;
  bondNotify = onBond;
  minFeesSol = minFees;
  enabled = true;
  connect();
  startPollLoop();
}

export function getPendingBonds(): { mint: string; bondedAt: number }[] {
  return [...pendingBonds.entries()].map(([mint, b]) => ({ mint, bondedAt: b.bondedAt }));
}

export function stopBondMonitor(): void {
  enabled = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (ws) { ws.removeAllListeners(); ws.close(); ws = null; }
  pendingBonds.clear();
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

  ws.on("message", (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      if (!event.mint) return;

      const feesSol: number | null =
        event.totalFeesSol ?? event.feesInSol ?? event.fees_in_sol ?? event.totalFees ?? null;

      // Only reject tokens with explicitly positive fees below threshold.
      // Zero or missing fees pass through — LetsBonk.fun graduations don't report SOL fees.
      if (feesSol !== null && feesSol > 0 && feesSol < minFeesSol) {
        logger.info(`Bond monitor: skipping ${event.symbol ?? event.mint} — fees ${feesSol} SOL < ${minFeesSol} SOL`);
        return;
      }

      const platform = event.txType ?? event.platform ?? (feesSol === null || feesSol === 0 ? "letsbonk?" : "pumpfun");
      logger.info("Bond monitor: migration queued for volume tracking", { mint: event.mint, platform });
      pendingBonds.set(event.mint, { bondedAt: Date.now(), rawEvent: event, lastM5: null, windowStartedAt: null, h1AtWindowStart: null });
    } catch (err) {
      logger.warn("PumpFun bond event parse error", { error: String(err) });
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

// ─── Volume poll loop ─────────────────────────────────────────────────────────

function startPollLoop(): void {
  if (pollTimer) return;
  pollTimer = setInterval(pollPendingBonds, POLL_INTERVAL_MS);
}

async function pollPendingBonds(): Promise<void> {
  if (pendingBonds.size === 0) return;

  const now = Date.now();

  // Prune tokens that have aged out without hitting the threshold
  for (const [mint, bond] of pendingBonds) {
    if ((now - bond.bondedAt) / 60_000 > MAX_TRACK_MINS) {
      logger.info(`PumpFun: dropped ${mint.slice(0, 8)}… — no volume threshold hit in ${MAX_TRACK_MINS} min`);
      pendingBonds.delete(mint);
    }
  }

  if (pendingBonds.size === 0) return;

  const mints = [...pendingBonds.keys()];

  try {
    const { data } = await axios.get(
      `https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`,
      { timeout: 8_000 }
    );

    // Take the first (highest-liquidity) pair per mint
    const seen = new Set<string>();

    const pairs: any[] = Array.isArray(data) ? data : (data?.pairs ?? []);
    for (const pair of pairs) {
      const mint: string = pair.baseToken?.address;
      if (!mint || !pendingBonds.has(mint) || seen.has(mint)) continue;
      seen.add(mint);

      const bond = pendingBonds.get(mint)!;
      const volumeM5: number = pair.volume?.m5 ?? 0;
      const volumeH1: number = pair.volume?.h1 ?? 0;

      // Align to a DexScreener m5 window boundary before evaluating.
      // Start clock when m5 is 0 on first poll, or drops vs previous reading.
      if (bond.windowStartedAt === null) {
        const windowBoundary = volumeM5 === 0 || (bond.lastM5 !== null && volumeM5 < bond.lastM5);
        bond.lastM5 = volumeM5;
        if (windowBoundary) {
          bond.windowStartedAt = now;
          bond.h1AtWindowStart = volumeH1;
          logger.info("PumpFun m5 window aligned", {
            symbol: pair.baseToken?.symbol ?? mint.slice(0, 8),
            reason: volumeM5 === 0 ? "m5=0" : "m5 drop",
            h1AtWindowStart: volumeH1,
          });
        }
        continue; // don't evaluate on the alignment poll itself
      }

      const ageMins       = (now - bond.windowStartedAt) / 60_000;
      const volumeSinceAlignment = Math.max(0, volumeH1 - bond.h1AtWindowStart!);
      const thresholdM5   = VOLUME_TARGET * (Math.exp(-LAMBDA * (ageMins - 5)) - Math.exp(-LAMBDA * ageMins));
      const thresholdH1   = VOLUME_TARGET * (1 - Math.exp(-LAMBDA * ageMins));

      logger.info("PumpFun volume check", {
        symbol:    pair.baseToken?.symbol ?? mint.slice(0, 8),
        ageMins:   ageMins.toFixed(1),
        volumeM5,          thresholdM5: thresholdM5.toFixed(0),
        volumeSinceAlignment, thresholdH1: thresholdH1.toFixed(0),
      });

      if (volumeM5 >= thresholdM5 && volumeSinceAlignment >= thresholdH1) {
        pendingBonds.delete(mint);

        const imageUri = await getOnChainImage(mint);
        const event: BondEvent = {
          mint,
          name:      pair.baseToken?.name   ?? bond.rawEvent.name   ?? "Unknown",
          symbol:    pair.baseToken?.symbol ?? bond.rawEvent.symbol ?? "???",
          marketCap: pair.marketCap         ?? 0,
          volumeH1,
          ageMins,
          imageUri,
        };

        if (bondNotify) await bondNotify(event);
      }
    }
  } catch (err) {
    logger.warn("PumpFun volume poll error", { error: String(err) });
  }
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

    const { data: meta } = await axios.get(uri, { timeout: 6_000 });
    return typeof meta?.image === "string" ? meta.image : undefined;
  } catch {
    return undefined;
  }
}

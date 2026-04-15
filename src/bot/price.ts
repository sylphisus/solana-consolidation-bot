import axios from "axios";
import { MarketCapUpdate } from "./types";
import { logger } from "./logger";
import { fmtMc } from "./consolidation";

export const SOL_MINT  = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ─── DexScreener API ──────────────────────────────────────────────────────────
// Batch endpoint: up to 30 comma-separated mints in one request.
// This keeps us well under the 60 req/min rate limit regardless of token count.

const DEXSCREENER_BASE = "https://api.dexscreener.com/tokens/v1/solana";

export async function fetchTokenInfo(
  mint: string
): Promise<{ symbol: string; marketCap: number; price: number }> {
  const res = await axios.get(`${DEXSCREENER_BASE}/${mint}`, { timeout: 8_000 });
  const pairs: any[] = Array.isArray(res.data) ? res.data : (res.data?.pairs ?? []);
  if (!pairs.length) throw new Error(`Token not found on DexScreener`);

  const best = pairs
    .filter((p: any) => p.chainId === "solana")
    .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

  if (!best) throw new Error(`No Solana pairs found`);

  return {
    symbol:    best.baseToken?.symbol ?? "UNKNOWN",
    marketCap: Number(best.marketCap ?? best.fdv ?? 0),
    price:     parseFloat(best.priceUsd ?? "0"),
  };
}

// ─── Batch poller ─────────────────────────────────────────────────────────────
// One shared timer fetches ALL watched tokens in a single DexScreener call.
// Each token still gets its own callback — the batching is transparent.

type McapCallback = (update: MarketCapUpdate) => void;

interface TokenEntry {
  symbol:   string;
  callback: McapCallback;
  stopped:  boolean;
}

const watchedTokens = new Map<string, TokenEntry>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let batchIntervalMs = 1_000;

const DEXSCREENER_BATCH_SIZE = 30;

async function runBatch(): Promise<void> {
  const mints = [...watchedTokens.keys()].filter(m => !watchedTokens.get(m)!.stopped);
  if (mints.length === 0) { scheduleBatch(); return; }

  try {
    // Chunk into groups of 30 (DexScreener batch limit) and fetch in parallel
    const chunks: string[][] = [];
    for (let i = 0; i < mints.length; i += DEXSCREENER_BATCH_SIZE) {
      chunks.push(mints.slice(i, i + DEXSCREENER_BATCH_SIZE));
    }

    const responses = await Promise.all(
      chunks.map(chunk =>
        axios.get(`${DEXSCREENER_BASE}/${chunk.join(",")}`, { timeout: 10_000 })
      )
    );

    const allPairs: any[] = responses.flatMap(res =>
      Array.isArray(res.data) ? res.data : (res.data?.pairs ?? [])
    );

    // Build a map of mint → best pair
    const bestPair = new Map<string, any>();
    for (const pair of allPairs) {
      if (pair.chainId !== "solana") continue;
      const addr = pair.baseToken?.address;
      if (!addr) continue;
      const existing = bestPair.get(addr);
      if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
        bestPair.set(addr, pair);
      }
    }

    const now = Date.now();
    for (const mint of mints) {
      const entry = watchedTokens.get(mint);
      if (!entry || entry.stopped) continue;
      const pair = bestPair.get(mint);
      if (!pair) { logger.warn(`[${entry.symbol}] Not found in batch response`); continue; }

      const marketCap = Number(pair.marketCap ?? pair.fdv ?? 0);
      const price     = parseFloat(pair.priceUsd ?? "0");
      if (!marketCap || isNaN(price)) continue;

      entry.callback({ mint, marketCap, price, timestamp: now });
      logger.debug(`[${entry.symbol}] mcap: ${fmtMc(marketCap)} price: $${price}`);
    }
  } catch (err) {
    logger.warn("Batch DexScreener fetch failed", { error: String(err) });
  }

  scheduleBatch();
}

function scheduleBatch(): void {
  if (batchTimer) return;
  batchTimer = setTimeout(() => { batchTimer = null; runBatch(); }, batchIntervalMs);
}

// ─── Public Interface ─────────────────────────────────────────────────────────

export function startPriceFeed(
  mint: string,
  symbol: string,
  intervalMs: number,
  onPrice: McapCallback
): void {
  if (watchedTokens.has(mint)) return;

  batchIntervalMs = intervalMs;
  watchedTokens.set(mint, { symbol, callback: onPrice, stopped: false });
  logger.info(`[${symbol}] Added to batch poller`);

  // Kick off the batch loop if it isn't running yet
  if (!batchTimer) runBatch();
}

export function stopPriceFeed(mint: string): void {
  const entry = watchedTokens.get(mint);
  if (!entry) return;
  entry.stopped = true;
  watchedTokens.delete(mint);
  logger.info(`[${entry.symbol}] Removed from batch poller`);
}

export function stopAllFeeds(): void {
  for (const mint of [...watchedTokens.keys()]) stopPriceFeed(mint);
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
}


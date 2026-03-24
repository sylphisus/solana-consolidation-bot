import axios from "axios";
import { MarketCapUpdate } from "./types";
import { logger } from "./logger";

export const SOL_MINT  = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ─── DexScreener API ──────────────────────────────────────────────────────────
// No API key required. Returns price and market cap for any Solana token.
// Endpoint: https://api.dexscreener.com/tokens/v1/solana/<mint>
// Returns an array of pairs — we use the one with the highest liquidity.

const DEXSCREENER_BASE = "https://api.dexscreener.com/tokens/v1/solana";

export async function fetchTokenInfo(
  mint: string
): Promise<{ symbol: string; marketCap: number; price: number }> {
  const res = await axios.get(`${DEXSCREENER_BASE}/${mint}`, { timeout: 8_000 });
  const pairs: any[] = res.data?.pairs ?? res.data ?? [];
  if (!pairs.length) throw new Error(`Token not found on DexScreener`);

  const best = pairs
    .filter((p: any) => p.chainId === "solana")
    .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

  if (!best) throw new Error(`No Solana pairs found`);

  const symbol    = best.baseToken?.symbol ?? "UNKNOWN";
  const marketCap = Number(best.marketCap ?? best.fdv ?? 0);
  const price     = parseFloat(best.priceUsd ?? "0");

  return { symbol, marketCap, price };
}

async function fetchDexScreener(mint: string): Promise<{ marketCap: number; price: number }> {
  const res = await axios.get(`${DEXSCREENER_BASE}/${mint}`, { timeout: 8_000 });

  const pairs: any[] = res.data?.pairs ?? res.data ?? [];
  if (!pairs.length) throw new Error(`No pairs found for ${mint.slice(0, 8)}`);

  // Pick the pair with the highest liquidity in USD
  const best = pairs
    .filter((p: any) => p.chainId === "solana" && p.marketCap > 0)
    .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

  if (!best) throw new Error(`No valid Solana pair for ${mint.slice(0, 8)}`);

  const marketCap = best.marketCap ?? best.fdv;
  const price     = parseFloat(best.priceUsd);

  if (!marketCap || isNaN(price)) throw new Error(`Missing marketCap/price for ${mint.slice(0, 8)}`);

  return { marketCap: Number(marketCap), price };
}

// ─── Active Poll Loops ────────────────────────────────────────────────────────

type McapCallback = (update: MarketCapUpdate) => void;

interface PollFeed {
  mint: string;
  symbol: string;
  intervalMs: number;
  callback: McapCallback;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

const activeFeeds = new Map<string, PollFeed>();

async function runPoll(feed: PollFeed): Promise<void> {
  if (feed.stopped) return;

  const start = Date.now();
  try {
    const { marketCap, price } = await fetchDexScreener(feed.mint);
    feed.callback({ mint: feed.mint, marketCap, price, timestamp: Date.now() });
    logger.debug(`[${feed.symbol}] mcap: ${fmtMarketCap(marketCap)} price: $${price}`);
  } catch (err) {
    logger.warn(`[${feed.symbol}] DexScreener fetch failed`, { error: String(err) });
  }

  if (feed.stopped) return;

  // Sleep for remainder of interval (accounting for request time)
  const elapsed = Date.now() - start;
  const delay = Math.max(0, feed.intervalMs - elapsed);
  feed.timer = setTimeout(() => runPoll(feed), delay);
}

// ─── Public Interface ─────────────────────────────────────────────────────────

/**
 * Starts polling DexScreener for a token at the given interval.
 * Calls onPrice on every successful fetch.
 */
export function startPriceFeed(
  mint: string,
  symbol: string,
  intervalMs: number,
  onPrice: McapCallback
): void {
  if (activeFeeds.has(mint)) return;

  const feed: PollFeed = {
    mint, symbol, intervalMs,
    callback: onPrice,
    timer: null,
    stopped: false,
  };

  activeFeeds.set(mint, feed);
  logger.info(`[${symbol}] DexScreener feed started (${intervalMs}ms interval)`);

  // Fire immediately, then on interval
  runPoll(feed);
}

export function stopPriceFeed(mint: string): void {
  const feed = activeFeeds.get(mint);
  if (!feed) return;
  feed.stopped = true;
  if (feed.timer) clearTimeout(feed.timer);
  activeFeeds.delete(mint);
  logger.info(`[${feed.symbol}] Price feed stopped`);
}

export function stopAllFeeds(): void {
  for (const mint of [...activeFeeds.keys()]) stopPriceFeed(mint);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function fmtMarketCap(mc: number): string {
  if (mc >= 1_000_000_000) return `$${(mc / 1_000_000_000).toFixed(2)}B`;
  if (mc >= 1_000_000)     return `$${(mc / 1_000_000).toFixed(2)}M`;
  if (mc >= 1_000)         return `$${(mc / 1_000).toFixed(1)}K`;
  return `$${mc.toFixed(0)}`;
}

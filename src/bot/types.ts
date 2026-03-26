// ─── Config Types ─────────────────────────────────────────────────────────────

export interface TokenConfig {
  mint: string;
  symbol: string;
  // Consolidation detection settings
  levelSpacingUsd: number;       // dollar gap between Y-lines (e.g. 1000000 = $1M)
  touchThreshold: number;        // touches on any single line to trigger a sell
  hysteresisPct: number;         // % mcap must move away from a line before re-arming (e.g. 1)
  hysteresisUsd: number | null;  // flat $ alternative to hysteresisPct — if set, takes priority
  minSecsBetweenTouches: number; // time-gate: minimum seconds between touches on the same line
  invalidationPct: number;       // if mcap moves this % above a line, reset that line's touch count
  buyMcap: number | null;        // market cap at time of purchase — grid floor
  sellPct: number;               // % of balance to sell when consolidation triggers (default 100)
  minProfitPct: number | null;   // minimum % above buyMcap required before a sell fires (null = disabled)
  priceTracking: boolean;        // if true, sends ATL and upside alerts via Telegram
  atlAlertSpacingUsd: number;    // fire an ATL alert each time ATL drops by this much (default $10k)
  upsideAlertPct: number;        // fire an upside alert each time mcap rises this % from last alert (default 30)
  notes?: string;
}

export interface GlobalConfig {
  minSolBalance: number;
}

export interface BotConfig {
  tokens: TokenConfig[];
  global: GlobalConfig;
}

// ─── Runtime State Types ───────────────────────────────────────────────────────

/**
 * One horizontal Y-line in the dynamic grid.
 * Lines are anchored on the first observed market cap and spaced by levelSpacingUsd.
 */
export interface YLevel {
  value: number;           // the market cap this line sits at (USD)
  touchCount: number;
  lastTouchTime: number | null;   // unix ms of last accepted touch
  eligibleForTouch: boolean;      // false after a touch; re-arms when mcap exits hysteresis band
}

export interface TokenState {
  mint: string;
  symbol: string;
  decimals: number;                // fetched from chain automatically
  currentMarketCap: number | null;
  currentPrice: number | null;
  lastUpdated: number | null;
  yLevels: YLevel[];               // dynamic grid — empty until first mcap reading
  anchorMcap: number | null;       // the mcap we used to build the grid
  buyMcap: number | null;          // grid floor — no lines generated below this
  sold: boolean;                   // true once a sell fires — bot stops watching
  allTimeLow: number | null;       // lowest mcap seen since tracking started
  lastAtlAlertMcap: number | null; // mcap at the time of the last ATL alert
  lastUpsideAlertMcap: number | null; // mcap baseline for the next upside alert
  balance: bigint;
  lastBalanceCheck: number | null;
}

export interface BotState {
  tokens: Map<string, TokenState>;
  solBalance: number;
  startTime: number;
  totalTradesExecuted: number;
}

// ─── Market Cap Feed ──────────────────────────────────────────────────────────

export interface MarketCapUpdate {
  mint: string;
  marketCap: number;
  price: number;
  timestamp: number;
}

// ─── Trade Types ──────────────────────────────────────────────────────────────

export type TradeStatus = "pending" | "success" | "failed";

export interface TradeRecord {
  id: string;
  mint: string;
  symbol: string;
  triggerMarketCap: number;
  triggerLevel: number;      // the Y-line value that hit threshold
  touchCount: number;
  amountRaw: bigint;
  amountUi: number;
  txSignature: string | null;
  status: TradeStatus;
  timestamp: number;
  error?: string;
}

// ─── Jupiter API ──────────────────────────────────────────────────────────────

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
}

export interface JupiterSwapResponse {
  swapTransaction: string;
}

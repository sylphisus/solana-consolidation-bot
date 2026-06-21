import { TokenConfig, TokenState, YLevel } from "./types";
import { logger } from "./logger";

/**
 * Consolidation Detection — Interpolated Crossing Model
 * ──────────────────────────────────────────────────────
 *
 * Instead of checking whether the current mcap snapshot lands inside a band,
 * we check whether any Y-line was CROSSED between the previous poll and the
 * current poll. If prevMcap=48M and newMcap=52M, the $50M line was crossed
 * regardless of whether either snapshot was near it.
 *
 * Touch rules:
 *   1. A touch is counted when a Y-line falls between prevMcap and newMcap
 *      (i.e. the price crossed it during this poll interval).
 *   2. After a touch the line becomes ineligible until the mcap has moved
 *      hysteresisPct% away from the line in either direction — i.e. the
 *      hysteresis band must be fully exited before it can touch again.
 *   3. Time-gate: a touch only counts if minSecsBetweenTouches seconds have
 *      passed since the last accepted touch on that line.
 *   4. Invalidation: if mcap rises more than invalidationPct% above a line,
 *      that line's touch count resets to zero.
 *   5. Any line reaching touchThreshold → sell triggered.
 *
 * Example — Line: $50M | Hysteresis: 1% (exit band: $49.5M–$50.5M) | Time-gate: 10s
 *
 *   Poll: prev=$48M → new=$52M   → crossed $50M ✅ Touch #1, line locked
 *   Poll: prev=$52M → new=$51M   → still above exit band ($50.5M), stays locked
 *   Poll: prev=$51M → new=$49M   → crossed $50M AND crossed exit band → re-arms AND touch #2 ✅
 *   Poll: prev=$49M → new=$74M   → crossed exit band, also blows past invalidation ($75M) — not yet
 *   Poll: prev=$74M → new=$76M   → now above $75M (50% above $50M) → INVALIDATED, reset to 0
 */

export interface ConsolidationEvent {
  mint: string;
  symbol: string;
  triggerLevel: number;
  touchCount: number;
  touchThreshold: number;
  currentMarketCap: number;
  isRange?: boolean;   // true when fired by range mode rather than the touch grid
  dwellSecs?: number;  // seconds held in the band (range mode only)
}

const GRID_RADIUS = 50;

// ─── Grid Builder ─────────────────────────────────────────────────────────────

export function buildGrid(anchorMcap: number, spacingUsd: number, floorMcap: number | null = null): YLevel[] {
  const snapped = Math.round(anchorMcap / spacingUsd) * spacingUsd;
  const levels: YLevel[] = [];
  for (let i = -GRID_RADIUS; i <= GRID_RADIUS; i++) {
    const value = snapped + i * spacingUsd;
    if (value <= 0) continue;
    // Skip lines below the buy price — no point watching levels we bought above
    if (floorMcap !== null && value < floorMcap) continue;
    levels.push({ value, touchCount: 0, lastTouchTime: null, eligibleForTouch: true });
  }
  return levels;
}

// ─── Main Processing Function ─────────────────────────────────────────────────

export function processMarketCap(
  state: TokenState,
  config: TokenConfig,
  newMarketCap: number
): ConsolidationEvent | null {

  if (state.sold) return null;

  const prevMarketCap = state.currentMarketCap;
  state.currentMarketCap = newMarketCap;
  state.lastUpdated = Date.now();

  // Range mode replaces the touch-grid detection entirely
  if (config.rangeMode) return processRange(state, config, newMarketCap);

  // First reading — build the grid, nothing to compare against yet
  if (state.yLevels.length === 0 || prevMarketCap === null) {
    if (state.yLevels.length === 0) {
      state.anchorMcap = newMarketCap;
      state.yLevels = buildGrid(newMarketCap, config.levelSpacingUsd, state.buyMcap);
      logger.info(`[${state.symbol}] Grid built`, {
        anchor: fmtMc(newMarketCap),
        spacing: fmtMc(config.levelSpacingUsd),
        floor: state.buyMcap ? fmtMc(state.buyMcap) : "none",
        lines: state.yLevels.length,
        range: state.yLevels.length > 0
          ? `${fmtMc(state.yLevels[0].value)} – ${fmtMc(state.yLevels[state.yLevels.length - 1].value)}`
          : "empty",
      });
    }
    return null;
  }

  const now = Date.now();
  const lo = Math.min(prevMarketCap, newMarketCap);
  const hi = Math.max(prevMarketCap, newMarketCap);
  const movingUp = newMarketCap > prevMarketCap;

  const invalidationAbs = config.invalidationPct / 100;

  for (const level of state.yLevels) {
    const invalidationHi = level.value * (1 + invalidationAbs);

    // Hysteresis: use flat USD if set, otherwise fall back to percent
    const hysteresisAmt = config.hysteresisUsd != null
      ? config.hysteresisUsd
      : level.value * (config.hysteresisPct / 100);
    const exitBandLo = level.value - hysteresisAmt;
    const exitBandHi = level.value + hysteresisAmt;

    // ── Invalidation ──────────────────────────────────────────────────────────
    if (newMarketCap > invalidationHi && level.touchCount > 0) {
      logger.info(
        `[${state.symbol}] Line ${fmtMc(level.value)} INVALIDATED — ` +
        `mcap ${fmtMc(newMarketCap)} is >${config.invalidationPct}% above — resetting ${level.touchCount} touch(es)`,
        { threshold: fmtMc(invalidationHi) }
      );
      level.touchCount       = 0;
      level.lastTouchTime    = null;
      level.eligibleForTouch = true;
      continue;
    }

    // ── Re-arm: mcap has moved outside the hysteresis exit band ───────────────
    if (!level.eligibleForTouch) {
      const exitedBand = newMarketCap < exitBandLo || newMarketCap > exitBandHi;
      if (exitedBand) {
        level.eligibleForTouch = true;
        logger.debug(`[${state.symbol}] Line ${fmtMc(level.value)} re-armed`, {
          mcap: fmtMc(newMarketCap),
        });
      }
    }

    // ── Touch: did the price cross this line between polls? ───────────────────
    // A crossing occurs when the line value sits strictly between prev and new.
    const crossed = level.value > lo && level.value < hi;

    if (crossed && level.eligibleForTouch) {
      const msSinceLast = level.lastTouchTime ? now - level.lastTouchTime : Infinity;
      const minMs = config.minSecsBetweenTouches * 1000;

      if (msSinceLast < minMs) {
        logger.debug(`[${state.symbol}] Line ${fmtMc(level.value)} touch gated`, {
          secsRemaining: ((minMs - msSinceLast) / 1000).toFixed(1),
        });
        // Lock out until price exits the band — prevents counting on next poll
        level.eligibleForTouch = false;
        continue;
      }

      level.eligibleForTouch = false;
      level.touchCount++;
      level.lastTouchTime = now;
      const dir = movingUp ? "↑" : "↓";

      logger.info(
        `[${state.symbol}] Touch #${level.touchCount}/${config.touchThreshold} ` +
        `on line ${fmtMc(level.value)} ${dir}`,
        { prev: fmtMc(prevMarketCap), now: fmtMc(newMarketCap), mint: state.mint }
      );

      if (level.touchCount % config.touchThreshold === 0) {
        logger.info(
          `[${state.symbol}] 🎯 CONSOLIDATION — ${level.touchCount} touches on ` +
          `${fmtMc(level.value)} — sell triggered!`,
          { mcap: fmtMc(newMarketCap) }
        );
        return {
          mint: state.mint,
          symbol: state.symbol,
          triggerLevel: level.value,
          touchCount: level.touchCount,
          touchThreshold: config.touchThreshold,
          currentMarketCap: newMarketCap,
        };
      }
    }
  }

  return null;
}

// ─── Range Mode ───────────────────────────────────────────────────────────────
//
// Sells when the market cap stays inside a fixed band for a continuous duration.
// The band is centred rangePct% above the anchor mcap (captured when range mode
// was enabled) and spans rangeSizeUsd wide (half above, half below the centre).
// If the mcap leaves the band the dwell timer resets to zero.

export function rangeBand(config: TokenConfig): { lo: number; hi: number; center: number } | null {
  if (config.rangeAnchorMcap == null) return null;
  const center = config.rangeAnchorMcap * (1 + config.rangePct / 100);
  const half = config.rangeSizeUsd / 2;
  return { lo: center - half, hi: center + half, center };
}

function processRange(
  state: TokenState,
  config: TokenConfig,
  mcap: number
): ConsolidationEvent | null {
  const band = rangeBand(config);
  if (!band) return null; // anchor not yet captured — index.ts captures + persists it

  const now = Date.now();
  const inBand = mcap >= band.lo && mcap <= band.hi;

  if (!inBand) {
    if (state.rangeDwellStart !== null) {
      logger.info(
        `[${state.symbol}] Range dwell reset — mcap ${fmtMc(mcap)} left band ` +
        `${fmtMc(band.lo)}–${fmtMc(band.hi)}`
      );
      state.rangeDwellStart = null;
    }
    return null;
  }

  if (state.rangeDwellStart === null) {
    state.rangeDwellStart = now;
    logger.info(
      `[${state.symbol}] Range dwell started — mcap ${fmtMc(mcap)} entered band ` +
      `${fmtMc(band.lo)}–${fmtMc(band.hi)} (need ${config.rangeDurationSecs}s)`
    );
    return null;
  }

  const dwellSecs = (now - state.rangeDwellStart) / 1000;
  if (dwellSecs >= config.rangeDurationSecs) {
    logger.info(
      `[${state.symbol}] 🎯 RANGE — held ${dwellSecs.toFixed(0)}s in band ` +
      `${fmtMc(band.lo)}–${fmtMc(band.hi)} — sell triggered!`,
      { mcap: fmtMc(mcap) }
    );
    return {
      mint: state.mint,
      symbol: state.symbol,
      triggerLevel: band.center,
      touchCount: 0,
      touchThreshold: 0,
      currentMarketCap: mcap,
      isRange: true,
      dwellSecs,
    };
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getHottestLevels(state: TokenState, n = 5): YLevel[] {
  return [...state.yLevels]
    .filter((l) => l.touchCount > 0)
    .sort((a, b) => b.touchCount - a.touchCount)
    .slice(0, n);
}

export function fmtMc(mc: number): string {
  if (mc >= 1_000_000_000) return `$${(mc / 1_000_000_000).toFixed(2)}B`;
  if (mc >= 1_000_000)     return `$${(mc / 1_000_000).toFixed(2)}M`;
  if (mc >= 1_000)         return `$${(mc / 1_000).toFixed(1)}K`;
  return `$${mc.toFixed(0)}`;
}

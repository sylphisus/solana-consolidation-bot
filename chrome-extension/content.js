/**
 * Consolidation Bot — Axiom Content Script
 * ─────────────────────────────────────────
 * Runs inside the Axiom tab. Finds the market cap element, watches it for
 * changes via MutationObserver, and streams every update to the bot over a
 * local WebSocket on port 3001.
 *
 * Auto-reconnects if the bot restarts. Silently does nothing if no bot is
 * running — so you can leave Axiom open without the extension complaining.
 */

const BOT_WS_URL = "ws://localhost:3001";

// ─── Market Cap Parser ────────────────────────────────────────────────────────
// Axiom shows mcap as "$1.23M", "$456K", "$1.2B" etc.

function parseMcap(text) {
  if (!text) return null;
  const clean = text.replace(/[$,\s]/g, "").toUpperCase();
  const num = parseFloat(clean);
  if (isNaN(num)) return null;
  if (clean.endsWith("B")) return num * 1_000_000_000;
  if (clean.endsWith("M")) return num * 1_000_000;
  if (clean.endsWith("K")) return num * 1_000;
  // Raw number (unlikely on Axiom but handle it)
  return num > 0 ? num : null;
}

// ─── DOM Finder ───────────────────────────────────────────────────────────────
// Axiom's DOM can change with updates so we use multiple strategies to find
// the market cap element rather than hardcoding a single CSS selector.
// Strategy: scan all text nodes for a value that looks like a market cap
// near the text "Market Cap" or "MC".

function findMcapElement() {
  // Strategy 1: look for an element whose text content is a label containing
  // "market cap" or "mc", then grab its sibling/parent value element
  const allEls = document.querySelectorAll("*");

  for (const el of allEls) {
    // Skip script/style/svg nodes
    if (["SCRIPT","STYLE","SVG","PATH","META","HEAD"].includes(el.tagName)) continue;

    const text = el.innerText?.trim() ?? "";

    // Look for label elements
    if (/^(market\s*cap|mcap|mc)$/i.test(text)) {
      // Try next sibling
      const sibling = el.nextElementSibling;
      if (sibling && parseMcap(sibling.innerText) !== null) return sibling;
      // Try parent's next child
      const parent = el.parentElement;
      if (parent) {
        const children = [...parent.children];
        const idx = children.indexOf(el);
        if (idx !== -1 && children[idx + 1]) {
          const candidate = children[idx + 1];
          if (parseMcap(candidate.innerText) !== null) return candidate;
        }
      }
    }
  }

  // Strategy 2: find any element whose text looks exactly like a mcap value
  // adjacent to a "MC" or "Mkt Cap" label anywhere on the page
  for (const el of allEls) {
    if (["SCRIPT","STYLE","SVG","PATH","META","HEAD"].includes(el.tagName)) continue;
    const text = el.innerText?.trim() ?? "";
    // Matches patterns like "$1.23M", "$456K", "$1.2B"
    if (/^\$\d+(\.\d+)?[KMB]$/.test(text)) {
      // Check if a nearby element has a label
      const nearby = el.closest("[class]");
      if (nearby && /cap|mcap|mc/i.test(nearby.textContent ?? "")) {
        return el;
      }
    }
  }

  return null;
}

// ─── WebSocket Connection ─────────────────────────────────────────────────────

let ws = null;
let wsReady = false;
let reconnectTimer = null;

function connect() {
  clearTimeout(reconnectTimer);
  try {
    ws = new WebSocket(BOT_WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    wsReady = true;
    console.log("[ConsolidationBot] Connected to bot");
    // Send current mcap immediately on connect
    const el = findMcapElement();
    if (el) sendMcap(el.innerText);
  };

  ws.onclose = () => {
    wsReady = false;
    scheduleReconnect();
  };

  ws.onerror = () => {
    wsReady = false;
  };
}

function scheduleReconnect() {
  reconnectTimer = setTimeout(connect, 3000);
}

function sendMcap(rawText) {
  if (!wsReady || !ws) return;
  const mcap = parseMcap(rawText);
  if (mcap === null) return;

  // Also try to grab the token mint from the URL
  // Axiom URLs look like: axiom.trade/meme/MINT or axiom.trade/token/MINT
  const urlParts = window.location.pathname.split("/");
  const mint = urlParts[urlParts.length - 1] ?? "unknown";

  try {
    ws.send(JSON.stringify({ type: "MCAP_UPDATE", mint, marketCap: mcap, source: "axiom" }));
  } catch (e) {
    // ws might have closed between the check and send
  }
}

// ─── MutationObserver ─────────────────────────────────────────────────────────
// Watch the whole page for DOM changes — when the mcap element's text changes,
// send the new value immediately.

let mcapEl = null;
let observerAttached = false;

function attachObserver() {
  // Find the element (retry if not found yet — page might still be loading)
  if (!mcapEl) {
    mcapEl = findMcapElement();
    if (!mcapEl) {
      setTimeout(attachObserver, 1000);
      return;
    }
    console.log("[ConsolidationBot] Found market cap element:", mcapEl.innerText);
    // Send initial value
    sendMcap(mcapEl.innerText);
  }

  if (observerAttached) return;
  observerAttached = true;

  const observer = new MutationObserver(() => {
    if (mcapEl) sendMcap(mcapEl.innerText);
  });

  // Observe the element itself and its subtree for text changes
  observer.observe(mcapEl, { childList: true, subtree: true, characterData: true });

  // Also watch the document body in case Axiom re-renders the whole component
  // (React apps often unmount/remount elements). If our element disappears,
  // re-find it.
  const bodyObserver = new MutationObserver(() => {
    if (!document.contains(mcapEl)) {
      mcapEl = null;
      observerAttached = false;
      observer.disconnect();
      setTimeout(attachObserver, 500);
    }
  });

  bodyObserver.observe(document.body, { childList: true, subtree: true });
}

// ─── URL change detection ─────────────────────────────────────────────────────
// Axiom is a single-page app — navigating to a new token doesn't reload the page.
// Watch for URL changes and re-find the mcap element.

let lastUrl = location.href;

new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    mcapEl = null;
    observerAttached = false;
    setTimeout(attachObserver, 1500); // give React time to render
  }
}).observe(document.body, { childList: true, subtree: true });

// ─── Boot ─────────────────────────────────────────────────────────────────────

connect();
setTimeout(attachObserver, 2000); // wait for Axiom to finish rendering

// ─── Write status to storage for the popup ───────────────────────────────────

let updateCount = 0;

const _origSend = sendMcap;
// Wrap sendMcap to also update storage
window._sendMcap = function(rawText) {
  _origSend(rawText);
  const mcap = parseMcap(rawText);
  if (mcap) {
    updateCount++;
    const urlParts = window.location.pathname.split("/");
    const mint = urlParts[urlParts.length - 1] ?? "unknown";
    chrome.storage.local.set({
      botConnected: wsReady,
      lastMcap: mcap,
      updateCount,
      lastMint: mint,
    });
  }
};

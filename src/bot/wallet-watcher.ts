import http from "http";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchTokenInfo } from "./price";
import { logger } from "./logger";

// ─── Quote token blacklist ─────────────────────────────────────────────────────
// These are never "real" token buys — they're just the swap output side.
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",    // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  // USDT
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",  // ETH (Wormhole)
]);

// ─── Public API ────────────────────────────────────────────────────────────────

export interface WalletWatcherCallbacks {
  /** Called when the watched wallet buys a token not already on the watchlist. */
  onBuy: (mint: string, symbol: string, buyMcap: number) => Promise<void>;
  /** Called when the watched wallet's balance for a tracked token drops to zero. */
  onFullSell: (mint: string) => Promise<void>;
  /** Returns true if the mint is already on the bot's watchlist. */
  isTracked: (mint: string) => boolean;
}

export interface WalletWatcher {
  /** Set (or clear) the wallet to watch. Manages Helius webhooks automatically. */
  setWallet: (wallet: string | null) => Promise<{ webhookId: string | null }>;
  getWallet: () => string | null;
  getWebhookId: () => string | null;
  /** Update the extra addresses (balance monitor wallets) included in the shared webhook. */
  setExtraAddresses: (addresses: string[]) => Promise<void>;
  /** Register a secondary event handler called for every webhook event. */
  registerEventHandler: (handler: (event: any) => Promise<void>) => void;
  stop: () => void;
}

// ─── Factory ───────────────────────────────────────────────────────────────────

export async function createWalletWatcher(
  connection: Connection,
  callbacks: WalletWatcherCallbacks,
  initialWallet?: string | null,
  initialWebhookId?: string | null,
): Promise<WalletWatcher> {
  let watchedWallet: string | null = initialWallet ?? null;
  let webhookId: string | null = null; // will be set after startup registration below
  let extraAddresses: string[] = [];
  const extraHandlers: ((event: any) => Promise<void>)[] = [];

  function getAllAddresses(): string[] {
    const all = new Set<string>(extraAddresses);
    if (watchedWallet) all.add(watchedWallet);
    return [...all];
  }

  const port = parseInt(process.env.WEBHOOK_PORT || "4000", 10);

  // ── HTTP server ──────────────────────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404); res.end(); return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200); res.end("OK");
      try {
        const payload = JSON.parse(body);
        const events: any[] = Array.isArray(payload) ? payload : [payload];
        for (const event of events) {
          handleEvent(event).catch((err) =>
            logger.error("Wallet watcher: event handler error", { error: String(err) })
          );
          for (const handler of extraHandlers) {
            handler(event).catch((err) =>
              logger.error("Webhook extra handler error", { error: String(err) })
            );
          }
        }
      } catch (err) {
        logger.error("Wallet watcher: failed to parse webhook body", { error: String(err) });
      }
    });
  });

  server.listen(port, () =>
    logger.info(`Wallet watcher: HTTP server listening on :${port}/webhook`)
  );

  // ── Helius webhook management ────────────────────────────────────────────────
  function getApiKey(): string | null {
    const m = (process.env.RPC_ENDPOINT || "").match(/api-key=([^&/\s]+)/i);
    return m ? m[1] : null;
  }

  async function createWebhook(addresses: string[]): Promise<string | null> {
    const apiKey = getApiKey();
    const webhookUrl = process.env.WEBHOOK_URL;

    if (!apiKey) {
      logger.warn("Wallet watcher: could not extract Helius API key from RPC_ENDPOINT — webhook not registered");
      return null;
    }
    if (!webhookUrl) {
      logger.warn("Wallet watcher: WEBHOOK_URL is not set — webhook not registered. Set WEBHOOK_URL=http://<your-vps-ip>:4000/webhook in .env");
      return null;
    }

    try {
      const res = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookURL: webhookUrl,
          transactionTypes: ["SWAP", "TRANSFER"],
          accountAddresses: addresses,
          webhookType: "enhanced",
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        logger.error("Wallet watcher: Helius webhook registration failed", { status: res.status, body: text });
        return null;
      }
      const data = (await res.json()) as { webhookID: string };
      logger.info("Wallet watcher: webhook registered", { webhookId: data.webhookID, addressCount: addresses.length });
      return data.webhookID;
    } catch (err) {
      logger.error("Wallet watcher: webhook registration error", { error: String(err) });
      return null;
    }
  }

  async function updateWebhook(id: string, addresses: string[]): Promise<void> {
    const apiKey = getApiKey();
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!apiKey || !webhookUrl) return;
    try {
      const res = await fetch(`https://api.helius.xyz/v0/webhooks/${id}?api-key=${apiKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookURL: webhookUrl,
          transactionTypes: ["SWAP", "TRANSFER"],
          accountAddresses: addresses,
          webhookType: "enhanced",
        }),
      });
      if (!res.ok) {
        logger.warn("Wallet watcher: webhook update returned non-OK", { status: res.status, webhookId: id });
      } else {
        logger.info("Wallet watcher: webhook updated", { webhookId: id, addressCount: addresses.length });
      }
    } catch (err) {
      logger.error("Wallet watcher: webhook update error", { error: String(err) });
    }
  }

  async function deleteWebhook(id: string): Promise<void> {
    const apiKey = getApiKey();
    if (!apiKey) return;
    try {
      const res = await fetch(`https://api.helius.xyz/v0/webhooks/${id}?api-key=${apiKey}`, {
        method: "DELETE",
      });
      if (res.ok) {
        logger.info("Wallet watcher: webhook deleted", { webhookId: id });
      } else {
        logger.warn("Wallet watcher: webhook delete returned non-OK", { status: res.status, webhookId: id });
      }
    } catch (err) {
      logger.warn("Wallet watcher: failed to delete webhook", { webhookId: id, error: String(err) });
    }
  }

  // ── Event processing ─────────────────────────────────────────────────────────
  async function handleEvent(event: any): Promise<void> {
    if (!watchedWallet) return;
    if (event.transactionError) return; // ignore failed txns

    const transfers: any[] = event.tokenTransfers ?? [];

    for (const t of transfers) {
      const mint: string | undefined = t.mint;
      if (!mint || QUOTE_MINTS.has(mint)) continue;

      const toUser: string  = t.toUserAccount   ?? "";
      const fromUser: string = t.fromUserAccount ?? "";

      // ── BUY: token flows into the watched wallet ─────────────────────────────
      if (toUser === watchedWallet && !callbacks.isTracked(mint)) {
        logger.info("Wallet watcher: buy detected", { mint, wallet: watchedWallet });
        try {
          const { symbol, marketCap } = await fetchTokenInfo(mint);
          await callbacks.onBuy(mint, symbol, marketCap);
        } catch (err) {
          logger.error("Wallet watcher: onBuy failed", { mint, error: String(err) });
        }
      }

      // ── FULL SELL: token flows out of the watched wallet ─────────────────────
      if (fromUser === watchedWallet && callbacks.isTracked(mint)) {
        logger.info("Wallet watcher: outflow detected, checking remaining balance", { mint });
        try {
          const remaining = await getWatchedWalletTokenBalance(connection, watchedWallet, mint);
          if (remaining === 0n) {
            logger.info("Wallet watcher: full sell confirmed", { mint, wallet: watchedWallet });
            await callbacks.onFullSell(mint);
          } else {
            logger.info("Wallet watcher: partial sell — still holding", { mint, remaining: remaining.toString() });
          }
        } catch (err) {
          logger.error("Wallet watcher: balance check failed", { mint, error: String(err) });
        }
      }
    }
  }

  // ── Register webhook on startup (always re-create so URL stays current) ───────
  if (watchedWallet) {
    if (initialWebhookId) await deleteWebhook(initialWebhookId);
    webhookId = await createWebhook(getAllAddresses());
  }

  // ── Public interface ─────────────────────────────────────────────────────────
  return {
    getWallet: () => watchedWallet,
    getWebhookId: () => webhookId,

    setWallet: async (wallet: string | null) => {
      if (webhookId) { await deleteWebhook(webhookId); webhookId = null; }
      watchedWallet = wallet;
      const all = getAllAddresses();
      if (all.length > 0) webhookId = await createWebhook(all);
      return { webhookId };
    },

    setExtraAddresses: async (addresses: string[]) => {
      extraAddresses = addresses;
      const all = getAllAddresses();
      if (all.length === 0) {
        if (webhookId) { await deleteWebhook(webhookId); webhookId = null; }
        return;
      }
      if (!webhookId) {
        webhookId = await createWebhook(all);
      } else {
        await updateWebhook(webhookId, all);
      }
    },

    registerEventHandler: (handler) => { extraHandlers.push(handler); },
    stop: () => { server.close(); },
  };
}

// ─── Helper: token balance for an arbitrary wallet ────────────────────────────
// Unlike wallet.ts's getTokenBalance (which uses the bot's own ATA), this
// queries any wallet by owner public key.
async function getWatchedWalletTokenBalance(
  connection: Connection,
  walletAddress: string,
  mint: string,
): Promise<bigint> {
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(walletAddress),
      { mint: new PublicKey(mint) },
    );
    let total = 0n;
    for (const { account } of accounts.value) {
      const raw: string | undefined =
        (account.data as any)?.parsed?.info?.tokenAmount?.amount;
      if (raw) total += BigInt(raw);
    }
    return total;
  } catch (err) {
    logger.warn("Wallet watcher: getParsedTokenAccountsByOwner failed", { error: String(err) });
    return 0n;
  }
}

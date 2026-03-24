import axios from "axios";
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import { JupiterQuoteResponse, JupiterSwapResponse, TradeRecord } from "./types";
import { logger } from "./logger";
import { USDC_MINT } from "./price";
import crypto from "crypto";

const JUPITER_QUOTE_API = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_API  = "https://lite-api.jup.ag/swap/v1/swap";
const OUTPUT_MINT       = USDC_MINT;
const SLIPPAGE_BPS      = parseInt(process.env.SLIPPAGE_BPS || "100", 10);
const PRIORITY_FEE      = parseInt(process.env.PRIORITY_FEE_MICROLAMPORTS || "100000", 10);
const RETRY_WINDOW_MS   = 10_000; // keep retrying for up to 10 seconds
const RETRY_DELAY_MS    = 1_000;  // 1s between retries

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + RETRY_WINDOW_MS;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) {
        logger.error(`${label} failed — 10s retry window exhausted`, { error: msg });
        throw err;
      }
      const delay = Math.min(RETRY_DELAY_MS, timeLeft);
      logger.warn(`${label} attempt ${attempt} failed — retrying in ${(delay / 1000).toFixed(1)}s (${(timeLeft / 1000).toFixed(1)}s left)`, { error: msg });
      await sleep(delay);
    }
  }
}

// ─── Quote ────────────────────────────────────────────────────────────────────

async function getQuote(inputMint: string, amountRaw: bigint): Promise<JupiterQuoteResponse> {
  return withRetry("Jupiter quote", async () => {
    const res = await axios.get(JUPITER_QUOTE_API, {
      params: {
        inputMint,
        outputMint: OUTPUT_MINT,
        amount: amountRaw.toString(),
        slippageBps: SLIPPAGE_BPS,
      },
      timeout: 12_000,
    });
    return res.data as JupiterQuoteResponse;
  });
}

// ─── Swap Transaction ─────────────────────────────────────────────────────────

async function getSwapTransaction(quote: JupiterQuoteResponse, userPublicKey: string): Promise<string> {
  return withRetry("Jupiter swap build", async () => {
    const res = await axios.post(
      JUPITER_SWAP_API,
      {
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: PRIORITY_FEE,
            priorityLevel: "high",
          },
        },
      },
      { timeout: 15_000 }
    );
    return (res.data as JupiterSwapResponse).swapTransaction;
  });
}

// ─── Send & Confirm ───────────────────────────────────────────────────────────

async function sendAndConfirm(connection: Connection, keypair: Keypair, swapTxBase64: string): Promise<string> {
  const txBuffer = Buffer.from(swapTxBase64, "base64");
  const tx = VersionedTransaction.deserialize(txBuffer);
  tx.sign([keypair]);
  const rawTx = tx.serialize();

  return withRetry("Send transaction", async () => {
    const sig = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 2,
    });

    logger.info("Transaction sent", { signature: sig });

    const { value } = await connection.confirmTransaction(
      { signature: sig, ...(await connection.getLatestBlockhash("confirmed")) },
      "confirmed"
    );

    if (value.err) throw new Error(`On-chain failure: ${JSON.stringify(value.err)}`);
    return sig;
  });
}

// ─── Public: Execute Sell ─────────────────────────────────────────────────────

export async function executeSell(
  connection: Connection,
  keypair: Keypair,
  mint: string,
  symbol: string,
  amountRaw: bigint,
  decimals: number,
  triggerMarketCap: number,
  triggerLevel: number,
  touchCount: number
): Promise<TradeRecord> {
  const id       = crypto.randomUUID();
  const amountUi = Number(amountRaw) / Math.pow(10, decimals);

  const record: TradeRecord = {
    id, mint, symbol, triggerMarketCap, triggerLevel, touchCount,
    amountRaw: amountRaw.toString() as any,  // store as string — bigint not JSON-serialisable
    amountUi,
    txSignature: null,
    status: "pending",
    timestamp: Date.now(),
  };

  logger.info(`[${symbol}] Initiating sell`, { amountUi, triggerMarketCap, triggerLevel, touchCount });

  try {
    const quote        = await getQuote(mint, amountRaw);
    const outAmountUi  = Number(quote.outAmount) / 1e6;
    const priceImpact  = parseFloat(quote.priceImpactPct);

    logger.info(`[${symbol}] Quote`, {
      in: amountUi, outUsdc: outAmountUi.toFixed(2),
      impact: `${priceImpact.toFixed(3)}%`,
    });

    if (priceImpact > 5)
      logger.warn(`[${symbol}] High price impact: ${priceImpact.toFixed(2)}%`);

    const swapTx = await getSwapTransaction(quote, keypair.publicKey.toBase58());
    const sig    = await sendAndConfirm(connection, keypair, swapTx);

    record.txSignature = sig;
    record.status = "success";

    logger.info(`[${symbol}] ✅ Sell confirmed`, {
      sig, url: `https://solscan.io/tx/${sig}`,
      sold: amountUi, receivedUsdc: outAmountUi.toFixed(2),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record.status = "failed";
    record.error  = msg;
    logger.error(`[${symbol}] ❌ Sell failed`, { error: msg });
  }

  return record;
}

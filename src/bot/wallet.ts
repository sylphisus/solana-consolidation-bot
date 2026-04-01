import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from "@solana/spl-token";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import { logger } from "./logger";

// ─── Keypair ──────────────────────────────────────────────────────────────────

let _keypair: Keypair | null = null;

export function loadKeypair(): Keypair {
  if (_keypair) return _keypair;
  const raw = process.env.BOT_PRIVATE_KEY;
  if (!raw || raw === "YOUR_BASE58_PRIVATE_KEY_HERE")
    throw new Error("BOT_PRIVATE_KEY is not set. Copy .env.example → .env and add your key.");
  try {
    _keypair = Keypair.fromSecretKey(bs58.decode(raw));
    logger.info("Wallet loaded", { publicKey: _keypair.publicKey.toBase58() });
    return _keypair;
  } catch (err) {
    throw new Error(`Failed to decode BOT_PRIVATE_KEY. Ensure it is base58-encoded. Error: ${err}`);
  }
}

export function getBotPublicKey(): PublicKey {
  return loadKeypair().publicKey;
}

// ─── SOL Balance ──────────────────────────────────────────────────────────────

export async function getSolBalance(connection: Connection): Promise<number> {
  const lamports = await connection.getBalance(getBotPublicKey());
  return lamports / LAMPORTS_PER_SOL;
}

// ─── Token Program Detection ──────────────────────────────────────────────────
// PumpFun and some other tokens use Token-2022 instead of the standard program.
// We detect which program owns the mint so ATA lookups use the right one.

const _programCache = new Map<string, PublicKey>();
const _decimalsCache = new Map<string, number>();

const CACHE_PATH = path.join(process.cwd(), "config", "token-cache.json");

export function loadTokenCache(): void {
  try {
    if (!fs.existsSync(CACHE_PATH)) return;
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
    for (const [mint, isToken2022] of Object.entries(data.programs ?? {})) {
      _programCache.set(mint, isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
    }
    for (const [mint, decimals] of Object.entries(data.decimals ?? {})) {
      _decimalsCache.set(mint, decimals as number);
    }
    logger.info(`Token cache loaded — ${_programCache.size} entries`);
  } catch (err) {
    logger.warn("Failed to load token cache", { error: String(err) });
  }
}

export function saveTokenCache(): void {
  try {
    const programs: Record<string, boolean> = {};
    for (const [mint, program] of _programCache) {
      programs[mint] = program.equals(TOKEN_2022_PROGRAM_ID);
    }
    const decimals: Record<string, number> = {};
    for (const [mint, d] of _decimalsCache) {
      decimals[mint] = d;
    }
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ programs, decimals }, null, 2));
  } catch (err) {
    logger.warn("Failed to save token cache", { error: String(err) });
  }
}

export function isTokenCached(mint: string): boolean {
  return _decimalsCache.has(mint);
}

async function getTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const key = mint.toBase58();
  if (_programCache.has(key)) return _programCache.get(key)!;

  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint account not found: ${key}`);

  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  _programCache.set(key, program);
  saveTokenCache();
  logger.debug(`Token program for ${key.slice(0, 8)}: ${program.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "Standard"}`);
  return program;
}

// ─── Decimals ─────────────────────────────────────────────────────────────────

export async function getTokenDecimals(connection: Connection, mint: string): Promise<number> {
  if (_decimalsCache.has(mint)) return _decimalsCache.get(mint)!;
  const program = await getTokenProgram(connection, new PublicKey(mint));
  const mintInfo = await getMint(connection, new PublicKey(mint), "confirmed", program);
  _decimalsCache.set(mint, mintInfo.decimals);
  saveTokenCache();
  logger.debug(`Decimals for ${mint.slice(0, 8)}: ${mintInfo.decimals}`);
  return mintInfo.decimals;
}

// ─── SPL Token Balance ────────────────────────────────────────────────────────

export async function getTokenBalance(connection: Connection, mint: PublicKey): Promise<bigint> {
  const owner = getBotPublicKey();

  // Try standard program first, then Token-2022
  // (getTokenProgram caches the result so the second call is free)
  const program = await getTokenProgram(connection, mint);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, program);

  try {
    const account = await getAccount(connection, ata, "confirmed", program);
    return account.amount;
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError) {
      return 0n;
    }
    throw err;
  }
}

export async function getAllTokenBalances(
  connection: Connection,
  mints: string[]
): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>(mints.map(m => [m, 0n]));
  const owner = getBotPublicKey();

  // Fetch all token accounts in 2 calls (standard + Token-2022) instead of N calls
  const [standard, token2022] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  for (const { account } of [...standard.value, ...token2022.value]) {
    const parsed = account.data.parsed?.info;
    if (!parsed) continue;
    const mint   = parsed.mint as string;
    const amount = BigInt(parsed.tokenAmount?.amount ?? "0");
    if (balances.has(mint)) balances.set(mint, amount);
  }

  return balances;
}

export function toUiAmount(raw: bigint, decimals: number): number {
  return Number(raw) / Math.pow(10, decimals);
}

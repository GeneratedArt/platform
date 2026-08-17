import type { Context } from "hono";
import { createPublicClient, getAddress, http, type Hex } from "viem";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getAuthUser } from "../auth/middleware";
import { checkRateLimit } from "../lib/rateLimit";
import {
  getAccount,
  listLedger,
  publicLedgerEntry,
  listActivePacks,
  getPackById,
  publicPack,
  claimPurchase,
  applyLedgerEntry,
} from "../db/tokens";

/**
 * The token-purchase counterpart to `chainConfig` in projects/mint.ts.
 * Deliberately not shared with it: mint reads GA_FACTORY_ADDRESS, this
 * reads TOKEN_TREASURY_ADDRESS — different unconfigured states should
 * fail independently rather than one env var silently gating the other.
 */
function treasuryConfig(env: Env) {
  const treasury = env.TOKEN_TREASURY_ADDRESS;
  const chainId = env.GA_CHAIN_ID ? parseInt(env.GA_CHAIN_ID, 10) : NaN;
  const rpcUrl = env.GA_RPC_URL ?? "";
  return { treasury, chainId, rpcUrl };
}

function badRequest(c: Context, error: string, detail?: unknown) {
  return c.json({ error, detail }, 400);
}

function isTxHash(s: unknown): s is Hex {
  return typeof s === "string" && /^0x[a-fA-F0-9]{64}$/.test(s);
}

/** GET /v1/tokens/account — balance + lifetime counters for the caller. */
export async function tokenAccountHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const account = await getAccount(c.env.DB, session.uid);
  return c.json({
    balance: account.balance,
    lifetime_purchased: account.lifetime_purchased,
    lifetime_spent: account.lifetime_spent,
    lifetime_earned: account.lifetime_earned,
  });
}

const LEDGER_LIST_DEFAULT = 30;
const LEDGER_LIST_MAX = 100;

/** GET /v1/tokens/ledger?limit=&before= — the caller's own history. */
export async function tokenLedgerHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);
  const url = new URL(c.req.url);
  const limitRaw = url.searchParams.get("limit");
  let limit = LEDGER_LIST_DEFAULT;
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1 || n > LEDGER_LIST_MAX) {
      return badRequest(c, "invalid_limit", { max: LEDGER_LIST_MAX });
    }
    limit = n;
  }
  const beforeRaw = url.searchParams.get("before");
  let before: number | undefined;
  if (beforeRaw) {
    const n = parseInt(beforeRaw, 10);
    if (!Number.isFinite(n) || n < 0) return badRequest(c, "invalid_before");
    before = n;
  }
  const rows = await listLedger(c.env.DB, session.uid, limit, before);
  return c.json({
    entries: rows.map(publicLedgerEntry),
    next_before: rows.length === limit ? rows[rows.length - 1].id : null,
  });
}

/** GET /v1/tokens/packs — public catalogue of purchasable token packs. */
export async function listPacksHandler(c: Context<{ Bindings: Env }>) {
  const packs = await listActivePacks(c.env.DB);
  const cfg = treasuryConfig(c.env);
  return c.json({
    packs: packs.map(publicPack),
    purchase_configured: !!cfg.treasury && !Number.isNaN(cfg.chainId),
    chain_id: Number.isNaN(cfg.chainId) ? null : cfg.chainId,
    treasury_address: cfg.treasury ?? null,
  });
}

interface ConfirmBody {
  pack_id?: unknown;
  tx_hash?: unknown;
}

/**
 * POST /v1/tokens/purchase/confirm
 *
 * No payment processor: the client sends ETH directly to
 * TOKEN_TREASURY_ADDRESS on the configured chain, then posts the tx
 * hash here. The Worker fetches the transaction + receipt from the
 * public RPC and verifies:
 *   - the tx succeeded
 *   - it was sent TO the treasury address
 *   - its value covers the pack's price_wei
 * before crediting the account. Trusting only the tx hash (never a
 * client-supplied amount) means a malicious client can't credit
 * themselves tokens they didn't pay for. Mirrors the verification
 * shape of projects/mint.ts confirmDeploy/confirmMint.
 */
export async function confirmPurchaseHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `tokens:purchase:${session.uid}`,
    limit: 20,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  const cfg = treasuryConfig(c.env);
  if (!cfg.treasury || Number.isNaN(cfg.chainId)) {
    return c.json({ error: "purchase_unconfigured" }, 503);
  }

  let body: ConfirmBody;
  try {
    body = await c.req.json<ConfirmBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  const packId = typeof body.pack_id === "number" ? body.pack_id : NaN;
  if (!Number.isFinite(packId) || packId < 1) return badRequest(c, "invalid_pack_id");
  if (!isTxHash(body.tx_hash)) return badRequest(c, "invalid_tx_hash");

  const pack = await getPackById(c.env.DB, packId);
  if (!pack) return c.json({ error: "pack_not_found" }, 404);

  const expectedTreasury = getAddress(cfg.treasury as Hex);
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });

  let fromAddress: Hex;
  let valueWei: bigint;
  try {
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: body.tx_hash }),
      client.getTransactionReceipt({ hash: body.tx_hash }),
    ]);
    if (receipt.status !== "success") return badRequest(c, "tx_reverted", 409);
    if (!tx.to || getAddress(tx.to) !== expectedTreasury) {
      return badRequest(c, "wrong_recipient", 409);
    }
    if (tx.value < BigInt(pack.price_wei)) {
      return badRequest(c, "underpaid", {
        required_wei: pack.price_wei,
        sent_wei: tx.value.toString(),
      });
    }
    fromAddress = tx.from;
    valueWei = tx.value;
  } catch (e) {
    console.error("purchase confirm verify failed", e);
    return c.json({ error: "rpc_unavailable" }, 503);
  }

  const purchase = await claimPurchase(c.env.DB, {
    userId: session.uid,
    packId: pack.id,
    chainId: cfg.chainId,
    txHash: body.tx_hash,
    fromAddress,
    valueWei: valueWei.toString(),
    tokens: pack.tokens,
  });
  if (!purchase) {
    // UNIQUE(chain_id, tx_hash) already claimed — this tx was already
    // redeemed (by this user or, if stolen, by whoever posted it first).
    return c.json({ error: "already_claimed" }, 409);
  }

  const ledger = await applyLedgerEntry(c.env.DB, {
    userId: session.uid,
    delta: pack.tokens,
    kind: "purchase",
    idempotencyKey: `purchase:${cfg.chainId}:${body.tx_hash.toLowerCase()}`,
    refKind: "purchase",
    refId: purchase.id,
    memo: `${pack.title} pack`,
  });
  // A purchase credit can never be "insufficient" — it's additive — so
  // the only real outcomes are applied/replayed. Both carry the entry.
  if (ledger.status === "insufficient") {
    return c.json({ error: "ledger_error" }, 500);
  }

  const account = await getAccount(c.env.DB, session.uid);
  return c.json(
    {
      purchase: {
        id: purchase.id,
        pack: publicPack(pack),
        tx_hash: purchase.tx_hash,
        tokens: purchase.tokens,
      },
      ledger_entry: publicLedgerEntry(ledger.entry),
      balance: account.balance,
    },
    201,
  );
}

import type { D1Database } from "@cloudflare/workers-types";

/**
 * Render-token accounting.
 *
 * A render token is a prepaid compute credit, never an ERC-721 token —
 * see the header of migrations/0018_token_service.sql.
 *
 * `token_ledger` is the source of truth and `token_accounts.balance` is
 * a cache of it. Both move in a single D1 batch (batches are
 * transactional) under the identical `balance + delta >= 0` guard, so a
 * debit that would overdraw applies to neither table.
 */

export const LEDGER_KINDS = [
  "grant",
  "purchase",
  "debit",
  "refund",
  "earn",
  "adjust",
] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];

export function isLedgerKind(v: unknown): v is LedgerKind {
  return typeof v === "string" && (LEDGER_KINDS as readonly string[]).includes(v);
}

export interface TokenAccount {
  user_id: number;
  balance: number;
  lifetime_purchased: number;
  lifetime_spent: number;
  lifetime_earned: number;
  created_at: number;
  updated_at: number;
}

export interface LedgerRow {
  id: number;
  user_id: number;
  delta: number;
  kind: string;
  balance_after: number;
  ref_kind: string | null;
  ref_id: number | null;
  memo: string | null;
  idempotency_key: string;
  created_at: number;
}

export interface LedgerEntryInput {
  userId: number;
  /** Signed. Positive credits, negative debits. Zero is rejected. */
  delta: number;
  kind: LedgerKind;
  /** Replay guard. Must be stable for the operation it represents. */
  idempotencyKey: string;
  refKind?: string | null;
  refId?: number | null;
  memo?: string | null;
}

export type LedgerResult =
  | { status: "applied"; entry: LedgerRow }
  | { status: "replayed"; entry: LedgerRow }
  | { status: "insufficient"; balance: number; shortfall: number };

/**
 * Which lifetime counter a ledger entry advances.
 *
 * Split out as a pure function because the mapping is the part that is
 * easy to get subtly wrong (a refund must not reduce `lifetime_spent`,
 * or a user who renders and gets refunded reads as having spent a
 * negative amount). Unit-tested directly.
 */
export function lifetimeDeltas(kind: LedgerKind, delta: number): {
  purchased: number;
  spent: number;
  earned: number;
} {
  return {
    purchased: kind === "purchase" || kind === "grant" ? Math.max(0, delta) : 0,
    spent: kind === "debit" ? Math.max(0, -delta) : 0,
    earned: kind === "earn" ? Math.max(0, delta) : 0,
  };
}

/** Creates the account row on first touch. Safe to call repeatedly. */
export async function ensureAccount(
  db: D1Database,
  userId: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT OR IGNORE INTO token_accounts
         (user_id, balance, created_at, updated_at)
       VALUES (?, 0, ?, ?)`,
    )
    .bind(userId, now, now)
    .run();
}

export async function getAccount(
  db: D1Database,
  userId: number,
): Promise<TokenAccount> {
  await ensureAccount(db, userId);
  const row = await db
    .prepare(`SELECT * FROM token_accounts WHERE user_id = ?`)
    .bind(userId)
    .first<TokenAccount>();
  // ensureAccount just guaranteed the row; the fallback keeps the return
  // type honest rather than asserting non-null.
  return (
    row ?? {
      user_id: userId,
      balance: 0,
      lifetime_purchased: 0,
      lifetime_spent: 0,
      lifetime_earned: 0,
      created_at: 0,
      updated_at: 0,
    }
  );
}

function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed/i.test(msg);
}

async function entryByKey(
  db: D1Database,
  key: string,
): Promise<LedgerRow | null> {
  return await db
    .prepare(`SELECT * FROM token_ledger WHERE idempotency_key = ?`)
    .bind(key)
    .first<LedgerRow>();
}

/**
 * The only balance-mutating path in the codebase.
 *
 * Returns `insufficient` rather than throwing when a debit would
 * overdraw, so callers can surface the shortfall to the user. Returns
 * `replayed` when `idempotencyKey` has already been used, carrying the
 * original entry — a retried request is a no-op, not a second charge.
 */
export async function applyLedgerEntry(
  db: D1Database,
  input: LedgerEntryInput,
): Promise<LedgerResult> {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new Error("ledger delta must be a non-zero integer");
  }
  await ensureAccount(db, input.userId);

  // Fast path for an already-applied key. The UNIQUE index below is what
  // actually enforces this; the lookup just avoids a guaranteed-failing
  // batch on the common retry.
  const existing = await entryByKey(db, input.idempotencyKey);
  if (existing) return { status: "replayed", entry: existing };

  const now = Math.floor(Date.now() / 1000);
  const life = lifetimeDeltas(input.kind, input.delta);
  const { userId, delta } = input;

  // Statement order matters. The INSERT runs first so `a.balance` is
  // still the pre-mutation value and `balance_after` is computed from
  // it. Both statements carry the same `balance + delta >= 0` guard, so
  // an overdraw silently affects zero rows in both — which is exactly
  // the signal read back from results[0].meta.changes.
  const insertLedger = db
    .prepare(
      `INSERT INTO token_ledger
         (user_id, delta, kind, balance_after, ref_kind, ref_id, memo,
          idempotency_key, created_at)
       SELECT ?, ?, ?, a.balance + ?, ?, ?, ?, ?, ?
         FROM token_accounts a
        WHERE a.user_id = ? AND a.balance + ? >= 0`,
    )
    .bind(
      userId,
      delta,
      input.kind,
      delta,
      input.refKind ?? null,
      input.refId ?? null,
      input.memo ?? null,
      input.idempotencyKey,
      now,
      userId,
      delta,
    );

  const updateAccount = db
    .prepare(
      `UPDATE token_accounts
          SET balance            = balance + ?,
              lifetime_purchased = lifetime_purchased + ?,
              lifetime_spent     = lifetime_spent + ?,
              lifetime_earned    = lifetime_earned + ?,
              updated_at         = ?
        WHERE user_id = ? AND balance + ? >= 0`,
    )
    .bind(delta, life.purchased, life.spent, life.earned, now, userId, delta);

  const readBack = db
    .prepare(`SELECT * FROM token_ledger WHERE idempotency_key = ?`)
    .bind(input.idempotencyKey);

  let applied = false;
  let entry: LedgerRow | null = null;
  try {
    const results = await db.batch<LedgerRow>([
      insertLedger,
      updateAccount,
      readBack,
    ]);
    applied = (results[0]?.meta?.changes ?? 0) > 0;
    entry = results[2]?.results?.[0] ?? null;
  } catch (e) {
    // A concurrent request won the race on the same key. The batch rolled
    // back, so re-reading gives that request's entry.
    if (isUniqueViolation(e)) {
      const raced = await entryByKey(db, input.idempotencyKey);
      if (raced) return { status: "replayed", entry: raced };
    }
    throw e;
  }

  if (!applied || !entry) {
    const account = await getAccount(db, userId);
    return {
      status: "insufficient",
      balance: account.balance,
      shortfall: Math.max(0, -delta - account.balance),
    };
  }
  return { status: "applied", entry };
}

export async function listLedger(
  db: D1Database,
  userId: number,
  limit: number,
  before?: number,
): Promise<LedgerRow[]> {
  const sql = before
    ? `SELECT * FROM token_ledger WHERE user_id = ? AND id < ?
        ORDER BY id DESC LIMIT ?`
    : `SELECT * FROM token_ledger WHERE user_id = ?
        ORDER BY id DESC LIMIT ?`;
  const stmt = db.prepare(sql);
  const bound = before
    ? stmt.bind(userId, before, limit)
    : stmt.bind(userId, limit);
  const { results } = await bound.all<LedgerRow>();
  return results ?? [];
}

export function publicLedgerEntry(row: LedgerRow) {
  return {
    id: row.id,
    delta: row.delta,
    kind: row.kind,
    balance_after: row.balance_after,
    ref_kind: row.ref_kind,
    ref_id: row.ref_id,
    memo: row.memo,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Packs + purchases
// ---------------------------------------------------------------------------

export interface PackRow {
  id: number;
  slug: string;
  title: string;
  tokens: number;
  price_wei: string;
  active: number;
  sort: number;
  created_at: number;
}

export async function listActivePacks(db: D1Database): Promise<PackRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM token_packs WHERE active = 1 ORDER BY sort ASC, id ASC`,
    )
    .all<PackRow>();
  return results ?? [];
}

export async function getPackById(
  db: D1Database,
  id: number,
): Promise<PackRow | null> {
  return await db
    .prepare(`SELECT * FROM token_packs WHERE id = ? AND active = 1`)
    .bind(id)
    .first<PackRow>();
}

export function publicPack(p: PackRow) {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    tokens: p.tokens,
    price_wei: p.price_wei,
  };
}

export interface PurchaseRow {
  id: number;
  user_id: number;
  pack_id: number;
  chain_id: number;
  tx_hash: string;
  from_address: string;
  value_wei: string;
  tokens: number;
  created_at: number;
}

/**
 * Claims a settled on-chain payment. The UNIQUE(chain_id, tx_hash)
 * constraint is the anti-replay mechanism — a second attempt to redeem
 * the same transfer returns null instead of inserting.
 */
export async function claimPurchase(
  db: D1Database,
  input: {
    userId: number;
    packId: number;
    chainId: number;
    txHash: string;
    fromAddress: string;
    valueWei: string;
    tokens: number;
  },
): Promise<PurchaseRow | null> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const row = await db
      .prepare(
        `INSERT INTO token_purchases
           (user_id, pack_id, chain_id, tx_hash, from_address, value_wei,
            tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .bind(
        input.userId,
        input.packId,
        input.chainId,
        input.txHash.toLowerCase(),
        input.fromAddress.toLowerCase(),
        input.valueWei,
        input.tokens,
        now,
      )
      .first<PurchaseRow>();
    return row ?? null;
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

export async function getPurchaseByTx(
  db: D1Database,
  chainId: number,
  txHash: string,
): Promise<PurchaseRow | null> {
  return await db
    .prepare(
      `SELECT * FROM token_purchases WHERE chain_id = ? AND tx_hash = ?`,
    )
    .bind(chainId, txHash.toLowerCase())
    .first<PurchaseRow>();
}

import type { D1Database } from "@cloudflare/workers-types";

export interface MintRow {
  id: number;
  project_id: number | null;
  contract_address: string;
  chain_id: number;
  token_id: string;
  owner_address: string;
  tx_hash: string;
  minted_at: number;
  seed: string | null;
  traits_json: string | null;
}

export interface PublicMint {
  id: number;
  project_id: number | null;
  contract_address: string;
  chain_id: number;
  token_id: string;
  owner_address: string;
  tx_hash: string;
  minted_at: number;
  seed: string | null;
  traits: Record<string, string> | null;
}

export function publicMint(row: MintRow): PublicMint {
  let traits: Record<string, string> | null = null;
  if (row.traits_json) {
    try {
      const parsed = JSON.parse(row.traits_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        traits = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") traits[k] = v;
        }
      }
    } catch {
      traits = null;
    }
  }
  return {
    id: row.id,
    project_id: row.project_id,
    contract_address: row.contract_address,
    chain_id: row.chain_id,
    token_id: row.token_id,
    owner_address: row.owner_address,
    tx_hash: row.tx_hash,
    minted_at: row.minted_at,
    seed: row.seed,
    traits,
  };
}

/**
 * Validate a client-supplied trait map. Required shape:
 *   - Plain object (not array, not null).
 *   - Every key is a non-empty string ≤ 32 chars.
 *   - Every value is a string (or coercible primitive — number/bool — which
 *     we stringify) ≤ 64 chars.
 *   - At most 16 entries (rarity-as-product breaks down past that anyway).
 *
 * Returns the normalised map, or null if the input doesn't conform.
 * Returning null lets the caller decide how to react (drop the
 * traits, 400 the request, etc.) — we never throw for bad input.
 */
export function normaliseTraits(
  raw: unknown,
): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 16) return null;
  const out: Record<string, string> = {};
  for (const [k, vRaw] of entries) {
    if (typeof k !== "string" || k.length === 0 || k.length > 32) return null;
    let v: string;
    if (typeof vRaw === "string") v = vRaw;
    else if (typeof vRaw === "number" && Number.isFinite(vRaw)) v = String(vRaw);
    else if (typeof vRaw === "boolean") v = String(vRaw);
    else return null;
    if (v.length === 0 || v.length > 64) return null;
    out[k] = v;
  }
  return out;
}

/**
 * Idempotent INSERT for a mint row, race-safe against concurrent
 * confirm-mint calls for the same (chain_id, contract_address,
 * token_id) tuple.
 *
 * Strategy: `INSERT OR IGNORE … RETURNING *`. SQLite returns the new
 * row when the insert succeeded; on conflict it skips the row and
 * returns nothing — at which point we SELECT the winning row. Either
 * way the caller gets back a non-null `row` and a boolean
 * `inserted` flag that tells them whether *they* wrote it (and
 * therefore whether they own emitting downstream events / fanning
 * out trait rows).
 *
 * Trait fan-out only runs on the inserted branch — if another
 * caller wrote the mint row, they are responsible for its traits.
 * mint_traits has its own (mint_id, trait_name) PK, so even if both
 * sides raced past the unique check, INSERT OR IGNORE on
 * mint_traits would still produce the right end state.
 */
export async function recordMintWithTraits(
  db: D1Database,
  args: {
    projectId: number;
    contractAddress: string;
    chainId: number;
    tokenId: string;
    ownerAddress: string;
    txHash: string;
    mintedAt: number;
    seed: string | null;
    traits: Record<string, string> | null;
  },
): Promise<{ row: MintRow; inserted: boolean } | null> {
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO mints
         (project_id, contract_address, chain_id, token_id,
          owner_address, tx_hash, minted_at, seed, traits_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      args.projectId,
      args.contractAddress,
      args.chainId,
      args.tokenId,
      args.ownerAddress,
      args.txHash,
      args.mintedAt,
      args.seed,
      args.traits ? JSON.stringify(args.traits) : null,
    )
    .first<MintRow>();
  if (inserted) {
    if (args.traits) {
      const stmts = Object.entries(args.traits).map(([n, v]) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO mint_traits
               (mint_id, project_id, trait_name, trait_value)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(inserted.id, args.projectId, n, v),
      );
      if (stmts.length > 0) await db.batch(stmts);
    }
    return { row: inserted, inserted: true };
  }
  // Conflict path: another caller won the race. Look up the row
  // they wrote so the caller still has a handle on it.
  const existing = await db
    .prepare(
      `SELECT * FROM mints
        WHERE chain_id = ? AND contract_address = ? AND token_id = ?`,
    )
    .bind(args.chainId, args.contractAddress, args.tokenId)
    .first<MintRow>();
  if (!existing) return null;
  return { row: existing, inserted: false };
}

export async function getMintByTokenId(
  db: D1Database,
  projectId: number,
  tokenId: string,
): Promise<MintRow | null> {
  return db
    .prepare(
      `SELECT * FROM mints WHERE project_id = ? AND token_id = ?`,
    )
    .bind(projectId, tokenId)
    .first<MintRow>();
}

export async function listMintsByProject(
  db: D1Database,
  projectId: number,
  opts: { limit?: number } = {},
): Promise<MintRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));
  const r = await db
    .prepare(
      `SELECT * FROM mints WHERE project_id = ?
        ORDER BY minted_at DESC, id DESC LIMIT ?`,
    )
    .bind(projectId, limit)
    .all<MintRow>();
  return r.results ?? [];
}

export interface TraitDistributionRow {
  trait_name: string;
  trait_value: string;
  count: number;
}

/**
 * Per-project rarity distribution: every (trait_name, trait_value) for
 * the project, with a count of mints carrying it. The project page
 * derives `frequency = count / project_mint_count` from this and the
 * token detail page derives `rarity_score = product(1/freq)` over the
 * specific token's traits.
 */
export async function listProjectTraitDistribution(
  db: D1Database,
  projectId: number,
): Promise<TraitDistributionRow[]> {
  const r = await db
    .prepare(
      `SELECT trait_name, trait_value, COUNT(*) AS count
         FROM mint_traits
        WHERE project_id = ?
        GROUP BY trait_name, trait_value
        ORDER BY trait_name ASC, count DESC, trait_value ASC`,
    )
    .bind(projectId)
    .all<TraitDistributionRow>();
  return r.results ?? [];
}

export async function projectMintCount(
  db: D1Database,
  projectId: number,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM mints WHERE project_id = ?`)
    .bind(projectId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

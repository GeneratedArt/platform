/**
 * §12 Artist–Artist Collaboration routes.
 *
 * Mounted twice from index.ts:
 *   /projects/:slug/collabs   → projectCollabRoutes (list + invite)
 *   /collabs                  → collabRoutes        (single invite + accept/revoke)
 *
 * EIP-712 typed data is verified with viem's `verifyTypedData`. The full
 * envelope ({domain,types,primaryType,message}) is stored so any future
 * audit can re-verify with no additional context.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ulid } from "ulid";
import { verifyTypedData, getAddress, keccak256, toBytes, type TypedDataDomain } from "viem";
import type { Env, Variables } from "../lib/env";
import { requireAuth } from "../lib/middleware";
import { audit } from "../lib/audit";

export const projectCollabRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
export const collabRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const ROLES = ["co-artist", "engineer", "sound", "advisor", "curator-note"] as const;

/** Canonical CollabInvite struct definition. The wallet may add EIP712Domain
 *  to its `types` map for signing UX, but every signature we accept must have
 *  THIS exact CollabInvite shape — same field names, same Solidity types, same
 *  order — so that downstream contracts (CollabAgreement.register) can verify
 *  the same digest without any guessing. */
const COLLAB_INVITE_TYPE = [
  { name: "projectId",    type: "bytes32" },
  { name: "collaborator", type: "address" },
  { name: "role",         type: "string"  },
  { name: "bps",          type: "uint16"  },
  { name: "nonce",        type: "bytes32" },
] as const;

function typesEqualCanonical(types: any): boolean {
  const got = types?.CollabInvite;
  if (!Array.isArray(got) || got.length !== COLLAB_INVITE_TYPE.length) return false;
  for (let i = 0; i < COLLAB_INVITE_TYPE.length; i++) {
    if (got[i]?.name !== COLLAB_INVITE_TYPE[i].name) return false;
    if (got[i]?.type !== COLLAB_INVITE_TYPE[i].type) return false;
  }
  return true;
}

const TypedData = z.object({
  domain: z.object({
    name: z.literal("GeneratedArt"),
    version: z.literal("1"),
    chainId: z.number().int().positive(),
  }),
  types: z.object({
    CollabInvite: z.array(z.object({ name: z.string(), type: z.string() })).min(5),
  }).passthrough(),
  primaryType: z.literal("CollabInvite"),
  message: z.object({
    projectId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    collaborator: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    role: z.enum(ROLES),
    bps: z.number().int().min(0).max(10000),
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
});

const InviteInput = z.object({
  collaborator_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  role: z.enum(ROLES),
  bps: z.number().int().min(0).max(10000),
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  typed_data: TypedData,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

const AcceptInput = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

/** Canonical projectId derivation: keccak256("generatedart:project:" + slug).
 *  Both client (CollabInviteIsland) and worker re-derive this; an eventual
 *  CollabAgreement.register(projectId,...) on Solidity must hash the same
 *  preimage so off-chain signatures are accepted on-chain unchanged. */
function projectIdHash(slug: string): `0x${string}` {
  return keccak256(toBytes(`generatedart:project:${slug}`));
}

function lc(addr: string) { return addr.toLowerCase(); }

// ---------------------------------------------------------------------------
// POST /projects/:slug/collabs   — artist creates a signed invite
// ---------------------------------------------------------------------------
projectCollabRoutes.post("/:slug/collabs", requireAuth, async (c) => {
  const slug = c.req.param("slug")!;
  const userId = c.get("userId")!;

  let parsed;
  try {
    parsed = InviteInput.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "invalid_input", detail: (err as Error).message }, 400);
  }

  const project = await c.env.DB.prepare(
    `SELECT id, artist_id FROM projects WHERE slug = ?`
  )
    .bind(slug)
    .first<{ id: string; artist_id: string }>();
  if (!project) return c.json({ error: "not_found" }, 404);
  if (project.artist_id !== userId) return c.json({ error: "forbidden" }, 403);

  const inviter = await c.env.DB.prepare(
    `SELECT wallet_address FROM users WHERE id = ?`
  )
    .bind(userId)
    .first<{ wallet_address: string | null }>();
  if (!inviter?.wallet_address) {
    return c.json({ error: "wallet_required", detail: "Link a wallet (sign in with Ethereum) before inviting collaborators." }, 409);
  }

  const collaborator = lc(parsed.collaborator_address);
  if (collaborator === lc(inviter.wallet_address)) {
    return c.json({ error: "self_invite" }, 400);
  }

  // Domain integrity — chain must match the worker's configured chain.
  const expectedChainId = Number(c.env.CHAIN_ID);
  if (parsed.typed_data.domain.chainId !== expectedChainId) {
    return c.json({ error: "wrong_chain", expected: expectedChainId }, 400);
  }

  // Type integrity — reject any non-canonical CollabInvite shape so we never
  // accept a signature whose digest a future on-chain verifier wouldn't.
  if (!typesEqualCanonical(parsed.typed_data.types)) {
    return c.json({ error: "noncanonical_types" }, 400);
  }

  // Message integrity — every field in `message` must match the unwrapped body
  // values, and the projectId must hash to this slug.
  const expectedProjectId = projectIdHash(slug);
  const m = parsed.typed_data.message;
  if (
    m.projectId !== expectedProjectId ||
    lc(m.collaborator) !== collaborator ||
    m.role !== parsed.role ||
    m.bps !== parsed.bps ||
    m.nonce !== parsed.nonce
  ) {
    return c.json({ error: "message_mismatch" }, 400);
  }

  // Recover signature.
  let valid = false;
  try {
    valid = await verifyTypedData({
      address: getAddress(inviter.wallet_address),
      domain: parsed.typed_data.domain as TypedDataDomain,
      types: parsed.typed_data.types as any,
      primaryType: "CollabInvite",
      message: parsed.typed_data.message,
      signature: parsed.signature as `0x${string}`,
    });
  } catch (err) {
    return c.json({ error: "signature_verify_failed", detail: (err as Error).message }, 400);
  }
  if (!valid) return c.json({ error: "bad_signature" }, 401);

  // Reject if a pending invite for this (project, collaborator) already exists.
  const dup = await c.env.DB.prepare(
    `SELECT id FROM collabs
      WHERE project_id = ? AND collaborator_address = ? AND status = 'pending'`
  )
    .bind(project.id, collaborator)
    .first();
  if (dup) return c.json({ error: "invite_already_pending" }, 409);

  const id = ulid();
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO collabs (
         id, project_id, inviter_user_id, inviter_address,
         collaborator_address, role, bps, nonce,
         typed_data_json, invite_signature, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
      .bind(
        id,
        project.id,
        userId,
        lc(inviter.wallet_address),
        collaborator,
        parsed.role,
        parsed.bps,
        parsed.nonce,
        JSON.stringify(parsed.typed_data),
        parsed.signature,
        now
      )
      .run();
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // SQLite raises "UNIQUE constraint failed" — turn the partial-unique-index
    // race into a deterministic 409 instead of a generic 500.
    if (/UNIQUE/i.test(msg)) {
      return c.json({ error: "invite_already_pending" }, 409);
    }
    throw err;
  }

  await audit(c.env, userId, "collab.invite", id, {
    project_slug: slug,
    collaborator,
    role: parsed.role,
    bps: parsed.bps,
  });

  return c.json({ id, status: "pending" });
});

// ---------------------------------------------------------------------------
// GET /projects/:slug/collabs   — public list (active only) + project owner sees all
// ---------------------------------------------------------------------------
projectCollabRoutes.get("/:slug/collabs", async (c) => {
  const slug = c.req.param("slug")!;
  const userId = c.get("userId");

  const project = await c.env.DB.prepare(
    `SELECT id, artist_id FROM projects WHERE slug = ?`
  )
    .bind(slug)
    .first<{ id: string; artist_id: string }>();
  if (!project) return c.json({ error: "not_found" }, 404);

  const isOwner = userId && userId === project.artist_id;
  const role = c.get("userRole");
  const isCurator = role === "curator" || role === "steward";
  const sql = isOwner || isCurator
    ? `SELECT id, collaborator_address, role, bps, status, created_at, responded_at
         FROM collabs WHERE project_id = ? ORDER BY created_at DESC`
    : `SELECT id, collaborator_address, role, bps, status, created_at, responded_at
         FROM collabs WHERE project_id = ? AND status = 'active' ORDER BY created_at DESC`;
  const rows = await c.env.DB.prepare(sql).bind(project.id).all();
  return c.json({ collabs: rows.results ?? [] });
});

// ---------------------------------------------------------------------------
// GET /collabs/:id   — fetch one (collaborator wallet, project owner, or curator)
// ---------------------------------------------------------------------------
collabRoutes.get("/:id", async (c) => {
  const id = c.req.param("id")!;
  const row = await c.env.DB.prepare(
    `SELECT c.*, p.slug AS project_slug, p.title AS project_title
       FROM collabs c JOIN projects p ON p.id = c.project_id
      WHERE c.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!row) return c.json({ error: "not_found" }, 404);

  // Authorisation: anyone may read an *active* collab (it's publicly displayed
  // on the project page anyway). Pending/revoked invites are restricted.
  if (row.status !== "active") {
    const userId = c.get("userId");
    const role = c.get("userRole");
    const isCurator = role === "curator" || role === "steward";
    let allowed = isCurator || userId === row.inviter_user_id;
    if (!allowed && userId) {
      const me = await c.env.DB.prepare(`SELECT wallet_address FROM users WHERE id = ?`)
        .bind(userId).first<{ wallet_address: string | null }>();
      if (me?.wallet_address && lc(me.wallet_address) === row.collaborator_address) allowed = true;
    }
    if (!allowed) return c.json({ error: "forbidden" }, 403);
  }

  return c.json({
    collab: {
      id: row.id,
      project_id: row.project_id,
      project_slug: row.project_slug,
      project_title: row.project_title,
      inviter_address: row.inviter_address,
      collaborator_address: row.collaborator_address,
      role: row.role,
      bps: row.bps,
      nonce: row.nonce,
      status: row.status,
      typed_data: JSON.parse(row.typed_data_json),
      invite_signature: row.invite_signature,
      accept_signature: row.accept_signature,
      onchain_tx: row.onchain_tx,
      created_at: row.created_at,
      responded_at: row.responded_at,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /collabs/:id/accept   — collaborator counter-signs
// ---------------------------------------------------------------------------
collabRoutes.post("/:id/accept", requireAuth, async (c) => {
  const id = c.req.param("id")!;
  const userId = c.get("userId")!;

  let parsed;
  try {
    parsed = AcceptInput.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "invalid_input", detail: (err as Error).message }, 400);
  }

  const me = await c.env.DB.prepare(`SELECT wallet_address FROM users WHERE id = ?`)
    .bind(userId).first<{ wallet_address: string | null }>();
  if (!me?.wallet_address) {
    return c.json({ error: "wallet_required" }, 409);
  }

  const row = await c.env.DB.prepare(
    `SELECT id, project_id, collaborator_address, typed_data_json, status
       FROM collabs WHERE id = ?`
  )
    .bind(id)
    .first<{ id: string; project_id: string; collaborator_address: string; typed_data_json: string; status: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status !== "pending") return c.json({ error: "invalid_status", current: row.status }, 409);
  if (lc(me.wallet_address) !== row.collaborator_address) {
    return c.json({ error: "not_collaborator" }, 403);
  }

  const typed = JSON.parse(row.typed_data_json);
  let valid = false;
  try {
    valid = await verifyTypedData({
      address: getAddress(me.wallet_address),
      domain: typed.domain,
      types: typed.types,
      primaryType: "CollabInvite",
      message: typed.message,
      signature: parsed.signature as `0x${string}`,
    });
  } catch (err) {
    return c.json({ error: "signature_verify_failed", detail: (err as Error).message }, 400);
  }
  if (!valid) return c.json({ error: "bad_signature" }, 401);

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE collabs
       SET status = 'active', accept_signature = ?, collaborator_user_id = ?, responded_at = ?
     WHERE id = ? AND status = 'pending'`
  )
    .bind(parsed.signature, userId, now, id)
    .run();

  await audit(c.env, userId, "collab.accept", id, { project_id: row.project_id });

  // §12.3 hooks (CODEOWNERS update + on-chain register) live downstream:
  // queue a job and let the github-bot/indexer workers pick them up.
  try {
    await c.env.PIN_QUEUE.send({
      type: "collab.activated",
      collab_id: id,
      project_id: row.project_id,
      collaborator_address: row.collaborator_address,
    });
  } catch (err) {
    console.error("collab_queue_failed", (err as Error).message);
  }

  return c.json({ ok: true, status: "active" });
});

// ---------------------------------------------------------------------------
// POST /collabs/:id/revoke   — either party while pending; rejector reason optional
// ---------------------------------------------------------------------------
const RevokeInput = z.object({ reason: z.string().max(500).optional() });

collabRoutes.post("/:id/revoke", requireAuth, async (c) => {
  const id = c.req.param("id")!;
  const userId = c.get("userId")!;

  let parsed: z.infer<typeof RevokeInput>;
  try {
    parsed = RevokeInput.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    return c.json({ error: "invalid_input", detail: (err as Error).message }, 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT id, project_id, inviter_user_id, collaborator_address, status
       FROM collabs WHERE id = ?`
  )
    .bind(id)
    .first<{ id: string; project_id: string; inviter_user_id: string; collaborator_address: string; status: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status !== "pending") return c.json({ error: "invalid_status", current: row.status }, 409);

  let allowed = userId === row.inviter_user_id;
  let nextStatus = "revoked";
  if (!allowed) {
    const me = await c.env.DB.prepare(`SELECT wallet_address FROM users WHERE id = ?`)
      .bind(userId).first<{ wallet_address: string | null }>();
    if (me?.wallet_address && lc(me.wallet_address) === row.collaborator_address) {
      allowed = true;
      nextStatus = "rejected";
    }
  }
  if (!allowed) return c.json({ error: "forbidden" }, 403);

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE collabs
       SET status = ?, revoked_at = ?, revoked_by = ?
     WHERE id = ? AND status = 'pending'`
  )
    .bind(nextStatus, now, userId, id)
    .run();

  await audit(c.env, userId, `collab.${nextStatus}`, id, {
    project_id: row.project_id,
    reason: parsed.reason ?? null,
  });

  return c.json({ ok: true, status: nextStatus });
});

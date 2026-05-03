import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getAuthUser } from "../auth/middleware";
import {
  getProjectById,
  recordProjectDeploy,
  markProjectMinted,
  publicProject,
} from "../db/projects";
import {
  encodeCreateProjectCalldata,
  encodeSetBaseFrozenCIDCalldata,
  encodeMintCalldata,
  type Hex,
} from "../lib/abi";

function badRequest(c: Context, code: string, status = 400) {
  return c.json({ error: code }, status as 400);
}

function isAddress(s: unknown): s is Hex {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

function isTxHash(s: unknown): s is Hex {
  return typeof s === "string" && /^0x[a-fA-F0-9]{64}$/.test(s);
}

function isHex32(s: unknown): s is Hex {
  return typeof s === "string" && /^0x[a-fA-F0-9]{64}$/.test(s);
}

function chainConfig(env: Env) {
  const factory = env.GA_FACTORY_ADDRESS;
  const chainId = env.GA_CHAIN_ID ? parseInt(env.GA_CHAIN_ID, 10) : NaN;
  const rpcUrl = env.GA_RPC_URL ?? "";
  return { factory, chainId, rpcUrl };
}

/**
 * POST /v1/projects/:id/mint/prepare
 *
 * Returns the calldata + target the user's wallet should sign next, so
 * the Worker stays a *thin* coordinator and never touches a private key.
 *
 * The flow has three phases keyed off project state:
 *   1. `deploy`   — no contract_address yet → call GAProjectFactory.createProject
 *   2. `lock_cid` — contract deployed, CID not yet locked on-chain → call setBaseFrozenCID
 *   3. `mint`     — CID locked → call GAProject.mint(seed)
 *
 * The client tells us which phase it's in (or asks for "auto"); the
 * Worker validates ownership for deploy/lock_cid and returns calldata.
 */
export async function prepareMint(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");

  const cfg = chainConfig(c.env);
  if (!cfg.factory || Number.isNaN(cfg.chainId)) {
    return c.json({ error: "mint_unconfigured" }, 503);
  }

  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);

  type Body = { phase?: string; seed?: string };
  const body = (await c.req.json().catch(() => ({}))) as Body;
  const requested = (body.phase ?? "auto").toString();

  // Auto-detect the next phase from D1 state. The client renders this
  // back to the artist/collector and is free to override (e.g. if
  // they want to retry a stuck deploy with a different gas price).
  let phase: "deploy" | "lock_cid" | "mint";
  if (!project.contract_address) phase = "deploy";
  else if (!project.deploy_tx_hash) phase = "deploy";
  else phase = "mint";
  if (requested === "deploy" || requested === "lock_cid" || requested === "mint") {
    phase = requested;
  }

  if (phase === "deploy") {
    // Deploying the per-project clone is artist-only.
    const session = getAuthUser(c);
    if (session.uid !== project.owner_id) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (project.contract_address) {
      return c.json({ error: "already_deployed" }, 409);
    }
    // Use the project slug as on-chain name; symbol is the
    // upper-cased first 6 chars of the slug, padded if too short.
    const name = project.title.slice(0, 32);
    const symbol = (project.slug.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() || "GAART")
      .slice(0, 6);
    const royaltyBps = 500; // 5% — hardcoded for hackathon (matches done criteria).
    const maxSupply = 0n;   // open edition for the demo.

    const data = encodeCreateProjectCalldata(name, symbol, royaltyBps, maxSupply);
    return c.json({
      phase: "deploy",
      chain: { id: cfg.chainId, rpcUrl: cfg.rpcUrl },
      to: cfg.factory,
      data,
      value: "0x0",
      meta: { name, symbol, royaltyBps, maxSupply: "0" },
    });
  }

  if (phase === "lock_cid") {
    const session = getAuthUser(c);
    if (session.uid !== project.owner_id) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!project.contract_address) {
      return c.json({ error: "not_deployed" }, 409);
    }
    if (!project.frozen_cid) {
      return c.json({ error: "no_frozen_cid" }, 409);
    }
    const data = encodeSetBaseFrozenCIDCalldata(project.frozen_cid);
    return c.json({
      phase: "lock_cid",
      chain: { id: cfg.chainId, rpcUrl: cfg.rpcUrl },
      to: project.contract_address,
      data,
      value: "0x0",
      meta: { frozen_cid: project.frozen_cid },
    });
  }

  // phase === "mint" — open to anyone with a wallet.
  if (!project.contract_address) {
    return c.json({ error: "not_deployed" }, 409);
  }
  if (!project.frozen_cid) {
    return c.json({ error: "no_frozen_cid" }, 409);
  }

  // Seed defaults to a fresh per-mint random 32-byte value generated
  // server-side using the Workers crypto RNG. The client may pass an
  // explicit hex seed for reproducible demos.
  let seed: Hex;
  if (body.seed && isHex32(body.seed)) {
    seed = body.seed;
  } else {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    seed = ("0x" +
      Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
  }
  const data = encodeMintCalldata(seed);
  return c.json({
    phase: "mint",
    chain: { id: cfg.chainId, rpcUrl: cfg.rpcUrl },
    to: project.contract_address,
    data,
    value: "0x0",
    meta: { seed, frozen_cid: project.frozen_cid },
  });
}

interface ConfirmDeployBody {
  contract_address?: unknown;
  tx_hash?: unknown;
  chain_id?: unknown;
}

/**
 * POST /v1/projects/:id/mint/confirm-deploy
 *
 * Called by the client after `factory.createProject` has been mined.
 * The client supplies the new clone address it parsed from the
 * `ProjectCreated` event log + the deploy tx hash; we persist that
 * to D1 so subsequent `mint/prepare` calls advance to the next phase
 * and so `/p/{id}` can deep-link to Basescan.
 */
export async function confirmDeploy(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");

  const session = getAuthUser(c);
  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);
  if (session.uid !== project.owner_id) return c.json({ error: "forbidden" }, 403);
  if (project.contract_address) return c.json({ error: "already_deployed" }, 409);

  const body = (await c.req.json().catch(() => ({}))) as ConfirmDeployBody;
  if (!isAddress(body.contract_address)) return badRequest(c, "invalid_contract_address");
  if (!isTxHash(body.tx_hash)) return badRequest(c, "invalid_tx_hash");

  const cfg = chainConfig(c.env);
  // Lock the chain id to whatever the Worker is configured for so a
  // misbehaving client can't claim a deploy on, say, mainnet.
  if (body.chain_id !== undefined && Number(body.chain_id) !== cfg.chainId) {
    return badRequest(c, "chain_id_mismatch");
  }

  const updated = await recordProjectDeploy(
    c.env.DB,
    id,
    body.contract_address,
    cfg.chainId,
    body.tx_hash,
  );
  if (!updated) return c.json({ error: "race_condition" }, 409);
  return c.json({ project: publicProject(updated) });
}

/**
 * POST /v1/projects/:id/mint/confirm-mint
 *
 * Called after a *collector* mints token #1 — flips the project status
 * to "minted" so the dashboard / portfolio show the new badge. Mints of
 * tokens 2..N do not flip status (it stays minted). This endpoint is
 * advisory only — it does not need to be auth'd to a specific user
 * because everything it asserts is already reflected on-chain; we
 * still gate it behind requireAuth to discourage abuse.
 */
export async function confirmMint(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");
  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);
  if (!project.contract_address) return c.json({ error: "not_deployed" }, 409);

  const updated = await markProjectMinted(c.env.DB, id);
  // markProjectMinted is a no-op if status is already 'minted' — return
  // the existing row in that case so the client always gets a 200.
  return c.json({ project: publicProject(updated ?? project) });
}

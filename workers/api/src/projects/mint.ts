import type { Context } from "hono";
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  parseAbiItem,
  type Hex,
} from "viem";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getAuthUser } from "../auth/middleware";
import { maybeAuthUser } from "../users/handlers";
import { getUserById } from "../db/users";
import {
  getProjectById,
  recordProjectDeploy,
  markProjectMinted,
  publicProject,
} from "../db/projects";
import { activeFrozenCid } from "./freeze";
import {
  encodeCreateProjectCalldata,
  encodeSetBaseFrozenCIDCalldata,
  encodeMintCalldata,
  projectAbi,
} from "../lib/abi";

const PROJECT_CREATED = parseAbiItem(
  "event ProjectCreated(address indexed project, address indexed artist, string name, string symbol, uint96 royaltyBps, uint256 maxSupply)",
);
const MINTED = parseAbiItem(
  "event Minted(uint256 indexed tokenId, address indexed to, bytes32 seed)",
);

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

function publicClient(rpcUrl: string) {
  return createPublicClient({ transport: http(rpcUrl) });
}

/**
 * POST /v1/projects/:id/mint/prepare
 *
 * Returns the calldata + target the user's wallet should sign next.
 *
 * Auth model:
 *   - phase=deploy / lock_cid → owner only (requires SIWE session)
 *   - phase=mint              → public (any wallet can mint after the
 *                                CID is locked on-chain)
 *
 * The `mint` phase is also gated on the *on-chain* lock state read
 * directly from the deployed `GAProject` clone, not on the D1
 * `frozen_cid` column — D1 can lag the chain or be wrong, but the
 * contract's `isCIDLocked()` is the source of truth. If the contract
 * isn't locked yet, we return 409 `cid_not_locked` so the UI can
 * surface "the artist hasn't finalised this drop yet".
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

  let phase: "deploy" | "lock_cid" | "mint";
  if (!project.contract_address) phase = "deploy";
  else phase = "mint";
  if (requested === "deploy" || requested === "lock_cid" || requested === "mint") {
    phase = requested;
  }

  // Owner-only phases: require an authenticated session whose uid
  // matches project.owner_id.
  if (phase === "deploy" || phase === "lock_cid") {
    const viewer = await maybeAuthUser(c);
    if (!viewer) return c.json({ error: "auth_required" }, 401);
    if (viewer.uid !== project.owner_id) {
      return c.json({ error: "forbidden" }, 403);
    }
  }

  // Task #15 mint guard: every phase that ultimately leads to a
  // token existing on-chain (deploy → lock_cid → mint) requires a
  // resolvable frozen CID. We check at the start of every phase
  // rather than only at lock_cid because (a) deploying a contract
  // that can never be locked wastes gas, and (b) collectors hitting
  // `mint` deserve a clean error instead of a confusing on-chain
  // revert.
  //
  // Backward compatibility: a project that has projects.frozen_cid
  // set directly (legacy / pre-Task #15) is grandfathered, so a
  // partially-onboarded project doesn't get bricked the moment this
  // ships. Going forward, activate() is the only path that writes
  // projects.frozen_cid, so the two states stay in sync.
  const activeCid =
    (await activeFrozenCid(c.env, project.id)) ?? project.frozen_cid;
  if (!activeCid) {
    return c.json({ error: "frozen_version_required" }, 422);
  }

  if (phase === "deploy") {
    if (project.contract_address) return c.json({ error: "already_deployed" }, 409);
    const name = project.title.slice(0, 32);
    const symbol = (project.slug.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() || "GAART")
      .slice(0, 6);
    const royaltyBps = 500;
    const maxSupply = 0n;
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
    if (!project.contract_address) return c.json({ error: "not_deployed" }, 409);
    if (!project.frozen_cid) return c.json({ error: "no_frozen_cid" }, 409);
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

  // phase === "mint" — open to any connected wallet.
  if (!project.contract_address) {
    return c.json({ error: "not_deployed" }, 409);
  }

  // On-chain truth check: only allow mint calldata when the contract
  // confirms its CID is locked. Saves the collector from sending a tx
  // that would revert with CIDNotSet.
  try {
    const locked = await publicClient(cfg.rpcUrl).readContract({
      address: project.contract_address as Hex,
      abi: projectAbi,
      functionName: "isCIDLocked",
    });
    if (!locked) return c.json({ error: "cid_not_locked" }, 409);
  } catch (e) {
    console.error("isCIDLocked read failed", e);
    return c.json({ error: "rpc_unavailable" }, 503);
  }

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
  tx_hash?: unknown;
}

/**
 * POST /v1/projects/:id/mint/confirm-deploy
 *
 * The client passes the deploy tx hash. The Worker fetches the receipt
 * from the configured RPC, verifies:
 *   - tx succeeded
 *   - tx target was the configured factory
 *   - a `ProjectCreated(project, artist=session.user.address, …)` log
 *     was emitted by the factory
 * and persists the resulting clone address. Trusting only the tx hash
 * (not a client-provided contract address) means a malicious client
 * cannot register a project deployed on a different factory or by
 * a different artist.
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
  if (!isTxHash(body.tx_hash)) return badRequest(c, "invalid_tx_hash");

  const cfg = chainConfig(c.env);
  if (!cfg.factory || Number.isNaN(cfg.chainId)) {
    return c.json({ error: "mint_unconfigured" }, 503);
  }
  const owner = await getUserById(c.env.DB, project.owner_id);
  if (!owner) return c.json({ error: "owner_missing" }, 500);
  const expectedArtist = getAddress(owner.address as Hex);
  const expectedFactory = getAddress(cfg.factory as Hex);

  let cloneAddr: Hex;
  try {
    const client = publicClient(cfg.rpcUrl);
    const receipt = await client.getTransactionReceipt({
      hash: body.tx_hash,
    });
    if (receipt.status !== "success") {
      return badRequest(c, "tx_reverted", 409);
    }
    if (!receipt.to || getAddress(receipt.to) !== expectedFactory) {
      return badRequest(c, "wrong_factory", 409);
    }
    const found = receipt.logs
      .filter((l) => getAddress(l.address) === expectedFactory)
      .map((l) => {
        try {
          return decodeEventLog({
            abi: [PROJECT_CREATED],
            topics: l.topics as [Hex, ...Hex[]],
            data: l.data,
          });
        } catch {
          return null;
        }
      })
      .find(
        (d) =>
          d?.eventName === "ProjectCreated" &&
          getAddress((d.args as { artist: Hex }).artist) === expectedArtist,
      );
    if (!found) {
      return badRequest(c, "event_not_found", 409);
    }
    cloneAddr = getAddress(
      (found.args as { project: Hex }).project,
    ) as Hex;
  } catch (e) {
    console.error("confirm-deploy verify failed", e);
    return c.json({ error: "rpc_unavailable" }, 503);
  }

  const updated = await recordProjectDeploy(
    c.env.DB,
    id,
    cloneAddr,
    cfg.chainId,
    body.tx_hash,
  );
  if (!updated) return c.json({ error: "race_condition" }, 409);
  return c.json({ project: publicProject(updated) });
}

interface ConfirmMintBody {
  tx_hash?: unknown;
}

/**
 * POST /v1/projects/:id/mint/confirm-mint
 *
 * Verifies a Minted event was emitted by `project.contract_address`
 * in the receipt for `tx_hash`, then flips status → 'minted' (no-op
 * if already minted). Public — anyone who minted should be able to
 * promote the project's status, since the proof lives on-chain.
 */
export async function confirmMint(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");
  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);
  if (!project.contract_address) return c.json({ error: "not_deployed" }, 409);

  const body = (await c.req.json().catch(() => ({}))) as ConfirmMintBody;
  if (!isTxHash(body.tx_hash)) return badRequest(c, "invalid_tx_hash");

  const cfg = chainConfig(c.env);
  if (Number.isNaN(cfg.chainId)) {
    return c.json({ error: "mint_unconfigured" }, 503);
  }
  const expectedProject = getAddress(project.contract_address as Hex);
  try {
    const receipt = await publicClient(cfg.rpcUrl).getTransactionReceipt({
      hash: body.tx_hash,
    });
    if (receipt.status !== "success") return badRequest(c, "tx_reverted", 409);
    const minted = receipt.logs
      .filter((l) => getAddress(l.address) === expectedProject)
      .some((l) => {
        try {
          const d = decodeEventLog({
            abi: [MINTED],
            topics: l.topics as [Hex, ...Hex[]],
            data: l.data,
          });
          return d.eventName === "Minted";
        } catch {
          return false;
        }
      });
    if (!minted) return badRequest(c, "event_not_found", 409);
  } catch (e) {
    console.error("confirm-mint verify failed", e);
    return c.json({ error: "rpc_unavailable" }, 503);
  }

  const updated = await markProjectMinted(c.env.DB, id);
  return c.json({ project: publicProject(updated ?? project) });
}

/** Whether this Worker has the on-chain factory wired up. Used by the
 *  client UI's bootstrap to short-circuit before connecting a wallet. */
export async function mintConfigHandler(
  c: Context<{ Bindings: Env }>,
) {
  const cfg = chainConfig(c.env);
  return c.json({
    configured: !!cfg.factory && !Number.isNaN(cfg.chainId),
    chain_id: Number.isNaN(cfg.chainId) ? null : cfg.chainId,
    factory_address: cfg.factory ?? null,
    rpc_url: cfg.rpcUrl || null,
  });
}

/**
 * GET /v1/projects/:id/mint/state
 *
 * Reads the live contract state (cid_locked, total_minted, max_supply)
 * from chain so the mint UI can render "5 / open" or "12 / 100" before
 * the collector signs anything. Returns nulls for fields that don't
 * apply yet (e.g. before deploy).
 */
export async function mintStateHandler(
  c: Context<{ Bindings: Env }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return badRequest(c, "invalid_id");
  const project = await getProjectById(c.env.DB, id);
  if (!project) return c.json({ error: "not_found" }, 404);

  const cfg = chainConfig(c.env);
  const base = {
    contract_address: project.contract_address,
    frozen_cid: project.frozen_cid,
    chain_id: project.chain_id,
    cid_locked: false as boolean,
    total_minted: null as string | null,
    max_supply: null as string | null,
  };
  if (!project.contract_address || !cfg.rpcUrl) return c.json(base);

  try {
    const client = publicClient(cfg.rpcUrl);
    const [locked, totalMinted, maxSupply] = await Promise.all([
      client.readContract({
        address: project.contract_address as Hex,
        abi: projectAbi,
        functionName: "isCIDLocked",
      }),
      client.readContract({
        address: project.contract_address as Hex,
        abi: projectAbi,
        functionName: "totalMinted",
      }),
      client.readContract({
        address: project.contract_address as Hex,
        abi: projectAbi,
        functionName: "maxSupply",
      }),
    ]);
    return c.json({
      ...base,
      cid_locked: Boolean(locked),
      total_minted: (totalMinted as bigint).toString(),
      max_supply: (maxSupply as bigint).toString(),
    });
  } catch (e) {
    console.error("mint state read failed", e);
    return c.json({ ...base, error: "rpc_unavailable" }, 200);
  }
}

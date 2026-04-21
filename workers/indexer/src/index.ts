/**
 * Chain indexer. Cron-triggered every minute.
 * Reads Transfer + ProjectCreated logs from Base via Cloudflare ETH gateway,
 * upserts into D1 editions + projects. Re-runnable from genesis with ?from=.
 */
import { createPublicClient, http, parseAbiItem, type Hex } from "viem";
import { base } from "viem/chains";

export interface Env {
  DB: D1Database;
  INDEXER_STATE: KVNamespace;
  ENVIRONMENT: string;
  CHAIN_ID: string;
  ETH_RPC_URL: string;
  FACTORY_ADDRESS: string;
}

const PROJECT_CREATED = parseAbiItem(
  "event ProjectCreated(address indexed project, string slug, address indexed artist)"
);
const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
);

async function getClient(env: Env) {
  return createPublicClient({ chain: base, transport: http(env.ETH_RPC_URL) });
}

// Most public RPCs cap eth_getLogs at 2k–10k blocks per request.
const CHUNK_SIZE = 2000n;

const TOKEN_HASHES_ABI = [
  {
    type: "function",
    name: "tokenHashes",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

async function fetchTokenHash(
  env: Env,
  contract: Hex,
  tokenId: bigint
): Promise<string> {
  try {
    const client = await getClient(env);
    const h = await client.readContract({
      address: contract,
      abi: TOKEN_HASHES_ABI,
      functionName: "tokenHashes",
      args: [tokenId],
    });
    return h as string;
  } catch {
    return "0x";
  }
}

async function indexChunk(env: Env, fromBlock: bigint, toBlock: bigint) {
  const client = await getClient(env);

  // Factory events: ProjectCreated.
  const projectLogs = await client.getLogs({
    address: env.FACTORY_ADDRESS as Hex,
    event: PROJECT_CREATED,
    fromBlock,
    toBlock,
  });

  for (const log of projectLogs) {
    const { project, slug, artist } = log.args as {
      project: Hex;
      slug: string;
      artist: Hex;
    };
    await env.DB.prepare(
      `UPDATE projects
       SET contract_address = ?, status = 'live'
       WHERE slug = ?`
    )
      .bind(project.toLowerCase(), slug)
      .run();
    console.log(`indexed ProjectCreated slug=${slug} project=${project} artist=${artist}`);
  }

  // Transfer events from each known project contract.
  const knownProjects = await env.DB.prepare(
    "SELECT id, contract_address FROM projects WHERE contract_address IS NOT NULL"
  ).all<{ id: string; contract_address: string }>();

  for (const proj of knownProjects.results ?? []) {
    const transfers = await client.getLogs({
      address: proj.contract_address as Hex,
      event: TRANSFER,
      fromBlock,
      toBlock,
    });
    for (const log of transfers) {
      const { from, to, tokenId } = log.args as {
        from: Hex;
        to: Hex;
        tokenId: bigint;
      };
      const editionId = `${proj.contract_address}:${tokenId.toString()}`;
      const isMint = from === "0x0000000000000000000000000000000000000000";
      if (isMint) {
        const tokenHash = await fetchTokenHash(
          env,
          proj.contract_address as Hex,
          tokenId
        );
        await env.DB.prepare(
          `INSERT INTO editions (id, project_id, token_id, token_hash, owner_address, minted_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash`
        )
          .bind(editionId, proj.id, Number(tokenId), tokenHash, to.toLowerCase(), Date.now())
          .run();
        await env.DB.prepare(
          `UPDATE projects SET minted_count = minted_count + 1 WHERE id = ?`
        )
          .bind(proj.id)
          .run();
      } else {
        await env.DB.prepare(
          `UPDATE editions SET owner_address = ? WHERE id = ?`
        )
          .bind(to.toLowerCase(), editionId)
          .run();
      }
    }
  }
}

async function indexRange(env: Env, fromBlock: bigint, toBlock: bigint) {
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = cursor + CHUNK_SIZE - 1n > toBlock ? toBlock : cursor + CHUNK_SIZE - 1n;
    await indexChunk(env, cursor, end);
    cursor = end + 1n;
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const client = await getClient(env);
        const head = await client.getBlockNumber();
        const stateKey = `last_block:${env.FACTORY_ADDRESS}`;
        const lastStr = await env.INDEXER_STATE.get(stateKey);
        const last = lastStr ? BigInt(lastStr) : head - 1000n;
        const to = head;
        const from = last + 1n;
        if (from > to) return;
        await indexRange(env, from, to);
        await env.INDEXER_STATE.put(stateKey, to.toString());
        console.log(`indexed blocks ${from}..${to}`);
      })()
    );
  },

  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname === "/backfill") {
      const fromStr = url.searchParams.get("from") ?? "0";
      const toStr = url.searchParams.get("to");
      const client = await getClient(env);
      const head = toStr ? BigInt(toStr) : await client.getBlockNumber();
      const from = BigInt(fromStr);
      await indexRange(env, from, head);
      // Persist the new high-water mark so the cron picks up from here.
      await env.INDEXER_STATE.put(
        `last_block:${env.FACTORY_ADDRESS}`,
        head.toString()
      );
      return new Response(`backfilled ${from}..${head}`);
    }
    if (url.pathname === "/status") {
      const last = await env.INDEXER_STATE.get(`last_block:${env.FACTORY_ADDRESS}`);
      return Response.json({
        factory: env.FACTORY_ADDRESS,
        last_indexed_block: last,
        chain_id: env.CHAIN_ID,
      });
    }
    return new Response("generatedart-indexer");
  },
};

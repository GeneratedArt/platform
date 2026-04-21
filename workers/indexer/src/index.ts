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

async function indexRange(env: Env, fromBlock: bigint, toBlock: bigint) {
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
        // tokenHash will be filled in by a follow-up call to the contract; placeholder here.
        await env.DB.prepare(
          `INSERT INTO editions (id, project_id, token_id, token_hash, owner_address, minted_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        )
          .bind(editionId, proj.id, Number(tokenId), "0x", to.toLowerCase(), Date.now())
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
      const fromStr = url.searchParams.get("from");
      if (!fromStr) return new Response("missing ?from=", { status: 400 });
      const client = await getClient(env);
      const head = await client.getBlockNumber();
      await indexRange(env, BigInt(fromStr), head);
      return new Response(`backfilled ${fromStr}..${head}`);
    }
    return new Response("generatedart-indexer");
  },
};

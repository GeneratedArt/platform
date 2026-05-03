# GeneratedArt — Smart contracts

`GAProject` (per-project ERC-721 + ERC-2981) and `GAProjectFactory`
(EIP-1167 minimal proxies) live here. The Worker never holds a private
key; it only encodes calldata and verifies receipts. The artist signs
deploy and lock; collectors sign mint.

## Test

```sh
forge test
```

15 unit tests cover initialization, CID lock, mint preconditions,
royalties, supply caps, and factory bounds.

## Deploy to Base Sepolia (chain 84532)

1. Set the deployer key:

   ```sh
   export PRIVATE_KEY=0x…           # wallet that will own the factory
   export BASESCAN_API_KEY=…         # for --verify
   ```

2. Run the script:

   ```sh
   forge script script/Deploy.s.sol:Deploy \
     --rpc-url https://sepolia.base.org \
     --broadcast \
     --verify \
     --etherscan-api-key "$BASESCAN_API_KEY"
   ```

3. Note the printed factory address (also written to
   `broadcast/Deploy.s.sol/84532/run-latest.json`).

4. Wire it into the Worker:

   ```toml
   # workers/api/wrangler.toml
   [vars]
   GA_CHAIN_ID = "84532"
   GA_RPC_URL  = "https://sepolia.base.org"
   GA_FACTORY_ADDRESS = "0x…"        # paste here
   ```

   And `cd workers/api && npx wrangler deploy`.

5. Smoke test:

   ```sh
   curl -s https://api.example.com/v1/mint/config | jq
   # expect: {"configured": true, "chain_id": 84532, ...}
   ```

## Deploy to Base mainnet (chain 8453)

Identical to the Sepolia steps but with `--rpc-url https://mainnet.base.org`
and pasting the resulting address into
`[env.production.vars] GA_FACTORY_ADDRESS` in `wrangler.toml`. Set
`GA_CHAIN_ID = "8453"` for the production env. See follow-up task
**#26 — Promote the mint flow from Base Sepolia to Base mainnet** for
the full mainnet runbook including pre-flight UX warnings.

## Rotating the factory

Factories are immutable. To migrate to a new factory:

1. Deploy the new factory.
2. Update `GA_FACTORY_ADDRESS` in `wrangler.toml` and redeploy the
   Worker.
3. Already-deployed `GAProject` clones keep working — they don't
   reference the factory after construction.

## Files

- `src/GAProject.sol` — clone implementation.
- `src/GAProjectFactory.sol` — `createProject(name, symbol, royaltyBps,
  maxSupply)` returns a clone address; emits `ProjectCreated`.
- `script/Deploy.s.sol` — broadcast script.
- `test/GAProject.t.sol` — Foundry unit tests.

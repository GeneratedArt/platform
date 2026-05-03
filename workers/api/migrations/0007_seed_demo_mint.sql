-- Task #8 — polish + demo prep.
--
-- The hackathon README links to a "demo mint on Base Sepolia". The mint flow
-- itself goes through the wallet, so a real mint can't be seeded from a
-- migration. What we *can* seed is the Worker's read-side mint state for
-- one demo project so `/p/{id}` and `/mint/{id}` render with non-empty
-- contract metadata in fresh databases.
--
-- This is idempotent: every UPDATE is keyed on `slug`, and the column
-- writes are conditional via COALESCE so a real on-chain deploy that
-- already populated these columns is left untouched.
--
-- Replace the placeholder values below before the first prod deploy
-- (the README's TODO entries track this). For local dev they're fine
-- as-is — they're only used to render the badge + Basescan link, never
-- to send a transaction.

UPDATE projects
   SET status           = CASE WHEN status = 'minted' THEN status ELSE 'minted' END,
       contract_address = COALESCE(contract_address, '0x000000000000000000000000000000000000dEaD'),
       frozen_cid       = COALESCE(frozen_cid, 'bafybeibfdemo000000000000000000000000000000000000000000000000000'),
       deploy_tx_hash   = COALESCE(deploy_tx_hash, '0xdemo000000000000000000000000000000000000000000000000000000000000'),
       chain_id         = COALESCE(chain_id, 84532),
       updated_at       = strftime('%s','now')
 WHERE slug = 'ga-smoke-flow-fields';

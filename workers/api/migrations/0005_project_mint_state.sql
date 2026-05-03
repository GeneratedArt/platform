-- Task #6: per-project mint state. We store the deployed clone address
-- (one ERC-721 contract per project), the frozen IPFS CID locked into
-- that contract, and the deploy tx hash so the dashboard can deep-link
-- to Basescan. `contract_address` is unique because each clone is its
-- own contract; null until the artist runs the factory deploy.

ALTER TABLE projects ADD COLUMN contract_address TEXT;
ALTER TABLE projects ADD COLUMN frozen_cid       TEXT;
ALTER TABLE projects ADD COLUMN deploy_tx_hash   TEXT;
ALTER TABLE projects ADD COLUMN chain_id         INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_contract_address
  ON projects(contract_address) WHERE contract_address IS NOT NULL;

-- Hardcoded frozen bundle for the hackathon demo project (ga-smoke / id 5).
-- The full freeze pipeline is P1 follow-up; for the hackathon we want
-- one project that can be minted end-to-end against Base Sepolia.
UPDATE projects
SET    frozen_cid = 'bafybeihackathondemo5flowfields000000000000000000000000000000'
WHERE  id = 5
  AND  frozen_cid IS NULL;

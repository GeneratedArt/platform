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

-- Note: frozen_cid stays NULL until the artist pins a frozen bundle
-- and runs the lock_cid step from /mint/{id}. We deliberately do NOT
-- seed a placeholder CID here — IPFS gateways would 404 on it and the
-- mint flow correctly refuses to mint until the contract reports
-- isCIDLocked()=true.

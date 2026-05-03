-- Track each provider's CID separately. They differ by construction
-- (web3.storage and Pinata wrap UnixFS differently for single-file
-- uploads), so a single `cid` column conflates "provider says it's
-- pinned" with "this is the CID that resolves on that provider".
-- The cron's drift check and the UI's "Retry pin" button both need
-- to know which CID to ask each gateway about.
ALTER TABLE frozen_versions ADD COLUMN cid_w3s TEXT;
ALTER TABLE frozen_versions ADD COLUMN cid_pinata TEXT;

-- Task #18 follow-up: persist the bytes32 seed emitted by `Minted`.
--
-- Without this, /t/?p=N&id=T can't reproduce the exact art the
-- collector minted: the frozen bundle is keyed off `?seed=0x…`, not
-- `?token=N`, and there's no general way to map tokenId → seed
-- without re-querying the contract. We ship the seed alongside the
-- mint row (NULL for any historical row written before this column
-- existed; the on-chain event remains the source of truth).

ALTER TABLE mints ADD COLUMN seed TEXT;

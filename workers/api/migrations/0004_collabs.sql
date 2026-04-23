-- §12 Artist–Artist Collaboration.
--
-- Each row is a single invite. The same project can have many collabs (one
-- per collaborator). EIP-712 signatures from inviter and (after accept)
-- collaborator are stored verbatim so the audit trail is reproducible from
-- nothing but D1 + the canonical typed-data payload.
--
-- An eventual on-chain CollabAgreement.register(...) tx is recorded in
-- onchain_tx; until then `status='active'` is enough to drive the UI.

CREATE TABLE IF NOT EXISTS collabs (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  inviter_user_id       TEXT NOT NULL REFERENCES users(id),
  inviter_address       TEXT NOT NULL,                 -- lowercased 0x…
  collaborator_address  TEXT NOT NULL,                 -- lowercased 0x… (target)
  collaborator_user_id  TEXT REFERENCES users(id),     -- filled when they accept
  role                  TEXT NOT NULL,                 -- co-artist|engineer|sound|advisor|curator-note
  bps                   INTEGER NOT NULL,              -- of the artist's portion
  nonce                 TEXT NOT NULL,                 -- 0x… 32-byte random
  typed_data_json       TEXT NOT NULL,                 -- canonical EIP-712 envelope
  invite_signature      TEXT NOT NULL,                 -- 0x… 65-byte sig from inviter
  accept_signature      TEXT,                          -- 0x… 65-byte sig from collaborator
  status                TEXT NOT NULL DEFAULT 'pending', -- pending|active|revoked|rejected
  onchain_tx            TEXT,                          -- future: CollabAgreement.register tx hash
  created_at            INTEGER NOT NULL,
  responded_at          INTEGER,
  revoked_at            INTEGER,
  revoked_by            TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_collabs_project       ON collabs(project_id);
CREATE INDEX IF NOT EXISTS idx_collabs_addr          ON collabs(collaborator_address);
CREATE INDEX IF NOT EXISTS idx_collabs_status        ON collabs(status);
CREATE INDEX IF NOT EXISTS idx_collabs_inviter       ON collabs(inviter_user_id);
CREATE INDEX IF NOT EXISTS idx_collabs_collab_user   ON collabs(collaborator_user_id);
CREATE INDEX IF NOT EXISTS idx_collabs_revoked_by    ON collabs(revoked_by);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collabs_pending_unique
  ON collabs(project_id, collaborator_address)
  WHERE status = 'pending';

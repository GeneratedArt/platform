-- Signal core: the source-agnostic layer that turns any personal data
-- stream into a mintable seed.
--
-- The platform renders art from personal data (body, location, listening,
-- spend, calendar). Writing a bespoke path per source is unbounded work,
-- so every source normalises to one of five SIGNAL SHAPES — time series,
-- interval series, point events, spatial trace, categorical distribution
-- (see src/signals/shapes.ts). Adapters target those five; everything
-- downstream sees nothing else. Adding a source is additive.
--
-- WHAT IS DELIBERATELY ABSENT FROM THIS SCHEMA: there is no column
-- anywhere below that holds raw personal data, a sample series, or a
-- feature vector. That is the point. Personal data is parsed in the
-- browser (file imports) or held only in transit (OAuth sources) and
-- reduced to an irreversible seed; only the seed, a hash commitment to
-- the features, and coarse descriptive metadata are persisted. Adding a
-- payload column here would silently convert this into a health-data
-- store subject to GDPR Article 9 — do not add one.
--
-- The derivation is one-way by construction (src/signals/derive.ts):
-- seed = H(features ‖ salt). A seed cannot be inverted to recover the
-- night, the route, or the heartbeat that produced it.

-- A registered origin of data for one user: either a file the user
-- imported, or an authorised third-party account.
CREATE TABLE IF NOT EXISTS data_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Free-text provider key (apple_health, fitbit, garmin, strava,
  -- spotify, manual, ...). Not constrained: the source set is expected to
  -- grow continuously and a CHECK here would mean a migration per source.
  provider      TEXT    NOT NULL,
  -- file_import | oauth_api. These carry DIFFERENT privacy guarantees and
  -- must not be conflated in copy: a file import is parsed client-side and
  -- its bytes never reach the Worker, whereas an OAuth response
  -- necessarily transits the Worker and is discarded after derivation.
  source_class  TEXT    NOT NULL,
  -- The user's own name for it ("Watch", "2019-2026 archive").
  label         TEXT,
  -- active | revoked. Revoking blocks further derivation but never
  -- retroactively invalidates derivations already made — a minted token
  -- cannot be recalled, and the schema should not pretend otherwise.
  status        TEXT    NOT NULL DEFAULT 'active',
  connected_at  INTEGER NOT NULL,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_sources_user
  ON data_sources(user_id, status, created_at DESC);

-- One normalised signal, extracted from a source over a declared window.
-- Describes the signal; never contains it.
CREATE TABLE IF NOT EXISTS signal_imports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id      INTEGER NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  -- One of the five shapes. See src/signals/shapes.ts.
  shape          TEXT    NOT NULL,
  -- What the signal is, in the source's own terms ("heart_rate",
  -- "sleep_stage", "play_event", "commute"). Descriptive only.
  signal_kind    TEXT    NOT NULL,
  -- The window of the person's life this covers, unix seconds.
  window_start   INTEGER NOT NULL,
  window_end     INTEGER NOT NULL,
  -- Coarse quality descriptors, so the UI can be honest about gaps
  -- without retaining the series itself.
  sample_count   INTEGER NOT NULL DEFAULT 0,
  -- 0..10000 basis points of the window actually covered by samples.
  -- Integer to keep D1 comparisons exact.
  coverage_bp    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signal_imports_user
  ON signal_imports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_imports_source
  ON signal_imports(source_id, created_at DESC);

-- The irreversible step: an import becomes a public seed.
CREATE TABLE IF NOT EXISTS derivations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  import_id       INTEGER NOT NULL REFERENCES signal_imports(id) ON DELETE CASCADE,
  -- sha256 over the canonical feature encoding. A COMMITMENT, not the
  -- features: it lets a holder later prove which feature set produced a
  -- seed, without the platform retaining anything invertible.
  feature_digest  TEXT    NOT NULL,
  -- The public, mintable seed. Hex. Feeds the same slot the sketch lane
  -- already mints against (migrations/0015_mint_seed.sql).
  seed            TEXT    NOT NULL,
  -- Which salt generation produced this seed, so the salt can be rotated
  -- without stranding older derivations.
  salt_version    INTEGER NOT NULL DEFAULT 1,
  -- Replay guard, mirroring token_ledger.idempotency_key.
  idempotency_key TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE(idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_derivations_user
  ON derivations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_derivations_import
  ON derivations(import_id);

-- Granular, individually revocable consent. Separate from data_sources
-- because one source can carry several independent permissions and a
-- person must be able to withdraw one without withdrawing the others.
CREATE TABLE IF NOT EXISTS consent_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Null for account-wide consent.
  source_id   INTEGER REFERENCES data_sources(id) ON DELETE CASCADE,
  -- derive | publish_artwork | retain_metadata. Note there is no
  -- 'retain_raw' scope: raw retention is not an option the system offers,
  -- so it is not a consent the user can be asked for.
  scope       TEXT    NOT NULL,
  granted_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_user_scope
  ON consent_records(user_id, scope, revoked_at);

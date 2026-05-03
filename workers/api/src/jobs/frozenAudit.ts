// Nightly drift audit + recovery.
//
// For each frozen_versions row (oldest-checked first) we ask each
// provider whether the CID is still pinned. When a provider that was
// previously pinned now reports the CID as unpinned, we rebuild the
// bundle deterministically from `commit_sha` and re-upload to the
// dropped provider. The bundler is deterministic, so the rebuilt
// bytes hash to the same value as the original pin — but we
// double-check `bundle_hash` before re-pinning and skip recovery
// (with a logged error) on mismatch. That guards against a repo
// that has been force-pushed or had history rewritten in a way that
// would silently change what we re-pin.

import type { Env } from "../types";
import {
  listFrozenForCronAudit,
  updatePinState,
  type FrozenVersionRow,
} from "../db/frozen";
import { getProjectById } from "../db/projects";
import { checkPinHealth, repinTo } from "../lib/pinning";
import { buildBundle } from "../lib/freeze";

interface RebuildResult {
  bytes: Uint8Array;
  filename: string;
}

const AUDIT_BATCH_SIZE = 25;

export interface AuditSummary {
  checked: number;
  drifted: number;
  re_pinned: number;
  rebuild_mismatches: number;
}

export async function runFrozenAudit(env: Env): Promise<AuditSummary> {
  const rows = await listFrozenForCronAudit(env.DB, AUDIT_BATCH_SIZE);
  const summary: AuditSummary = {
    checked: 0,
    drifted: 0,
    re_pinned: 0,
    rebuild_mismatches: 0,
  };
  for (const row of rows) {
    summary.checked++;
    try {
      await auditOne(env, row, summary);
    } catch (err) {
      console.error("frozen_audit_row_failed", row.id, err);
    }
  }
  return summary;
}

async function auditOne(
  env: Env,
  row: FrozenVersionRow,
  summary: AuditSummary,
): Promise<void> {
  // Each provider has its own CID — we have to ask each one about
  // its own CID, not a shared "primary".
  const cidForW3s = row.cid_w3s ?? row.cid;
  const cidForPinata = row.cid_pinata ?? row.cid;
  const [hW3s, hPinata] = await Promise.all([
    checkPinHealth(env, cidForW3s),
    checkPinHealth(env, cidForPinata),
  ]);
  const health = {
    pinned_w3s: hW3s.pinned_w3s,
    pinned_pinata: hPinata.pinned_pinata,
    errors: { ...hW3s.errors, ...hPinata.errors },
  };
  const wasPinnedW3s = row.pinned_w3s === 1;
  const wasPinnedPinata = row.pinned_pinata === 1;
  const driftedW3s = wasPinnedW3s && !health.pinned_w3s;
  const driftedPinata = wasPinnedPinata && !health.pinned_pinata;
  if (driftedW3s || driftedPinata) summary.drifted++;

  // Try to recover any drifted provider by re-uploading the
  // deterministically-rebuilt bundle.
  let recoveredW3s = health.pinned_w3s;
  let recoveredPinata = health.pinned_pinata;
  let cidW3s: string | null | undefined; // undefined = leave as-is
  let cidPinata: string | null | undefined;
  if ((driftedW3s || driftedPinata) && env.PINNING_MOCK !== "1") {
    const rebuild = await tryRebuild(env, row, summary);
    if (rebuild) {
      if (driftedW3s && env.W3S_TOKEN) {
        try {
          const r = await repinTo(env, "w3s", rebuild);
          cidW3s = r.cid;
          recoveredW3s = true;
          summary.re_pinned++;
        } catch (err) {
          console.error("repin_w3s_failed", row.id, err);
        }
      }
      if (driftedPinata && env.PINATA_JWT) {
        try {
          const r = await repinTo(env, "pinata", rebuild);
          cidPinata = r.cid;
          recoveredPinata = true;
          summary.re_pinned++;
        } catch (err) {
          console.error("repin_pinata_failed", row.id, err);
        }
      }
    }
  }

  const partial = !(recoveredW3s && recoveredPinata);
  await updatePinState(env.DB, row.id, {
    pinned_w3s: recoveredW3s,
    pinned_pinata: recoveredPinata,
    pinning_partial: partial,
    pin_errors: Object.keys(health.errors).length > 0 ? health.errors : null,
    cid_w3s: cidW3s,
    cid_pinata: cidPinata,
  });
}

async function tryRebuild(
  env: Env,
  row: FrozenVersionRow,
  summary: AuditSummary,
): Promise<RebuildResult | null> {
  const project = await getProjectById(env.DB, row.project_id);
  if (!project) {
    console.error("audit_rebuild_project_missing", row.id, row.project_id);
    return null;
  }
  const built = await buildBundle(env, {
    repoFull: project.repo_full,
    engine: project.engine,
    title: project.title,
    commit: row.commit_sha,
    projectId: project.id,
  });
  if (built.bundle_hash !== row.bundle_hash) {
    summary.rebuild_mismatches++;
    console.error(
      "audit_rebuild_hash_mismatch",
      row.id,
      "expected",
      row.bundle_hash,
      "got",
      built.bundle_hash,
    );
    return null;
  }
  return {
    bytes: built.bytes,
    filename: `project-${project.id}-${row.bundle_hash.slice(0, 8)}.html`,
  };
}

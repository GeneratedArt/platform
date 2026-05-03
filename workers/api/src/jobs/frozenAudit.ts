// Task #15: nightly drift audit.
//
// Walks the oldest-checked frozen_versions rows and re-checks pin
// health with each provider. If a provider reports the CID as
// unpinned, attempts to re-pin from the original bytes. Today the
// re-pin path is a stub — re-fetching the original bundle would
// require us to either store the bytes in R2 or re-build from the
// repo at the same commit; both are follow-up scope. The audit
// still has value as-is because it surfaces drift in the row's
// pinned_w3s / pinned_pinata flags and timestamps last_checked_at,
// which the UI uses to show "last verified" badges.

import type { Env } from "../types";
import { listFrozenForCronAudit, updatePinState } from "../db/frozen";
import { checkPinHealth } from "../lib/pinning";

const AUDIT_BATCH_SIZE = 25;

export async function runFrozenAudit(env: Env): Promise<{
  checked: number;
  drifted: number;
}> {
  const rows = await listFrozenForCronAudit(env.DB, AUDIT_BATCH_SIZE);
  let drifted = 0;
  for (const row of rows) {
    try {
      const health = await checkPinHealth(env, row.cid);
      const wasPinnedW3s = row.pinned_w3s === 1;
      const wasPinnedPinata = row.pinned_pinata === 1;
      const partial = !(health.pinned_w3s && health.pinned_pinata);
      const driftedNow =
        (wasPinnedW3s && !health.pinned_w3s) ||
        (wasPinnedPinata && !health.pinned_pinata);
      if (driftedNow) drifted++;
      await updatePinState(env.DB, row.id, {
        pinned_w3s: health.pinned_w3s,
        pinned_pinata: health.pinned_pinata,
        pinning_partial: partial,
        pin_errors:
          Object.keys(health.errors).length > 0 ? health.errors : null,
      });
    } catch (err) {
      console.error("frozen_audit_row_failed", row.id, err);
    }
  }
  return { checked: rows.length, drifted };
}

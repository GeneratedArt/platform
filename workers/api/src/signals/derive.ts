/**
 * Seed derivation — the one-way door.
 *
 * `deriveSeed` turns a feature set into the public, mintable seed that
 * drives the artwork. It must be:
 *
 *   - DETERMINISTIC: the same features always yield the same seed, or a
 *     token's provenance claim is meaningless.
 *   - IRREVERSIBLE: no feature value may be recoverable from a seed. The
 *     seed is published on-chain and pinned to IPFS forever; if it were
 *     invertible, minting would be permanent publication of health data.
 *   - SALTED: a per-deployment secret prevents an attacker from
 *     brute-forcing plausible feature sets against a public seed. Without
 *     it, the feature space is small enough (a dozen rounded numbers) that
 *     a dictionary attack is realistic — hashing alone is NOT enough here.
 *
 * The salt is versioned so it can be rotated without stranding existing
 * derivations: a row records which generation produced it.
 */

import type { Features } from "./features";

/** Fixed-point precision for canonical encoding. */
const PRECISION = 6;

/**
 * Current salt generation. Bump alongside SIGNAL_SALT when rotating, and
 * whenever the canonical encoding or an existing feature NAME changes —
 * all of those alter the seed for identical input, and a stale version
 * number would misrepresent how an old seed was produced.
 */
export const SALT_VERSION = 1;

export class DerivationError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

/**
 * Canonical text encoding of a feature set.
 *
 * Sorted by name and written at fixed precision so the encoding does not
 * depend on extraction order or on floating-point noise: the same night
 * parsed on two devices must hash identically, and IEEE-754 arithmetic
 * differs in the last bits across engines. Rounding is what makes the
 * determinism guarantee real rather than approximate.
 */
export function canonicalEncode(features: Features): string {
  if (!features.length) {
    throw new DerivationError("cannot derive from an empty feature set", "empty_features");
  }
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const f of [...features].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (seen.has(f.name)) {
      throw new DerivationError(`duplicate feature name: ${f.name}`, "duplicate_feature");
    }
    seen.add(f.name);
    if (!Number.isFinite(f.value)) {
      throw new DerivationError(`feature ${f.name} is not finite`, "invalid_feature");
    }
    // toFixed then Number-normalise so -0 and 0 encode identically.
    const rounded = Number(f.value.toFixed(PRECISION));
    parts.push(`${f.name}=${rounded === 0 ? 0 : rounded}`);
  }
  return parts.join(";");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Commitment to a feature set: sha256 over the canonical encoding, with
 * no salt. Stored so a holder can later prove which features produced a
 * seed by re-supplying them — the salt is deliberately excluded so this
 * check does not require the platform's secret.
 */
export async function featureDigest(features: Features): Promise<string> {
  return sha256Hex(canonicalEncode(features));
}

/**
 * The public seed. Salted, so the published value cannot be attacked by
 * enumerating plausible feature sets.
 */
export async function deriveSeed(features: Features, salt: string): Promise<string> {
  if (!salt || salt.length < 16) {
    // Failing closed matters more than convenience: a short or missing
    // salt silently removes the only defence against brute-forcing a
    // published seed back to someone's health data.
    throw new DerivationError(
      "signal salt is missing or too short (min 16 chars)",
      "salt_unconfigured",
    );
  }
  return sha256Hex(`ga-signal-v${SALT_VERSION}|${salt}|${canonicalEncode(features)}`);
}

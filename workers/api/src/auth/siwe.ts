import type { Context } from "hono";
import { SiweMessage } from "siwe";
import { isAddress } from "viem";
import type { Env } from "../types";
import { checkRateLimit } from "../lib/rateLimit";
import { upsertUserByAddress } from "../db/users";
import { issueSession, SESSION_TTL_SECONDS } from "./jwt";
import { setSessionCookie } from "../lib/cookies";

const NONCE_TTL_SECONDS = 5 * 60;

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export async function nonceHandler(c: Context<{ Bindings: Env }>) {
  const ip = clientIp(c);
  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `nonce:${ip}`,
    limit: 30,
    windowSeconds: 60,
  });
  if (!rl.ok) {
    return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);
  }

  const nonce = randomNonce();
  await c.env.SESSIONS.put(`nonce:${nonce}`, "1", {
    expirationTtl: NONCE_TTL_SECONDS,
  });
  return c.json({ nonce, expires_in: NONCE_TTL_SECONDS });
}

interface VerifyBody {
  message: string;
  signature: string;
}

export type SiweBindingResult =
  | "ok"
  | "domain_not_allowed"
  | "invalid_siwe_uri"
  | "uri_domain_mismatch";

/**
 * Bind a signed SIWE message to one of the deployment's configured origins.
 *
 * A SIWE message carries `domain` as a bare authority ("host[:port]"); the
 * `scheme` field is optional and our own client (client/auth.ts) sends
 * `window.location.host` without one. Reconstructing an origin by assuming
 * "https://" therefore rejected every http:// entry in ALLOWED_ORIGINS,
 * which made sign-in impossible against a local dev origin. Compare
 * authorities instead, and require the message's `uri` to name the same
 * authority so a signature minted for one deployment can't be replayed
 * against another that shares the allowlist.
 *
 * Exported for unit tests — this is the whole of the origin check.
 */
export function checkSiweBinding(
  allowedOrigins: string,
  msg: { domain: string; uri?: string | null },
): SiweBindingResult {
  const allowedHosts = new Set<string>();
  for (const entry of allowedOrigins.split(",").map((s) => s.trim())) {
    if (!entry) continue;
    try {
      allowedHosts.add(new URL(entry).host);
    } catch {
      // Entry configured as a bare host rather than a full origin.
      allowedHosts.add(entry);
    }
  }
  if (!allowedHosts.has(msg.domain)) return "domain_not_allowed";
  if (msg.uri) {
    let uriHost: string;
    try {
      uriHost = new URL(msg.uri).host;
    } catch {
      return "invalid_siwe_uri";
    }
    if (uriHost !== msg.domain) return "uri_domain_mismatch";
  }
  return "ok";
}

export async function verifyHandler(c: Context<{ Bindings: Env }>) {
  const ip = clientIp(c);
  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `verify:${ip}`,
    limit: 10,
    windowSeconds: 60,
  });
  if (!rl.ok) {
    return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);
  }

  let body: VerifyBody;
  try {
    body = await c.req.json<VerifyBody>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body?.message || !body?.signature) {
    return c.json({ error: "missing_fields" }, 400);
  }

  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(body.message);
  } catch {
    return c.json({ error: "invalid_siwe_message" }, 400);
  }

  const nonceKey = `nonce:${siwe.nonce}`;
  const nonceExists = await c.env.SESSIONS.get(nonceKey);
  if (!nonceExists) {
    return c.json({ error: "unknown_or_expired_nonce" }, 400);
  }

  const bind = checkSiweBinding(c.env.ALLOWED_ORIGINS, {
    domain: siwe.domain,
    uri: siwe.uri,
  });
  if (bind !== "ok") {
    return c.json(
      bind === "domain_not_allowed"
        ? { error: bind, domain: siwe.domain }
        : { error: bind },
      400,
    );
  }

  let verification;
  try {
    verification = await siwe.verify({
      signature: body.signature,
      nonce: siwe.nonce,
    });
  } catch (err) {
    return c.json({ error: "signature_verification_failed" }, 401);
  }
  if (!verification.success) {
    return c.json({ error: "signature_invalid" }, 401);
  }

  await c.env.SESSIONS.delete(nonceKey);

  if (!isAddress(siwe.address)) {
    return c.json({ error: "bad_address" }, 400);
  }

  const user = await upsertUserByAddress(c.env.DB, siwe.address);
  const { token, jti } = await issueSession(c.env.JWT_SECRET, user.id, user.address);

  setSessionCookie(c, token, c.env.COOKIE_DOMAIN, SESSION_TTL_SECONDS);

  return c.json({
    ok: true,
    user: {
      id: user.id,
      address: user.address,
      handle: user.handle,
    },
    session: { jti, expires_in: SESSION_TTL_SECONDS },
  });
}

import { Hono } from "hono";
import { ulid } from "ulid";
import { SiweMessage } from "siwe";
import type { Env, Variables } from "../lib/env";
import { exchangeCodeForToken, fetchGitHubUser } from "../lib/auth-github";
import { upsertGitHubUser, upsertWalletUser } from "../lib/db";
import { createSession, destroySession } from "../lib/session";
import { audit } from "../lib/audit";

export const authRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

authRoutes.post("/github/callback", async (c) => {
  let body: { code?: string; redirect_uri?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body.code) return c.json({ error: "missing_code" }, 400);
  let accessToken: string;
  let ghUser;
  try {
    accessToken = await exchangeCodeForToken(c.env, body.code, body.redirect_uri);
    ghUser = await fetchGitHubUser(accessToken);
  } catch (err) {
    return c.json({ error: "github_oauth_failed", detail: (err as Error).message }, 502);
  }
  const userId = await upsertGitHubUser(c.env, {
    id: ulid(),
    githubLogin: ghUser.login,
    displayName: ghUser.name,
    bio: ghUser.bio,
  });
  const token = await createSession(c.env, userId);
  await audit(c.env, userId, "auth.github.login", userId, { login: ghUser.login });
  return c.json({ token, user_id: userId, github_login: ghUser.login });
});

authRoutes.post("/siwe/verify", async (c) => {
  let body: { message?: string; signature?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body.message || !body.signature) {
    return c.json({ error: "missing_message_or_signature" }, 400);
  }
  let address: string;
  try {
    const siwe = new SiweMessage(body.message);
    const result = await siwe.verify({ signature: body.signature });
    if (!result.success) throw new Error("siwe_verify_failed");
    address = result.data.address.toLowerCase();
  } catch (err) {
    return c.json({ error: "siwe_invalid", detail: (err as Error).message }, 401);
  }
  const userId = await upsertWalletUser(c.env, { id: ulid(), walletAddress: address });
  const token = await createSession(c.env, userId);
  await audit(c.env, userId, "auth.siwe.login", userId, { address });
  return c.json({ token, user_id: userId, wallet_address: address });
});

authRoutes.post("/logout", async (c) => {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    await destroySession(c.env, auth.slice(7));
  }
  return c.json({ ok: true });
});

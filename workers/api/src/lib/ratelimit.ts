import type { Context, Next } from "hono";
import type { Env, Variables } from "./env";

type Bucket = { count: number; windowStart: number };

async function check(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const k = `rl:${key}`;
  const raw = await env.RATE_LIMIT.get(k);
  let bucket: Bucket = raw
    ? (JSON.parse(raw) as Bucket)
    : { count: 0, windowStart: now };
  if (now - bucket.windowStart >= windowSeconds) {
    bucket = { count: 0, windowStart: now };
  }
  bucket.count += 1;
  const allowed = bucket.count <= limit;
  const resetIn = windowSeconds - (now - bucket.windowStart);
  await env.RATE_LIMIT.put(k, JSON.stringify(bucket), {
    expirationTtl: windowSeconds + 5,
  });
  return { allowed, remaining: Math.max(0, limit - bucket.count), resetIn };
}

export async function rateLimit(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next
) {
  const userId = c.get("userId");
  const cf = c.req.raw.headers.get("cf-connecting-ip") ?? "unknown";
  const key = userId ? `u:${userId}` : `ip:${cf}`;
  const limit = userId ? 60 : 10;
  const result = await check(c.env, key, limit, 60);
  c.header("X-RateLimit-Limit", String(limit));
  c.header("X-RateLimit-Remaining", String(result.remaining));
  c.header("X-RateLimit-Reset", String(result.resetIn));
  if (!result.allowed) {
    return c.json({ error: "rate_limited", retry_after: result.resetIn }, 429);
  }
  await next();
}

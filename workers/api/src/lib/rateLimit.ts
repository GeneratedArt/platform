import type { KVNamespace } from "@cloudflare/workers-types";

export interface RateLimitOptions {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;
}

export async function checkRateLimit(
  kv: KVNamespace,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const bucket = `rl:${opts.key}:${Math.floor(now / opts.windowSeconds)}`;
  const raw = await kv.get(bucket);
  const used = raw ? parseInt(raw, 10) : 0;
  if (used >= opts.limit) {
    return {
      ok: false,
      remaining: 0,
      resetAt: (Math.floor(now / opts.windowSeconds) + 1) * opts.windowSeconds,
    };
  }
  await kv.put(bucket, String(used + 1), { expirationTtl: opts.windowSeconds });
  return {
    ok: true,
    remaining: opts.limit - used - 1,
    resetAt: (Math.floor(now / opts.windowSeconds) + 1) * opts.windowSeconds,
  };
}

import { sign, verify } from "hono/jwt";
import type { JWTPayload } from "hono/utils/jwt/types";
import type { JwtPayload } from "../types";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const ALG = "HS256";

export async function issueSession(
  secret: string,
  uid: number,
  address: string,
): Promise<{ token: string; jti: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_TTL_SECONDS;
  const jti = crypto.randomUUID();
  const payload: JWTPayload = {
    sub: address.toLowerCase(),
    uid,
    jti,
    iat: now,
    exp,
  };
  const token = await sign(payload, secret, ALG);
  return { token, jti, exp };
}

export async function verifySession(
  secret: string,
  token: string,
): Promise<JwtPayload | null> {
  try {
    const decoded = (await verify(token, secret, ALG)) as unknown as JwtPayload;
    if (typeof decoded.uid !== "number" || typeof decoded.sub !== "string") {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

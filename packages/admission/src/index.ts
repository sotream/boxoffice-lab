import { createHmac, timingSafeEqual } from "node:crypto";

/** Stateless admission token: `userId.eventId.expiresAtMs.hmac`. The gateway verifies it without touching Redis. */
export function signAdmission(userId: string, eventId: number, ttlSeconds: number, secret: string, now = Date.now()): string {
  const body = `${userId}.${eventId}.${now + ttlSeconds * 1000}`;
  return `${body}.${mac(body, secret)}`;
}

export function verifyAdmission(token: string, eventId: number, secret: string, now = Date.now()): { userId: string } | null {
  const parts = token.split(".");
  if (parts.length < 4) return null;
  const sig = parts.pop() as string;
  const body = parts.join(".");
  const [expStr, evStr] = [parts[parts.length - 1], parts[parts.length - 2]];
  // Canonical lowercase hex only: Buffer.from(..., "hex") silently accepts upper case and ignores trailing garbage,
  // which would make one signature verify under many different token strings.
  if (!/^[0-9a-f]{64}$/.test(sig) || !/^\d{1,16}$/.test(evStr) || !/^\d{1,16}$/.test(expStr)) return null;
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(mac(body, secret), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(evStr) !== eventId || Number(expStr) < now) return null;
  return { userId: parts.slice(0, -2).join(".") };
}

function mac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Service-to-service request signing. The caller never sends the shared secret; it sends a timestamp and an HMAC-SHA256 over
 * `timestamp, method, path (no query), SHA-256 of the body`. A captured header therefore cannot be reused for another path,
 * another method or another body, and stops working after the allowed clock skew. It is still a shared secret: whoever holds
 * it can sign any request, and the service cannot tell its callers apart.
 */
export const INTERNAL_AUTH_HEADER = "x-internal-auth";
export const INTERNAL_AUTH_MAX_SKEW_MS = 30_000;

const FORMAT = /^(\d{1,15})\.([0-9a-f]{64})$/;
const sha256hex = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const mac = (secret: string, ts: string, method: string, path: string, body: string | Buffer): Buffer =>
  createHmac("sha256", secret).update(`${ts}\n${method.toUpperCase()}\n${path}\n${sha256hex(body)}`).digest();

/** `path` is the URL path without the query string; `body` is the exact bytes that are sent (empty for no body). */
export function signInternalRequest(secret: string, method: string, path: string, body: string | Buffer = "", now = Date.now()): string {
  const ts = String(Math.trunc(now));
  return `${ts}.${mac(secret, ts, method, path, body).toString("hex")}`;
}

/** The cheap part, done before the body is read: well-formed and inside the allowed skew. */
export function internalAuthFresh(header: unknown, now = Date.now()): boolean {
  if (typeof header !== "string") return false;
  const m = FORMAT.exec(header);
  return !!m && Math.abs(now - Number(m[1])) <= INTERNAL_AUTH_MAX_SKEW_MS;
}

/** Constant-time check against every accepted secret (current first, then the previous one during a rotation). */
export function verifyInternalRequest(header: unknown, secrets: string[], method: string, path: string, body: string | Buffer, now = Date.now()): boolean {
  if (!internalAuthFresh(header, now)) return false;
  const [, ts, hex] = FORMAT.exec(header as string)!;
  const given = Buffer.from(hex, "hex");
  let ok = false;
  for (const secret of secrets) if (timingSafeEqual(given, mac(secret, ts, method, path, body))) ok = true;
  return ok;
}

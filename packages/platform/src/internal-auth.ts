import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";

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

/** Probe and metrics paths stay open: they carry no business data and orchestrators call them without credentials. */
const OPEN_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);
/** Larger than any legitimate request; an authenticated-looking caller cannot make a service buffer more than this before the signature is checked. */
export const INTERNAL_AUTH_MAX_BODY = 64 * 1024;

/**
 * What the hooks enforce. `verify` gets the raw header, method, path without query and the exact body bytes; `maxBodyBytes` caps what
 * is buffered before that. A service passes its own policy (see the internal-auth.ts of payments and inventory), so what is accepted stays in the
 * service's code and under its mutation tests; `internalAuthPolicy` is the standard one.
 */
export interface InternalAuthPolicy {
  verify(header: unknown, method: string, path: string, body: Buffer): boolean;
  maxBodyBytes: number;
}
export const internalAuthPolicy = (secrets: string[]): InternalAuthPolicy => ({
  verify: (header, method, path, body) => verifyInternalRequest(header, secrets, method, path, body),
  maxBodyBytes: INTERNAL_AUTH_MAX_BODY
});

const reject401 = (reply: { code(n: number): { header(k: string, v: string): { send(b: unknown): unknown } } }) =>
  reply.code(401).header("content-type", "application/json").send({ statusCode: 401, error: "Unauthorized", message: "signed internal request required" });

/**
 * Service-to-service authentication, shared by every service that has callers of its own (payments, inventory): every request
 * except the probe paths must carry `x-internal-auth`, a timestamp and an HMAC over method, path and body. The policy's
 * `verify` checks against the accepted keys: the current one and, during a rotation, the previous one. Each service has its own key.
 *
 * Two hooks, both before the body is parsed and long before any controller or database access, so an unauthenticated caller
 * gets 401 even for a malformed body: `onRequest` rejects a missing, malformed or stale header without reading anything;
 * `preParsing` reads the raw body (capped), verifies the signature over it and hands the same bytes on to the parser.
 * Everything that is not a probe path is denied by default (a route added later is protected without anybody remembering to
 * guard it). Register it AFTER the instrumentation hooks, so that the 401s are counted and carry a request id.
 */
export function installInternalAuth(app: FastifyInstance, policy: InternalAuthPolicy): void {
  app.addHook("onRequest", async (req, reply) => {
    if (OPEN_PATHS.has(req.url.split("?", 1)[0])) return;
    if (!internalAuthFresh(req.headers[INTERNAL_AUTH_HEADER])) return reject401(reply);
  });
  app.addHook("preParsing", async (req, reply, payload) => {
    const path = req.url.split("?", 1)[0];
    if (OPEN_PATHS.has(path)) return payload;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of payload) {
      size += (c as Buffer).length;
      if (size > policy.maxBodyBytes) return reply.code(413).header("content-type", "application/json").send({ statusCode: 413, error: "Payload Too Large", message: "body too large" });
      chunks.push(c as Buffer);
    }
    const body = Buffer.concat(chunks);
    if (!policy.verify(req.headers[INTERNAL_AUTH_HEADER], req.method, path, body)) return reject401(reply);
    return Readable.from(body.length ? [body] : []);
  });
}

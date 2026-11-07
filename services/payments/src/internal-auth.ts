import { Readable } from "node:stream";
import { INTERNAL_AUTH_HEADER, internalAuthFresh, verifyInternalRequest, type wireNest } from "@boxoffice/platform";

/** The Fastify instance under the Nest app (the package has no direct dependency on fastify). */
type Fastify = ReturnType<typeof wireNest>;

export { INTERNAL_AUTH_HEADER };

/** Probe and metrics paths stay open: they carry no business data and orchestrators call them without credentials. */
const OPEN_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);
/** Larger than any legitimate request; an authenticated-looking caller cannot make payments buffer more than this before the signature is checked. */
const MAX_SIGNED_BODY = 64 * 1024;

const reject401 = (reply: { code(n: number): { header(k: string, v: string): { send(b: unknown): unknown } } }) =>
  reply.code(401).header("content-type", "application/json").send({ statusCode: 401, error: "Unauthorized", message: "signed internal request required" });

/**
 * Service-to-service authentication: every request except the probe paths must carry `x-internal-auth`, a timestamp and an
 * HMAC over method, path and body (see packages/platform/src/internal-auth.ts). `secrets` are the accepted keys: the current
 * one and, during a rotation, the previous one.
 *
 * Two hooks, both before the body is parsed and long before any controller or database access, so an unauthenticated caller
 * gets 401 even for a malformed body: `onRequest` rejects a missing, malformed or stale header without reading anything;
 * `preParsing` reads the raw body (capped), verifies the signature over it and hands the same bytes on to the parser.
 * Everything that is not a probe path is denied by default (a route added later is protected without anybody remembering to
 * guard it). Register it AFTER the instrumentation hooks, so that the 401s are counted and carry a request id.
 */
export function installInternalAuth(app: Fastify, secrets: string[]): void {
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
      if (size > MAX_SIGNED_BODY) return reply.code(413).header("content-type", "application/json").send({ statusCode: 413, error: "Payload Too Large", message: "body too large" });
      chunks.push(c as Buffer);
    }
    const body = Buffer.concat(chunks);
    if (!verifyInternalRequest(req.headers[INTERNAL_AUTH_HEADER], secrets, req.method, path, body)) return reject401(reply);
    return Readable.from(body.length ? [body] : []);
  });
}

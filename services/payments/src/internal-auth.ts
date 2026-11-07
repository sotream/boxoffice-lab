import { createHash, timingSafeEqual } from "node:crypto";
import type { wireNest } from "@boxoffice/platform";

/** The Fastify instance under the Nest app (the package has no direct dependency on fastify). */
type Fastify = ReturnType<typeof wireNest>;

export const INTERNAL_TOKEN_HEADER = "x-internal-token";

/** Probe and metrics paths stay open: they carry no business data and orchestrators call them without credentials. */
const OPEN_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);

/**
 * Constant-time comparison of the presented token with the expected one. Both sides are hashed first, so the buffers always
 * have the same length (timingSafeEqual throws on different lengths) and the length of the secret does not leak through timing.
 */
export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Service-to-service authentication: every request except the probe paths must carry `x-internal-token` equal to the shared secret.
 * It is an onRequest hook, so it runs before the body is read or parsed and long before any controller or database access:
 * an unauthenticated caller gets 401 even for a malformed body. Everything that is not a probe path is denied by default
 * (a route added later is protected without anybody remembering to guard it).
 * Register it AFTER the instrumentation hooks, so that the 401s are counted and carry a request id.
 */
export function installInternalAuth(app: Fastify, expected: string): void {
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?", 1)[0];
    if (OPEN_PATHS.has(path)) return;
    if (!tokenMatches(req.headers[INTERNAL_TOKEN_HEADER], expected)) {
      return reply.code(401).header("content-type", "application/json").send({ statusCode: 401, error: "Unauthorized", message: "internal token required" });
    }
  });
}

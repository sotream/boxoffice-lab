import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { contextFromHeaders, runWithContext, TraceContext } from "./context";
import { Readiness } from "./health";
import { getLogger } from "./logger";
import { counter, gauge, histogram, metricsContentType, metricsText } from "./metrics";

export const HTTP_REQUESTS = "http_requests_total";
export const HTTP_DURATION = "http_request_duration_seconds";
export const HTTP_IN_FLIGHT = "http_requests_in_flight";

const OPS_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);
const KNOWN_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export const statusClass = (code: number): string => `${Math.floor(code / 100)}xx`;

export interface InstrumentOptions {
  /** Bounded route label. Default: the registered route pattern ("/events/:eventId/holds"), never the raw URL. */
  routeLabel?: (req: FastifyRequest) => string;
}

const contexts = new WeakMap<object, TraceContext>();
export const requestContext = (req: object): TraceContext | undefined => contexts.get(req);

/**
 * RED metrics + correlation for every route of a Fastify instance (also the one inside a Nest app).
 * Registered as hooks, so it works for any framework on top. Probe endpoints (/healthz, /readyz, /metrics) are not counted:
 * they would dilute the success ratio and the latency of real traffic.
 * Request-level logs: 5xx at error, everything else at debug (a log line per request is itself a cost at flash-sale rates).
 */
export function instrumentFastify(app: FastifyInstance, o: InstrumentOptions = {}): void {
  const requests = counter(HTTP_REQUESTS, "HTTP requests by route and status class.", ["method", "route", "status_class"]);
  const duration = histogram(HTTP_DURATION, "HTTP request duration in seconds, from first byte to response close.", ["method", "route"]);
  const inFlight = gauge(HTTP_IN_FLIGHT, "HTTP requests currently being served.");
  const routeLabel = o.routeLabel ?? ((req: FastifyRequest) => req.routeOptions?.url ?? "unmatched");

  app.addHook("onRequest", (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const ctx = contextFromHeaders(req.headers);
    contexts.set(req, ctx);
    reply.header("x-request-id", ctx.requestId);
    const path = req.url.split("?", 1)[0];
    if (!OPS_PATHS.has(path)) {
      const t0 = process.hrtime.bigint();
      inFlight.inc();
      let finished = false;
      // 'close' fires for completed responses and for clients that hang up, so the in-flight gauge cannot leak.
      reply.raw.once("close", () => {
        if (finished) return;
        finished = true;
        inFlight.dec();
        const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
        const method = KNOWN_METHODS.has(req.method) ? req.method : "OTHER";
        const route = routeLabel(req);
        const code = reply.raw.statusCode;
        requests.inc({ method, route, status_class: statusClass(code) });
        duration.observe({ method, route }, seconds);
        const log = getLogger();
        const f = { method, route, status: code, durationMs: Math.round(seconds * 1000), requestId: ctx.requestId, traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: ctx.parentSpanId };
        if (code >= 500) log.error("request failed", f); else log.debug("request", f);
      });
    }
    runWithContext(ctx, done);
  });
}

export interface OpsRouteOptions { readiness: Readiness }

/** /healthz (liveness: no dependency calls), /readyz (503 with a per-dependency body), /metrics (Prometheus text). */
export function registerOpsRoutes(app: FastifyInstance, o: OpsRouteOptions): void {
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    const r = await o.readiness.evaluate();
    reply.status(r.ok ? 200 : 503);
    return r.body;
  });
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", metricsContentType());
    return metricsText();
  });
}

/** Nest-on-Fastify: instrument + ops routes on the underlying Fastify instance. Call before app.listen()/init(). */
export function wireNest(app: { getHttpAdapter(): { getInstance(): unknown } }, readiness: Readiness, o: InstrumentOptions = {}): FastifyInstance {
  const f = app.getHttpAdapter().getInstance() as FastifyInstance;
  instrumentFastify(f, o);
  registerOpsRoutes(f, { readiness });
  return f;
}

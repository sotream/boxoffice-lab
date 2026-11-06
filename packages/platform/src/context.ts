import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";

/** Per-request correlation: one requestId and one W3C trace id follow a purchase across hops; each hop has its own span id. */
export interface TraceContext {
  requestId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  flags: string;
}

const als = new AsyncLocalStorage<TraceContext>();

export const currentContext = (): TraceContext | undefined => als.getStore();
export const runWithContext = <T>(ctx: TraceContext, fn: () => T): T => als.run(ctx, fn);

export const newTraceId = (): string => randomBytes(16).toString("hex");
export const newSpanId = (): string => randomBytes(8).toString("hex");

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
export function parseTraceparent(h: string | undefined): { traceId: string; spanId: string; flags: string } | null {
  if (!h) return null;
  const m = TRACEPARENT.exec(h.trim().toLowerCase());
  if (!m || m[1] === "ff" || /^0+$/.test(m[2]) || /^0+$/.test(m[3])) return null;
  return { traceId: m[2], spanId: m[3], flags: m[4] };
}
export const formatTraceparent = (c: Pick<TraceContext, "traceId" | "spanId" | "flags">): string => `00-${c.traceId}-${c.spanId}-${c.flags}`;

/** Accept a caller-supplied request id only if it is short and printable; otherwise it could be used to inject into logs. */
const REQUEST_ID = /^[A-Za-z0-9._:\-]{1,128}$/;

type Headers = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Context for a request that just arrived: reuse the caller's request id and trace id when valid, else generate them
 * (this is how the gateway becomes the trace root). The span id is always new; the caller's span becomes the parent.
 */
export function contextFromHeaders(headers: Headers): TraceContext {
  const rid = first(headers["x-request-id"]);
  const tp = parseTraceparent(first(headers["traceparent"]));
  return {
    requestId: rid && REQUEST_ID.test(rid) ? rid : randomUUID(),
    traceId: tp?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    parentSpanId: tp?.spanId,
    flags: tp?.flags ?? "01"
  };
}

/** Headers for an outgoing call: the next hop sees this hop's span as its parent. Empty outside a request. */
export function outgoingHeaders(ctx: TraceContext | undefined = currentContext()): Record<string, string> {
  return ctx ? { "x-request-id": ctx.requestId, traceparent: formatTraceparent(ctx) } : {};
}

/** The two fields to store in an outbox payload so a later, asynchronous hop can continue the same trace. */
export function traceFields(ctx: TraceContext | undefined = currentContext()): { requestId: string; traceparent: string } | undefined {
  return ctx ? { requestId: ctx.requestId, traceparent: formatTraceparent(ctx) } : undefined;
}

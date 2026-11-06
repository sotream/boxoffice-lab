import { Counter, Gauge, Histogram, collectDefaultMetrics, register } from "prom-client";
import type { Pool } from "pg";

export { register, Counter, Gauge, Histogram };

/**
 * Latency buckets in seconds. They are dense around the SLO thresholds in docs/operations.md (0.1, 0.25, 0.5, 1, 2.5)
 * because histogram_quantile and "fraction under X" are only exact at bucket boundaries.
 */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

let started = false;
/** Default registry, one per process. Every series gets a `service` label; Node/process default metrics are enabled once. */
export function initMetrics(service: string, defaults = true): void {
  register.setDefaultLabels({ service });
  if (defaults && !started) { started = true; collectDefaultMetrics(); }
}

/** Create-or-reuse by name, so importing a metrics module twice (tests, hot paths) never throws "already registered". */
export function counter(name: string, help: string, labelNames: string[] = []): Counter<string> {
  return (register.getSingleMetric(name) as Counter<string> | undefined) ?? new Counter({ name, help, labelNames });
}
export function gauge(name: string, help: string, labelNames: string[] = [], collect?: (this: Gauge<string>) => void | Promise<void>): Gauge<string> {
  return (register.getSingleMetric(name) as Gauge<string> | undefined) ?? new Gauge({ name, help, labelNames, collect });
}
export function histogram(name: string, help: string, labelNames: string[] = [], buckets = DURATION_BUCKETS): Histogram<string> {
  return (register.getSingleMetric(name) as Histogram<string> | undefined) ?? new Histogram({ name, help, labelNames, buckets });
}

/** Names of the standard pool gauges (USE: utilisation = total-idle, saturation = waiting). */
export const POOL_TOTAL = "pg_pool_total_connections";
export const POOL_IDLE = "pg_pool_idle_connections";
export const POOL_WAITING = "pg_pool_waiting_clients";

const pools = new Map<string, Pool>();
/** Expose total/idle/waiting for a pool, read at scrape time (no timers). `name` is a fixed string per pool, never user input. */
export function registerPoolMetrics(pool: Pool, name: string): void {
  pools.set(name, pool);
  const each = (read: (p: Pool) => number) => function (this: Gauge<string>) { for (const [n, p] of pools) this.set({ pool: n }, read(p)); };
  gauge(POOL_TOTAL, "Open connections in the pool (idle + in use).", ["pool"], each((p) => p.totalCount));
  gauge(POOL_IDLE, "Idle connections in the pool.", ["pool"], each((p) => p.idleCount));
  gauge(POOL_WAITING, "Requests waiting for a free connection (pool saturation).", ["pool"], each((p) => p.waitingCount));
}

export const metricsText = (): Promise<string> => register.metrics();
export const metricsContentType = (): string => register.contentType;

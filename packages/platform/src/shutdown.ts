import { Readiness } from "./health";
import { getLogger, Logger } from "./logger";

export interface ShutdownOptions {
  /** Total time for all steps. Default 10 s (SHUTDOWN_DEADLINE_MS in the services). */
  deadlineMs?: number;
  /** Pause after going not-ready and before closing the listener, so a load balancer can notice. Default 0. */
  drainDelayMs?: number;
  readiness?: Readiness;
  logger?: Logger;
  /** Injectable for tests. */
  exit?: (code: number) => void;
  proc?: Pick<NodeJS.Process, "on" | "off">;
  signals?: NodeJS.Signals[];
}

export interface Shutdown {
  /** Steps run in registration order: register "stop accepting", then "stop workers", then "close clients". */
  add(name: string, fn: () => Promise<unknown> | unknown): void;
  install(): void;
  /** Resolves with the exit code once the sequence has finished (also what is passed to exit()). */
  trigger(reason: string): Promise<number>;
  readonly started: boolean;
}

/**
 * Graceful shutdown. First signal: go not-ready, run the steps in order under one deadline, exit 0 (1 if a step failed or the
 * deadline passed). Second signal while draining: exit immediately with 1.
 */
export function createShutdown(o: ShutdownOptions = {}): Shutdown {
  const steps: { name: string; fn: () => Promise<unknown> | unknown }[] = [];
  const log = () => o.logger ?? getLogger();
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const proc = o.proc ?? process;
  const deadlineMs = o.deadlineMs ?? 10_000;
  let running: Promise<number> | undefined;

  const run = async (reason: string): Promise<number> => {
    const t0 = Date.now();
    log().info("shutdown started", { reason, deadlineMs });
    o.readiness?.setDraining();
    let failed = false;
    const remaining = () => Math.max(0, deadlineMs - (Date.now() - t0));
    if (o.drainDelayMs) await new Promise((r) => setTimeout(r, Math.min(o.drainDelayMs!, remaining())));
    for (const s of steps) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(s.fn),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`deadline of ${deadlineMs} ms exceeded`)), remaining()); })
        ]);
        log().info("shutdown step done", { step: s.name, elapsedMs: Date.now() - t0 });
      } catch (e) {
        failed = true;
        log().error("shutdown step failed", { step: s.name, err: e });
      } finally { clearTimeout(timer); }
    }
    const code = failed ? 1 : 0;
    log().info("shutdown complete", { code, elapsedMs: Date.now() - t0 });
    exit(code);
    return code;
  };

  const trigger = (reason: string) => (running ??= run(reason));
  const handler = (sig: NodeJS.Signals) => {
    if (running) { log().warn("second signal, forcing exit", { signal: sig }); exit(1); return; }
    void trigger(sig);
  };

  return {
    add: (name, fn) => { steps.push({ name, fn }); },
    install: () => { for (const s of o.signals ?? ["SIGTERM", "SIGINT"]) proc.on(s, handler); },
    trigger,
    get started() { return running !== undefined; }
  };
}

/**
 * Stop an HTTP server without cutting off work: `close` (app.close()) stops accepting and waits for in-flight requests, while
 * this polls closeIdleConnections(). Without the poll, a keep-alive connection that becomes idle AFTER close() started stays open
 * for the keep-alive timeout (72 s in Fastify) and the shutdown hangs until the deadline.
 */
export async function drainHttp(server: { closeIdleConnections?: () => void }, close: () => Promise<unknown>, pollMs = 50): Promise<void> {
  const t = setInterval(() => server.closeIdleConnections?.(), pollMs);
  try { await close(); } finally { clearInterval(t); }
}

import { getLogger } from "./logger";

export interface LoopOptions {
  name: string;
  /** One iteration. May return how much work it did (see `drain`). */
  fn: () => Promise<number | void>;
  /** Sleep between iterations. */
  intervalMs: number;
  /** Sleep after a failed iteration. */
  errorDelayMs?: number;
  /** When true, an iteration that returned > 0 is followed immediately by the next one (drain until empty, then sleep). */
  drain?: boolean;
  onError?: (e: unknown) => void;
}
export interface Loop { stop(): Promise<void> }

/** Background loop that can be stopped cleanly: stop() wakes it from sleep and waits for the running iteration to finish. */
export function startLoop(o: LoopOptions): Loop {
  let stopped = false;
  let wake: (() => void) | undefined;
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
  const done = (async () => {
    while (!stopped) {
      let delay = o.intervalMs;
      try {
        const n = await o.fn();
        if (o.drain && typeof n === "number" && n > 0) delay = 0;
      } catch (e) {
        delay = o.errorDelayMs ?? o.intervalMs;
        if (o.onError) o.onError(e); else getLogger().warn(`loop ${o.name} failed`, { err: e });
      }
      if (!stopped && delay > 0) await sleep(delay);
    }
  })();
  return { stop: async () => { stopped = true; wake?.(); await done; } };
}

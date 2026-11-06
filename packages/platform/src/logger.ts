import { currentContext } from "./context";

export const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 100 } as const;
export type Level = keyof typeof LEVELS;
export type Fields = Record<string, unknown>;

export interface Logger {
  level: Level;
  trace(msg: string, f?: Fields): void;
  debug(msg: string, f?: Fields): void;
  info(msg: string, f?: Fields): void;
  warn(msg: string, f?: Fields): void;
  error(msg: string, f?: Fields): void;
  fatal(msg: string, f?: Fields): void;
  child(f: Fields): Logger;
}

export function serializeError(e: unknown, depth = 0): unknown {
  if (!(e instanceof Error)) return e;
  const o: Fields = { type: e.constructor?.name ?? e.name, message: e.message, stack: e.stack };
  const code = (e as { code?: unknown }).code;
  if (code !== undefined) o.code = code;
  if (e.cause !== undefined && depth < 3) o.cause = serializeError(e.cause, depth + 1);
  return o;
}

/** Silent under vitest/NODE_ENV=test unless LOG_LEVEL is set explicitly. */
export function defaultLevel(env: NodeJS.ProcessEnv = process.env): Level {
  const v = env.LOG_LEVEL?.toLowerCase();
  if (v && v in LEVELS) return v as Level;
  return env.NODE_ENV === "test" || env.VITEST ? "silent" : "info";
}

export interface LoggerOptions { service: string; level?: Level; write?: (line: string) => void; base?: Fields }

/** One JSON object per line on stdout. Request id / trace ids are added from the async context of the call. */
export function createLogger(o: LoggerOptions): Logger {
  const write = o.write ?? ((l: string) => { process.stdout.write(l + "\n"); });
  const make = (base: Fields, level: Level): Logger => {
    const emit = (lvl: Exclude<Level, "silent">) => (msg: string, f?: Fields) => {
      if (LEVELS[lvl] < LEVELS[self.level]) return;
      const ctx = currentContext();
      const rec: Fields = { time: new Date().toISOString(), level: lvl, service: o.service, msg };
      if (ctx) { rec.requestId = ctx.requestId; rec.traceId = ctx.traceId; rec.spanId = ctx.spanId; if (ctx.parentSpanId) rec.parentSpanId = ctx.parentSpanId; }
      Object.assign(rec, base);
      if (f) for (const [k, v] of Object.entries(f)) rec[k] = v instanceof Error ? serializeError(v) : v;
      let line: string;
      try { line = JSON.stringify(rec); } catch { line = JSON.stringify({ time: rec.time, level: lvl, service: o.service, msg, logError: "unserialisable fields" }); }
      write(line);
    };
    const self: Logger = {
      level,
      trace: emit("trace"), debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error"), fatal: emit("fatal"),
      child: (f) => { const c = make({ ...base, ...f }, self.level); return c; }
    };
    return self;
  };
  return make(o.base ?? {}, o.level ?? defaultLevel());
}

let root: Logger = createLogger({ service: "app" });
/** Set once per process by initService(); library code (pool errors, shutdown) logs through this. */
export const setRootLogger = (l: Logger) => { root = l; };
export const getLogger = (): Logger => root;

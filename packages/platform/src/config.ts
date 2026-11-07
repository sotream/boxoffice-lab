/** Thrown at boot with every problem found, so one restart fixes all of them instead of one per restart. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export interface NumOpts { min?: number; max?: number }

/**
 * Tiny typed env reader. Each accessor returns the default (and records a problem) on bad input,
 * so a builder function can read every variable and `done()` reports all problems at once.
 * An empty string counts as unset, so `PORT= node ...` behaves like no PORT.
 */
export class EnvReader {
  readonly problems: string[] = [];
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get production(): boolean { return this.env.NODE_ENV === "production"; }

  private raw(name: string): string | undefined {
    const v = this.env[name];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  }

  str(name: string, def: string): string {
    return this.raw(name) ?? def;
  }

  /** Required string with no default. */
  required(name: string): string {
    const v = this.raw(name);
    if (v === undefined) { this.problems.push(`${name} is required`); return ""; }
    return v;
  }

  int(name: string, def: number, o: NumOpts = {}): number {
    const v = this.raw(name);
    if (v === undefined) return def;
    if (!/^-?\d+$/.test(v)) { this.problems.push(`${name} must be an integer, got "${v}"`); return def; }
    return this.bounded(name, Number(v), def, o);
  }

  num(name: string, def: number, o: NumOpts = {}): number {
    const v = this.raw(name);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n)) { this.problems.push(`${name} must be a number, got "${v}"`); return def; }
    return this.bounded(name, n, def, o);
  }

  private bounded(name: string, n: number, def: number, o: NumOpts): number {
    if (o.min !== undefined && n < o.min) { this.problems.push(`${name} must be >= ${o.min}, got ${n}`); return def; }
    if (o.max !== undefined && n > o.max) { this.problems.push(`${name} must be <= ${o.max}, got ${n}`); return def; }
    return n;
  }

  port(name: string, def: number): number {
    return this.int(name, def, { min: 0, max: 65535 });
  }

  bool(name: string, def: boolean): boolean {
    const v = this.raw(name)?.toLowerCase();
    if (v === undefined) return def;
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
    this.problems.push(`${name} must be a boolean (1/0/true/false), got "${v}"`);
    return def;
  }

  list(name: string, def: string[] = []): string[] {
    const v = this.raw(name);
    return v === undefined ? def : v.split(",").map((x) => x.trim()).filter(Boolean);
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], def: T): T {
    const v = this.raw(name);
    if (v === undefined) return def;
    if (!(allowed as readonly string[]).includes(v)) { this.problems.push(`${name} must be one of ${allowed.join("|")}, got "${v}"`); return def; }
    return v as T;
  }

  url(name: string, def: string, protocols: string[] = ["http:", "https:"]): string {
    const v = this.raw(name) ?? def;
    try {
      const u = new URL(v);
      if (!protocols.includes(u.protocol)) throw new Error("protocol");
    } catch { this.problems.push(`${name} must be a URL with protocol ${protocols.join(" or ")}, got "${v}"`); }
    return v;
  }

  /** host:port pair, e.g. a Kafka broker. */
  hostPort(name: string, def: string): string {
    const v = this.raw(name) ?? def;
    if (!/^[^:\s]+:\d{1,5}$/.test(v)) this.problems.push(`${name} must be host:port, got "${v}"`);
    return v;
  }

  /**
   * A secret that has a development default. With NODE_ENV=production the variable must be set and must not equal
   * the development default (or any value in `forbidden`).
   */
  secret(name: string, devDefault: string, forbidden: string[] = []): string {
    const v = this.raw(name);
    if (this.production) {
      if (v === undefined) { this.problems.push(`${name} must be set when NODE_ENV=production (the development default is refused)`); return devDefault; }
      if (v === devDefault || forbidden.includes(v)) { this.problems.push(`${name} is set to a known development value; refused when NODE_ENV=production`); return v; }
    }
    return v ?? devDefault;
  }

  /** A safety control that is on by default and may be switched off only outside production (tests, benchmarks). */
  safeguard(name: string): boolean {
    const on = this.bool(name, true);
    if (!on && this.production) this.problems.push(`${name} cannot be switched off when NODE_ENV=production`);
    return on;
  }

  /** A secret that may be absent (for example the previous key during a rotation). Refused in production when it is a known development value. */
  optionalSecret(name: string, forbidden: string[] = []): string | undefined {
    const v = this.raw(name);
    if (v !== undefined && this.production && forbidden.includes(v)) this.problems.push(`${name} is set to a known development value; refused when NODE_ENV=production`);
    return v;
  }

  /** Throws ConfigError when any accessor recorded a problem. */
  done(): void {
    if (this.problems.length) throw new ConfigError([...this.problems]);
  }
}

/** Build a typed config object from the environment; throws one ConfigError listing every problem. */
export function loadConfig<T>(build: (e: EnvReader) => T, env: NodeJS.ProcessEnv = process.env): T {
  const r = new EnvReader(env);
  const cfg = build(r);
  r.done();
  return cfg;
}

/** Boot wrapper for main.ts: prints a readable message and exits 78 (EX_CONFIG) instead of a stack trace. */
export function loadConfigOrExit<T>(build: (e: EnvReader) => T, env: NodeJS.ProcessEnv = process.env): T {
  try { return loadConfig(build, env); }
  catch (e) {
    if (e instanceof ConfigError) { process.stderr.write(`${e.message}\n`); process.exit(78); }
    throw e;
  }
}

/** SHUTDOWN_DEADLINE_MS (total drain time, default 10 s) and SHUTDOWN_DRAIN_DELAY_MS (wait after going not-ready, default 0). */
export const shutdownEnv = (e: EnvReader) => ({
  deadlineMs: e.int("SHUTDOWN_DEADLINE_MS", 10_000, { min: 100 }),
  drainDelayMs: e.int("SHUTDOWN_DRAIN_DELAY_MS", 0, { min: 0 })
});

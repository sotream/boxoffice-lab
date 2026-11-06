import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { run, parseNumber, fmt, usage } from "./cli.js";
import {
  LATENCY_NS,
  SECONDS_PER_DAY,
  avgRps,
  bandwidth,
  cacheBytes,
  concurrency,
  humanBytes,
  instancesNeeded,
  peakRps,
  shardsNeeded,
  storageBytes
} from "./index.js";

const N = { numRuns: 500 };
const pos = fc.double({ min: 1e-3, max: 1e9, noNaN: true });
const posInt = fc.integer({ min: 1, max: 1_000_000_000 });
const util = fc.double({ min: 0.05, max: 1, noNaN: true });
const REL = 1e-9; // float tolerance for the "capacity covers the peak" check

describe("traffic formulas", () => {
  const traffic = fc.record({ dau: pos, actionsPerUser: pos, peakFactor: pos });

  it("avg RPS is dau x actions / 86 400 and peak = avg x factor", () => {
    fc.assert(
      fc.property(traffic, (t) => {
        expect(avgRps(t)).toBeCloseTo((t.dau * t.actionsPerUser) / SECONDS_PER_DAY, 6);
        expect(peakRps(t)).toBeCloseTo(avgRps(t) * t.peakFactor, 6);
        expect(peakRps(t)).toBeGreaterThanOrEqual(t.peakFactor >= 1 ? avgRps(t) * (1 - REL) : 0);
      }),
      N
    );
  });

  it("is monotone in every input and linear in dau", () => {
    fc.assert(
      fc.property(traffic, fc.double({ min: 1, max: 10, noNaN: true }), (t, k) => {
        for (const key of ["dau", "actionsPerUser", "peakFactor"] as const) {
          expect(peakRps({ ...t, [key]: t[key] * k })).toBeGreaterThanOrEqual(peakRps(t) * (1 - REL));
        }
        expect(Math.abs(avgRps({ ...t, dau: t.dau * k }) - avgRps(t) * k)).toBeLessThanOrEqual(avgRps(t) * k * 1e-9);
      }),
      N
    );
  });
});

describe.each([
  ["instancesNeeded", instancesNeeded],
  ["shardsNeeded", shardsNeeded]
])("%s (ceil with headroom)", (_name, f) => {
  it("returns an integer >= 1 whose capacity covers the peak, and one fewer would not", () => {
    fc.assert(
      fc.property(pos, pos, (peak, per) => {
        const n = f(peak, per); // default utilisation 0.6
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n * per * 0.6).toBeGreaterThanOrEqual(peak * (1 - REL)); // instances x per_instance x 0.6 >= peak
        if (n > 1) expect((n - 1) * per * 0.6).toBeLessThan(peak * (1 + REL)); // minimal: ceil, not "+1"
      }),
      N
    );
  });

  it("is monotone: more peak needs >= instances, more per-instance capacity or utilisation needs <=", () => {
    fc.assert(
      fc.property(pos, pos, util, fc.double({ min: 1, max: 100, noNaN: true }), (peak, per, u, k) => {
        expect(f(peak * k, per, u)).toBeGreaterThanOrEqual(f(peak, per, u));
        expect(f(peak, per * k, u)).toBeLessThanOrEqual(f(peak, per, u));
        expect(f(peak, per, Math.min(1, u * k))).toBeLessThanOrEqual(f(peak, per, u));
      }),
      N
    );
  });

  it("exact multiples do not round up (ceil semantics, not floor+1) and fractions do", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 100_000 }), (n, per) => {
        // peak = n x per x 1.0 utilisation is an exact integer ratio
        expect(f(n * per, per, 1)).toBe(n);
        expect(f(n * per + 1, per, 1)).toBe(n + 1);
      }),
      N
    );
    expect(f(1, 1000)).toBe(1); // tiny load still needs one
  });

  it("inverse: needed capacity at the returned count is within one instance of the peak at utilisation", () => {
    fc.assert(
      fc.property(pos, pos, util, (peak, per, u) => {
        const n = f(peak, per, u);
        expect(n * per * u - peak).toBeLessThan(per * u * (1 + REL));
      }),
      N
    );
  });

  it("documented examples (README: 520 users/s derivation style)", () => {
    expect(f(10_000, 2_654)).toBe(7); // 10000 / (2654 x 0.6) = 6.28
    expect(f(1_592, 2_654)).toBe(1);
    expect(f(1_593, 2_654)).toBe(2);
  });
});

describe("other formulas", () => {
  it("Little's law and bandwidth are bilinear and commutative in their operands", () => {
    fc.assert(
      fc.property(pos, pos, (a, b) => {
        expect(concurrency(a, b)).toBe(concurrency(b, a));
        expect(bandwidth(a, b)).toBe(bandwidth(b, a));
        expect(concurrency(a * 2, b)).toBe(2 * concurrency(a, b));
      }),
      N
    );
  });

  it("storage is the product of its factors, replication defaults to 1, and scales linearly with years", () => {
    fc.assert(
      fc.property(posInt, posInt, fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1, max: 5 }), (rec, bytes, years, repl) => {
        const s = storageBytes({ recordsPerDay: rec, bytesPerRecord: bytes, years, replication: repl });
        expect(s).toBe(rec * bytes * 365 * years * repl);
        expect(storageBytes({ recordsPerDay: rec, bytesPerRecord: bytes, years })).toBe(rec * bytes * 365 * years);
        expect(storageBytes({ recordsPerDay: rec, bytesPerRecord: bytes, years: years * 2, replication: repl })).toBe(2 * s);
      }),
      N
    );
  });

  it("cache size is the hot fraction of the daily read bytes and monotone in it", () => {
    fc.assert(
      fc.property(pos, util, util, (bytes, h1, h2) => {
        expect(cacheBytes(bytes)).toBeCloseTo(bytes * 0.2, 3);
        const [lo, hi] = h1 <= h2 ? [h1, h2] : [h2, h1];
        expect(cacheBytes(bytes, lo)).toBeLessThanOrEqual(cacheBytes(bytes, hi));
        expect(cacheBytes(bytes, 1)).toBe(bytes);
      }),
      N
    );
  });

  it("humanBytes: valid format, unit grows monotonically, round-trips within rounding, never throws", () => {
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const mult = Object.fromEntries(units.map((u, i) => [u, 1000 ** i]));
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e18, noNaN: true }), (b) => {
        const m = /^(\d+(?:\.\d)?) (B|KB|MB|GB|TB|PB)$/.exec(humanBytes(b));
        expect(m, humanBytes(b)).not.toBeNull();
        const back = Number(m![1]) * mult[m![2]];
        expect(Math.abs(back - b)).toBeLessThanOrEqual(b * 0.051 + 0.06);
      }),
      N
    );
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e17, noNaN: true }), (b) => {
        const idx = (x: number) => units.indexOf(humanBytes(x).split(" ")[1]);
        expect(idx(b * 10)).toBeGreaterThanOrEqual(idx(b));
      }),
      N
    );
    expect(humanBytes(999)).toBe("999 B");
    expect(humanBytes(1000)).toBe("1.0 KB");
    expect(humanBytes(5_475_000_000_000)).toBe("5.5 TB");
    expect(humanBytes(1e21)).toMatch(/PB$/); // clamps at the largest unit
  });

  it("latency table is strictly increasing (orders of magnitude)", () => {
    const v = Object.values(LATENCY_NS);
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThan(v[i - 1]);
  });
});

describe("CLI parsing fuzz", () => {
  it("parseNumber: positive numbers with suffixes round-trip, everything else is undefined, never throws", () => {
    const mult: Record<string, number> = { "": 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 };
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999_999 }), fc.constantFrom("", "k", "K", "m", "M", "g", "G", "t", "T"), (n, suf) => {
        expect(parseNumber(`${n}${suf}`)).toBe(n * mult[suf.toLowerCase()]);
        expect(parseNumber(` ${n}${suf} `)).toBe(n * mult[suf.toLowerCase()]);
      }),
      N
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        const v = parseNumber(s);
        if (v !== undefined) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThan(0);
        }
      }),
      { numRuns: 2000 }
    );
    for (const bad of ["", " ", "-1", "+1", "0", "0k", "1.", ".", "1e999", "1x", "NaN", "Infinity", "0x10", "1 k", "1kk", "١"]) {
      expect(parseNumber(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("fmt never throws and returns a short, non-empty string for any finite number", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (x) => {
        const s = fmt(x);
        expect(s.length).toBeGreaterThan(0);
      }),
      N
    );
  });

  it("run() is total: arbitrary argv gives exit code 0 or 2, non-empty output, never throws", () => {
    const names = ["traffic", "instances", "storage", "concurrency", "shards", "bandwidth", "cache", "help", "--help", "-h", "--", "__proto__", "constructor", "toString", ""];
    const flags = ["--dau", "--actions", "--peak", "--per-instance", "--util", "--rps", "--bytes", "--hot", "--years", "--replication", "--bogus", "-x", "--", "--=", "--dau=5"];
    const tok = fc.oneof(fc.constantFrom(...names, ...flags), fc.string({ maxLength: 12 }), fc.integer().map(String), fc.constantFrom("1k", "2.5M", "0", "-3", "1e999", "NaN"));
    fc.assert(
      fc.property(fc.array(tok, { maxLength: 10 }), (argv) => {
        const r = run(argv);
        expect([0, 2]).toContain(r.code);
        expect(r.out.length).toBeGreaterThan(0);
        if (r.code === 2) expect(r.out).toContain(usage());
        if (r.code === 0) expect(r.out).not.toMatch(/NaN|Infinity|undefined/);
      }),
      { numRuns: 3000 }
    );
  });

  it("run() with valid generated arguments always succeeds, and its answer matches the formula", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 99 }), (peak, per, u100) => {
        const u = u100 / 100;
        const r = run(["instances", "--peak", String(peak), "--per-instance", String(per), "--util", String(u)]);
        expect(r.code).toBe(0);
        expect(r.out.endsWith(`= ${instancesNeeded(peak, per, u)}`)).toBe(true);
        const s = run(["shards", "--peak-writes", String(peak), "--per-shard", String(per)]);
        expect(s.code).toBe(0);
        expect(s.out.endsWith(`= ${shardsNeeded(peak, per)}`)).toBe(true);
      }),
      N
    );
  });

  it("--util and --hot above 1 are rejected, 1 is accepted; flags are order independent", () => {
    fc.assert(
      fc.property(fc.double({ min: 1.0001, max: 1e6, noNaN: true }), (x) => {
        expect(run(["instances", "--peak", "100", "--per-instance", "10", "--util", String(x)]).code).toBe(2);
        expect(run(["cache", "--daily-read-bytes", "1000", "--hot", String(x)]).code).toBe(2);
      }),
      N
    );
    expect(run(["cache", "--daily-read-bytes", "1000", "--hot", "1"]).code).toBe(0);
    const a = run(["traffic", "--dau", "1k", "--actions", "2", "--peak", "3"]);
    const b = run(["traffic", "--peak", "3", "--actions", "2", "--dau", "1k"]);
    expect(a).toEqual(b);
  });

  it("every command rejects a missing required option, one at a time", () => {
    const full: Record<string, string[]> = {
      traffic: ["dau", "actions", "peak"],
      instances: ["peak", "per-instance"],
      storage: ["records-per-day", "bytes", "years"],
      concurrency: ["rps", "latency-ms"],
      shards: ["peak-writes", "per-shard"],
      bandwidth: ["rps", "bytes"],
      cache: ["daily-read-bytes"]
    };
    for (const [cmd, opts] of Object.entries(full)) {
      expect(run([cmd, ...opts.flatMap((o) => [`--${o}`, "10"])]).code, cmd).toBe(0);
      for (const drop of opts) {
        const args = opts.filter((o) => o !== drop).flatMap((o) => [`--${o}`, "10"]);
        const r = run([cmd, ...args]);
        expect(r.code, `${cmd} without ${drop}`).toBe(2);
        expect(r.out).toContain(`missing --${drop}`);
      }
    }
  });
});

#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SECONDS_PER_DAY,
  avgRps,
  peakRps,
  instancesNeeded,
  concurrency,
  storageBytes,
  bandwidth,
  cacheBytes,
  shardsNeeded,
  humanBytes
} from "./index.js";

export interface RunResult {
  code: number;
  out: string;
}

interface CommandSpec {
  summary: string;
  /** Required numeric options. */
  required: string[];
  /** Optional numeric options with defaults. */
  optional: Record<string, number>;
  exec: (o: Record<string, number>) => string[];
}

/** Format a number for a formula line: grouped thousands, short decimals. */
export function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  if (a >= 1) return String(parseFloat(n.toFixed(1)));
  return String(parseFloat(n.toPrecision(2)));
}

/** Parse a positive number with optional decimal suffix (k, M, G, T). */
export function parseNumber(raw: string): number | undefined {
  const m = /^(\d*\.?\d+(?:e[+-]?\d+)?)([kmgt])?$/i.exec(raw.trim());
  if (!m) return undefined;
  const mult: Record<string, number> = { "": 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 };
  const v = Number(m[1]) * mult[(m[2] ?? "").toLowerCase()];
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

const COMMANDS: Record<string, CommandSpec> = {
  traffic: {
    summary: "traffic --dau N --actions N --peak N                      average and peak RPS",
    required: ["dau", "actions", "peak"],
    optional: {},
    exec: (o) => {
      const t = { dau: o.dau, actionsPerUser: o.actions, peakFactor: o.peak };
      const avg = avgRps(t);
      return [
        `avg = ${fmt(o.dau)} x ${fmt(o.actions)} / ${fmt(SECONDS_PER_DAY)} = ${fmt(avg)} RPS`,
        `peak = ${fmt(avg)} x ${fmt(o.peak)} = ${fmt(peakRps(t))} RPS`
      ];
    }
  },
  instances: {
    summary: "instances --peak RPS --per-instance RPS [--util 0.6]       instances with headroom",
    required: ["peak", "per-instance"],
    optional: { util: 0.6 },
    exec: (o) => {
      const ratio = o.peak / (o["per-instance"] * o.util);
      return [
        `instances = ceil(${fmt(o.peak)} / (${fmt(o["per-instance"])} x ${fmt(o.util)})) = ceil(${fmt(ratio)}) = ${instancesNeeded(o.peak, o["per-instance"], o.util)}`
      ];
    }
  },
  storage: {
    summary: "storage --records-per-day N --bytes N --years N [--replication 3]",
    required: ["records-per-day", "bytes", "years"],
    optional: { replication: 3 },
    exec: (o) => {
      const b = storageBytes({
        recordsPerDay: o["records-per-day"],
        bytesPerRecord: o.bytes,
        years: o.years,
        replication: o.replication
      });
      return [
        `storage = ${fmt(o["records-per-day"])} x ${fmt(o.bytes)} B x 365 x ${fmt(o.years)} x ${fmt(o.replication)} = ${fmt(b)} B = ${humanBytes(b)}`
      ];
    }
  },
  concurrency: {
    summary: "concurrency --rps RPS --latency-ms MS                       Little's law",
    required: ["rps", "latency-ms"],
    optional: {},
    exec: (o) => [
      `in flight = ${fmt(o.rps)} x ${fmt(o["latency-ms"] / 1000)} s = ${fmt(concurrency(o.rps, o["latency-ms"] / 1000))}`
    ]
  },
  shards: {
    summary: "shards --peak-writes N --per-shard N [--util 0.6]           shards with headroom",
    required: ["peak-writes", "per-shard"],
    optional: { util: 0.6 },
    exec: (o) => {
      const ratio = o["peak-writes"] / (o["per-shard"] * o.util);
      return [
        `shards = ceil(${fmt(o["peak-writes"])} / (${fmt(o["per-shard"])} x ${fmt(o.util)})) = ceil(${fmt(ratio)}) = ${shardsNeeded(o["peak-writes"], o["per-shard"], o.util)}`
      ];
    }
  },
  bandwidth: {
    summary: "bandwidth --rps RPS --bytes N                               payload bytes per request",
    required: ["rps", "bytes"],
    optional: {},
    exec: (o) => {
      const bps = bandwidth(o.rps, o.bytes);
      return [
        `bandwidth = ${fmt(o.rps)} x ${fmt(o.bytes)} B = ${fmt(bps)} B/s = ${humanBytes(bps)}/s = ${fmt((bps * 8) / 1e6)} Mbit/s`
      ];
    }
  },
  cache: {
    summary: "cache --daily-read-bytes N [--hot 0.2]                       Pareto cache size",
    required: ["daily-read-bytes"],
    optional: { hot: 0.2 },
    exec: (o) => [
      `cache = ${humanBytes(o["daily-read-bytes"])} x ${fmt(o.hot)} = ${humanBytes(cacheBytes(o["daily-read-bytes"], o.hot))}`
    ]
  }
};

export function usage(): string {
  return [
    "usage: calc <command> [options]",
    "",
    ...Object.values(COMMANDS).map((c) => `  ${c.summary}`),
    "",
    "Numbers accept suffixes k, M, G, T (decimal), e.g. --dau 1M. --util and --hot must be in (0, 1]."
  ].join("\n");
}

function fail(msg: string): RunResult {
  return { code: 2, out: `error: ${msg}\n${usage()}` };
}

/** Pure entry point: argv without node and script path. Returns exit code and output. */
export function run(argv: string[]): RunResult {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [name, ...rest] = args;
  if (name === "help" || name === "--help" || name === "-h") return { code: 0, out: usage() };
  if (!name) return fail("missing command");
  const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!spec) return fail(`unknown command "${name}"`);

  const optionNames = [...spec.required, ...Object.keys(spec.optional)];
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: rest,
      options: Object.fromEntries(optionNames.map((n) => [n, { type: "string" as const }])),
      allowPositionals: false,
      strict: true
    }).values;
  } catch (e) {
    return fail((e as Error).message);
  }

  const nums: Record<string, number> = {};
  for (const n of optionNames) {
    const raw = values[n];
    if (raw === undefined) {
      if (n in spec.optional) {
        nums[n] = spec.optional[n];
        continue;
      }
      return fail(`missing --${n}`);
    }
    const v = parseNumber(String(raw));
    if (v === undefined) return fail(`--${n} must be a positive number, got "${String(raw)}"`);
    nums[n] = v;
  }
  for (const n of ["util", "hot"]) {
    if (n in nums && nums[n] > 1) return fail(`--${n} must be in (0, 1], got ${nums[n]}`);
  }
  return { code: 0, out: spec.exec(nums).join("\n") };
}

function isMain(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const { code, out } = run(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(out + "\n");
  process.exitCode = code;
}

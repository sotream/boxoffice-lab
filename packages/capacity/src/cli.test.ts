import { describe, expect, it } from "vitest";
import { run, parseNumber, fmt } from "./cli.js";
import { LATENCY_NS } from "./index.js";

const ok = (argv: string[]) => {
  const r = run(argv);
  expect(r.code).toBe(0);
  return r.out;
};

describe("cli output format", () => {
  it("traffic prints formula and substituted numbers", () => {
    const out = ok(["traffic", "--dau", "1000000", "--actions", "10", "--peak", "3"]);
    expect(out).toBe("avg = 1 000 000 x 10 / 86 400 = 115.7 RPS\npeak = 115.7 x 3 = 347.2 RPS");
  });
  it("accepts suffixes and a leading --", () => {
    expect(ok(["--", "traffic", "--dau", "1M", "--actions", "10", "--peak", "3"])).toContain("347.2 RPS");
    expect(parseNumber("2.5k")).toBe(2500);
    expect(parseNumber("abc")).toBeUndefined();
    expect(parseNumber("-1")).toBeUndefined();
    expect(fmt(0.02)).toBe("0.02");
  });
  it("storage is human readable", () => {
    expect(ok(["storage", "--records-per-day", "1000000", "--bytes", "1000", "--years", "5"])).toBe(
      "storage = 1 000 000 x 1 000 B x 365 x 5 x 3 = 5 475 000 000 000 B = 5.5 TB"
    );
  });
});

describe("bad input", () => {
  const bad: string[][] = [
    [],
    ["nope"],
    ["traffic"],
    ["traffic", "--dau", "1M", "--actions", "10"],
    ["traffic", "--dau", "x", "--actions", "10", "--peak", "3"],
    ["traffic", "--dau", "0", "--actions", "10", "--peak", "3"],
    ["instances", "--peak", "100", "--per-instance", "10", "--util", "1.5"],
    ["instances", "--peak", "100", "--per-instance", "10", "--bogus", "1"],
    ["instances", "--peak", "100", "--per-instance", "10", "extra"]
  ];
  it.each(bad)("exit code 2 with usage: %j", (...argv) => {
    const r = run(argv);
    expect(r.code).toBe(2);
    expect(r.out).toContain("usage: calc");
  });
  it("help exits 0", () => {
    expect(run(["help"]).code).toBe(0);
  });
});

describe("worked examples from services/*/CAPACITY.md", () => {
  it("catalog: 116 avg RPS, ~1 200 peak at factor 10", () => {
    const out = ok(["traffic", "--dau", "1M", "--actions", "10", "--peak", "10"]);
    expect(out).toContain("= 115.7 RPS");
    expect(out).toContain("= 1 157 RPS"); // doc rounds to ~1 200
  });
  it("catalog: 3 instances for 1 200 RPS at 684 RPS each", () => {
    expect(ok(["instances", "--peak", "1200", "--per-instance", "684"])).toContain("ceil(2.9) = 3");
  });
  it("catalog: hot 20% of 300 MB is 60 MB", () => {
    expect(ok(["cache", "--daily-read-bytes", "300M"])).toBe("cache = 300 MB x 0.2 = 60.0 MB");
  });
  it("inventory: flash sale 2 500 RPS, 2 instances, 50 in flight, 23 RPS average day", () => {
    expect(150_000 / 60).toBe(2500);
    expect(ok(["instances", "--peak", "2500", "--per-instance", "2300"])).toContain("ceil(1.8) = 2");
    expect(ok(["concurrency", "--rps", "2500", "--latency-ms", "20"])).toBe("in flight = 2 500 x 0.02 s = 50");
    expect(ok(["traffic", "--dau", "1M", "--actions", "2", "--peak", "100"])).toContain(
      "avg = 1 000 000 x 2 / 86 400 = 23.1 RPS"
    );
  });
  it("payments: 40 in flight, 1 instance, 120 KB/s Kafka", () => {
    expect(ok(["concurrency", "--rps", "400", "--latency-ms", "100"])).toBe("in flight = 400 x 0.1 s = 40");
    expect(ok(["instances", "--peak", "400", "--per-instance", "700"])).toMatch(/= 1$/);
    expect(ok(["bandwidth", "--rps", "400", "--bytes", "300"])).toContain("= 120 KB/s");
  });
  it("payments: ~9 GB for 1M payments/year x 600 B x 5 years x 3", () => {
    const out = ok(["storage", "--records-per-day", String(1_000_000 / 365), "--bytes", "600", "--years", "5"]);
    expect(out).toMatch(/= 9\.0 GB$/);
  });
  it("gateway: 12 instances for 12 500 RPS at 1 742 RPS each", () => {
    expect(ok(["instances", "--peak", "12500", "--per-instance", "1742"])).toMatch(/= 12$/);
  });
  it("waiting-room: 3 instances for 10 000 status RPS at 7 600 each", () => {
    expect(ok(["instances", "--peak", "10000", "--per-instance", "7600"])).toMatch(/= 3$/);
  });
  it("notifications: 38 000 deliveries, 633 per s over 60 s, one consumer at 450/s is not enough", () => {
    const deliveries = 20_000 * (0.9 * 2 + 0.1);
    expect(deliveries).toBe(38_000);
    expect(Math.round(deliveries / 60)).toBe(633);
    expect(ok(["instances", "--peak", "633", "--per-instance", "450", "--util", "1"])).toMatch(/= 2$/);
  });
  it("notifications: 1M tickets/year x 1.9 channels x 60 B x 5 years is ~570 MB", () => {
    const out = ok([
      "storage",
      "--records-per-day",
      String((1_000_000 * 1.9) / 365),
      "--bytes",
      "60",
      "--years",
      "5",
      "--replication",
      "1"
    ]);
    expect(out).toMatch(/= 570 MB$/);
  });
  it("shards: 30 000 writes/s at 10 000 per shard needs 5", () => {
    expect(ok(["shards", "--peak-writes", "30000", "--per-shard", "10000"])).toMatch(/= 5$/);
  });
});

describe("latency table", () => {
  it("same-DC round trip is 5000x main memory", () => {
    expect(LATENCY_NS.sameDcRoundTrip / LATENCY_NS.mainMemory).toBe(5000);
  });
});

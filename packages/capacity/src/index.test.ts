import { describe, expect, it } from "vitest";
import { avgRps, peakRps, instancesNeeded, concurrency, storageBytes, humanBytes, shardsNeeded } from "./index.js";

describe("capacity formulas", () => {
  const t = { dau: 1_000_000, actionsPerUser: 10, peakFactor: 3 };
  it("avg and peak RPS", () => {
    expect(avgRps(t)).toBeCloseTo(115.7, 1);
    expect(peakRps(t)).toBeCloseTo(347.2, 1);
  });
  it("instances with headroom", () => {
    expect(instancesNeeded(1000, 500)).toBe(4);
  });
  it("Little's law", () => {
    expect(concurrency(2000, 0.05)).toBe(100);
  });
  it("storage with replication", () => {
    expect(storageBytes({ recordsPerDay: 1_000_000, bytesPerRecord: 1000, years: 5, replication: 3 })).toBe(5_475_000_000_000);
    expect(humanBytes(5_475_000_000_000)).toBe("5.5 TB");
  });
  it("shards", () => {
    expect(shardsNeeded(30_000, 10_000)).toBe(5);
  });
});

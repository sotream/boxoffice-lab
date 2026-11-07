import { describe, expect, it } from "vitest";
import { EnvReader, loadConfig } from "@boxoffice/platform";
import { SWEEP_MARGIN_MS, sweepMarginProblem } from "./sweep-margin";

const ok = { sweepMinAgeMs: 3000, confirmTimeoutMs: 2000, pspTimeoutMs: 2000, verifyHolds: true };

describe("sweeper threshold versus the pre-charge check (ADR 007)", () => {
  it("the defaults hold the margin (3000 >= 2000 + 500)", () => {
    expect(sweepMarginProblem(ok)).toBeUndefined();
  });

  it("accepts exactly the bound and refuses one millisecond below it", () => {
    expect(sweepMarginProblem({ ...ok, sweepMinAgeMs: 2000 + SWEEP_MARGIN_MS })).toBeUndefined();
    expect(sweepMarginProblem({ ...ok, sweepMinAgeMs: 2000 + SWEEP_MARGIN_MS - 1 })).toMatch(/SWEEP_MIN_AGE_MS \(2499\) must be at least 2500/);
  });

  it("a threshold equal to the step timeout has no margin and is refused", () => {
    expect(sweepMarginProblem({ ...ok, sweepMinAgeMs: 2000 })).toMatch(/must be at least 2500/);
  });

  it("raising both timeouts breaks the default threshold, and the message names the variables", () => {
    const p = sweepMarginProblem({ ...ok, confirmTimeoutMs: 2600, pspTimeoutMs: 2800 });
    expect(p).toMatch(/must be at least 3100/);
    expect(p).toMatch(/CONFIRM_TIMEOUT_MS/);
    expect(p).toMatch(/PSP_TIMEOUT_MS/);
  });

  it("the check ends at the smaller of the two bounds: a long PSP timeout alone is fine, so is a long confirm timeout with a short PSP one", () => {
    expect(sweepMarginProblem({ ...ok, pspTimeoutMs: 60_000 })).toBeUndefined();
    expect(sweepMarginProblem({ ...ok, confirmTimeoutMs: 60_000, pspTimeoutMs: 300, sweepMinAgeMs: 800 })).toBeUndefined();
    expect(sweepMarginProblem({ ...ok, confirmTimeoutMs: 60_000, pspTimeoutMs: 300, sweepMinAgeMs: 799 })).toMatch(/must be at least 800/);
  });

  it("with the check switched off there is no race and nothing is enforced", () => {
    expect(sweepMarginProblem({ ...ok, sweepMinAgeMs: 1, verifyHolds: false })).toBeUndefined();
  });

  it("is reported together with the other configuration problems (the boot path collects them in one ConfigError)", () => {
    const build = (e: EnvReader) => {
      const pspTimeoutMs = e.int("PSP_TIMEOUT_MS", 2000, { min: 1 }); const confirmTimeoutMs = e.int("CONFIRM_TIMEOUT_MS", 2000, { min: 1 });
      const sweepMinAgeMs = e.int("SWEEP_MIN_AGE_MS", 3000, { min: 1 });
      const m = sweepMarginProblem({ sweepMinAgeMs, confirmTimeoutMs, pspTimeoutMs, verifyHolds: true });
      if (m) e.problems.push(m);
      e.int("SEAT_PRICE_CENTS", 5000, { min: 1 });
    };
    expect(() => loadConfig(build, { SWEEP_MIN_AGE_MS: "1000", SEAT_PRICE_CENTS: "0" })).toThrow(/SWEEP_MIN_AGE_MS \(1000\) must be at least 2500[\s\S]*SEAT_PRICE_CENTS must be >= 1/);
    expect(() => loadConfig(build, {})).not.toThrow();
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { signAdmission, verifyAdmission } from "./index";

const NUM_RUNS = 300;
const secretArb = fc.string({ minLength: 1, maxLength: 40 });
const userArb = fc.string({ minLength: 1, maxLength: 30 }); // any unicode/ASCII, including dots
const eventArb = fc.integer({ min: 0, max: 1_000_000 });
const nowArb = fc.integer({ min: 0, max: 2_000_000_000_000 });
const ttlArb = fc.integer({ min: 1, max: 86_400 });

describe("admission token properties", () => {
  it("round trip: verify(sign(u, e)) returns u for any user id, event and secret, until expiry", () => {
    fc.assert(
      fc.property(userArb, eventArb, ttlArb, secretArb, nowArb, (u, e, ttl, s, now) => {
        const t = signAdmission(u, e, ttl, s, now);
        expect(verifyAdmission(t, e, s, now)).toEqual({ userId: u });
        expect(verifyAdmission(t, e, s, now + ttl * 1000)).toEqual({ userId: u }); // boundary: still valid at expiry
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("expired tokens are rejected one millisecond after expiry", () => {
    fc.assert(
      fc.property(userArb, eventArb, ttlArb, secretArb, nowArb, fc.integer({ min: 1, max: 10_000_000 }), (u, e, ttl, s, now, late) => {
        const t = signAdmission(u, e, ttl, s, now);
        expect(verifyAdmission(t, e, s, now + ttl * 1000 + late)).toBeNull();
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("a token for another event or signed with another secret is rejected", () => {
    fc.assert(
      fc.property(userArb, eventArb, eventArb, ttlArb, secretArb, secretArb, nowArb, (u, e, e2, ttl, s, s2, now) => {
        const t = signAdmission(u, e, ttl, s, now);
        if (e2 !== e) expect(verifyAdmission(t, e2, s, now)).toBeNull();
        if (s2 !== s) expect(verifyAdmission(t, e, s2, now)).toBeNull();
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("any single-character tamper anywhere in the token is rejected", () => {
    fc.assert(
      fc.property(userArb, eventArb, ttlArb, secretArb, nowArb, fc.nat(), fc.integer({ min: 1, max: 0xffff }), (u, e, ttl, s, now, pos, xor) => {
        const t = signAdmission(u, e, ttl, s, now);
        const i = pos % t.length;
        const c = String.fromCharCode((t.charCodeAt(i) ^ xor) & 0xffff);
        if (c === t[i]) return;
        const tampered = t.slice(0, i) + c + t.slice(i + 1);
        expect(verifyAdmission(tampered, e, s, now)).toBeNull();
      }),
      { numRuns: 1000 }
    );
  });

  it("exhaustive: every position of a token, every hex-digit substitution in the signature, is rejected", () => {
    const t = signAdmission("alice", 7, 300, "secret", 1000);
    const sigStart = t.lastIndexOf(".") + 1;
    for (let i = 0; i < t.length; i++) {
      for (const c of "0123456789abcdefABCDEF.xZ ") {
        if (c === t[i]) continue;
        const tampered = t.slice(0, i) + c + t.slice(i + 1);
        expect(verifyAdmission(tampered, 7, "secret", 1000), `pos ${i} -> ${c}${i >= sigStart ? " (sig)" : ""}`).toBeNull();
      }
    }
  });

  it("truncation and extension of the token are rejected", () => {
    const t = signAdmission("alice", 7, 300, "secret", 1000);
    for (let n = 0; n < t.length; n++) expect(verifyAdmission(t.slice(0, n), 7, "secret", 1000)).toBeNull();
    for (const extra of ["0", "a", "zz", ".", "00", "\n"]) expect(verifyAdmission(t + extra, 7, "secret", 1000)).toBeNull();
  });

  it("equal-length wrong signatures are rejected (the comparison path, not only the length check)", () => {
    fc.assert(
      fc.property(userArb, eventArb, secretArb, fc.uint8Array({ minLength: 32, maxLength: 32 }), (u, e, s, sigBytes) => {
        const real = signAdmission(u, e, 60, s, 0);
        const body = real.slice(0, real.lastIndexOf("."));
        const wrong = Buffer.from(sigBytes).toString("hex");
        fc.pre(real !== `${body}.${wrong}`);
        expect(wrong).toHaveLength(64);
        expect(verifyAdmission(`${body}.${wrong}`, e, s, 0)).toBeNull();
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it("uses a constant-time comparison for the signature (read from the source)", () => {
    const src = readFileSync(join(__dirname, "index.ts"), "utf8");
    expect(src).toMatch(/import\s*\{[^}]*timingSafeEqual[^}]*\}\s*from\s*"node:crypto"/);
    expect(src).toMatch(/timingSafeEqual\(\s*a\s*,\s*b\s*\)/);
    // the signature must never be compared with ===, !==, == or startsWith
    expect(src).not.toMatch(/\bsig\s*[!=]==?/);
    expect(src).not.toMatch(/[!=]==?\s*sig\b/);
    expect(src).not.toMatch(/\bmac\([^)]*\)\s*[!=]==?/);
  });

  it("never throws on malformed input: arbitrary strings, bytes, and almost-valid shapes", () => {
    const shapes = fc.oneof(
      fc.string({ maxLength: 300 }),
      fc.uint8Array({ maxLength: 200 }).map((b) => Buffer.from(b).toString("latin1")),
      fc.uint8Array({ maxLength: 200 }).map((b) => Buffer.from(b).toString("utf8")),
      fc.uint8Array({ maxLength: 200 }).map((b) => Buffer.from(b).toString("hex")),
      fc.array(fc.string({ maxLength: 12 }), { minLength: 0, maxLength: 8 }).map((p) => p.join(".")),
      fc.tuple(fc.string(), fc.string(), fc.string(), fc.uint8Array({ maxLength: 40 })).map(([a, b, c, d]) => `${a}.${b}.${c}.${Buffer.from(d).toString("hex")}`),
      fc.constantFrom("", ".", "....", "a.b.c.d", "a.1.9999999999999.", "a.1.NaN.00", "a.1.1e999.00", "..0.0.00", "\u0000.\u0000.\u0000.\u0000", "a".repeat(100_000))
    );
    fc.assert(
      fc.property(shapes, eventArb, secretArb, nowArb, (token, e, s, now) => {
        expect(verifyAdmission(token, e, s, now)).toBeNull();
      }),
      { numRuns: 1000 }
    );
  });

  it("a validly MAC'd body with a garbage event or expiry field is rejected, not crashed on", () => {
    // Only the secret holder can produce these, but verify must still be total.
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const forge = (body: string, s: string) => `${body}.${createHmac("sha256", s).update(body).digest("hex")}`;
    for (const body of ["u.x.5", "u.1.", "u..", "u.1.NaN", "u.1.-5", "u.Infinity.1e999", "u.1.1e999"]) {
      expect(verifyAdmission(forge(body, "k"), 1, "k", 10)).toBeNull();
    }
  });
});

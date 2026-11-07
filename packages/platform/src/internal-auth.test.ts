import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { INTERNAL_AUTH_MAX_SKEW_MS, internalAuthFresh, signInternalRequest, verifyInternalRequest } from "./internal-auth";

const NOW = 1_800_000_000_000;

describe("signed internal requests", () => {
  it("a signature verifies for exactly the method, path, body and secret it was made for", () => {
    const h = signInternalRequest("k", "post", "/payments", '{"a":1}', NOW);
    expect(verifyInternalRequest(h, ["k"], "POST", "/payments", '{"a":1}', NOW)).toBe(true); // method case does not matter
    expect(verifyInternalRequest(h, ["k"], "GET", "/payments", '{"a":1}', NOW)).toBe(false);
    expect(verifyInternalRequest(h, ["k"], "POST", "/payment", '{"a":1}', NOW)).toBe(false);
    expect(verifyInternalRequest(h, ["k"], "POST", "/payments", '{"a":2}', NOW)).toBe(false);
    expect(verifyInternalRequest(h, ["K"], "POST", "/payments", '{"a":1}', NOW)).toBe(false);
    expect(verifyInternalRequest(h, [], "POST", "/payments", '{"a":1}', NOW)).toBe(false);
    expect(verifyInternalRequest(h, ["x", "k"], "POST", "/payments", '{"a":1}', NOW)).toBe(true);
  });

  it("the allowed skew is symmetric and exact", () => {
    const h = signInternalRequest("k", "POST", "/p", "", NOW);
    expect(verifyInternalRequest(h, ["k"], "POST", "/p", "", NOW + INTERNAL_AUTH_MAX_SKEW_MS)).toBe(true);
    expect(verifyInternalRequest(h, ["k"], "POST", "/p", "", NOW - INTERNAL_AUTH_MAX_SKEW_MS)).toBe(true);
    expect(verifyInternalRequest(h, ["k"], "POST", "/p", "", NOW + INTERNAL_AUTH_MAX_SKEW_MS + 1)).toBe(false);
    expect(verifyInternalRequest(h, ["k"], "POST", "/p", "", NOW - INTERNAL_AUTH_MAX_SKEW_MS - 1)).toBe(false);
  });

  it("the secret does not appear in the header", () => {
    expect(signInternalRequest("a-very-recognisable-secret", "POST", "/p", "b", NOW)).not.toContain("recognisable");
  });

  it("a changed timestamp invalidates the signature even when it is fresh", () => {
    const h = signInternalRequest("k", "POST", "/p", "", NOW);
    const [, mac] = h.split(".");
    expect(verifyInternalRequest(`${NOW + 1}.${mac}`, ["k"], "POST", "/p", "", NOW)).toBe(false);
  });

  it("garbage never throws and never verifies", () => {
    fc.assert(fc.property(fc.anything(), (v) => {
      expect(internalAuthFresh(v, NOW)).toBe(false);
      expect(verifyInternalRequest(v, ["k"], "POST", "/p", "", NOW)).toBe(false);
    }), { numRuns: 300 });
  });

  it("property: any single-character tamper of a valid header is rejected", () => {
    const h = signInternalRequest("k", "POST", "/p", "body", NOW);
    fc.assert(fc.property(fc.nat({ max: h.length - 1 }), fc.integer({ min: 1, max: 0xffff }), (i, x) => {
      const c = String.fromCharCode((h.charCodeAt(i) ^ x) & 0xffff);
      fc.pre(c !== h[i]);
      expect(verifyInternalRequest(h.slice(0, i) + c + h.slice(i + 1), ["k"], "POST", "/p", "body", NOW)).toBe(false);
    }), { numRuns: 300 });
  });

  it("property: sign then verify is true for any method, path, body and secret", () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }), fc.string(), fc.string(), fc.string(), (secret, path, body, method) => {
      expect(verifyInternalRequest(signInternalRequest(secret, method, path, body, NOW), [secret], method, path, body, NOW)).toBe(true);
    }), { numRuns: 200 });
  });
});

import { describe, expect, it } from "vitest";
import { signAdmission, verifyAdmission } from "./index";

describe("admission token", () => {
  const secret = "s3cret";
  it("round-trips", () => {
    const t = signAdmission("alice", 1, 300, secret);
    expect(verifyAdmission(t, 1, secret)).toEqual({ userId: "alice" });
  });
  it("rejects tampering, wrong event, wrong secret and expiry", () => {
    const t = signAdmission("alice", 1, 300, secret, 1000);
    expect(verifyAdmission(t.replace("alice", "mallory"), 1, secret, 2000)).toBeNull();
    expect(verifyAdmission(t, 2, secret, 2000)).toBeNull();
    expect(verifyAdmission(t, 1, "other", 2000)).toBeNull();
    expect(verifyAdmission(t, 1, secret, 1000 + 301_000)).toBeNull();
    expect(verifyAdmission("garbage", 1, secret)).toBeNull();
  });
});

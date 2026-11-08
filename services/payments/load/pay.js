import http from "k6/http";
import { check } from "k6";
import crypto from "k6/crypto";

// Every iteration pays for a unique seat set. Seats must exist and be held by the user for CONFIRMED;
// with unheld seats the saga takes the compensation path (REFUNDED), which is also a valid thing to load.
// Payments is an internal service: every request is signed with the shared secret (timestamp, method, path, body hash; the gateway does the same
// in production-like setups, see packages/platform/src/internal-auth.ts). The secret itself is not sent.
// The price is computed by the server (SEAT_PRICE_CENTS, default 5000 per seat); amountCents is optional and must equal it.
const BASE = __ENV.BASE || "http://localhost:3103";
const TOKEN = __ENV.PAYMENTS_INTERNAL_TOKEN || "dev-internal-token";
// HELD=1: every VU pays for seats that are already held for it (scripts/bench.sh does that in SQL before the run: VU n owns seats
// (n-1)*SEATS_PER_VU+1 .. n*SEATS_PER_VU, held by u-n), so the pre-charge ownership check (ADR 007) passes and the saga ends CONFIRMED.
// Without it all VUs pay for seat 1+ITER, which nobody holds: the compensation path, run with VERIFY_HOLDS=0.
const HELD = __ENV.HELD === "1";
const SEATS_PER_VU = Number(__ENV.SEATS_PER_VU || 1000);
export const options = {
  scenarios: { pay: { executor: "constant-vus", vus: Number(__ENV.VUS || 100), duration: __ENV.DURATION || "20s" } },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)"]
};

function signed(body) {
  const ts = String(Date.now());
  const mac = crypto.hmac("sha256", TOKEN, `${ts}\nPOST\n/payments\n${crypto.sha256(body, "hex")}`, "hex");
  return `${ts}.${mac}`;
}

export default function () {
  const key = `k-${__VU}-${__ITER}`;
  // A VU that runs out of its own seats would pay for a neighbour's: fail the check instead of measuring something else.
  const seat = HELD ? (__VU - 1) * SEATS_PER_VU + 1 + __ITER : 1 + __ITER;
  if (HELD && __ITER >= SEATS_PER_VU) { check(null, { "seats left for this VU (raise SEATS_PER_VU)": () => false }); return; }
  const body = JSON.stringify({ eventId: 1, userId: `u-${__VU}`, seatIds: [seat], amountCents: 5000 });
  const r = http.post(`${BASE}/payments`, body,
    { headers: { "Content-Type": "application/json", "Idempotency-Key": key, "x-internal-auth": signed(body) }, tags: { name: "pay" } });
  check(r, { ok: (x) => x.status === 200 });
  if (__ITER % 5 === 0) { // client retry with the same key (timeouts happen): must not charge again
    http.post(`${BASE}/payments`, body,
      { headers: { "Content-Type": "application/json", "Idempotency-Key": key, "x-internal-auth": signed(body) }, tags: { name: "retry" } });
  }
}

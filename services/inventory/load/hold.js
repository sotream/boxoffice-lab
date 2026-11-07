import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import crypto from "k6/crypto";

// RANGE = how many distinct seats users compete for. 100000 = low contention, 20 = flash-sale hotspot.
const RANGE = Number(__ENV.RANGE || 100000);
const STRATEGY = __ENV.STRATEGY || "atomic-update";
const BASE = __ENV.BASE || "http://localhost:3101";
// Inventory authenticates every request (ADR 002): `x-internal-auth` = `<ms>.<HMAC-SHA256 hex>` over "<ms>\n<METHOD>\n<path, no query>\n<sha256 hex of the body>",
// key INVENTORY_INTERNAL_TOKEN (dev default if unset), never sent. Same scheme as services/payments/load/pay.js.
const TOKEN = __ENV.INVENTORY_INTERNAL_TOKEN || "dev-inventory-internal-token";
const ok = new Counter("holds_ok");
const conflict = new Counter("holds_conflict");

export const options = {
  scenarios: {
    load: { executor: "constant-vus", vus: Number(__ENV.VUS || 50), duration: __ENV.DURATION || "20s" }
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)"],
  thresholds: { http_req_failed: ["rate<0.001"] } // 409 is expected: mark it as non-failure below
};

http.setResponseCallback(http.expectedStatuses(200, 201, 409));

function signed(method, path, body) {
  const ts = String(Date.now());
  return `${ts}.${crypto.hmac("sha256", TOKEN, `${ts}\n${method}\n${path}\n${crypto.sha256(body, "hex")}`, "hex")}`;
}

export default function () {
  const seat = 1 + Math.floor(Math.random() * RANGE);
  const body = JSON.stringify({ seatIds: [seat], userId: `u-${__VU}-${__ITER}` });
  const res = http.post(
    `${BASE}/events/1/holds?strategy=${STRATEGY}`, body,
    { headers: { "Content-Type": "application/json", "x-internal-auth": signed("POST", "/events/1/holds", body) } }
  );
  check(res, { "201 or 409": (r) => r.status === 201 || r.status === 409 });
  if (res.status === 201) ok.add(1); else if (res.status === 409) conflict.add(1);
}

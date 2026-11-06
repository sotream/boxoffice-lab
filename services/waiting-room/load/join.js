import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE || "http://localhost:3102";
export const options = {
  scenarios: { spike: { executor: "constant-vus", vus: Number(__ENV.VUS || 100), duration: __ENV.DURATION || "20s" } },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)"]
};

// Each iteration = one new user joins, then polls status twice (typical client behaviour).
export default function () {
  const userId = `u-${__VU}-${__ITER}`;
  const j = http.post(`${BASE}/events/1/queue/join`, JSON.stringify({ userId }), { headers: { "Content-Type": "application/json" }, tags: { name: "join" } });
  check(j, { joined: (r) => r.status === 201 });
  for (let i = 0; i < 2; i++) http.get(`${BASE}/events/1/queue/status?userId=${userId}`, { tags: { name: "status" } });
}

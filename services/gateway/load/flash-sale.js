import http from "k6/http";
import { sleep } from "k6";
import { Counter } from "k6/metrics";

// End to end through the gateway: join the queue, poll until admitted, then try to hold 3 random seats.
const BASE = __ENV.BASE || "http://localhost:3100";
const SEATS = Number(__ENV.SEATS || 5000);
const USERS = Number(__ENV.USERS || 2000);
// Users arrive spread over this many seconds. 0 = all 2000 dial in the same millisecond, which overflows the OS accept queue
// on a laptop (macOS kern.ipc.somaxconn is 128 whatever the app asks for) and shows up as "dial: i/o timeout" in k6.
const SPREAD = Number(__ENV.ARRIVAL_SPREAD_S ?? 3);
const held = new Counter("e2e_holds_ok");
const taken = new Counter("e2e_holds_conflict");
const limited = new Counter("e2e_holds_429");
const noAdmission = new Counter("e2e_admission_timeout");
const J = { headers: { "Content-Type": "application/json" } };

export const options = {
  scenarios: { sale: { executor: "per-vu-iterations", vus: USERS, iterations: 1, maxDuration: "120s" } },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)"]
};

export default function () {
  if (SPREAD > 0) sleep(Math.random() * SPREAD);
  const userId = `user-${__VU}`;
  http.post(`${BASE}/events/1/queue/join`, JSON.stringify({ userId }), { ...J, tags: { name: "join" } });
  let token = null;
  for (let i = 0; i < 60 && !token; i++) {
    const r = http.get(`${BASE}/events/1/queue/status?userId=${userId}`, { tags: { name: "status" } });
    const b = r.json();
    if (b && b.state === "admitted") token = b.token; else sleep(1);
  }
  if (!token) { noAdmission.add(1); return; }
  for (let i = 0; i < 3; i++) {
    const seat = 1 + Math.floor(Math.random() * SEATS);
    const r = http.post(`${BASE}/events/1/holds`, JSON.stringify({ seatIds: [seat], userId }),
      { headers: { "Content-Type": "application/json", "x-admission": token }, tags: { name: "hold" },
        responseCallback: http.expectedStatuses(201, 409, 429) });
    if (r.status === 201) held.add(1); else if (r.status === 409) taken.add(1); else if (r.status === 429) limited.add(1);
  }
}

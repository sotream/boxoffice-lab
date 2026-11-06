import http from "k6/http";
// Compare BASE=http://localhost:3101 (direct) with BASE=http://localhost:3100 (through gateway).
export const options = { vus: 50, duration: "15s", summaryTrendStats: ["avg", "med", "p(95)", "p(99)"] };
export default function () { http.get(`${__ENV.BASE}/events/1/availability`); }

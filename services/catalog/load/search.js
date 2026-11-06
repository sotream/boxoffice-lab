import http from "k6/http";

// Query popularity is Zipf-like: a few terms are searched all the time, most rarely. That is why caches work.
const TERMS = ["rock","jazz","opera","techno","folk","metal","ballet","comedy","football","tennis","festival","musical","orchestra","stand-up","marathon","circus"];
const CITIES = ["Berlin","Munich","Hamburg","Cologne","Frankfurt","Vienna","Zurich","Prague","Warsaw","Kyiv","Lviv","Paris","Madrid","Rome","Amsterdam","Lisbon"];
const BASE = __ENV.BASE || "http://localhost:3104";
const STRATEGY = __ENV.STRATEGY || "fts";
const CACHE = __ENV.CACHE || "1";
const RARE = __ENV.RARE === "1"; // RARE=1: search for a single event number (very selective term)

// weights ~ 1/rank
const W = TERMS.map((_, i) => 1 / (i + 1));
const SUM = W.reduce((a, b) => a + b, 0);
function zipf(list) { let r = Math.random() * SUM, i = 0; while (r > W[i] && i < list.length - 1) { r -= W[i]; i++; } return list[i]; }

export const options = {
  scenarios: { s: { executor: "constant-vus", vus: Number(__ENV.VUS || 50), duration: __ENV.DURATION || "15s" } },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)"]
};

export default function () {
  const q = RARE ? String(1 + Math.floor(Math.random() * 200000)) : zipf(TERMS);
  const city = RARE ? "" : zipf(CITIES);
  http.get(`${BASE}/search?q=${q}&city=${city}&strategy=${STRATEGY}&cache=${CACHE}`, { tags: { name: "search" } });
}

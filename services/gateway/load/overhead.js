import http from "k6/http";
import crypto from "k6/crypto";
// Compare BASE=http://localhost:3101 (direct) with BASE=http://localhost:3100 (through gateway).
// Inventory authenticates every request (inventory ADR 002), so a direct run signs each request with INVENTORY_INTERNAL_TOKEN (dev default if unset);
// the gateway ignores the header (it signs its own requests to inventory).
const TOKEN = __ENV.INVENTORY_INTERNAL_TOKEN || "dev-inventory-internal-token";
const PATH = "/events/1/availability";
export const options = { vus: 50, duration: "15s", summaryTrendStats: ["avg", "med", "p(95)", "p(99)"] };
export default function () {
  const ts = String(Date.now());
  const mac = crypto.hmac("sha256", TOKEN, `${ts}\nGET\n${PATH}\n${crypto.sha256("", "hex")}`, "hex");
  http.get(`${__ENV.BASE}${PATH}`, { headers: { "x-internal-auth": `${ts}.${mac}` } });
}

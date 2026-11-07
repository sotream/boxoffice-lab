// Request signature for the internal services (same scheme as packages/platform/src/internal-auth.ts): header `x-internal-auth` = `<ms>.<hex HMAC-SHA256>`
// over "<ms>\n<METHOD>\n<path>\n<sha256 hex of the body>". Each callee has its own key, never sent:
//   "payments"  -> PAYMENTS_INTERNAL_TOKEN  (dev default "dev-internal-token")
//   "inventory" -> INVENTORY_INTERNAL_TOKEN (dev default "dev-inventory-internal-token")
import { createHash, createHmac } from "node:crypto";
const KEYS = {
  payments: () => process.env.PAYMENTS_INTERNAL_TOKEN ?? "dev-internal-token",
  inventory: () => process.env.INVENTORY_INTERNAL_TOKEN ?? "dev-inventory-internal-token"
};
/** `path` is the URL path without the query; `body` the exact string that is sent ("" for none); `service` picks the key (default: payments). */
export const signInternal = (method, path, body = "", service = "payments") => {
  const secret = KEYS[service]?.();
  if (secret === undefined) throw new Error(`unknown service "${service}" (payments or inventory)`);
  const ts = String(Date.now());
  const mac = createHmac("sha256", secret).update(`${ts}\n${method}\n${path}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
  return { "x-internal-auth": `${ts}.${mac}` };
};

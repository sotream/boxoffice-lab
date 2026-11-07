// Request signature for payments (same scheme as packages/platform/src/internal-auth.ts): header `x-internal-auth` = `<ms>.<hex HMAC-SHA256>`
// over "<ms>\n<METHOD>\n<path>\n<sha256 hex of the body>". The secret is PAYMENTS_INTERNAL_TOKEN (dev default if unset) and is never sent.
import { createHash, createHmac } from "node:crypto";
export const signInternal = (method, path, body) => {
  const secret = process.env.PAYMENTS_INTERNAL_TOKEN ?? "dev-internal-token";
  const ts = String(Date.now());
  const mac = createHmac("sha256", secret).update(`${ts}\n${method}\n${path}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
  return { "x-internal-auth": `${ts}.${mac}` };
};

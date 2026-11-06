import Fastify from "fastify";
import { instrumentFastify, Readiness, registerOpsRoutes } from "@boxoffice/platform";
import { GatewayService, routeOf } from "./gateway.service";

/**
 * trustedProxies: addresses or CIDRs of the reverse proxies in front of the gateway. Empty (default) means req.ip is the
 * socket address and x-forwarded-for from clients is ignored, so a spoofed header cannot change the rate-limit key.
 * Behind a load balancer list its address or subnet, otherwise every client shares the balancer's IP and one bucket.
 *
 * Upstream x-forwarded-for: if the peer is a trusted proxy and sent a chain, the chain is kept and the peer address is appended
 * (standard proxy behaviour, the client stays the leftmost entry); otherwise it is just the socket address, never client-supplied text.
 */
export function buildApp(svc: Pick<GatewayService, "handle">, trustedProxies: string[] = [], opts: { readiness?: Readiness } = {}) {
  const app = Fastify({ logger: false, trustProxy: trustedProxies.length ? trustedProxies : false });
  instrumentFastify(app, { routeLabel: (req) => routeOf(req.url.split("?", 1)[0]) });
  registerOpsRoutes(app, { readiness: opts.readiness ?? new Readiness([]) });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.all("/*", async (req, reply) => {
    const [path, qs] = req.url.split("?");
    const peer = req.socket.remoteAddress ?? req.ip;
    const xff = req.headers["x-forwarded-for"];
    // req.ip differs from the peer only when the peer is a trusted proxy that sent a chain.
    const forwardedFor = req.ip !== peer && xff ? `${Array.isArray(xff) ? xff.join(", ") : xff}, ${peer}` : peer;
    const r = await svc.handle(req.method, path, qs ? `?${qs}` : "", req.body as string | undefined, req.ip, req.headers["x-admission"] as string | undefined, forwardedFor);
    reply.status(r.status).headers({ "content-type": "application/json", ...r.headers }).send(r.body);
  });
  return app;
}

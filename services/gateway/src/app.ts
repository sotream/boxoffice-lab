import Fastify from "fastify";
import { GatewayService } from "./gateway.service";

/**
 * trustedProxies: addresses or CIDRs of the reverse proxies in front of the gateway. Empty (default) means req.ip is the
 * socket address and x-forwarded-for from clients is ignored, so a spoofed header cannot change the rate-limit key.
 * Behind a load balancer list its address or subnet, otherwise every client shares the balancer's IP and one bucket.
 */
export function buildApp(svc: Pick<GatewayService, "handle">, trustedProxies: string[] = []) {
  const app = Fastify({ logger: false, trustProxy: trustedProxies.length ? trustedProxies : false });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.all("/*", async (req, reply) => {
    const [path, qs] = req.url.split("?");
    const r = await svc.handle(req.method, path, qs ? `?${qs}` : "", req.body as string | undefined, req.ip, req.headers["x-admission"] as string | undefined);
    reply.status(r.status).headers({ "content-type": "application/json", ...r.headers }).send(r.body);
  });
  return app;
}

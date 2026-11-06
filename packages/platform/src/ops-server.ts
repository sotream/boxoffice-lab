import { createServer, Server } from "node:http";
import { Readiness } from "./health";
import { metricsContentType, metricsText } from "./metrics";

/** Minimal HTTP server for processes that have no HTTP API of their own (the notifications consumer). */
export function startOpsServer(port: number, readiness: Readiness, host = "0.0.0.0"): Promise<Server> {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?", 1)[0];
    try {
      if (path === "/healthz") { res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}'); return; }
      if (path === "/readyz") {
        const r = await readiness.evaluate();
        res.writeHead(r.ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(r.body));
        return;
      }
      if (path === "/metrics") { res.writeHead(200, { "content-type": metricsContentType() }).end(await metricsText()); return; }
      res.writeHead(404).end();
    } catch { res.writeHead(500).end(); }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(server); });
  });
}

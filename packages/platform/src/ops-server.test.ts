import { describe, expect, it } from "vitest";
import { Readiness } from "./health";
import { initMetrics } from "./metrics";
import { startOpsServer } from "./ops-server";

describe("startOpsServer", () => {
  it("serves healthz, readyz (503 when a dependency fails) and metrics", async () => {
    initMetrics("ops-test");
    let up = true;
    const srv = await startOpsServer(0, new Readiness([{ name: "kafka", run: async () => { if (!up) throw new Error("no broker"); } }]), "127.0.0.1");
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
      up = false;
      const r = await fetch(`${base}/readyz`);
      expect(r.status).toBe(503);
      expect((await r.json()).checks.kafka.ok).toBe(false);
      expect((await (await fetch(`${base}/metrics`)).text())).toContain("# HELP");
      expect((await fetch(`${base}/other`)).status).toBe(404);
    } finally { srv.close(); }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(__dirname, "..", "..", "..");
const load = async () => import(join(root, "ops", "catalogue.mjs")) as Promise<typeof import("../../../ops/catalogue.mjs")>;

describe("ops package is consistent with the code", () => {
  it("every metric and label used in ops/alerts.yml exists in the code, every alert has severity, route, slo, summary, runbook", async () => {
    const c = await load();
    const problems = c.checkRules(c.loadRules(join(root, "ops/alerts.yml")), c.scanCatalogue(root), c.defaultMetricNames(root));
    expect(problems).toEqual([]);
  });

  it("the checker really catches an unknown metric, an unknown label and a missing runbook", async () => {
    const c = await load();
    const cat = c.scanCatalogue(root);
    const rule = (expr: string, extra: object = {}) => ({ group: "g", kind: "alert", name: "T", expr, raw: { labels: { severity: "x", route: "x", slo: "x" }, annotations: { summary: "s", runbook: "r" }, ...extra } });
    expect(c.checkRules([rule('sum(rate(http_requests_total{service="gateway"}[5m]))')], cat)).toEqual([]);
    expect(c.checkRules([rule("sum(rate(http_requestz_total[5m]))")], cat).join()).toMatch(/unknown identifier http_requestz_total/);
    expect(c.checkRules([rule('sum(http_requests_total{statuz="5xx"})')], cat).join()).toMatch(/no label statuz/);
    expect(c.checkRules([rule('nope_total{a="b"} > 1')], cat).join()).toMatch(/unknown metric nope_total/);
    expect(c.checkRules([rule("up", { annotations: { summary: "s" } })], cat).join()).toMatch(/missing runbook/);
  });

  it("the metric table in docs/operations.md is the one generated from the code", async () => {
    const c = await load();
    const md = readFileSync(join(root, "docs/operations.md"), "utf8");
    expect(c.docTable(md)).toBe(c.renderTable(c.scanCatalogue(root)));
  });

  it("every runbook link in alerts.yml points at a heading in docs/operations.md", () => {
    const md = readFileSync(join(root, "docs/operations.md"), "utf8");
    const anchors = new Set([...md.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-")));
    const links = [...readFileSync(join(root, "ops/alerts.yml"), "utf8").matchAll(/runbook: docs\/operations\.md#([a-z0-9-]+)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(10);
    for (const l of links) expect(anchors, `anchor #${l}`).toContain(l);
  });

  it("prometheus.yml parses, loads the alert rules and scrapes every service", () => {
    const p = parse(readFileSync(join(root, "ops/prometheus.yml"), "utf8"));
    expect(p.rule_files).toContain("/etc/prometheus/alerts.yml");
    const targets = p.scrape_configs.map((s: any) => `${s.job_name}=${s.static_configs[0].targets[0]}`);
    expect(targets).toEqual(["gateway=host.docker.internal:3100", "inventory=host.docker.internal:3101", "waiting-room=host.docker.internal:3102", "payments=host.docker.internal:3103", "catalog=host.docker.internal:3104", "notifications=host.docker.internal:3105"]);
  });

  it("the observability compose profile does not change the default services", () => {
    const c = parse(readFileSync(join(root, "docker-compose.yml"), "utf8"));
    for (const s of ["postgres", "redis", "redpanda"]) expect(c.services[s].profiles, s).toBeUndefined();
    for (const s of ["prometheus", "grafana"]) expect(c.services[s].profiles).toEqual(["observability"]);
  });
});

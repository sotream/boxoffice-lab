#!/usr/bin/env node
// System-level mutation check: break one thing in a service, run the e2e scenario that must notice, restore the file byte for byte.
//   node packages/e2e/mutation-check.mjs [--list] [--only id,id]
// The services run from dist/, rebuilt by the suite itself (ensureBuilt), so mutating src is enough. A backup of each file is kept
// under $TMPDIR/boxoffice-e2e-mutation/. A mutation is KILLED only if the run fails AND the output contains the expected evidence.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = join(root, "packages", "e2e");
const backups = join(process.env.TMPDIR ?? tmpdir(), "boxoffice-e2e-mutation");
mkdirSync(backups, { recursive: true });

const MUTATIONS = [
  { id: "inv-confirm-owner", file: "services/inventory/src/inventory.service.ts", test: "src/happy.e2e.test.ts", evidence: "(b) CONFIRMED payment",
    find: "WHERE event_id=$1 AND seat_id = ANY($2) AND held_by=$3", replace: "WHERE event_id=$1 AND seat_id = ANY($2) AND $3::text IS NOT NULL",
    what: "inventory confirm skips the owner check (anybody can confirm anybody's hold)" },
  { id: "inv-hold-overlap", file: "services/inventory/src/inventory.service.ts", test: "src/happy.e2e.test.ts", evidence: "was granted (HTTP 200) to",
    find: "AND (status='free' OR (status='held' AND hold_until < now()))\n         RETURNING hold_until", replace: "RETURNING hold_until",
    what: "atomic hold takes seats that are already held or sold (oversell)" },
  { id: "pay-confirm-blind", file: "services/payments/src/payments.service.ts", test: "src/happy.e2e.test.ts", evidence: "CONFIRMED",
    find: 'if (ok) return this.transition(id, "CHARGED", "CONFIRMED", "payment.confirmed", p);', replace: 'if (true) return this.transition(id, "CHARGED", "CONFIRMED", "payment.confirmed", p);',
    what: "payments stores CONFIRMED even when inventory said no" },
  { id: "pay-no-outbox", file: "services/payments/src/payments.service.ts", test: "src/happy.e2e.test.ts", evidence: "not quiescent",
    find: "if (won && event) {", replace: "if (false && won && event) {",
    what: "payments changes state but writes no outbox event" },
  { id: "relay-drops", file: "services/payments/src/outbox-relay.ts", test: "src/happy.e2e.test.ts", evidence: "not quiescent",
    find: "for (const [topic, msgs] of byTopic) await this.publish(topic, msgs);", replace: "for (const [topic, msgs] of byTopic) void topic, msgs;",
    what: "relay marks rows published without publishing them" },
  { id: "not-dedup", file: "services/notifications/src/handler.ts", test: "src/happy.e2e.test.ts", evidence: "the notifications process sent",
    find: "WHERE notifications.deliveries.status = 'FAILED'\n            OR (notifications.deliveries.status = 'SENDING' AND notifications.deliveries.updated_at < now() - make_interval(secs => $3))", replace: "WHERE $3::float8 >= 0",
    what: "notifications: an already SENT delivery is claimed and sent again" },
  { id: "pay-no-sweeper", file: "services/payments/src/payments.service.ts", test: "src/chaos.e2e.test.ts -t 2001", evidence: "not quiescent",
    find: "async sweep(olderThanSeconds = 3, limit = 200, parallel = 10): Promise<number> {", replace: "async sweep(olderThanSeconds = 3, limit = 200, parallel = 10): Promise<number> {\n    if (olderThanSeconds >= 0) return 0;",
    what: "the sweeper never resumes stuck sagas (crash recovery removed)" },
];

const argv = process.argv.slice(2);
if (argv.includes("--list")) { for (const m of MUTATIONS) console.log(`${m.id.padEnd(18)} ${m.what}`); process.exit(0); }
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",") : null;

let active = null; // { path, original, backup }
const restore = () => {
  if (!active) return;
  copyFileSync(active.backup, active.path);
  if (!readFileSync(active.path).equals(active.original)) { console.error(`RESTORE MISMATCH for ${active.path}`); process.exitCode = 3; }
  active = null;
};
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(130); });
process.on("exit", restore);

const results = [];
for (const m of MUTATIONS) {
  if (only && !only.includes(m.id)) continue;
  const path = join(root, m.file);
  const original = readFileSync(path);
  const text = original.toString("utf8");
  if (text.split(m.find).length !== 2) { console.error(`${m.id}: pattern must occur exactly once in ${m.file}`); process.exit(2); }
  const backup = join(backups, `${m.id}.${m.file.split("/").pop()}`);
  copyFileSync(path, backup);
  active = { path, original, backup };
  writeFileSync(path, text.replace(m.find, () => m.replace));
  const t0 = Date.now();
  const [file, ...rest] = m.test.split(" ");
  const run = spawnSync("pnpm", ["exec", "vitest", "run", file, ...rest], { cwd: pkg, encoding: "utf8", maxBuffer: 64 << 20 });
  restore();
  const out = (run.stdout ?? "") + (run.stderr ?? "");
  const failed = run.status !== 0;
  const killed = failed && out.includes(m.evidence);
  results.push({ id: m.id, what: m.what, result: killed ? "KILLED" : failed ? "FAILED-OTHER-REASON" : "SURVIVED", seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(JSON.stringify(results.at(-1)));
  const first = out.split("\n").find((l) => /^\s*[+-]?\s*"\(|AssertionError|not quiescent|Error:/.test(l));
  if (first) console.log("   evidence: " + first.trim().slice(0, 220));
}
// leave dist matching the restored sources
for (const d of ["inventory", "payments", "notifications"]) execFileSync(join(root, "services", d, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: join(root, "services", d) });
console.log(results.every((r) => r.result === "KILLED") ? "all killed" : "SOME MUTATIONS NOT KILLED");
process.exit(results.every((r) => r.result === "KILLED") ? 0 : 1);

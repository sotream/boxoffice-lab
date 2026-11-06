#!/usr/bin/env node
// Dependency-free mutation check. For every entry of scripts/mutations.json:
//   1. back the target file up (under $TMPDIR/boxoffice-mutation/), apply find -> replace in place,
//   2. run `pnpm --filter <package> test`; the mutation is KILLED when the run fails,
//   3. ALWAYS restore the file (finally block, SIGINT/SIGTERM handler, process exit) and verify it byte for byte.
// Usage: node scripts/mutation-check.mjs [--only id1,id2] [--list] [--file scripts/mutations.json]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const mutationsFile = resolve(ROOT, opt("--file") ?? "scripts/mutations.json");
const only = opt("--only")?.split(",");
const BACKUP_DIR = join(process.env.TMPDIR || tmpdir(), "boxoffice-mutation");
// payments, platform and the bootstraps are owned by other people while mutations run: never mutate them.
const FORBIDDEN = [/^services\/payments\//, /^packages\/platform\//, /(^|\/)src\/(main|db|app\.module)\.ts$/, /(^|\/)app\.ts$/, /\.test\.ts$/, /package\.json$/];

mkdirSync(BACKUP_DIR, { recursive: true });
const mutations = JSON.parse(readFileSync(mutationsFile, "utf8"));

/** state of the mutation currently applied, so a signal can undo it */
let active = null;

function restore(m = active) {
  if (!m) return true;
  const path = resolve(ROOT, m.file);
  const original = readFileSync(m.backup);
  const current = readFileSync(path);
  if (current.equals(m.mutated)) writeFileSync(path, original);
  else {
    // someone else edited the file while the mutation was applied: undo only our edit, never clobber theirs
    const text = current.toString("utf8");
    const at = text.indexOf(m.replace);
    if (at >= 0 && m.replace !== m.find) writeFileSync(path, text.slice(0, at) + m.find + text.slice(at + m.replace.length));
    else writeFileSync(path, original);
    console.error(`  ! ${m.file} changed during the run; reverted only the mutation`);
  }
  if (active === m) active = null;
  return true;
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { restore(); console.error(`\nrestored after ${sig}`); process.exit(130); });
process.on("exit", () => { if (active) restore(); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(1); });

function runTests(pkg) {
  const r = spawnSync("pnpm", ["--filter", pkg, "test"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}
const failingNames = (out) => [...out.matchAll(/(?:FAIL|×|✗)\s+(.+)/g)].map((m) => m[1].trim());

if (args.includes("--list")) {
  for (const m of mutations) console.log(`${m.id.padEnd(28)} ${m.package.padEnd(26)} ${m.file}`);
  process.exit(0);
}

const baselines = new Map();
const rows = [];
for (const m of mutations) {
  if (only && !only.includes(m.id)) continue;
  const row = { id: m.id, pkg: m.package, status: "", note: "" };
  rows.push(row);
  if (FORBIDDEN.some((re) => re.test(m.file))) { row.status = "REFUSED"; row.note = "file is off limits"; continue; }
  const path = resolve(ROOT, m.file);
  if (!existsSync(path)) { row.status = "INVALID"; row.note = "file missing"; continue; }
  const original = readFileSync(path);
  const text = original.toString("utf8");
  const hits = text.split(m.find).length - 1;
  if (hits !== 1) { row.status = "INVALID"; row.note = `find string matches ${hits} times`; continue; }

  if (!baselines.has(m.package)) {
    const b = runTests(m.package);
    baselines.set(m.package, b.code);
    if (b.code !== 0) console.error(`baseline for ${m.package} FAILS before any mutation:\n${b.out.slice(-1500)}`);
  }
  if (baselines.get(m.package) !== 0) { row.status = "BASELINE-RED"; row.note = "unmutated tests already fail"; continue; }

  const backup = join(BACKUP_DIR, `${m.id}-${basename(m.file)}.bak`);
  writeFileSync(backup, original);
  const mutated = Buffer.from(text.replace(m.find, () => m.replace), "utf8");
  active = { ...m, backup, mutated };
  const t0 = Date.now();
  let res;
  try {
    writeFileSync(path, mutated);
    res = runTests(m.package);
  } finally {
    restore(active);
  }
  const identical = readFileSync(path).equals(original);
  row.secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!identical) { row.note += " RESTORE-DIFFERS (file changed by someone else meanwhile?)"; }

  if (res.code === 0) { row.status = "SURVIVED"; row.note = (row.note + " tests still pass").trim(); continue; }
  const names = failingNames(res.out);
  const expect = m.expectFailingTests ?? [];
  const seen = expect.filter((e) => res.out.includes(e));
  if (expect.length && seen.length === 0) {
    row.status = "UNEXPECTED";
    row.note = `failed, but none of the expected tests did; failing: ${names.slice(0, 3).join(" | ")}`;
  } else {
    row.status = "KILLED";
    row.note = (seen.length ? `by ${seen.join(", ")}` : names[0] ?? "").slice(0, 110) + (row.note ? ` ${row.note}` : "");
  }
}

const w = (s, n) => String(s).padEnd(n);
console.log(`\n${w("mutation", 28)} ${w("package", 26)} ${w("result", 10)} ${w("secs", 5)} note`);
console.log("-".repeat(110));
for (const r of rows) console.log(`${w(r.id, 28)} ${w(r.pkg, 26)} ${w(r.status, 10)} ${w(r.secs ?? "", 5)} ${r.note}`);
const killed = rows.filter((r) => r.status === "KILLED").length;
console.log(`\n${killed}/${rows.length} killed; survivors: ${rows.filter((r) => r.status !== "KILLED").map((r) => `${r.id}(${r.status})`).join(", ") || "none"}`);
process.exit(killed === rows.length ? 0 : 1);

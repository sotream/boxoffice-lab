// node ops/check.mjs          check alerts.yml and docs/operations.md against the metrics defined in the code
// node ops/check.mjs --write  regenerate the metric table in docs/operations.md
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRules, defaultMetricNames, docTable, loadRules, renderTable, scanCatalogue, TABLE_END, TABLE_START } from "./catalogue.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cat = scanCatalogue(root);
const docPath = join(root, "docs/operations.md");
const table = renderTable(cat);

if (process.argv.includes("--write")) {
  const md = readFileSync(docPath, "utf8");
  const a = md.indexOf(TABLE_START), b = md.indexOf(TABLE_END);
  if (a < 0 || b < 0) { console.error("markers not found in docs/operations.md"); process.exit(1); }
  writeFileSync(docPath, `${md.slice(0, a + TABLE_START.length)}\n${table}\n${md.slice(b)}`);
  console.log(`wrote ${cat.length} metrics to docs/operations.md`);
  process.exit(0);
}

const problems = checkRules(loadRules(join(root, "ops/alerts.yml")), cat, defaultMetricNames(root));
const current = docTable(readFileSync(docPath, "utf8"));
if (current !== table) problems.push("docs/operations.md metric table is out of date: run `node ops/check.mjs --write`");
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`ok: ${cat.length} metrics, alert rules consistent, docs table current`);

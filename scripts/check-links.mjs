#!/usr/bin/env node
// Checks relative links in tracked Markdown files: the target file or directory must exist, and a #fragment must match a heading of the
// target (GitHub's slug rules: lower case, punctuation dropped, spaces to hyphens, -1/-2 for duplicates). External URLs are not fetched.
// shortcut: reference-style links and HTML <a href> are not checked, add them if one ever breaks unnoticed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const files = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

const stripFences = (t) => t.replace(/^```[\s\S]*?^```/gm, (m) => m.replace(/[^\n]/g, " "));
const stripCode = (t) => stripFences(t).replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length)); // inline code is blanked for links, kept for headings
const slug = (h) => h.trim().toLowerCase().replace(/<[^>]*>/g, "").replace(/[`*_~]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
const anchorCache = new Map();
function anchors(path) {
  if (anchorCache.has(path)) return anchorCache.get(path);
  const seen = new Map(), out = new Set();
  for (const m of stripFences(readFileSync(path, "utf8")).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")), n = seen.get(base) ?? 0;
    seen.set(base, n + 1); out.add(n ? `${base}-${n}` : base);
  }
  anchorCache.set(path, out); return out;
}

const bad = [];
for (const f of files) {
  const abs = resolve(ROOT, f), text = stripCode(readFileSync(abs, "utf8"));
  for (const m of text.matchAll(/\[(?:[^\]\n]|\[[^\]\n]*\])*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const link = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("//")) continue;
    const [pathPart, frag] = link.split("#");
    const target = pathPart ? resolve(dirname(abs), decodeURIComponent(pathPart)) : abs;
    const line = text.slice(0, m.index).split("\n").length;
    if (!existsSync(target)) { bad.push(`${f}:${line}: missing file ${link}`); continue; }
    if (frag && target.endsWith(".md") && statSync(target).isFile() && !anchors(target).has(decodeURIComponent(frag).toLowerCase()))
      bad.push(`${f}:${line}: no heading #${frag} in ${relative(ROOT, target)}`);
  }
}
if (bad.length) { console.error(bad.join("\n") + `\n${bad.length} broken link(s)`); process.exit(1); }
console.log(`ok: ${files.length} Markdown files, every relative link and anchor resolves`);

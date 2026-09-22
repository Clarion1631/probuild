#!/usr/bin/env node
/**
 * quiet-check: run typecheck / lint / unit tests and print only what an agent needs.
 *
 *   node scripts/quiet-check.mjs                 # typecheck + lint + unit tests
 *   node scripts/quiet-check.mjs typecheck lint  # subset
 *   node scripts/quiet-check.mjs test tests/foo.test.ts tests/bar.test.ts
 *   node scripts/quiet-check.mjs --max 30        # show up to 30 problems per step (default 15)
 *
 * Output is capped to a few dozen lines: a one-line summary per step, then the first
 * N failures as `file:line message`. Full output is written to .quiet-check/<step>.log
 * (gitignored) so anything truncated can be inspected with grep or tail.
 * Exit code is non-zero if any step fails.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const maxIdx = argv.indexOf("--max");
const MAX = maxIdx >= 0 ? Number(argv.splice(maxIdx, 2)[1]) || 15 : 15;
const KNOWN = new Set(["typecheck", "lint", "test"]);
const steps = argv.filter((a) => KNOWN.has(a));
const extraFiles = argv.filter((a) => !KNOWN.has(a));
const run = steps.length ? steps : ["typecheck", "lint", "test"];

const LOG_DIR = ".quiet-check";
mkdirSync(LOG_DIR, { recursive: true });
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

function exec(args, step) {
  const res = spawnSync(NPX, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const out = (res.stdout || "") + (res.stderr || "");
  writeFileSync(join(LOG_DIR, `${step}.log`), out);
  return { code: res.status ?? 1, out };
}

function show(list) {
  for (const line of list.slice(0, MAX)) console.log("  " + line);
  if (list.length > MAX) console.log(`  … ${list.length - MAX} more in ${LOG_DIR}/`);
}

let failed = false;

function typecheck() {
  const { code, out } = exec(["tsc", "--noEmit", "--pretty", "false"], "typecheck");
  const errs = out
    .split(/\r?\n/)
    .map((l) => l.match(/^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/))
    .filter(Boolean)
    .map((m) => `${m[1]}:${m[2]} ${m[3]} ${m[4]}`);
  if (code === 0 && errs.length === 0) return console.log("typecheck: ok");
  failed = true;
  console.log(`typecheck: ${errs.length} error(s)`);
  show(errs.length ? errs : out.trim().split(/\r?\n/).slice(-5));
}

function lint() {
  const { code, out } = exec(["eslint", ".", "--format", "json"], "lint");
  let results;
  try {
    results = JSON.parse(out.slice(out.indexOf("[")));
  } catch {
    failed = failed || code !== 0;
    console.log(`lint: ${code === 0 ? "ok" : "failed to parse output"}`);
    if (code !== 0) show(out.trim().split(/\r?\n/).slice(-5));
    return;
  }
  const problems = [];
  let warnings = 0;
  for (const f of results) {
    for (const m of f.messages) {
      if (m.severity === 2) problems.push(`${f.filePath.replace(process.cwd() + "\\", "").replace(process.cwd() + "/", "")}:${m.line} ${m.ruleId ?? ""} ${m.message}`);
      else warnings++;
    }
  }
  if (problems.length === 0) return console.log(`lint: ok${warnings ? ` (${warnings} warnings)` : ""}`);
  failed = true;
  console.log(`lint: ${problems.length} error(s), ${warnings} warning(s)`);
  show(problems);
}

function unitFiles() {
  if (extraFiles.length) return extraFiles;
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const cmd = pkg.scripts?.["test:unit"] ?? "";
  return cmd.split(/\s+/).filter((t) => t.startsWith("tests/"));
}

function test() {
  const files = unitFiles();
  if (!files.length) return console.log("test: no unit test files found");
  const { code, out } = exec(["tsx", "--test", "--test-reporter=tap", ...files], "test");
  const lines = out.split(/\r?\n/);
  const failures = [];
  let detail = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*not ok \d+ - (.*)$/);
    if (!m) continue;
    // skip suite-level "not ok" wrappers whose subtests already reported
    if (lines[i + 1]?.trim().startsWith("---") && /type: 'suite'/.test(lines.slice(i, i + 6).join("\n"))) continue;
    failures.push(m[1]);
    if (!detail.length) {
      for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
        const t = lines[j].trim();
        if (t === "..." ) break;
        if (/^(error|failureType|location|stack|expected|actual|message):/.test(t) || t.startsWith("at ") || t.startsWith("+") || t.startsWith("-")) detail.push(t);
        if (detail.length >= 12) break;
      }
    }
  }
  const pass = Number((out.match(/^# pass (\d+)/m) || [])[1] ?? 0);
  const fail = Number((out.match(/^# fail (\d+)/m) || [])[1] ?? failures.length);
  if (code === 0 && fail === 0) return console.log(`test: ok (${pass} passed, ${files.length} files)`);
  failed = true;
  console.log(`test: ${fail} failed, ${pass} passed`);
  show(failures);
  if (detail.length) {
    console.log("  first failure:");
    for (const d of detail) console.log("    " + d);
  }
  if (!failures.length) show(out.trim().split(/\r?\n/).slice(-8));
}

for (const step of run) ({ typecheck, lint, test })[step]();
console.log(failed ? `FAIL — full logs in ${LOG_DIR}/` : "ALL OK");
process.exit(failed ? 1 : 0);

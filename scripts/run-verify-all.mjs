// Run every scripts/verify-*.ts and report a single summary.
//
// Why this exists: CI ran lint, build and Playwright, but never these. The
// consequence was not theoretical — verify-mcp-pm-tools.ts had been failing since
// PR #273 renamed a script it asserts on, and nothing noticed for days. Several
// of these suites are the only executable proof of invariants the codebase
// depends on (money locks, portal visibility, dispatch publication).
//
// Runs ALL of them rather than stopping at the first failure, so one broken suite
// doesn't hide the state of the other fifteen.
//
//   node scripts/run-verify-all.mjs           # all
//   node scripts/run-verify-all.mjs --only task-evidence,mcp-pm-tools
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const scriptsDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const onlyArg = process.argv.find(a => a.startsWith("--only="))
    ?? (process.argv.includes("--only") ? `--only=${process.argv[process.argv.indexOf("--only") + 1]}` : null);
const only = onlyArg ? onlyArg.split("=")[1].split(",").map(s => s.trim()).filter(Boolean) : null;

// Suites knowingly excluded, with the reason PRINTED on every run. A silent skip
// list is worse than no gate at all: it reads as green while proving nothing.
// Anything in here is a debt to pay down, not a permanent exemption.
const SKIP = {
    "verify-schedule-board-render-contract.ts":
        "stale since PR #272 consolidated popovers onto FloatingLayer — ~18 assertions "
        + "describe internals that moved out of FloatingPopover. Needs each invariant "
        + "re-verified against FloatingLayer individually, not blanket-repointed.",
};

const all = readdirSync(scriptsDir)
    .filter(f => /^verify-.*\.ts$/.test(f))
    .filter(f => !only || only.some(o => f.includes(o)))
    .sort();
// --only is an explicit request, so it overrides the skip list.
const suites = only ? all : all.filter(f => !SKIP[f]);
const skipped = only ? [] : all.filter(f => SKIP[f]);

if (suites.length === 0) {
    console.error("No verify-*.ts suites matched.");
    process.exit(1);
}

const results = [];
for (const suite of suites) {
    process.stdout.write(`\n── ${suite} ${"─".repeat(Math.max(0, 60 - suite.length))}\n`);
    const started = Date.now();
    const run = spawnSync("npx", ["tsx", path.join("scripts", suite)], {
        stdio: "inherit",
        shell: process.platform === "win32",
        env: process.env,
    });
    results.push({ suite, ok: run.status === 0, code: run.status, ms: Date.now() - started });
}

console.log(`\n${"=".repeat(72)}\nVERIFY SUMMARY\n${"=".repeat(72)}`);
for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.suite.padEnd(46)} ${(r.ms / 1000).toFixed(1)}s${r.ok ? "" : `  (exit ${r.code})`}`);
}
for (const s of skipped) console.log(`SKIP  ${s.padEnd(46)} ${SKIP[s]}`);
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} suites passed${skipped.length ? `, ${skipped.length} skipped` : ""}.`);
if (failed.length > 0) {
    console.log(`Failing: ${failed.map(r => r.suite).join(", ")}`);
    process.exit(1);
}

/**
 * The one-shot data scripts must LOAD under the runtime their own docs name
 * (Codex round 11, item 3).
 *
 * They import TypeScript from src/, so they need a loader. Plain `node` happens
 * to work on this machine (Node 24 strips types) and fails on CI's Node 20 —
 * which is the worst possible split, because these are the scripts someone runs
 * by hand, in a hurry, against production. The documented command is
 * `node --import=tsx`, and this asserts the documented command actually works.
 *
 * `--help` is deliberately the probe: it exercises the whole import graph with
 * no database, no env and no writes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.join(__dirname, "..");

const SCRIPTS = [
    "scripts/backfill-expense-attribution.ts",
    "scripts/suggest-expense-cost-codes.ts",
];

for (const script of SCRIPTS) {
    test(`${script} loads and prints usage under \`node --import=tsx\``, () => {
        const output = execFileSync(
            process.execPath,
            ["--import=tsx", script, "--help"],
            { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        // A failed import throws above (non-zero exit); this pins that the
        // script reached its own argument handling rather than merely starting.
        assert.match(output, /--import=tsx/, "usage text must name the required loader");
        assert.match(output, /--apply/, "and the write flag");
    });

    test(`${script} documents the loader in its own usage block`, () => {
        const source = execFileSync(
            process.execPath,
            ["-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(script)}, "utf8"))`],
            { cwd: ROOT, encoding: "utf8" },
        );
        // Nobody should be able to copy a bare `node scripts/...` line out of
        // the header and have it fail on the Node the rest of the repo pins.
        assert.ok(
            !/^\s*\*\s+node scripts\//m.test(source),
            "the usage block must not show a bare `node scripts/...` command",
        );
    });
}

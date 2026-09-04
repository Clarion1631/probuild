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
import { readFileSync } from "node:fs";
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

// ── the report script must stay READ-ONLY (round 12, item 4) ───────────────

test("suggest-expense-cost-codes issues no writes and offers no --apply", () => {
    // It used to have its own `--apply`, which made it a SECOND writer of
    // `costCodeId` — one that knew nothing about the per-expense lock, the
    // row-version CAS, the re-plan under that lock, or the project-scoped phase
    // check the real backfill applies. Two ways to code an expense, one of them
    // unaware of every guarantee the other was given.
    const source = readFileSync(path.join(ROOT, "scripts/suggest-expense-cost-codes.ts"), "utf8");
    const code = source
        .split("\n")
        .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");

    for (const write of [".update(", ".updateMany(", ".create(", ".delete(", ".deleteMany("]) {
        assert.ok(!code.includes(`prisma.expense${write}`), `write survived: ${write}`);
    }
    assert.ok(
        !/process\.argv\.includes\("--apply"\)/.test(code),
        "the --apply flag must be gone, not merely undocumented",
    );
});

test("the report scopes by the canonical overhead id, not the name \"Shop\"", () => {
    const source = readFileSync(path.join(ROOT, "scripts/suggest-expense-cost-codes.ts"), "utf8");
    assert.ok(source.includes("OVERHEAD_PROJECT_ID"), "excluded by id");
    assert.ok(!/notIn: OVERHEAD_PROJECTS/.test(source), "the name-based scope is gone");
    // ...and it reads attribution the one way, so a re-attributed expense is
    // not invisible to the report that is supposed to find it.
    assert.ok(source.includes("resolveExpenseProjectId"));
    assert.ok(source.includes("csvCell"), "OCR'd vendor text is formula-neutralized");
});

// ── the money backfill names its target (Codex round 48, item 5) ──────────

test("--apply refuses an ambient DATABASE_URL with no --target, before any write", () => {
    // This script writes `projectId`, `costCodeId` and `costCodeSource`. It
    // used to load .env.local/.env and take whatever DATABASE_URL was in the
    // shell — so the more dangerous of the two Phase 3 scripts was the less
    // guarded one, while the DDL script already had a target guard, a
    // project-ref check and a redacted identity line.
    //
    // The refusal happens before a PrismaClient is constructed, which is why
    // this needs no database: a local URL is supplied and never dialled.
    const ambient = {
        ...process.env,
        DATABASE_URL: "postgresql://probuild:probuild@localhost:5432/probuild",
    };
    const attempt = (args: string[]) => {
        try {
            const stdout = execFileSync(
                process.execPath,
                ["--import=tsx", "scripts/backfill-expense-attribution.ts", ...args],
                { cwd: ROOT, env: ambient, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
            );
            return { code: 0, output: stdout };
        } catch (error) {
            const failure = error as { status?: number; stdout?: string; stderr?: string };
            return { code: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
        }
    };

    const noTarget = attempt(["--apply"]);
    assert.notEqual(noTarget.code, 0, "it must not run");
    assert.match(noTarget.output, /REFUSING: --target is required/);
    assert.doesNotMatch(noTarget.output, /planned writes|applied \d/, "nothing was planned or written");

    // ...and naming prod does not rescue it: that target reads
    // .env.production.local, which is not checked in and is not on CI.
    const asProd = attempt(["--target", "prod", "--apply"]);
    assert.notEqual(asProd.code, 0);
    assert.match(asProd.output, /REFUSING/);
    assert.doesNotMatch(asProd.output, /planned writes|applied \d/);

    // ...and a target WITHOUT the database/host assertions is refused too.
    const noExpect = attempt(["--target", "ci", "--apply"]);
    assert.notEqual(noExpect.code, 0);
    assert.match(noExpect.output, /--expect-db and --expect-host/);
});

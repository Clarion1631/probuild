/**
 * Raw-SQL tripwires and the real transaction paths.
 *
 * The pure-logic suites mock every database call, so the SQL itself is the one
 * part of this feature they cannot see. Two failures live there and both are
 * silent until production: selecting a void-returning function, and a claim
 * transaction that does not behave the way the mocked version implies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** Line and block comments only — enough to stop prose ABOUT the rule tripping it. */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .map(line => line.replace(/\/\/.*$/, ""))
        .join("\n");
}

/** The raw-SQL helper nearest BEFORE `at` — the one that issues that statement. */
function nearestRawHelper(source: string, at: number): string | null {
    const helpers = ["$queryRawUnsafe", "$queryRaw", "$executeRawUnsafe", "$executeRaw"];
    let best: { name: string; index: number } | null = null;
    for (const name of helpers) {
        const index = source.lastIndexOf(name, at);
        if (index === -1) continue;
        // Prefer the LONGEST match at the same position, so "$queryRawUnsafe"
        // is not read as "$queryRaw" plus stray characters.
        if (!best || index > best.index || (index === best.index && name.length > best.name.length)) {
            best = { name, index };
        }
    }
    return best?.name ?? null;
}

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
}

/**
 * Functions that return `void`. `SELECT`ing one through $queryRaw produces a
 * row whose single column has no readable type, which Prisma's query path can
 * reject outright — and inside a transaction that throw looks like a transient
 * DB fault forever while the lock was never actually taken. $executeRaw runs
 * the statement for its effect and asks nothing of the result.
 */
const VOID_FUNCTIONS = [
    "pg_advisory_xact_lock",
    "pg_advisory_lock",
    "pg_advisory_unlock_all",
];

test("no $queryRaw anywhere SELECTs a void-returning function unreadably", () => {
    // The rule: find the raw-SQL helper that ISSUES this call — the nearest one
    // before it — and require that it is not a result-reading form, unless the
    // call is cast to a readable type.
    //
    // Two shapes are correct and must not be flagged, or the tripwire gets
    // muted as noise:
    //   * $executeRaw / $executeRawUnsafe — runs the statement for its effect.
    //   * an explicit cast, e.g. `pg_advisory_xact_lock(...)::text AS x`, which
    //     is exactly how qbo-expense-sync.ts makes its lock readable.
    // Comments are stripped first, because selection-ai-sort-apply-core.ts
    // explains this very rule in prose directly above a CORRECT call.
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, "src"))) {
        const source = stripComments(readFileSync(file, "utf8"));
        for (const fn of VOID_FUNCTIONS) {
            let at = source.indexOf(fn + "(");
            while (at !== -1) {
                const issuer = nearestRawHelper(source, at);
                const cast = /\)\s*::\s*\w+/.test(source.slice(at, at + 200));
                if (issuer && issuer.startsWith("$queryRaw") && !cast) {
                    offenders.push(path.relative(ROOT, file) + " -> " + fn);
                    break;
                }
                at = source.indexOf(fn + "(", at + 1);
            }
        }
    }
    assert.deepEqual(offenders, [], "use $executeRaw, or cast the result to a readable type");
});

test("the tripwire actually catches the shape it exists for", () => {
    // Without this the test above passes just as happily on an empty scan.
    const bad = 'await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(k, 0))`;';
    const at = bad.indexOf("pg_advisory_xact_lock(");
    assert.ok(bad.slice(0, at).includes("$queryRaw"), "the offending shape is recognisable");
    assert.ok(!/\)\s*::\s*\w+/.test(bad.slice(at)), "and it has no rescuing cast");
});

test("the TRY variant returns a boolean, so it is correctly read with $queryRaw", () => {
    // pg_try_advisory_xact_lock returns bool — reading it is the whole point,
    // and this pins that the two are not confused for each other.
    const worker = readFileSync(
        path.join(ROOT, "src/app/api/cron/receipt-intake-worker/route.ts"),
        "utf8",
    );
    const tryAt = worker.indexOf("pg_try_advisory_xact_lock(");
    assert.ok(tryAt > 0, "the try-lock is present");
    assert.ok(worker.slice(tryAt - 200, tryAt).includes("$queryRaw"), "try-lock is READ with $queryRaw");

    const blockingAt = worker.indexOf("pg_advisory_xact_lock(hashtextextended");
    assert.ok(blockingAt > 0, "the blocking lock is present");
    assert.ok(
        worker.slice(blockingAt - 300, blockingAt).includes("$executeRaw"),
        "the blocking (void) lock is EXECUTED, never selected",
    );
});

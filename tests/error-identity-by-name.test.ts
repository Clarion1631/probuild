/**
 * ERROR IDENTITY IS BY NAME, NOT BY `instanceof` (Codex round 40, item 4).
 *
 * Node 20 + tsx can load one module TWICE under different specifiers — a
 * relative import in one file and an aliased `@/lib/...` import in another
 * resolve to different module instances, each with its own class object. An
 * `instanceof` check against one of them answers FALSE for an error thrown by
 * the other, even though it is the same class in the same file.
 *
 * The branch already learned this three times and wrote the guards:
 * `isQBTimeoutError`, `isQboManagedExpenseError`,
 * `isEstimateAttributionPairConflict`. It then kept calling `instanceof` at the
 * sites that matter — the expense DELETE and PUT handlers, where a missed
 * `QboManagedExpenseError` turns a 409 the caller can act on into a 500, and
 * `isTerminalQboFault`, where a missed `QBTimeoutError` parks a row that only
 * needed a retry.
 *
 * So: where a shared guard EXISTS, the guard is the only permitted spelling.
 * This is a tripwire, not a proof — it fails when a new `instanceof` appears
 * for one of these classes, which is the failure a behavioural test cannot see.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
    }
    return out;
}

/**
 * Error class -> the shared guard that must be used instead, and the module
 * that owns both. The guard's OWN definition is allowed to say `instanceof`:
 * that is the fast path, and it is the one place where the class and the check
 * are guaranteed to come from the same module instance.
 */
const GUARDED_ERRORS: { klass: string; guard: string; owner: string }[] = [
    { klass: "QboManagedExpenseError", guard: "isQboManagedExpenseError", owner: "src/lib/qbo-expense-guard.ts" },
    { klass: "QBTimeoutError", guard: "isQBTimeoutError", owner: "src/lib/quickbooks.ts" },
    {
        klass: "EstimateAttributionPairConflictError",
        guard: "isEstimateAttributionPairConflict",
        owner: "src/lib/expense-attribution.ts",
    },
];

test("no src/ file uses instanceof for an error that has a shared name-based guard", () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, "src"))) {
        const relative = path.relative(ROOT, file).replace(/\\/g, "/");
        const source = readFileSync(file, "utf8");
        for (const { klass, guard, owner } of GUARDED_ERRORS) {
            if (relative === owner) continue;
            const uses = new RegExp(`instanceof\\s+${klass}\\b`);
            if (uses.test(source)) {
                offenders.push(`${relative}: use ${guard}() instead of \`instanceof ${klass}\``);
            }
        }
    }
    assert.deepEqual(offenders, [], offenders.join("\n  "));
});

test("the guards this pins actually exist and are name-based", () => {
    // A tripwire naming a guard nobody wrote passes forever. Each one must be
    // exported from its owner AND carry the `error.name` fallback, because the
    // `instanceof` half alone is exactly what fails under a duplicated module.
    for (const { klass, guard, owner } of GUARDED_ERRORS) {
        const source = readFileSync(path.join(ROOT, owner), "utf8");
        assert.ok(
            new RegExp(`export function ${guard}\\b`).test(source),
            `${owner} does not export ${guard}`,
        );
        const body = source.slice(source.indexOf(`export function ${guard}`));
        const decl = body.slice(0, body.indexOf("\n}"));
        assert.ok(
            new RegExp(`error\\.name === "${klass}"`).test(decl),
            `${guard} does not fall back to the error NAME, which is the whole point`,
        );
    }
});

test("the two sites round 40 found are the ones that were fixed", () => {
    // Pins the specific regression rather than trusting the scan: a missed
    // QboManagedExpenseError in these handlers is a 500 where the client
    // expected a 409 telling it the row is QuickBooks-owned.
    const source = readFileSync(path.join(ROOT, "src/app/api/expenses/[id]/route.ts"), "utf8");
    assert.equal(
        (source.match(/isQboManagedExpenseError\(/g) ?? []).length, 2,
        "the DELETE and PUT handlers both classify by name",
    );
    assert.ok(!/instanceof\s+QboManagedExpenseError/.test(source));
});

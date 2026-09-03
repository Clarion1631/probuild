/**
 * EVERY Expense writer that sets a cost code answers the phase question INSIDE
 * its write transaction (Codex round 18, item 4).
 *
 * There are six of them, written at different times by different hands, and
 * five had the same shape: ask `isCostCodeAllowedForProject` on the global
 * client, then write in a transaction that holds nothing. An estimate archived
 * or reassigned, or a cost code deactivated, in that window still landed on the
 * row — and on the routes that stamp "capture" or "manual" it landed as
 * something no automated pass is allowed to correct.
 *
 * This is a TRIPWIRE, not a proof: it fails when a NEW writer appears without
 * the invariant, which is the failure mode a behavioural test cannot see. The
 * behaviour itself is covered by tests/phase-invariant.test.ts (the rules and
 * the lock order) and by the concurrency test at the bottom of this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { assertPhaseOfProjectTx } from "../src/lib/phase-invariant";

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
 * A file that writes `costCodeId` onto an Expense.
 *
 * Scoped to the STATEMENT, not the file: billing-core builds ChangeOrderItems
 * carrying a `costCodeId` and, separately, stamps invoice ids onto expenses. A
 * file-wide search reads that pair as "an expense writer setting a phase" and
 * fails on a file that does nothing of the sort. The window is generous enough
 * to span a formatted `data: { ... }` block and short enough not to run into
 * the next unrelated statement.
 *
 * The window was 2000 and had to grow (round 38): the expense PUT's `where`
 * clause gained a `installedAtCustomer` CAS pin and the comment explaining it,
 * which pushed `costCodeId` in the SAME statement's `data` block past the cut
 * — and the tripwire reported the file as "no longer an Expense cost-code
 * writer" instead of reporting anything true. The companion test below is the
 * only reason that was noticed rather than silently reducing the scan to
 * nothing, which is exactly what it exists for.
 */
function writesAnExpenseCostCode(source: string): boolean {
    const writes = /(?:prisma|tx|transaction|client)\.expense\.(?:create|update|updateMany)\s*\(/g;
    for (let match = writes.exec(source); match; match = writes.exec(source)) {
        const window = source.slice(match.index, match.index + 3000);
        // `costCodeId` as an assigned VALUE inside the payload — never a
        // `select: { costCodeId: true }` and never a `where` predicate. Both
        // spellings count: `costCodeId: <value>` and the property SHORTHAND
        // `costCodeId,` that two of these routes use. Missing the shorthand is
        // how a tripwire quietly stops covering the writer it was written for.
        if (/data:\s*\{[\s\S]{0,1500}?costCodeId(:\s*(?!true\b)|\s*[,}])/.test(window)) return true;
    }
    return false;
}

test("every Expense writer that sets a cost code calls assertPhaseOfProjectTx", () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, "src"))) {
        const source = readFileSync(file, "utf8");
        if (!writesAnExpenseCostCode(source)) continue;
        if (source.includes("assertPhaseOfProjectTx")) continue;
        offenders.push(path.relative(ROOT, file).replace(/\\/g, "/"));
    }
    assert.deepEqual(
        offenders,
        [],
        "these write a phase onto an Expense without the transactional invariant:\n  " +
            offenders.join("\n  "),
    );
});

test("the writers we know about are actually in the scanned set", () => {
    // A tripwire that scans nothing passes forever. This pins that the scan
    // really does reach the six writers, so a future refactor that moves one
    // out of `src/` fails here rather than silently shrinking the net.
    const expected = [
        "src/app/api/expenses/route.ts",
        "src/app/api/expenses/[id]/route.ts",
        "src/app/api/integrations/receipt-ingest/route.ts",
        "src/lib/time-expense-core.ts",
        "src/lib/receipt-intake/book.ts",
        "src/lib/qbo-expense-sync.ts",
    ];
    const scanned = walk(path.join(ROOT, "src"))
        .filter(file => writesAnExpenseCostCode(readFileSync(file, "utf8")))
        .map(file => path.relative(ROOT, file).replace(/\\/g, "/"));
    for (const writer of expected) {
        assert.ok(scanned.includes(writer), `${writer} is no longer detected as an Expense cost-code writer`);
    }
});

// ── the concurrency the tripwire cannot see ────────────────────────────────

test("a phase deactivated between the check and the write is refused, not written", async () => {
    // The interleaving, deterministically: the caller's own validation passed
    // (that is the premise), and the code is deactivated before the write. The
    // invariant re-asks on the writing transaction and answers no.
    const world = { isActive: true };
    const tx = {
        async $queryRawUnsafe(query: string, ...args: unknown[]) {
            if (/FOR SHARE/.test(query)) {
                // The deactivation lands as the locks are taken — the last
                // moment it can, and the one a pre-transaction check misses.
                world.isActive = false;
                return [];
            }
            if (/FROM "Project" WHERE id/.test(query)) return [{ id: args[0], status: "In Progress" }];
            if (/FROM "CostCode" WHERE id/.test(query)) {
                return [{ id: args[0], code: "03-PLUMB", isActive: world.isActive }];
            }
            if (/FROM "EstimateItem"/.test(query)) return [{ ok: 1 }];
            return [];
        },
    };

    assert.deepEqual(
        await assertPhaseOfProjectTx(tx, "job-1", "cc-plumb"),
        { ok: false, reason: "code-inactive" },
        "the write must not proceed on an answer that was true a moment ago",
    );
});

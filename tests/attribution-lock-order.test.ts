/**
 * ONE ACQUISITION ORDER FOR THE ATTRIBUTION TABLES (Codex round 37, item 3).
 *
 * `src/lib/phase-invariant.ts` has declared
 *
 *     Project -> Estimate -> EstimateItem -> CostCode
 *
 * since it was written, and the backfill's DB test pins it. The LIVE writers
 * did not obey it: each of them took a slice of the set through
 * `lockEstimateAttribution` / `resolveExpenseProjectUnderLock` — which
 * share-lock the ESTIMATE, to re-read the attribution pair — and only
 * afterwards reached for the PROJECT through `assertPhaseOfProjectTx`. Against
 * a Project-first writer (a job editor holding its Project row FOR UPDATE and
 * then reaching for an estimate) that is a cycle, and Postgres breaks a cycle
 * by killing one side with 40P01.
 *
 * Two things are checked here, and neither can replace the other:
 *
 *   1. the helper emits the tables in the declared order, and folds a named
 *      estimate / line item into the ORDERED scan rather than locking it
 *      ahead of one (a unit test with a scripted client), and
 *   2. every transaction that reaches these tables both ways calls the helper
 *      FIRST (a source tripwire — it fails when a NEW writer appears without
 *      it, which is the failure a behavioural test cannot see).
 *
 * The behaviour itself — that two opposite orders now complete instead of
 * deadlocking — is in tests/phase-invariant-db.test.ts, against a real
 * Postgres, because a scripted client has no lock manager.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { lockAttributionParents } from "../src/lib/phase-invariant";

const ROOT = path.resolve(__dirname, "..");

/** A scripted transaction client that only records the SQL it is handed. */
function recorder() {
    const queries: string[] = [];
    const params: unknown[][] = [];
    return {
        queries,
        params,
        tx: {
            async $queryRawUnsafe(query: string, ...values: unknown[]) {
                queries.push(query);
                params.push(values);
                return [];
            },
        },
    };
}

const tableOf = (query: string) => query.match(/FROM "(\w+)"/)?.[1];

test("the full set is taken Project, Estimate, EstimateItem, CostCode", async () => {
    const rec = recorder();
    await lockAttributionParents(rec.tx, {
        projectId: "job-1",
        estimateId: "est-1",
        itemId: "item-1",
        costCodeId: "cc-1",
    });
    assert.deepEqual(rec.queries.map(tableOf), ["Project", "Estimate", "EstimateItem", "CostCode"]);
    assert.ok(rec.queries.every(query => /FOR SHARE/.test(query)), "share locks, never exclusive");
});

test("a named estimate joins the job's ORDERED scan instead of jumping it", async () => {
    // Locking the named estimate in its own statement first would put it ahead
    // of the job's ascending-id scan, and two callers naming different
    // estimates of the same job would then walk the table in opposite orders.
    const rec = recorder();
    await lockAttributionParents(rec.tx, { projectId: "job-1", estimateId: "est-1" });
    const estimate = rec.queries.find(query => tableOf(query) === "Estimate")!;
    assert.equal(rec.queries.filter(query => tableOf(query) === "Estimate").length, 1);
    assert.match(estimate, /"projectId" = \$1 OR id = \$2/);
    assert.match(estimate, /ORDER BY id/);
    assert.ok(estimate.indexOf("ORDER BY id") < estimate.indexOf("FOR SHARE"));
    assert.deepEqual(rec.params[1], ["job-1", "est-1"]);
});

test("a named line item joins the job's ORDERED item scan, and locks only the item", async () => {
    const rec = recorder();
    await lockAttributionParents(rec.tx, { projectId: "job-1", itemId: "item-1" });
    const item = rec.queries.find(query => /"EstimateItem"/.test(query))!;
    assert.match(item, /e\."projectId" = \$1 OR ei\.id = \$2/);
    assert.match(item, /ORDER BY ei\.id/);
    // `FOR SHARE OF ei` and not a bare `FOR SHARE`: the joined Estimate rows
    // are held by the scan before this one, and locking them again here would
    // put an Estimate acquisition AFTER an EstimateItem one.
    assert.match(item, /FOR SHARE OF ei/);
});

test("only what the caller named is locked", async () => {
    // Every slice has to be omissible, or a caller with no cost code (a
    // booking that carries none) would be forced to invent one to use the
    // helper at all.
    const bare = recorder();
    await lockAttributionParents(bare.tx, {});
    assert.deepEqual(bare.queries, []);

    const estimateOnly = recorder();
    await lockAttributionParents(estimateOnly.tx, { estimateId: "est-1" });
    assert.deepEqual(estimateOnly.queries.map(tableOf), ["Estimate"]);
    assert.match(estimateOnly.queries[0], /WHERE id = \$1 ORDER BY id FOR SHARE/);

    const projectOnly = recorder();
    await lockAttributionParents(projectOnly.tx, { projectId: "job-1", costCodeId: "cc-1" });
    assert.deepEqual(projectOnly.queries.map(tableOf), ["Project", "Estimate", "EstimateItem", "CostCode"]);
    // The project-only shape is byte-for-byte what `lockPhaseRowsForShare`
    // emitted before it was folded into this helper, so nothing about the
    // established order moved.
    assert.match(projectOnly.queries[1], /^SELECT id FROM "Estimate" WHERE "projectId" = \$1 ORDER BY id FOR SHARE$/);
});

// ── the tripwire ───────────────────────────────────────────────────────────

/** Calls that share-lock an ESTIMATE (or an EstimateItem) on their own. */
const ESTIMATE_FIRST = [
    "lockEstimateAttribution(",
    "resolveExpenseProjectUnderLock(",
    "itemBelongsToEstimateTx(",
    "itemBelongsToProjectTx(",
];
/** Calls that reach the PROJECT row. */
const PROJECT_FIRST = ["assertPhaseOfProjectTx(", "lockPhaseRowsForShare("];

/**
 * Every `$transaction(...)` body in a file, by brace matching from the opening
 * parenthesis. Scoped per transaction because a file can hold several: the
 * expense DELETE handler legitimately locks nothing but the estimate, and a
 * file-wide scan would read that as the PUT handler's ordering.
 */
function transactionBodies(source: string): string[] {
    const bodies: string[] = [];
    const opens = /\$transaction\s*\(/g;
    for (let match = opens.exec(source); match; match = opens.exec(source)) {
        let depth = 0;
        let i = match.index + match[0].length - 1;
        for (; i < source.length; i++) {
            if (source[i] === "(") depth++;
            else if (source[i] === ")") {
                depth--;
                if (depth === 0) break;
            }
        }
        bodies.push(source.slice(match.index, i));
    }
    return bodies;
}

/**
 * The writers that exist TODAY. The scan below covers all of `src/` rather
 * than this list — a fixed list is blind to the next writer, which is the only
 * failure a tripwire is for — and this is here so a refactor that moves one of
 * them out of the scanned set fails loudly instead of quietly shrinking the
 * net.
 */
const WRITERS = [
    "src/app/api/expenses/route.ts",
    "src/app/api/expenses/[id]/route.ts",
    "src/app/api/integrations/receipt-ingest/route.ts",
    "src/lib/time-expense-core.ts",
    "src/lib/receipt-intake/book.ts",
    "src/lib/qbo-expense-sync.ts",
];

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
    }
    return out;
}

const firstIndexOf = (body: string, needles: string[]) =>
    needles
        .map(needle => body.indexOf(needle))
        .filter(index => index >= 0)
        .sort((a, b) => a - b)[0];

/** Every `$transaction` in `src/` that reaches BOTH the Project and an Estimate. */
function mixedOrderTransactions(): { file: string; index: number; body: string }[] {
    const found: { file: string; index: number; body: string }[] = [];
    for (const file of walk(path.join(ROOT, "src"))) {
        const source = readFileSync(file, "utf8");
        if (!ESTIMATE_FIRST.some(needle => source.includes(needle))) continue;
        for (const [index, body] of transactionBodies(source).entries()) {
            if (firstIndexOf(body, ESTIMATE_FIRST) === undefined) continue;
            if (firstIndexOf(body, PROJECT_FIRST) === undefined) continue;
            found.push({ file: path.relative(ROOT, file).replace(/\\/g, "/"), index, body });
        }
    }
    return found;
}

test("every transaction that reaches both tables takes the whole set first", () => {
    const offenders: string[] = [];
    const mixed = mixedOrderTransactions();
    for (const { file, index, body } of mixed) {
        const setAt = body.indexOf("lockAttributionParents(");
        if (setAt < 0) {
            offenders.push(`${file} $transaction #${index + 1}: no lockAttributionParents call`);
            continue;
        }
        const estimateAt = firstIndexOf(body, ESTIMATE_FIRST)!;
        const projectAt = firstIndexOf(body, PROJECT_FIRST)!;
        if (setAt > estimateAt || setAt > projectAt) {
            offenders.push(`${file} $transaction #${index + 1}: lockAttributionParents is not first`);
        }
    }
    assert.deepEqual(offenders, [], offenders.join("\n  "));
    // A tripwire that scans nothing passes forever.
    assert.ok(mixed.length >= 6, `only ${mixed.length} mixed-order transactions found`);
});

test("the writers we know about are actually in the scanned set", () => {
    const scanned = new Set(mixedOrderTransactions().map(entry => entry.file));
    for (const writer of WRITERS) {
        assert.ok(scanned.has(writer), `${writer} is no longer detected as a mixed-order writer`);
    }
});

test("the writers that lock only ONE of the tables are left alone", () => {
    // The point of scoping per transaction rather than per file. The expense
    // DELETE handler resolves the job under the estimate lock and never asks a
    // phase question, so it has no ordering to get wrong — and forcing a
    // Project lock into it would ADD a table to a transaction that does not
    // need one.
    const source = readFileSync(path.join(ROOT, "src/app/api/expenses/[id]/route.ts"), "utf8");
    const bodies = transactionBodies(source);
    const estimateOnly = bodies.filter(
        body => firstIndexOf(body, ESTIMATE_FIRST) !== undefined && firstIndexOf(body, PROJECT_FIRST) === undefined,
    );
    assert.ok(estimateOnly.length >= 1, "the DELETE handler is no longer estimate-only");
    assert.ok(
        estimateOnly.every(body => !body.includes("lockAttributionParents(")),
        "an estimate-only transaction does not need the whole set",
    );
});

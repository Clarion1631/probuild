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
/** Calls that reach the PROJECT row by name. */
const PROJECT_FIRST = ["assertPhaseOfProjectTx(", "lockPhaseRowsForShare("];

/**
 * THE LOCK NOBODY WRITES DOWN (round 38, item 1).
 *
 * An INSERT or UPDATE that sets `Expense.projectId` makes Postgres take
 * `FOR KEY SHARE` on the referenced `Project` row to enforce the foreign key,
 * and `FOR KEY SHARE` conflicts with the `FOR UPDATE` a Project-first job
 * editor holds. `Expense.estimateId` does the same to `Estimate`.
 *
 * So a transaction can be `Estimate -> Project` without its source ever
 * containing the string `"Project"` — which is exactly how round 37's tripwire
 * cleared three writers that were still inverted: the QBO create path, the QBO
 * attribution fill, and the AI receipt parser. A scan that only counts the
 * helper calls is measuring the documentation, not the locks.
 *
 * Scoped to the STATEMENT, like `writesAnExpenseCostCode` in
 * expense-writer-phase-guard.test.ts and for the same reason: a file-wide
 * search reads an unrelated `projectId` as an attribution write. `where`
 * clauses do not count — `expenseStillOnProjectWhere` puts `projectId` in a
 * predicate, which takes no lock on the parent.
 */
const EXPENSE_WRITE = /(?:prisma|tx|transaction|client|db)\.expense\.(?:create|update|updateMany|upsert)\s*\(/g;

/**
 * The column as an assigned VALUE inside a write payload — never
 * `select: { projectId: true }`, and never a `where` predicate. Both
 * spellings count: `projectId: <value>` and the property SHORTHAND
 * `projectId,`, because missing the shorthand is how a tripwire quietly stops
 * covering the writer it was written for.
 *
 * THE VALUE IS CAPTURED AND CHECKED IN CODE rather than excluded by a
 * lookahead. `projectId(:\s*(?!true\b)|...)` looks like it rejects a
 * `select: { projectId: true }`, and does not: `\s*` is free to match ZERO
 * characters, which puts the lookahead in front of a SPACE, where `true` does
 * not match and the negative lookahead therefore passes. Capturing the token
 * and comparing it cannot be backtracked around.
 *
 * Written as literal regexes rather than built from a template, because a
 * template literal eats the backslashes these need.
 */
const ASSIGNS_FK = {
    projectId: /data:\s*\{[\s\S]{0,1500}?\bprojectId\s*(?:([,}])|:\s*([^,}\s]+))/,
    estimateId: /data:\s*\{[\s\S]{0,1500}?\bestimateId\s*(?:([,}])|:\s*([^,}\s]+))/,
};

function fkWritePosition(body: string, column: "projectId" | "estimateId"): number | undefined {
    const writes = new RegExp(EXPENSE_WRITE.source, "g");
    for (let match = writes.exec(body); match; match = writes.exec(body)) {
        const window = body.slice(match.index, match.index + 2000);
        const assigned = ASSIGNS_FK[column].exec(window);
        if (!assigned) continue;
        const [, shorthand, value] = assigned;
        // `true` is a `select`, not a value. Everything else — a variable, a
        // property access, a ternary, a null — is a real foreign-key write.
        if (shorthand || value !== "true") return match.index;
    }
    return undefined;
}

/**
 * Where this transaction first touches the ESTIMATE and the PROJECT — counting
 * the implicit foreign-key locks, not just the helper calls.
 */
function acquisitions(body: string): { estimate?: number; project?: number } {
    const first = (values: (number | undefined)[]) =>
        values.filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0];
    return {
        estimate: first([firstIndexOf(body, ESTIMATE_FIRST), fkWritePosition(body, "estimateId")]),
        project: first([firstIndexOf(body, PROJECT_FIRST), fkWritePosition(body, "projectId")]),
    };
}

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
        for (const [index, body] of transactionBodies(source).entries()) {
            const { estimate, project } = acquisitions(body);
            if (estimate === undefined || project === undefined) continue;
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
        const { estimate, project } = acquisitions(body);
        if (setAt > estimate! || setAt > project!) {
            offenders.push(`${file} $transaction #${index + 1}: lockAttributionParents is not first`);
        }
    }
    assert.deepEqual(offenders, [], offenders.join("\n  "));
    // A tripwire that scans nothing passes forever.
    assert.ok(mixed.length >= 8, `only ${mixed.length} mixed-order transactions found`);
});

test("a foreign-key write of projectId/estimateId counts as reaching those tables", () => {
    // THE DETECTOR ITSELF (round 38, item 1). Round 37's version counted only
    // the helper calls, so three transactions that reach `Project` purely
    // through a foreign key — the QBO create path, the QBO attribution fill,
    // and the AI receipt parser — scanned as estimate-only and were left
    // inverted. These are the exact shapes that defeated it.
    const create = `tx.expense.create({ data: { estimateId: pair.estimateId, projectId: pair.projectId } })`;
    assert.equal(typeof fkWritePosition(create, "projectId"), "number");
    assert.equal(typeof fkWritePosition(create, "estimateId"), "number");

    const fill = `await transaction.expense.updateMany({
        where: { id: existing.id, projectId: null },
        data: { projectId: pair.projectId, estimateId: pair.estimateId },
    });`;
    assert.equal(typeof fkWritePosition(fill, "projectId"), "number");

    // The property SHORTHAND, which two of these routes use.
    assert.equal(
        typeof fkWritePosition(`tx.expense.create({ data: { amount, projectId, vendor } })`, "projectId"),
        "number",
    );

    // `expenseStillOnProjectWhere` puts projectId in a PREDICATE. Postgres
    // takes no lock on a parent row for a WHERE clause, and counting it would
    // make the tripwire demand a Project lock from every scoped read.
    const predicateOnly = `await tx.expense.updateMany({
        where: { id, projectId: lockedProjectId },
        data: { status: "Reviewed" },
    });`;
    assert.equal(fkWritePosition(predicateOnly, "projectId"), undefined);

    // ...and a `select` is not a write either.
    const selectOnly = `await tx.expense.update({ where: { id }, data: { vendor }, select: { projectId: true } })`;
    assert.equal(fkWritePosition(selectOnly, "projectId"), undefined);
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

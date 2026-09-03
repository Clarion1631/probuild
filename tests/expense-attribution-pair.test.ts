/**
 * `projectId` and `estimateId` are ONE fact, and every creator wrote them from
 * two reads taken minutes apart (Codex round 20, item 3).
 *
 * The project is the answer and the estimate is where it came from. Resolving
 * the estimate's project, doing other work — a cost-code lookup, a receipt-file
 * check, a QBO round trip — and only then inserting both means an estimate
 * moved in that window is persisted alongside the OLD project: an expense on
 * two jobs at once, which `resolveExpenseProjectId` and every join through the
 * estimate answer differently, and no report can be right about.
 *
 * These drive the shared helpers against a scripted database, so each
 * interleaving is deterministic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
    assertEstimateMoveKeepsAttributionPairs,
    isEstimateAttributionPairConflict,
    itemBelongsToEstimateTx,
    lockEstimateAttribution,
} from "../src/lib/expense-attribution";

function db(world: {
    estimateProject: string | null;
    items?: { id: string; estimateId: string }[];
    onLock?: () => void;
}) {
    const queries: string[] = [];
    const tx = {
        async $queryRawUnsafe(query: string, ...args: unknown[]) {
            queries.push(query.replace(/\s+/g, " ").trim());
            if (/FROM "Estimate" WHERE id/.test(query) && /FOR SHARE/.test(query)) {
                world.onLock?.();
                return [];
            }
            if (/FROM "Estimate" WHERE id/.test(query)) {
                return [{ projectId: world.estimateProject }];
            }
            if (/FROM "EstimateItem"/.test(query)) {
                const [itemId, estimateId] = args as string[];
                return (world.items ?? []).some(
                    item => item.id === itemId && item.estimateId === estimateId,
                )
                    ? [{ id: itemId }]
                    : [];
            }
            return [];
        },
    };
    return { tx, queries };
}

test("the pair comes back together, from a LOCKED estimate", async () => {
    const { tx, queries } = db({ estimateProject: "job-1" });
    assert.deepEqual(await lockEstimateAttribution(tx, "est-1"), {
        estimateId: "est-1",
        projectId: "job-1",
    });
    // The lock is taken BEFORE the read it protects — a read taken first
    // describes a moment the lock then fails to preserve.
    assert.match(queries[0], /FOR SHARE/);
    assert.ok(!/FOR SHARE/.test(queries[1]), "then the read");
});

test("an estimate with no project is not half a pair", async () => {
    // Callers must refuse: there is no job to attribute against, and writing
    // the estimate alone would leave a row nobody can resolve.
    const { tx } = db({ estimateProject: null });
    assert.equal(await lockEstimateAttribution(tx, "est-1"), null);
});

test("a MOVED estimate reports its new job, not the caller's stale one", async () => {
    // This is the whole point: the caller compares what it read earlier with
    // what this returns, and refuses when they differ.
    const { tx } = db({ estimateProject: "job-2" });
    const pair = await lockEstimateAttribution(tx, "est-1");
    assert.equal(pair?.projectId, "job-2");
    assert.notEqual(pair?.projectId, "job-1", "the pre-transaction answer is void");
});

test("the lock is taken even when the estimate has since vanished", async () => {
    const { tx, queries } = db({ estimateProject: null });
    await lockEstimateAttribution(tx, "gone");
    assert.match(queries[0], /FOR SHARE/);
});

// ── the line item is re-checked under the same lock ────────────────────────

test("an item on the estimate passes; one that was re-parented does not", async () => {
    const world = { estimateProject: "job-1", items: [{ id: "item-1", estimateId: "est-1" }] };
    const { tx } = db(world);
    assert.equal(await itemBelongsToEstimateTx(tx, "item-1", "est-1"), true);
    assert.equal(
        await itemBelongsToEstimateTx(tx, "item-1", "est-2"),
        false,
        "an item is only on one estimate",
    );
    assert.equal(await itemBelongsToEstimateTx(tx, "item-elsewhere", "est-1"), false);
});

test("the item check locks the row it answers about", async () => {
    // A re-parented item is how a cost code from another job reaches an
    // expense, so the answer has to hold until the write.
    const { tx, queries } = db({ estimateProject: "job-1", items: [{ id: "i", estimateId: "e" }] });
    await itemBelongsToEstimateTx(tx, "i", "e");
    assert.match(queries[0], /FROM "EstimateItem"/);
    assert.match(queries[0], /FOR SHARE/);
});

// ── the OTHER end: moving the estimate must not orphan the pair ───────────

/**
 * A move-guard database. `expenses` is what the grouped conflict query would
 * return; `locks` records the FOR UPDATE statements `lockMoneyParentsMany`
 * issues, because the count is worthless if it can be falsified before the
 * move commits.
 */
function moveDb(expenses: { estimateId: string; projectId: string; expenses: number }[]) {
    const locks: string[] = [];
    const conflictQueries: { ids: string[]; target: string }[] = [];
    const tx = {
        async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
            locks.push(strings.join("?") + " :: " + values.join(","));
            return [];
        },
        async $queryRawUnsafe(query: string, ...args: unknown[]) {
            conflictQueries.push({ ids: args[0] as string[], target: args[1] as string });
            const [ids, target] = args as [string[], string];
            return expenses.filter(row => ids.includes(row.estimateId) && row.projectId !== target);
        },
    } as any;
    return { tx, locks, conflictQueries };
}

test("an estimate whose expenses are pinned elsewhere cannot be moved", async () => {
    // `Expense.projectId` is write-once; `Estimate.projectId` is not. Moving
    // the estimate to job-2 would leave three expenses claiming job-1 while the
    // estimate, the billing paths and the phase cascade all follow job-2 — one
    // expense on two jobs, which is the exact shape the pair exists to prevent.
    const { tx } = moveDb([{ estimateId: "est-1", projectId: "job-1", expenses: 3 }]);
    await assert.rejects(
        () => assertEstimateMoveKeepsAttributionPairs(tx, ["est-1"], "job-2"),
        (error: unknown) => {
            assert.ok(isEstimateAttributionPairConflict(error), "a typed conflict, not a bare Error");
            // The operator has to be able to act on it without reading the code.
            assert.match((error as Error).message, /est-1/);
            assert.match((error as Error).message, /job-1/);
            assert.match((error as Error).message, /Re-attribute those expenses/);
            return true;
        },
    );
});

test("a move with no linked expenses is allowed", async () => {
    const { tx } = moveDb([]);
    await assertEstimateMoveKeepsAttributionPairs(tx, ["est-1", "est-2"], "job-2");
});

test("expenses ALREADY on the target job are not a conflict", async () => {
    // Re-running a conversion, or converting onto the job the rows already
    // name, moves nothing and breaks nothing.
    const { tx } = moveDb([{ estimateId: "est-1", projectId: "job-2", expenses: 5 }]);
    await assertEstimateMoveKeepsAttributionPairs(tx, ["est-1"], "job-2");
});

test("a NULL-projectId expense is not a conflict — the move is what answers it", async () => {
    // The query itself excludes them (`e."projectId" IS NOT NULL`), because
    // such a row has no pinned job at all: it resolves THROUGH the estimate, so
    // the move takes it along. Asserted on the SQL, since the fake cannot
    // model a predicate it never sees.
    const { tx, conflictQueries } = moveDb([]);
    await assertEstimateMoveKeepsAttributionPairs(tx, ["est-1"], "job-2");
    assert.equal(conflictQueries.length, 1);
    const sql = readFileSync(path.join(ROOT, "src", "lib", "expense-attribution.ts"), "utf8");
    const query = sql.slice(sql.indexOf('WHERE e."estimateId" = ANY'));
    assert.match(query.slice(0, 400), /e\."projectId" IS NOT NULL/);
    assert.match(query.slice(0, 400), /e\."projectId" <> \$2/);
});

test("the estimates are LOCKED before they are counted", async () => {
    // A count taken without a lock is a count a concurrent booking can falsify
    // between the check and the move. Ascending ids, one row per statement —
    // the same order `lockMoneyParentsMany` gives every other money path, so
    // this cannot deadlock against a settle.
    const { tx, locks } = moveDb([]);
    await assertEstimateMoveKeepsAttributionPairs(tx, ["est-b", "est-a", "est-b"], "job-2");
    assert.equal(locks.length, 2, "deduplicated");
    assert.ok(locks.every(lock => /FOR UPDATE/.test(lock)));
    assert.match(locks[0], /est-a/);
    assert.match(locks[1], /est-b/);
});

test("an empty id list takes no locks and asks nothing", async () => {
    const { tx, locks, conflictQueries } = moveDb([]);
    await assertEstimateMoveKeepsAttributionPairs(tx, [], "job-2");
    assert.deepEqual(locks, []);
    assert.deepEqual(conflictQueries, []);
});

test("the conflict is identified by NAME, not instanceof", () => {
    // Node 20 + tsx can load a module twice under different specifiers, which
    // makes `instanceof` false for an error this very file threw — the same
    // trap QBNotConnectedError hit (commit 953606ec).
    const impostor = new Error("nope");
    impostor.name = "EstimateAttributionPairConflictError";
    assert.equal(isEstimateAttributionPairConflict(impostor), true);
    assert.equal(isEstimateAttributionPairConflict(new Error("nope")), false);
    assert.equal(isEstimateAttributionPairConflict(null), false);
});

// ── the tripwire: every writer of the pair re-reads it under lock ──────────

/**
 * The `data: { … }` payload of a write, extracted by matching BRACES rather
 * than by a character budget.
 *
 * A fixed window is what makes this kind of scan lie: billing-core's
 * `expense.updateMany` writes `{ invoiceId, invoicedAt }` and a 1,500-character
 * window from its `data:` runs straight past the closing brace into the next
 * statement, where `projectId` appears for an unrelated reason. Reading the
 * actual object is the difference between "a writer of this column" and "a file
 * that mentions it nearby".
 */
function firstDataPayload(source: string, from: number): string | null {
    const open = /data:\s*\{/g;
    open.lastIndex = from;
    const match = open.exec(source);
    if (!match) return null;
    let depth = 0;
    for (let index = match.index + match[0].length - 1; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(match.index, index + 1);
        }
    }
    return null;
}

/**
 * A file that writes `projectId` onto an Expense.
 *
 * Same reasoning as `writesAnExpenseCostCode` in
 * tests/expense-writer-phase-guard.test.ts: scoped to the STATEMENT rather
 * than the file, so a `select: { projectId: true }` or a `where` predicate
 * elsewhere in the same file cannot be mistaken for a write.
 */
function writesAnExpenseProjectId(source: string): boolean {
    const writes = /(?:prisma|tx|transaction|client)\.expense\.(?:create|update|updateMany)\s*\(/g;
    for (let match = writes.exec(source); match; match = writes.exec(source)) {
        const payload = firstDataPayload(source, match.index);
        if (!payload) continue;
        // The property as a WRITTEN value — `projectId: x` or the shorthand
        // `projectId,` — never `projectId: true`, which is a select.
        if (/(^|[\s,{])projectId(\s*:\s*(?!true\b)|\s*[,}])/.test(payload)) return true;
    }
    return false;
}

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
    }
    return out;
}

const ROOT = path.resolve(__dirname, "..");

test("every writer of Expense.projectId re-reads the pair under lock", () => {
    // A TRIPWIRE, not a proof: it fails when a NEW writer appears that stamps a
    // project from a value read before its transaction — which is exactly how
    // four of them shipped (Codex round 21, item 1). The behaviour is covered
    // by the per-writer interleaving tests.
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, "src"))) {
        const source = readFileSync(file, "utf8");
        if (!writesAnExpenseProjectId(source)) continue;
        if (source.includes("lockEstimateAttribution")) continue;
        offenders.push(path.relative(ROOT, file).split(path.sep).join("/"));
    }
    assert.deepEqual(
        offenders,
        [],
        "these stamp a job onto an Expense without re-reading the estimate under lock:\n  " +
            offenders.join("\n  "),
    );
});

/**
 * The balanced `( ... )` argument list of a call whose `(` sits at `open`.
 *
 * Needed because an UPSERT has no top-level `data:` — a forward search for one
 * would walk out of the statement and read the NEXT one's payload, the same
 * "a fixed window makes this kind of scan lie" failure `firstDataPayload` was
 * written to avoid.
 */
function callArguments(source: string, open: number): string | null {
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        if (source[index] === "(") depth += 1;
        else if (source[index] === ")") {
            depth -= 1;
            if (depth === 0) return source.slice(open, index + 1);
        }
    }
    return null;
}

/** The `{ … }` value of `key:` inside an argument list, matched by braces. */
function objectProperty(args: string, key: string): string | null {
    const open = new RegExp(String.raw`\b${key}:\s*\{`, "g");
    const match = open.exec(args);
    if (!match) return null;
    let depth = 0;
    for (let index = match.index + match[0].length - 1; index < args.length; index += 1) {
        if (args[index] === "{") depth += 1;
        else if (args[index] === "}") {
            depth -= 1;
            if (depth === 0) return args.slice(match.index, index + 1);
        }
    }
    return null;
}

/**
 * A file that MOVES an existing estimate to another job.
 *
 * `create` is deliberately excluded: a brand-new estimate has no expenses to
 * strand, and `duplicateEstimate` "moving" an estimate onto another project is
 * really a create. Only `update` / `updateMany` / an `upsert`'s update half can
 * change a `projectId` that expenses were already written against.
 */
function movesAnEstimateProject(source: string): boolean {
    const writes = /(?:prisma|tx|transaction|client|t)\.estimate\.(?:update|updateMany|upsert)\s*\(/g;
    for (let match = writes.exec(source); match; match = writes.exec(source)) {
        const args = callArguments(source, match.index + match[0].length - 1);
        if (!args) continue;
        for (const key of ["data", "update"]) {
            const payload = objectProperty(args, key);
            // The property as a WRITTEN value — never `projectId: true`, which
            // is a select.
            if (payload && /(^|[\s,{])projectId(\s*:\s*(?!true\b)|\s*[,}])/.test(payload)) return true;
        }
    }
    return false;
}

test("every path that MOVES an estimate checks the attribution pair first", () => {
    // The mirror of the tripwire above, from the other end (Codex round 32).
    // `lockEstimateAttribution` stops a WRITER persisting a stale pair; nothing
    // stopped an estimate MOVE from invalidating a pair that was already
    // written correctly. Today `convertLeadToProjectCore` is the only such
    // path — a second one must not ship without the guard.
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, "src"))) {
        const source = readFileSync(file, "utf8");
        if (!movesAnEstimateProject(source)) continue;
        if (source.includes("assertEstimateMoveKeepsAttributionPairs")) continue;
        offenders.push(path.relative(ROOT, file).split(path.sep).join("/"));
    }
    assert.deepEqual(
        offenders,
        [],
        "these move an estimate between jobs without checking the expenses booked through it: " +
            offenders.join(", "),
    );
});

test("the estimate-move scanner actually sees the one mover we have", () => {
    // A tripwire that scans nothing passes forever. This is also the control
    // for the exclusion above: the file IS detected, and only the guard call
    // keeps it off the offender list.
    const source = readFileSync(path.join(ROOT, "src", "lib", "lead-conversion-core.ts"), "utf8");
    assert.ok(movesAnEstimateProject(source), "lead conversion is no longer detected as a mover");
    assert.ok(
        source.includes("assertEstimateMoveKeepsAttributionPairs"),
        "and it still calls the guard",
    );
    // It moves only the ids it checked. A `where: { leadId }` re-scan for the
    // write can pick up an estimate the guard never saw, because a row can
    // acquire that leadId between the two statements under READ COMMITTED.
    assert.match(source, /where: \{ id: \{ in: movingEstimateIds \} \}/);
    assert.ok(
        !/estimate\.updateMany\(\{ where: \{ leadId \}, data: \{ projectId/.test(source),
        "the unguarded leadId-scoped move must be gone",
    );
});

test("the estimate-move scanner tells a move from a create, and stays in its statement", () => {
    assert.ok(
        !movesAnEstimateProject(`await prisma.estimate.create({ data: { projectId: target } });`),
        "a create has no expenses to strand",
    );
    assert.ok(
        movesAnEstimateProject(
            `await prisma.estimate.upsert({ where: { id }, create: { x: 1 }, update: { projectId: p } });`,
        ),
        "an upsert that re-points a project IS a move",
    );
    assert.ok(
        !movesAnEstimateProject(
            `await prisma.estimate.update({ where: { id }, data: { status } });\nawait other({ data: { projectId } });`,
        ),
        "the scan must not walk out of the statement into the next one's payload",
    );
    assert.ok(
        !movesAnEstimateProject(`await prisma.estimate.update({ where: { id }, data: { code }, select: { projectId: true } });`),
        "a select is not a write",
    );
});

test("the writers we know about are actually in the scanned set", () => {
    // A tripwire that scans nothing passes forever.
    const expected = [
        "src/app/api/expenses/route.ts",
        "src/app/api/integrations/receipt-ingest/route.ts",
        "src/app/api/receipts/parse/route.ts",
        "src/lib/time-expense-core.ts",
        "src/lib/receipt-intake/book.ts",
        "src/lib/qbo-expense-sync.ts",
    ];
    const scanned = walk(path.join(ROOT, "src"))
        .filter(file => writesAnExpenseProjectId(readFileSync(file, "utf8")))
        .map(file => path.relative(ROOT, file).split(path.sep).join("/"));
    for (const writer of expected) {
        assert.ok(scanned.includes(writer), `${writer} is no longer detected as an attribution writer`);
    }
});

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

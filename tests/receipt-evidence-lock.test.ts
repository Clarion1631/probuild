import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { RECEIPT_EVIDENCE_LOCK } from "../src/lib/receipt-evidence-lock";

/**
 * THE TRIPWIRE FOR THE RECEIPT-EVIDENCE FENCE (Codex PR #443 gate round 42,
 * finding 1).
 *
 * The missing-receipt sweep decides from evidence it READ — ReceiptIntake rows
 * and Expense receipt linkage — and holds one advisory lock across those reads
 * AND its ReviewIssue writes. That only fences anything if every writer of that
 * evidence takes the same lock inside its own transaction, so this walks `src/`
 * and fails when one does not.
 *
 * Same technique as the bank-ledger writer scan: find the write shapes, then
 * insist on the lock. The allowlist below is the list of writes that provably
 * cannot change what the sweep reads, each with its reason — an allowlist with
 * reasons is a decision; an allowlist without them is a hole.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(repoRoot, "src");

/** Writes that do not change sweep-visible evidence, and why. */
const ALLOWED: Array<{ file: string; because: string }> = [
    {
        file: "src/lib/receipt-intake/park.ts",
        because: "builds a write PLAN as data; the caller executes it under the lock",
    },
    {
        file: "src/lib/receipt-intake/route-state.ts",
        because: "pure routing decisions — it returns states, it writes nothing",
    },
    {
        file: "src/lib/billing-core.ts",
        because: "stamps invoiceId/invoicedAt on already-billed expenses; it never touches receipt linkage, which is the only Expense column the sweep reads",
    },
    {
        file: "src/lib/qbo-expense-sync.ts",
        because: "same reason as billing-core: its Expense writes are the QBO import's own columns and the cost-code SUGGESTION (costCodeId/costCodeSource/costCodeConfidence), never receipt linkage. `receiptUrl` appears in this file only in two comments explaining that the import deliberately does NOT write it, which is what this scan's file-level heuristic matched on",
    },
];

const WRITE_SHAPES = /\b(?:prisma|tx|db|client)\.(receiptIntake|expense)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;
/** Anything that means "this write is inside a transaction that took the lock". */
const LOCK_MARKERS = /lockReceiptEvidence\(|withReceiptEvidenceLock|evidenceCreate\(|evidenceUpdateMany\(|evidenceDeleteMany\(|evidenceDelete\(/;

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (/\.tsx?$/.test(full)) out.push(full);
    }
    return out;
}

test("every receipt-evidence writer takes the evidence lock", () => {
    const offenders: string[] = [];
    const covered: string[] = [];

    for (const file of walk(srcRoot)) {
        const rel = relative(repoRoot, file).replace(/\\/g, "/");
        const source = readFileSync(file, "utf8");
        const lines = source.split(/\r?\n/);
        const writes = lines.filter(line => WRITE_SHAPES.test(line) && !/\/\//.test(line.trim().slice(0, 2)));
        if (writes.length === 0) continue;

        // An Expense write only counts when it touches receipt linkage — the
        // sweep reads `receiptUrl`, not amounts or cost codes.
        const touchesEvidence = /receiptIntake\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(source)
            || /receiptUrl|receiptIntake:/.test(source);
        if (!touchesEvidence) continue;

        const allowed = ALLOWED.find(entry => entry.file === rel);
        if (allowed) {
            assert.ok(allowed.because.length > 10, `${rel}: an allowlist entry needs a reason`);
            continue;
        }

        if (LOCK_MARKERS.test(source)) covered.push(rel);
        else offenders.push(rel);
    }

    assert.deepEqual(
        offenders, [],
        `these files write receipt evidence without taking the evidence lock:\n  ${offenders.join("\n  ")}`,
    );
    // A tripwire that matches nothing is a tripwire nobody has to step over.
    assert.ok(covered.length >= 8, `expected the known writers to be covered, saw ${covered.length}: ${covered.join(", ")}`);
});

test("the writers this fence is built for are all in the covered set", () => {
    // Named explicitly, so deleting a lock from one of them fails HERE with the
    // file's name rather than only shifting a count.
    const expected = [
        "src/app/api/cron/receipt-intake-worker/route.ts",
        "src/app/api/receipts/intake/route.ts",
        "src/app/api/receipts/intake/start/route.ts",
        "src/app/api/receipts/intake/[id]/finalize/route.ts",
        "src/app/api/receipts/intake/[id]/archived/route.ts",
        "src/lib/receipt-intake/book.ts",
        "src/lib/receipt-intake/storage-cleanup.ts",
        "src/lib/actions.ts",
        "src/app/api/expenses/[id]/receipt/route.ts",
        "src/lib/qbo-receipt-attachments.ts",
    ];
    for (const rel of expected) {
        const source = readFileSync(join(repoRoot, rel), "utf8");
        assert.match(source, LOCK_MARKERS, `${rel} writes receipt evidence and must take the evidence lock`);
    }
});

test("the sweep holds the same lock across its reads AND its verdicts", () => {
    const sweep = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    const txAt = sweep.indexOf("await withTxRetry(() => prisma.$transaction(async tx => {");
    const lockAt = sweep.indexOf("await lockReceiptEvidence(tx);", txAt);
    const componentLockAt = sweep.indexOf("pg_advisory_xact_lock", txAt);
    const readAt = sweep.indexOf("tx.receiptIntake.findMany(", txAt);
    const writeAt = sweep.indexOf("const applied = await applyReceiptRequestPlan(", txAt);

    assert.ok(txAt > 0 && lockAt > txAt, "the sweep takes the evidence lock inside its component transaction");
    assert.ok(lockAt < componentLockAt, "and FIRST — the evidence lock is the outermost, which is what makes the order global");
    assert.ok(readAt > lockAt && writeAt > readAt, "reads and verdicts are both inside it");
});

test("one lock name, defined once", () => {
    assert.equal(RECEIPT_EVIDENCE_LOCK, "receipt-evidence");
    const lockModule = readFileSync(join(repoRoot, "src/lib/receipt-evidence-lock.ts"), "utf8");
    assert.match(lockModule, /pg_advisory_xact_lock\(hashtext\(\$\{RECEIPT_EVIDENCE_LOCK\}\)\)/);
    // Two spellings of one lock is the same as no lock (the bank-line identity
    // lock learned this): nobody else may write the string.
    const strays = walk(srcRoot)
        .filter(file => !file.endsWith("receipt-evidence-lock.ts"))
        .filter(file => readFileSync(file, "utf8").includes(`"${RECEIPT_EVIDENCE_LOCK}"`))
        .map(file => relative(repoRoot, file));
    assert.deepEqual(strays, [], `the lock name is spelled out in ${strays.join(", ")} instead of imported`);
});

test("every local `evidence*` helper actually wraps its write in the lock", () => {
    /**
     * The per-FILE marker above is necessary and not sufficient. Each writer
     * routes its evidence writes through a small local helper —
     * `evidenceUpdateMany`, `evidenceCreate` — and once those exist, gutting
     * one to call Prisma directly leaves every call site, and therefore every
     * marker, exactly where it was. The file still reads as covered while none
     * of its writes are.
     *
     * (Measured, not assumed: a mutation that replaced one helper's body with a
     * bare `prisma.receiptIntake.updateMany(args)` survived the marker test.)
     *
     * So each helper DEFINITION is checked on its own terms: whatever it does,
     * it has to reach the lock.
     */
    const unwrapped: string[] = [];
    for (const file of walk(srcRoot)) {
        if (file.endsWith("receipt-evidence-lock.ts")) continue;
        const source = readFileSync(file, "utf8");
        const rel = relative(repoRoot, file);
        // `const evidenceXxx = ...` up to the end of its (arrow) definition —
        // the next line that starts a new top-level statement. Only WRITE
        // helpers: `evidenceDay` is a date helper, not a write.
        const pattern = /const (evidence[A-Za-z]*(?:Create|Update|Upsert|Delete)[A-Za-z]*)\s*=[\s\S]{0,600}?(?=\n(?:const|function|export|async function|\/\*\*|test\()|\n\n)/g;
        for (const [body, name] of source.matchAll(pattern)) {
            if (/withReceiptEvidenceLock|lockReceiptEvidence\(/.test(body)) continue;
            unwrapped.push(`${rel}: ${name}`);
        }
    }
    assert.deepEqual(unwrapped, [],
        `these helpers are named for the fence but do not take it: ${unwrapped.join(", ")}`);
});

test("no evidence write is issued on the prisma CLIENT — only inside a transaction", () => {
    /**
     * THE PER-FILE MARKER IS NOT ENOUGH, AGAIN (Codex PR #443 gate round 45,
     * finding 3).
     *
     * `actions.ts` carries lock markers all over it, so the file counted as
     * covered while `prisma.expense.deleteMany({ where: { estimateId } })` —
     * the cascade from deleting an estimate — ran with no lock and no epoch
     * bump at all. Four more writes were in the same shape across the expense
     * routes, including one that edits `amount`, `vendor` and `date`: three of
     * the exact fields the matcher pairs a charge on.
     *
     * The rule that catches all of them is structural rather than
     * field-by-field: an evidence write issued on the `prisma` CLIENT can never
     * be fenced, because `pg_advisory_xact_lock` is transaction-scoped and a
     * bare client call is its own implicit transaction. So the receiver is the
     * test. A `tx.` receiver is fine — it only exists inside a transaction the
     * shared helpers opened and locked.
     *
     * Uniform across every field on purpose. A per-field rule would oblige
     * every future edit to re-derive which columns the sweep happens to read,
     * and the cost here is an advisory lock on a handful of rare admin actions.
     */
    const WRITE_VERBS = "create|createMany|update|updateMany|upsert|delete|deleteMany";
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
        if (file.endsWith("receipt-evidence-lock.ts")) continue;
        const rel = relative(repoRoot, file);
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
            const trimmed = line.trim();
            // Comments and doc prose quote these shapes deliberately.
            if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
            if (new RegExp(String.raw`\bprisma\.(receiptIntake|expense)\.(${WRITE_VERBS})\(`).test(line)) {
                offenders.push(`${rel}:${index + 1}`);
            }
        });
    }
    assert.deepEqual(offenders, [],
        `these evidence writes run on the client, so they cannot hold the xact lock: ${offenders.join(", ")}`);
});

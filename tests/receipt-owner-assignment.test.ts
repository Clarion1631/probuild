import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReceiptOwnerLocked } from "../src/lib/receipt-owner-assignment";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * cheap-sweep-restart-spec.md §14.2: a recording fake transaction, in the
 * same style as the evidence-epoch tests — each call is tagged by what it
 * does rather than matched against reconstructed SQL text, so the assertions
 * below read the ORDER of operations, not the lock module's own wording.
 */
function fakeDb(count: number) {
    const calls: string[] = [];
    let updateManyArgs: { where?: unknown; data?: Record<string, unknown> } | undefined;
    let transactionOptions: unknown;
    const tx = {
        $executeRaw: async (query: TemplateStringsArray, ..._values: unknown[]) => {
            const text = query.join("");
            if (text.includes("SET LOCAL")) calls.push("set-local");
            else if (text.includes("pg_advisory_xact_lock")) calls.push("lock");
            else calls.push(`executeRaw:${text}`);
            return 0;
        },
        $queryRaw: async (query: TemplateStringsArray, ..._values: unknown[]) => {
            const text = query.join("");
            if (text.includes("INSERT INTO")) calls.push("bump-owner-epoch");
            else calls.push(`queryRaw:${text}`);
            return [{ value: "1" }];
        },
        reviewIssue: {
            updateMany: async (args: { where?: unknown; data?: Record<string, unknown> }) => {
                calls.push("update-issue");
                updateManyArgs = args;
                return { count };
            },
        },
    };
    const db = {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
            transactionOptions = options;
            return fn(tx);
        },
    };
    return {
        db,
        calls,
        get updateManyArgs() { return updateManyArgs; },
        get transactionOptions() { return transactionOptions; },
    };
}

test("writeReceiptOwnerLocked: SET LOCAL, then the evidence lock, then updateMany, then the owner-epoch bump", async () => {
    const fake = fakeDb(1);
    const now = new Date("2026-09-22T12:00:00.000Z");

    const count = await writeReceiptOwnerLocked(fake.db as never, {
        issueId: "issue-1",
        expectedVersion: 3,
        displayDetailsJson: '{"ownerOverride":"CJ"}',
        now,
    });

    assert.equal(count, 1);
    assert.deepEqual(fake.calls, ["set-local", "lock", "update-issue", "bump-owner-epoch"]);
    assert.deepEqual(fake.transactionOptions, { timeout: 8_000, maxWait: 2_000 });
});

test("updateMany's data includes updatedAt, and its where re-checks version and clearedAt", async () => {
    const fake = fakeDb(1);
    const now = new Date("2026-09-22T12:00:00.000Z");

    await writeReceiptOwnerLocked(fake.db as never, {
        issueId: "issue-1",
        expectedVersion: 3,
        displayDetailsJson: '{"ownerOverride":"CJ"}',
        now,
    });

    assert.deepEqual(fake.updateManyArgs?.where, { id: "issue-1", version: 3, clearedAt: null });
    assert.equal(fake.updateManyArgs?.data?.displayDetails, '{"ownerOverride":"CJ"}');
    assert.deepEqual(fake.updateManyArgs?.data?.version, { increment: 1 });
    assert.equal(fake.updateManyArgs?.data?.updatedAt, now);
});

test("no bump when the CAS matches zero rows", async () => {
    const fake = fakeDb(0);

    const count = await writeReceiptOwnerLocked(fake.db as never, {
        issueId: "issue-1",
        expectedVersion: 3,
        displayDetailsJson: '{"ownerOverride":"CJ"}',
        now: new Date("2026-09-22T12:00:00.000Z"),
    });

    assert.equal(count, 0);
    assert.deepEqual(fake.calls, ["set-local", "lock", "update-issue"]);
});

test("source pin: setMissingReceiptOwner calls writeReceiptOwnerLocked and no longer writes reviewIssue.updateMany directly", () => {
    const source = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    const start = source.indexOf("export async function setMissingReceiptOwner(");
    const end = source.indexOf("// ============ Payroll", start);
    assert.ok(start > 0 && end > start, "setMissingReceiptOwner not found in the expected shape");
    const body = source.slice(start, end);

    assert.match(body, /writeReceiptOwnerLocked\(/);
    assert.doesNotMatch(body, /prisma\.reviewIssue\.updateMany\(/);
});

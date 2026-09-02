import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * A → B and B → A, at the same moment.
 *
 * Both validations pass (neither row is a duplicate YET), both writes land, and
 * the two rows now point at each other: a cycle nothing downstream can resolve,
 * and neither receipt has an original. The fix is not a better check — it is
 * doing the check while HOLDING both rows.
 *
 * The model below is the transaction semantics this depends on: row locks taken
 * in one statement, in id order, released at commit. It runs the same sequence
 * the action runs, so "validate before the lock" and "validate after the lock"
 * can be compared directly rather than asserted about.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Row { id: string; state: string; duplicateOfId: string | null }

/** A tiny serialized-row-lock model: one waiter at a time per row, FIFO. */
class Rows {
    private readonly rows = new Map<string, Row>();
    private readonly locked = new Set<string>();
    private readonly waiting: Array<() => void> = [];

    constructor(ids: string[]) {
        for (const id of ids) this.rows.set(id, { id, state: "NEEDS_REVIEW", duplicateOfId: null });
    }

    read(id: string): Row | undefined {
        const row = this.rows.get(id);
        return row ? { ...row } : undefined;
    }

    /** `SELECT … WHERE id IN (…) ORDER BY id FOR UPDATE` — all or nothing. */
    async lock(ids: string[]): Promise<() => void> {
        const wanted = [...ids].sort();
        while (wanted.some(id => this.locked.has(id))) {
            await new Promise<void>(resolve => this.waiting.push(resolve));
        }
        for (const id of wanted) this.locked.add(id);
        return () => {
            for (const id of wanted) this.locked.delete(id);
            const next = this.waiting.shift();
            if (next) next();
        };
    }

    write(id: string, duplicateOfId: string) {
        const row = this.rows.get(id);
        if (!row) throw new Error("gone");
        row.state = "DUPLICATE";
        row.duplicateOfId = duplicateOfId;
    }

    cycles(): string[] {
        const out: string[] = [];
        for (const row of this.rows.values()) {
            const target = row.duplicateOfId ? this.rows.get(row.duplicateOfId) : null;
            if (target && target.duplicateOfId === row.id) out.push(`${row.id}↔${target.id}`);
        }
        return out;
    }
}

/** The validation the action performs, exactly. */
function validate(original: Row | undefined, id: string): void {
    if (!original) throw new Error("That original receipt no longer exists");
    if (original.state === "DUPLICATE") throw new Error("That receipt is itself a duplicate — point at the original instead");
    if (original.state === "VOID") throw new Error("That receipt was voided — it can't be the original");
    if (original.duplicateOfId === id) throw new Error("Those two receipts already point at each other");
}

async function markAfterLock(rows: Rows, id: string, duplicateOfId: string): Promise<void> {
    const release = await rows.lock([id, duplicateOfId]);
    try {
        validate(rows.read(duplicateOfId), id);
        rows.write(id, duplicateOfId);
    } finally {
        release();
    }
}

async function markBeforeLock(rows: Rows, id: string, duplicateOfId: string): Promise<void> {
    // The shape this replaces: read, validate, then write under a lock.
    const snapshot = rows.read(duplicateOfId);
    validate(snapshot, id);
    const release = await rows.lock([id, duplicateOfId]);
    try {
        rows.write(id, duplicateOfId);
    } finally {
        release();
    }
}

test("A→B and B→A at once: exactly ONE succeeds", async () => {
    const rows = new Rows(["a", "b"]);
    const results = await Promise.allSettled([
        markAfterLock(rows, "a", "b"),
        markAfterLock(rows, "b", "a"),
    ]);
    const ok = results.filter(r => r.status === "fulfilled");
    assert.equal(ok.length, 1, "exactly one, not both and not neither");
    assert.deepEqual(rows.cycles(), [], "and no pair points at itself");
    // The loser is refused for a reason a human can act on.
    const failure = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    assert.match(String(failure.reason), /itself a duplicate|already point at each other/);
});

test("the CONTROL: validating before the lock lets both through", async () => {
    // Without this the test above proves nothing — it would pass on any
    // implementation that happens to serialize.
    const rows = new Rows(["a", "b"]);
    const results = await Promise.allSettled([
        markBeforeLock(rows, "a", "b"),
        markBeforeLock(rows, "b", "a"),
    ]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 2, "both writes land");
    assert.deepEqual(rows.cycles(), ["a↔b", "b↔a"], "and that is the cycle");
});

test("both rows are locked, in id order, before anything is read", () => {
    const source = readFileSync(join(repoRoot, "src/lib/actions.ts"), "utf8");
    const fn = source.slice(source.indexOf("export async function markReceiptIntakeDuplicate("));
    const body = fn.slice(0, fn.indexOf("\n}"));

    // One transaction, one locking statement, both ids, ORDER BY id.
    assert.match(body, /const \[first, second\] = \[id, duplicateOfId\]\.sort\(\);/);
    assert.match(body, /await prisma\.\$transaction\(async tx => \{/);
    assert.match(body, /SELECT "id" FROM "ReceiptIntake"[\s\S]{0,200}FOR UPDATE/);
    assert.match(body, /WHERE "id" IN \(\$\{first\}, \$\{second\}\)/);
    assert.match(body, /ORDER BY "id"/);

    // The validation READ comes after the lock, and the write after that.
    const lockAt = body.indexOf("FOR UPDATE");
    const readAt = body.indexOf("const original = await tx.receiptIntake.findUnique(");
    const writeAt = body.indexOf("await runParkWrites(");
    assert.ok(lockAt > 0 && readAt > lockAt, "reading before the lock is the bug");
    assert.ok(writeAt > readAt, "and the write comes last");

    // The write happens on the TRANSACTION, or it is not covered by the lock.
    assert.match(body, /\}\), id, expected, now, tx\);/);
    // Every validation is inside the transaction, not left outside it.
    for (const check of [
        /if \(original\.state === "DUPLICATE"\)/,
        /if \(original\.state === "VOID"\)/,
        /if \(original\.duplicateOfId === id\)/,
    ]) {
        assert.match(body.slice(lockAt), check);
    }
});

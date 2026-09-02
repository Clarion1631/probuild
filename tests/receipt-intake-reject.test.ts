/**
 * Rejecting a row, and publishing one.
 *
 * Both are two writes that must agree. A reject deletes the row AND queues its
 * object for deletion: do them separately and either the bytes are orphaned
 * with nothing left to remember them (delete first, record fails) or the queue
 * names a path a live row still points at (record first, delete fails). A
 * publish moves STAGING -> RECEIVED: do it by id alone and a row that moved on
 * gets dragged back to RECEIVED and re-read, which for a BOOKED row is a second
 * Purchase.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RECOVERABLE_PARK_REASONS } from "../src/lib/receipt-intake/stored-object";
import {
    rejectRowAndQueueCleanup,
    type RejectClient,
    type RejectTxClient,
} from "../src/lib/receipt-intake/storage-cleanup";

const ROOT = path.resolve(__dirname, "..");
const intake = readFileSync(path.join(ROOT, "src/app/api/receipts/intake/route.ts"), "utf8");
const finalize = readFileSync(
    path.join(ROOT, "src/app/api/receipts/intake/[id]/finalize/route.ts"),
    "utf8",
);

interface Store {
    rows: Set<string>;
    events: { id: string; data: Record<string, unknown> }[];
    committed: boolean;
}

/** A $transaction that really rolls back: the fake state is only kept on commit. */
function client(rows: string[], opts: { undeletable?: boolean } = {}): { db: RejectClient; store: Store } {
    const store: Store = { rows: new Set(rows), events: [], committed: false };
    const db: RejectClient = {
        $transaction: async fn => {
            const stagedRows = new Set(store.rows);
            const stagedEvents: Store["events"] = [];
            let seq = 0;
            const tx: RejectTxClient = {
                automationEvent: {
                    create: async ({ data }) => {
                        const id = `ev-${++seq}`;
                        stagedEvents.push({ id, data });
                        return { id };
                    },
                },
                receiptIntake: {
                    deleteMany: async ({ where }) => {
                        if (opts.undeletable) return { count: 0 };
                        return { count: stagedRows.delete(where.id) ? 1 : 0 };
                    },
                    findUnique: async ({ where }) => (stagedRows.has(where.id) ? { id: where.id } : null),
                },
            };
            const out = await fn(tx);
            store.rows = stagedRows;
            store.events.push(...stagedEvents);
            store.committed = true;
            return out;
        },
    };
    return { db, store };
}

test("a reject deletes the row and queues the object in ONE transaction", async () => {
    const { db, store } = client(["row-1"]);
    const injected = await rejectRowAndQueueCleanup("row-1", "receipts/intake/row-1.bin", "unsupported-type", db);
    assert.equal(injected.ok, true);
    assert.equal(store.rows.has("row-1"), false, "the row is gone");
    assert.equal(store.events.length, 1, "and exactly one cleanup is queued");
    assert.equal(store.events[0].data.status, "pending");
    assert.match(String(store.events[0].data.detail), /receipts\/intake\/row-1\.bin/);
});

test("a row that survives the delete rolls the queue entry back and reports failure", async () => {
    // The caller must then KEEP the object: a row that still exists may still
    // point at those bytes, so deleting them would destroy a live receipt.
    const { db, store } = client(["row-1"], { undeletable: true });
    const result = await rejectRowAndQueueCleanup("row-1", "receipts/intake/row-1.bin", "empty-file", db);
    assert.equal(result.ok, false);
    assert.equal(store.committed, false, "nothing committed");
    assert.deepEqual(store.events, [], "no orphan record for a row that is still there");
    assert.equal(store.rows.has("row-1"), true);
});

test("rejecting an already-deleted row still queues the cleanup", async () => {
    // The retry of a reject whose response was lost. deleteMany counts zero,
    // but the row is ABSENT, which is the condition that matters — and its
    // object is unreferenced, so it still has to be queued.
    const { db, store } = client([], {});
    const result = await rejectRowAndQueueCleanup("row-1", "receipts/intake/row-1.bin", "unsupported-type", db);
    assert.equal(result.ok, true);
    assert.equal(store.events.length, 1);
});

test("an unconfirmed reject answers 503 and keeps the object", () => {
    const branch = finalize.slice(finalize.indexOf("const rejected = await rejectRowAndQueueCleanup"));
    const head = branch.slice(0, branch.indexOf("settleQueuedCleanup"));
    assert.match(head, /reject-failed/);
    assert.match(head, /status: 503/);
    assert.ok(
        !/deleteObjectOrRecord|removeSecureDoc/.test(head),
        "no object deletion on the unconfirmed path",
    );
});

test("publishing STAGING -> RECEIVED is fenced on the exact state", () => {
    const fn = intake.slice(intake.indexOf("async function publishStagedRow"));
    const body = fn.slice(0, fn.indexOf("\n/**"));
    assert.match(body, /updateMany/, "not a bare update by id");
    assert.match(body, /where: \{ id, state: expectState \}/);
    assert.match(body, /alreadyPublished: true/, "an already-RECEIVED row is the outcome we wanted");
    assert.match(body, /publish-conflict/);
});

test("recovery is restricted to the two reasons a re-upload can actually fix", () => {
    // "Any NEEDS_REVIEW row" would drag a row parked for a vendor mismatch, a
    // zero total, or a QBO fault back to RECEIVED and re-read it, discarding a
    // decision a human had already made.
    // ONE list, in the lib, asked by both publishers — two copies is how they
    // come to disagree about whether a human's decision can be overwritten.
    assert.deepEqual(RECOVERABLE_PARK_REASONS, ["file-missing", "sha-mismatch"]);
    assert.match(intake, /finalizeDisposition\(existing\) === "publish"/);
    assert.match(finalize, /finalizeDisposition\(row\)/, "the finalize route asks the same rule");
    for (const source of [intake, finalize]) {
        assert.ok(!/"file-missing" \|\| /.test(source), "no hand-rolled copy of the list");
    }
});

test("a heal that loses its CAS deletes the object it just uploaded", () => {
    // The upload happened before the CAS. Losing the race means nothing
    // references those bytes, and the row we were healing belongs to somebody
    // else now.
    const heal = intake.slice(intake.indexOf("const healed = await storeObject"));
    const body = heal.slice(0, heal.indexOf("return NextResponse.json({\n                ok: true, recovered: true"));
    assert.match(body, /if \(count === 0\)/);
    assert.match(body, /deleteObjectOrRecord\(payload\.storagePath, "heal-lost-race"\)/);
    assert.match(body, /publish-conflict/);
    assert.ok(
        body.indexOf("payload.storagePath !== existing.storagePath") < body.indexOf("heal-lost-race"),
        "and never deletes the path the surviving row still points at",
    );
});

/**
 * Compensation must never delete an invoice a settlement has just paid.
 *
 * Codex round 50, finding 2 (P0). `compensateAndUnlink` did the irreversible
 * QuickBooks delete FIRST and then cleared the row pinned only to
 * `{ id, qbInvoiceId }` — no `status`, no `qbPaymentId`, not even the marker it
 * owned. A settlement committing after the finalize released its locks but
 * before that clear meant:
 *
 *   • the QuickBooks invoice of a milestone that had just been PAID was
 *     deleted, and
 *   • the paid row was cleared anyway — a progress billing was additionally
 *     reset to Draft, so the money and the document both vanished.
 *
 * The fix is the same claim protocol the deletion sweep uses: CAS into a
 * `compensating:<token>` marker under the parent invoice's money lock, pinned
 * to the full state the decision was made from; re-check immediately before the
 * remote call; and clear using the complete claimed state. A settle racing it
 * takes the claim away.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compensateAndUnlink } from "../src/lib/quickbooks-payments";

type Row = Record<string, any>;

/**
 * One PaymentSchedule row, with Prisma's WHERE semantics as far as this path
 * uses them. `onClaimed` fires the instant the claim commits — that is the
 * window a settlement lands in, and the only place the post-claim race can be
 * staged.
 */
function table(row: Row, opts: { onClaimed?: () => void } = {}) {
    const matchOne = (value: any, cond: any): boolean => {
        if (cond !== null && typeof cond === "object") {
            if ("in" in cond) return cond.in.includes(value);
            if ("not" in cond) return value !== cond.not;
            if ("startsWith" in cond) return typeof value === "string" && value.startsWith(cond.startsWith);
            throw new Error(`unsupported condition: ${JSON.stringify(cond)}`);
        }
        return value === cond;
    };
    const match = (where: any): boolean =>
        Object.entries(where ?? {}).every(([k, v]) =>
            k === "OR" ? (v as any[]).some(match) : matchOne(row[k], v));
    return {
        row,
        delegate: {
            async updateMany(args: any) {
                if (!match(args.where)) return { count: 0 };
                Object.assign(row, args.data);
                if (String(args.data?.qbSyncError ?? "").startsWith("compensating:")) opts.onClaimed?.();
                return { count: 1 };
            },
            async count(args: any) {
                return match(args.where) ? 1 : 0;
            },
        },
    };
}

const MARKER = "create-in-flight:@1|INV-1-2|note";
const UNSETTLED = { status: "Pending", qbPaymentId: null };

function pendingRow(over: Row = {}): Row {
    return { id: "ps-1", status: "Pending", qbPaymentId: null, qbInvoiceId: "qb-1", qbSyncError: MARKER, ...over };
}

test("round 50: a settle that commits BEFORE the claim stops the delete entirely", async () => {
    const { row, delegate } = table(pendingRow({ status: "Paid", qbPaymentId: "pay-9" }));
    const deleted: string[] = [];

    const res = await compensateAndUnlink(
        delegate as any,
        "ps-1",
        "qb-1",
        async () => { deleted.push("qb-1"); return true; },
        {},
        MARKER,
        { invoiceId: "inv-1", unsettled: UNSETTLED, transaction: async (fn: any) => fn(undefined) },
    );

    assert.deepEqual(deleted, [], "a paid milestone's invoice is NEVER deleted");
    assert.equal(res.refused, true);
    assert.equal(row.qbInvoiceId, "qb-1", "and the paid row keeps its link");
    assert.equal(row.status, "Paid");
});

test("round 50: a settle that CANCELS a live claim stops the delete at the last look", async () => {
    // The other order: the claim is held, and the settle lands while the sweep
    // is between the claim and the remote call.
    const { row, delegate } = table(pendingRow(), {
        onClaimed: () => { row.status = "Paid"; row.qbPaymentId = "pay-9"; },
    });
    const deleted: string[] = [];

    const res = await compensateAndUnlink(
        delegate as any,
        "ps-1",
        "qb-1",
        async () => { deleted.push("qb-1"); return true; },
        {},
        MARKER,
        { invoiceId: "inv-1", unsettled: UNSETTLED, transaction: async (fn: any) => fn(undefined) },
    );

    assert.deepEqual(deleted, [], "the cancelled claim stops the delete");
    assert.equal(res.refused, true);
});

test("round 50: an UNSETTLED row still compensates, and the clear pins the claim (control)", async () => {
    // Without this the two tests above would pass against a compensation that
    // had simply stopped working.
    const { row, delegate } = table(pendingRow());
    const deleted: string[] = [];

    const res = await compensateAndUnlink(
        delegate as any,
        "ps-1",
        "qb-1",
        async () => { deleted.push("qb-1"); return true; },
        {},
        MARKER,
        { invoiceId: "inv-1", unsettled: UNSETTLED, transaction: async (fn: any) => fn(undefined) },
    );

    assert.deepEqual(deleted, ["qb-1"]);
    assert.equal(res.deleted, true);
    assert.equal(res.unlinked, true);
    assert.equal(row.qbInvoiceId, null, "the link is released");
    assert.equal(row.qbSyncError, null, "and the claim with it");
});

test("round 50: an ORPHAN the row no longer references is still deleted, and not written to", async () => {
    // The regression the claim nearly introduced. When another owner takes the
    // marker mid-create, our invoice is litter that nothing references and
    // nothing ever will — refusing to delete it would leave a real document in
    // QuickBooks forever. It is deleted, and the row (which points elsewhere)
    // is not touched.
    const { row, delegate } = table(pendingRow({ qbInvoiceId: null, qbSyncError: "somebody-elses-marker" }));
    const deleted: string[] = [];

    const res = await compensateAndUnlink(
        delegate as any,
        "ps-1",
        "qb-1",
        async () => { deleted.push("qb-1"); return true; },
        {},
        MARKER,
        { invoiceId: "inv-1", unsettled: UNSETTLED, transaction: async (fn: any) => fn(undefined) },
    );

    assert.deepEqual(deleted, ["qb-1"], "the orphan is swept up");
    assert.equal(res.deleted, true);
    assert.equal(res.unlinked, false, "but this compensation writes nothing to a row it does not own");
    assert.equal(row.qbSyncError, "somebody-elses-marker", "the other owner's claim is untouched");
});

test("round 50: a thrown delete gives the claim back", async () => {
    // The remote outcome is unknown, so the row must not be left holding a
    // marker only this code path understands.
    const { row, delegate } = table(pendingRow());

    const res = await compensateAndUnlink(
        delegate as any,
        "ps-1",
        "qb-1",
        async () => { throw new Error("QuickBooks refused"); },
        {},
        MARKER,
        { invoiceId: "inv-1", unsettled: UNSETTLED, transaction: async (fn: any) => fn(undefined) },
    );

    assert.equal(res.deleted, false);
    assert.equal(row.qbSyncError, MARKER, "the claim went back to the marker we owned");
});

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

test("round 51: while the claim is held, no settlement rail may settle the row", async () => {
    // Round 50 re-COUNTED the row just before dispatching the delete. Round 51:
    // a count is a READ, not a fence. A settlement committing between that read
    // and the network call still won — the delete destroyed the invoice of a
    // milestone that had just been paid, and the post-delete CAS then failed,
    // leaving a paid row pointing at nothing.
    //
    // The claim is now the exclusion itself: every settlement rail refuses a row
    // whose marker is `compensating:*`. That is what makes the remote call safe,
    // so this asserts the fence rather than trying to win a race against it.
    const { isIrreversibleClaimHeld, compensationClaimMarker } =
        await import("../src/lib/qbo-create-markers");

    const held = compensationClaimMarker("abc123");
    assert.equal(isIrreversibleClaimHeld(held), true);

    // The claim really is what the row carries mid-compensation: take one and
    // look at the row while the delete is in flight.
    let markerDuringDelete: string | null = null;
    const { row, delegate } = table(pendingRow());
    await compensateAndUnlink(
        delegate as any,
        "ps-1",
        "qb-1",
        async () => { markerDuringDelete = row.qbSyncError; return true; },
        {},
        MARKER,
        { invoiceId: "inv-1", unsettled: UNSETTLED, transaction: async (fn: any) => fn(undefined) },
    );

    assert.ok(
        isIrreversibleClaimHeld(markerDuringDelete),
        `the row must carry a live claim while the delete is in flight, saw ${markerDuringDelete}`,
    );
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

// --- Round 51: the milestone create is judged before it links ---

/**
 * The body of one top-level function, from its declaration to the next one.
 *
 * A fixed-size window is a trap: it stops covering a landmark the moment the
 * function grows, and the pin then fails for a reason unrelated to the property
 * it guards (this happened twice while writing these tests).
 */
function functionBody(src: string, name: string): string {
    const at = src.indexOf(`function ${name}`);
    assert.ok(at > -1, `${name} declaration not found`);
    const next = src.indexOf(String.fromCharCode(10) + "export ", at + 10);
    return src.slice(at, next > -1 ? next : undefined);
}

/**
 * The milestone rail linked whatever QuickBooks returned. Its claim identity
 * recorded no tax, no transaction date and no service item, and after the
 * response `created.document` was ignored entirely — a total more than five
 * cents out only warned, and the link was written anyway. So a different
 * DocNumber, customer, accounting period, income account or tax split all
 * became payable, while the document and progress-billing rails refused the
 * very same response.
 *
 * These drive the shared predicate the rail now uses, with the identity the
 * rail now builds, so a regression in either shows up here.
 */
test("round 51: the milestone identity freezes tax, date and item", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/quickbooks-payments.ts", "utf8"));
    const body = functionBody(src, "pushMilestoneToQuickBooks");
    const identity = body.indexOf("const identity = {");
    assert.ok(identity > -1, "the claim identity must exist");
    const block = body.slice(identity, identity + 2000);
    assert.match(block, /expectedTax:/, "the tax split");
    assert.match(block, /txnDate: qboTxnDate\(claimedAt\)/, "the accounting period, fixed at claim time");
    assert.match(block, /itemId,/, "the income account");
    // ...and the payload sends the date the identity recorded, rather than
    // letting the helper compute today's.
    assert.match(body, /txnDate: identity\.txnDate/);
    // ...which the helper contract now actually accepts. It did not, so the
    // property was an excess property on a typed literal and TypeScript said
    // nothing while the payload used `new Date()`.
    const qb = await import("node:fs").then((fs) => fs.readFileSync("src/lib/quickbooks.ts", "utf8"));
    const helper = functionBody(qb, "createQBMilestoneInvoice");
    assert.match(helper, /txnDate\?: string;/, "the helper must declare it");
    assert.match(qb, /TxnDate: input\.txnDate \?\? qboTxnDate\(\)/, "and use it in the payload");
});

test("round 51: the create is run through documentMatchesClaim BEFORE the link", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/quickbooks-payments.ts", "utf8"));
    const body = functionBody(src, "pushMilestoneToQuickBooks");
    const verdict = body.indexOf("documentMatchesClaim(created.document");
    const link = body.indexOf("data: { qbInvoiceId: qbId, qbSyncedAt: new Date(), qbSyncError: PAYLINK_PENDING_MARKER }");
    assert.ok(verdict > -1, "the created document must be judged");
    assert.ok(link > -1, "the provisional link write must still be there");
    assert.ok(verdict < link, "and the judgement must come BEFORE anything is linked");
    // The old behaviour, gone: a drift over five cents used to only warn.
    assert.doesNotMatch(body, /QBO total drift on/, "a warning is not a guard");
});

test("round 51: every field the rail now freezes is one the predicate checks", async () => {
    // The two halves have to agree: recording a field the predicate ignores
    // proves nothing, and checking one the identity never records silently
    // skips. This walks the actual predicate against a claim carrying all of
    // them, one wrong field at a time.
    const { documentMatchesClaim } = await import("../src/lib/qbo-document-sync");
    const identity = {
        docNumber: "INV-1-2",
        privateNote: "ProBuild INV-1 - Rough-in - Job",
        customerId: "42",
        expectedTotal: 1089,
        expectedTax: 89,
        txnDate: "2026-09-03",
        itemId: "7",
    } as any;
    const good = {
        docNumber: "INV-1-2",
        privateNote: "ProBuild INV-1 - Rough-in - Job",
        customerId: "42",
        total: 1089,
        totalTax: 89,
        txnDate: "2026-09-03",
        itemIds: ["7"],
    };
    assert.equal(documentMatchesClaim(good as any, identity).ok, true, "the matching control");

    for (const [label, patch] of [
        ["wrong DocNumber", { docNumber: "INV-9-9" }],
        ["wrong customer", { customerId: "99" }],
        ["wrong date", { txnDate: "2019-01-01" }],
        ["wrong item", { itemIds: ["7", "99"] }],
        ["wrong tax split", { totalTax: 12 }],
        ["material total drift", { total: 1200 }],
    ] as const) {
        const verdict = documentMatchesClaim({ ...good, ...patch } as any, identity);
        assert.equal(verdict.ok, false, `${label} must be refused`);
    }
});

test("round 53: the fence lets every NON-claimed marker through, including null", async () => {
    // The bug this encodes: the fence was first expressed in SQL as
    // `NOT (qbSyncError LIKE 'compensating:%')`. Three-valued logic makes that
    // NULL — not TRUE — when qbSyncError IS NULL, so the predicate excluded
    // every CLEAN row and ordinary settlement stopped dead. Two e2e deposit
    // specs and a progress-billing settle went red on their FIRST apply, on
    // fresh fixtures carrying no marker at all.
    //
    // The check now reads the marker and decides in JS. These are the values a
    // real row carries; only the two claim prefixes may be refused.
    const { isIrreversibleClaimHeld, compensationClaimMarker, deletionClaimMarker } =
        await import("../src/lib/qbo-create-markers");

    for (const marker of [
        null,
        undefined,
        "",
        "paylink-pending",
        "paylink-pending:2",
        "paylink-missing",
        "pending-deletion",
        "pending-deletion:settled",
        "voided",
        "notFound",
        "create-in-flight:@1|INV-1-2|note",
        "ambiguous-create:@1|INV-1-2|note",
    ]) {
        assert.equal(
            isIrreversibleClaimHeld(marker as any),
            false,
            `${String(marker)} carries no irreversible claim and must still settle`,
        );
    }

    // ...and exactly the two that do.
    assert.equal(isIrreversibleClaimHeld(compensationClaimMarker("abc123")), true);
    assert.equal(isIrreversibleClaimHeld(deletionClaimMarker("abc123")), true);
});

test("round 53: the QuickBooks settle rail expresses the fence in JS, not in SQL", async () => {
    // Belt and braces on the above: the same predicate written back into the
    // WHERE clause would reintroduce the NULL hole without failing the pure
    // unit test, because that test never goes near a database.
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/quickbooks-payments.ts", "utf8"));
    const body = functionBody(src, "settleMilestonePaidInTx");
    assert.match(body, /isIrreversibleClaimHeld\(current\?\.qbSyncError\)/, "the fence is a JS check on the read marker");
    assert.doesNotMatch(
        body,
        /NOT: \[/,
        "a NOT ... LIKE in the WHERE is NULL for a null marker and silently excludes clean rows",
    );
});

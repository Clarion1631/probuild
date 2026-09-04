/**
 * ONE predicate decides whether a milestone may be sent to a client.
 *
 * Every send path used to make its own decision, and each checked a different,
 * smaller thing. `sendMilestoneInvoicesCore` rejected only Paid/Canceled — and
 * an ALREADY-LINKED row never reaches `pushMilestoneToQuickBooks`, which is
 * where every marker guard lives. So a milestone whose QuickBooks invoice was
 * queued for deletion, or parked by an unknown-outcome create, or settled
 * outside QuickBooks, could still be emailed to the client with a pay link for
 * a document about to vanish or already paid.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    milestoneSendBlockedReason,
    PAID_DELETION_UNRESOLVABLE,
    PENDING_DELETION_MARKER,
    PENDING_DELETION_SETTLED_MARKER,
    SETTLED_WITHOUT_QB_PAYMENT,
    CREATE_IN_FLIGHT_MARKER,
    AMBIGUOUS_CREATE_MARKER,
} from "../src/lib/qbo-create-markers";

test("every marker that must block a send does block it", () => {
    const blocked = [
        PENDING_DELETION_MARKER,
        PENDING_DELETION_SETTLED_MARKER,
        PAID_DELETION_UNRESOLVABLE,
        SETTLED_WITHOUT_QB_PAYMENT,
        CREATE_IN_FLIGHT_MARKER,
        AMBIGUOUS_CREATE_MARKER,
        // ...including a marker carrying a full recovery identity.
        "ambiguous-create:@1|EST-1|ProBuild EST-1",
    ];
    for (const marker of blocked) {
        const reason = milestoneSendBlockedReason({ qbSyncError: marker });
        assert.ok(reason, `${marker} must block a send`);
        // The reason is shown to an operator and printed on the button, so it
        // has to say something, not just be truthy.
        assert.ok((reason as string).length > 20, `${marker} needs a usable reason`);
    }
});

test("a clean row, and the poller's own diagnoses, still send", () => {
    // The control. A guard that refused everything would satisfy the test above
    // and quietly stop the product billing anyone.
    for (const marker of [null, undefined, "voided", "notFound"]) {
        assert.equal(
            milestoneSendBlockedReason({ qbSyncError: marker }),
            null,
            `${marker} is not a reason to refuse a send`,
        );
    }
});

/**
 * Source tripwires: the predicate only helps if every entry point calls it, and
 * an outcome assertion on the happy path cannot see a path that skipped it.
 * These are the send/copy/resend entry points, enumerated.
 */
test("every send, copy and resend entry point consults the predicate", () => {
    const sites: Array<[string, string, string]> = [
        // file, the function that must be gated, what it does
        ["src/lib/billing-core.ts", "sendMilestoneInvoicesCore", "emails a payment request"],
        ["src/lib/payment-notifications.ts", "sendInvoicePaymentReceiptOnly", "emails a receipt"],
        [
            "src/app/projects/[id]/invoices/[invoiceId]/InvoiceEditor.tsx",
            "handleQBLink",
            "copies a hosted pay link to the clipboard",
        ],
    ];
    for (const [file, fn, what] of sites) {
        const src = readFileSync(file, "utf8");
        // The DECLARATION, not the first mention: an import or a doc comment
        // higher up would anchor the slice thousands of characters early and
        // the assertion would pass or fail on where the comment sat.
        const at = ["export async function ", "export function ", "async function ", "function "]
            .map((k) => src.indexOf(k + fn))
            .find((i) => i > -1) ?? -1;
        assert.ok(at > -1, `${fn} not found in ${file} — has it been renamed?`);
        // Wide enough to reach the guard in the longest of these (the send core
        // validates a batch before it reaches the per-row loop).
        const body = src.slice(at, at + 9000);
        assert.ok(
            body.includes("milestoneSendBlockedReason"),
            `${fn} (${what}) must consult milestoneSendBlockedReason`,
        );
    }
});

test("the editor disables the buttons with the reason, not just on hover", () => {
    const src = readFileSync("src/app/projects/[id]/invoices/[invoiceId]/InvoiceEditor.tsx", "utf8");
    assert.match(src, /const sendBlockedReason = milestoneSendBlockedReason\(payment\)/);
    // Send: folded into the existing sendability flag, so the button disappears.
    assert.match(src, /&& !sendBlockedReason;/);
    // QuickBooks Link / Copy: disabled AND explained.
    assert.match(src, /disabled=\{qbBusy === payment\.id \|\| !!sendBlockedReason\}/);
    assert.match(src, /Blocked: \$\{sendBlockedReason\}/);
    // ...and said in the row, so it is legible without hovering.
    assert.match(src, /Cannot send: \{sendBlockedReason\}/);
});

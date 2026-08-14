/**
 * handleChangeOrderApproved's suppressClientEmails option AND its DB-derived backstop
 * (billing-core.ts).
 *
 * The manual-approval path (manuallyApproveChangeOrder -> handleChangeOrderApproved with
 * { suppressClientEmails: true }) must still create billing rows/invoice totals exactly as the
 * portal path does, but must NEVER invoke the client-facing milestone-send function.
 *
 * Suppression must also hold for callers that never pass the option at all — the hourly
 * co-billing-sweep cron calls `handleChangeOrderApproved(co.id)` with no opts, so if the inline
 * after() callback ever drops (no delivery guarantee) or its first attempt fails, the cron's
 * retry must still recognize a manually-approved CO from the row itself (Approved, no
 * clientSignatureUrl, approvedBy carries the manual-approval marker — see co-approval.ts) and
 * suppress the client email on its own, independent of the option.
 *
 * This proves both by injecting fakes for billChangeOrder/sendMilestoneInvoices via
 * handleChangeOrderApproved's `dependencies` parameter (mirroring billChangeOrderCore's own
 * existing logActivity/revalidatePath DI) and asserting the send fake's call count.
 *
 * `@/lib/prisma` is mocked with the same `Module.prototype.require` patch used by
 * tests/takeoff-convert-tax.test.ts and tests/change-order-manual-approval-core.test.ts (see the
 * former's header comment for the full rationale). Only two lookups need faking here —
 * `changeOrder.findUnique` (routes past the COST_PLUS branch and carries the manual-approval
 * provenance) and `companySettings.findUnique` (returning null so the best-effort
 * team-notification email never fires a real network call) — because billing itself is fully
 * replaced by the injected `billChangeOrder` fake.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const state: {
    changeOrder: any;
    companySettings: any;
} = { changeOrder: null, companySettings: null };

function resetFixture() {
    state.changeOrder = null;
    state.companySettings = null;
}

const fakePrisma = {
    changeOrder: {
        findUnique: async () => state.changeOrder,
    },
    companySettings: {
        findUnique: async () => state.companySettings,
    },
};

let handleChangeOrderApproved: (
    changeOrderId: string,
    opts?: { notify?: boolean; freshlyApproved?: boolean; suppressClientEmails?: boolean },
    dependencies?: { billChangeOrder?: (...args: any[]) => any; sendMilestoneInvoices?: (...args: any[]) => any },
) => Promise<{ billed: boolean; sent: boolean; issues: string[]; awaitingActuals?: boolean }>;

const PRISMA_SPECIFIER = "@/lib/prisma";

before(async () => {
    const originalRequire = Module.prototype.require;
    let requirePatchHit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === PRISMA_SPECIFIER) {
            requirePatchHit = true;
            return { prisma: fakePrisma };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: { handleChangeOrderApproved?: unknown };
    try {
        mod = await import("../src/lib/billing-core");
    } finally {
        Module.prototype.require = originalRequire;
    }

    if (typeof mod.handleChangeOrderApproved !== "function") {
        throw new Error(
            `change-order-approved-suppress-emails.test.ts: mock of "${PRISMA_SPECIFIER}" did not apply — ` +
                `handleChangeOrderApproved export is ${typeof mod.handleChangeOrderApproved}. ` +
                `require() patch ${requirePatchHit ? "WAS" : "was NOT"} hit while importing billing-core.`,
        );
    }
    handleChangeOrderApproved = mod.handleChangeOrderApproved as typeof handleChangeOrderApproved;
});

beforeEach(() => {
    resetFixture();
    // No notification email configured -> the best-effort team-notify block is a no-op,
    // so no real network call happens during the test.
    state.companySettings = null;
});

/** A CO the client actually signed on the portal — clientSignatureUrl set, approvedBy is
 * the client's own typed name (no manual-approval marker). isManualCoApproval() is false. */
function portalApprovedCo() {
    return {
        code: "CO-001",
        title: "Extra tile",
        totalAmount: 500,
        pricingType: "FIXED",
        markupPercent: null,
        approvedBy: "Jane Client",
        clientSignatureUrl: "https://example.com/signatures/co-1-client.png",
        project: { name: "Mueller Bathroom" },
    };
}

/** A CO manually approved by staff — no clientSignatureUrl, approvedBy carries the
 * " (manual approval — staff)" marker. isManualCoApproval() is true. */
function manualApprovedCo() {
    return {
        code: "CO-001",
        title: "Extra tile",
        totalAmount: 500,
        pricingType: "FIXED",
        markupPercent: null,
        approvedBy: "Jane Doe (manual approval — staff)",
        clientSignatureUrl: null,
        project: { name: "Mueller Bathroom" },
    };
}

function freshBillResult() {
    return {
        ok: true as const,
        alreadyBilled: false,
        invoiceId: "inv-1",
        invoiceCode: "INV-001",
        milestoneId: "ms-1",
        milestoneName: "CO-001 — Payment 1",
        milestones: [
            { id: "ms-1", name: "CO-001 — Payment 1", amount: 500, pretaxAmount: 460, taxAmount: 40, status: "Pending", created: true },
        ],
        amount: 500,
        subtotal: 460,
        taxAmount: 40,
        taxLabel: "Sales Tax",
        milestoneStatus: "Pending",
        note: "Added 1 milestone for $500.00.",
    };
}

test("explicit suppressClientEmails:true suppresses the send even for a portal-signed CO", async () => {
    state.changeOrder = portalApprovedCo();
    let sendCallCount = 0;
    const billChangeOrder = async () => freshBillResult();
    const sendMilestoneInvoices = async () => {
        sendCallCount += 1;
        return { results: [{ sentTo: "client@example.com", error: undefined }] };
    };

    const summary = await handleChangeOrderApproved(
        "co-1",
        { freshlyApproved: false, suppressClientEmails: true },
        { billChangeOrder, sendMilestoneInvoices },
    );

    assert.equal(sendCallCount, 0, "sendMilestoneInvoices must not be called on the suppressed path");
    assert.equal(summary.billed, true);
    assert.equal(summary.sent, false);
});

test("default path (portal-signed CO, no option passed) still calls the milestone-send function", async () => {
    state.changeOrder = portalApprovedCo();
    let sendCallCount = 0;
    let sendArgs: any[] = [];
    const billChangeOrder = async () => freshBillResult();
    const sendMilestoneInvoices = async (...args: any[]) => {
        sendCallCount += 1;
        sendArgs = args;
        return { results: [{ sentTo: "client@example.com", error: undefined }] };
    };

    const summary = await handleChangeOrderApproved(
        "co-1",
        { freshlyApproved: false },
        { billChangeOrder, sendMilestoneInvoices },
    );

    assert.equal(sendCallCount, 1, "sendMilestoneInvoices must still run on the normal (unsuppressed) path");
    assert.equal(sendArgs[0], "inv-1");
    assert.deepEqual(sendArgs[1], ["ms-1"]);
    assert.equal(summary.billed, true);
    assert.equal(summary.sent, true);
});

test("cron path: a manually-approved CO in the DB suppresses the send even when the caller never passes suppressClientEmails", async () => {
    // Mirrors co-billing-sweep's exact call shape: handleChangeOrderApproved(co.id) with no
    // second argument at all — the option is never in play here, only the DB row itself.
    state.changeOrder = manualApprovedCo();
    let sendCallCount = 0;
    const billChangeOrder = async () => freshBillResult();
    const sendMilestoneInvoices = async () => {
        sendCallCount += 1;
        return { results: [{ sentTo: "client@example.com", error: undefined }] };
    };

    const summary = await handleChangeOrderApproved(
        "co-1",
        undefined,
        { billChangeOrder, sendMilestoneInvoices },
    );

    assert.equal(sendCallCount, 0, "a manually-approved CO must suppress the client email even without the explicit option");
    assert.equal(summary.billed, true);
    assert.equal(summary.sent, false);
});

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
 * `@/lib/prisma` and `./email` are mocked with the same `Module.prototype.require` patch used by
 * tests/takeoff-convert-tax.test.ts and tests/change-order-manual-approval-core.test.ts (see the
 * former's header comment for the full rationale). Faked lookups: `changeOrder.findUnique` (routes
 * past the COST_PLUS branch and carries the manual-approval provenance), `companySettings.findUnique`
 * (returns null in most tests so the best-effort team-notification email never fires a real network
 * call — the two tests that assert on subject/detail text set a notification email AND capture
 * `sendNotification`'s call instead of hitting Resend) — because billing itself is fully replaced
 * by the injected `billChangeOrder` fake.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { isManualCoApproval } from "../src/lib/co-approval";

const state: {
    changeOrder: any;
    companySettings: any;
} = { changeOrder: null, companySettings: null };

const sentEmails: Array<{ to: string; subject: string; html: string }> = [];

function resetFixture() {
    state.changeOrder = null;
    state.companySettings = null;
    sentEmails.length = 0;
}

const fakePrisma = {
    changeOrder: {
        findUnique: async () => state.changeOrder,
    },
    companySettings: {
        findUnique: async () => state.companySettings,
    },
};

const fakeEmail = {
    sendNotification: async (to: string, subject: string, html: string) => {
        sentEmails.push({ to, subject, html });
        return { success: true };
    },
};

let handleChangeOrderApproved: (
    changeOrderId: string,
    opts?: { notify?: boolean; freshlyApproved?: boolean; suppressClientEmails?: boolean },
    dependencies?: { billChangeOrder?: (...args: any[]) => any; sendMilestoneInvoices?: (...args: any[]) => any },
) => Promise<{ billed: boolean; sent: boolean; issues: string[]; awaitingActuals?: boolean }>;

const PRISMA_SPECIFIER = "@/lib/prisma";
const EMAIL_SPECIFIER = "./email";

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
        if (id === EMAIL_SPECIFIER) {
            return fakeEmail;
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
    // so no real network call happens during the test. Tests that assert on the email's
    // subject/detail text override this with a notificationEmail.
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
        status: "Approved",
        project: { name: "Mueller Bathroom" },
    };
}

/** A CO manually approved by staff — no clientSignatureUrl, approvedBy carries the
 * " (manual approval — staff)" marker, status Approved. isManualCoApproval() is true. */
function manualApprovedCo() {
    return {
        code: "CO-001",
        title: "Extra tile",
        totalAmount: 500,
        pricingType: "FIXED",
        markupPercent: null,
        approvedBy: "Jane Doe (manual approval — staff)",
        clientSignatureUrl: null,
        status: "Approved",
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

test("isManualCoApproval requires status Approved — the suffix alone is not enough", () => {
    const suffixedButNotApproved = {
        status: "Sent",
        clientSignatureUrl: null,
        approvedBy: "Jane Doe (manual approval — staff)",
    };
    assert.equal(isManualCoApproval(suffixedButNotApproved), false);

    const suffixedAndApproved = { ...suffixedButNotApproved, status: "Approved" };
    assert.equal(isManualCoApproval(suffixedAndApproved), true);
});

test("email block: a manual approval with an extra issue beyond the standard manual notice gets the needs-a-look manual subject and includes the issue text", async () => {
    // Simulates any post-billing problem landing a second entry in summary.issues
    // alongside the standard MANUAL_BILLING_NOTICE (e.g. the schedule hook's
    // "Schedule update failed (billing unaffected): ..." message) — here produced
    // via the already-injectable billChangeOrder fake returning alreadyBilled:true,
    // which pushes its own distinct issue text through the exact same summary.issues
    // array the email block reads.
    state.changeOrder = manualApprovedCo();
    state.companySettings = { notificationEmail: "team@example.com", companyName: "GTR", email: null };
    const billChangeOrder = async () => ({
        ok: true as const,
        alreadyBilled: true,
        invoiceId: "inv-1",
        invoiceCode: "INV-001",
        milestoneId: "ms-1",
        milestoneName: "CO-001 — Payment 1",
        milestones: [],
        amount: 500,
        milestoneStatus: "Pending",
        note: "already billed",
    });
    const sendMilestoneInvoices = async () => {
        throw new Error("sendMilestoneInvoices must not be called on the suppressed manual-approval path");
    };

    const summary = await handleChangeOrderApproved(
        "co-1",
        { freshlyApproved: false },
        { billChangeOrder, sendMilestoneInvoices },
    );

    assert.equal(summary.billed, true);
    assert.equal(summary.sent, false);
    assert.ok(
        summary.issues.some((issue) => issue.includes("Already on invoice INV-001")),
        "the extra issue should still land in summary.issues",
    );

    assert.equal(sentEmails.length, 1);
    const email = sentEmails[0];
    assert.match(email.subject, /^⚠️ Change order manually approved — needs a look —/);
    assert.match(email.html, /Already on invoice INV-001/);
    assert.match(email.html, /Review in ProBuild or ChatGPT/);
});

test("email block: needsLook detail for a failed manual-approval billing attempt uses honest staff wording, not 'the customer signed'", async () => {
    // isManualApproval true but billing itself failed (summary.billed stays false),
    // so outcomeKind is "needsLook", not "manual" — the detail text must still say
    // staff manually approved, never imply a client signature that never happened.
    state.changeOrder = manualApprovedCo();
    state.companySettings = { notificationEmail: "team@example.com", companyName: "GTR", email: null };
    const billChangeOrder = async () => ({ ok: false as const, error: "Invoice already voided" });
    const sendMilestoneInvoices = async () => {
        throw new Error("sendMilestoneInvoices must not be called when billing itself failed");
    };

    const summary = await handleChangeOrderApproved(
        "co-1",
        { freshlyApproved: false },
        { billChangeOrder, sendMilestoneInvoices },
    );

    assert.equal(summary.billed, false);
    assert.equal(sentEmails.length, 1);
    const email = sentEmails[0];
    assert.match(email.subject, /^⚠️ Change order approved — needs a look —/);
    assert.match(email.html, /Staff.*manually approved this change order \(no client signature\)/);
    assert.doesNotMatch(email.html, /The customer signed/);
    assert.match(email.html, /Invoice already voided/);
});

test("email block: a clean manual approval (no extra issues) keeps the ✅ manual subject", async () => {
    state.changeOrder = manualApprovedCo();
    state.companySettings = { notificationEmail: "team@example.com", companyName: "GTR", email: null };
    const billChangeOrder = async () => freshBillResult();
    const sendMilestoneInvoices = async () => {
        throw new Error("sendMilestoneInvoices must not be called on the suppressed manual-approval path");
    };

    const summary = await handleChangeOrderApproved(
        "co-1",
        { freshlyApproved: false },
        { billChangeOrder, sendMilestoneInvoices },
    );

    assert.equal(summary.billed, true);
    assert.equal(sentEmails.length, 1);
    const email = sentEmails[0];
    assert.match(email.subject, /^✅ Change order manually approved by staff —/);
    assert.doesNotMatch(email.html, /needs a look/);
});

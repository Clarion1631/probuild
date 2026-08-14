/**
 * handleChangeOrderApproved's suppressClientEmails option AND its DB-derived backstop
 * (billing-core.ts), plus the schedule-hook issue surfacing added alongside the revision CAS
 * (Round 4).
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
 * Round 4 replaced the old MANUAL_BILLING_NOTICE-in-summary.issues mechanism with a structural
 * `clientEmailSuppressed` field, so summary.issues now carries only actual problems — including a
 * schedule-hook failure (applyChangeOrderToSchedule, invoked only when freshlyApproved is true).
 * Two tests below exercise that hook for real rather than asserting on a hand-pushed issue string,
 * proving the ⚠️-vs-✅ subject actually reacts to a live failure — one for the manual-approval
 * "manual" outcome, one for the cost-plus "awaitingActuals" outcome.
 *
 * The schedule hook is reached via `await import("./schedule-core")` INSIDE
 * handleChangeOrderApproved's body — a genuine dynamic import, not a top-level one, so (confirmed
 * empirically) it resolves through Node's real ESM loader and is NOT interceptable by patching
 * `Module.prototype.require` the way the top-level `@/lib/prisma`/`./email` imports are. The real
 * schedule-core.ts module loads for real, but ITS OWN top-level `import { prisma } from
 * "@/lib/prisma"` (identical specifier to billing-core.ts's own) is a normal static import that
 * DOES route through the patched require when schedule-core.ts's compiled body executes — so it
 * still picks up this file's fakePrisma. That is enough surface: adding a controllable
 * `$transaction` to fakePrisma lets these tests force `applyChangeOrderToSchedule` to throw a
 * plain (non-precondition) Error with a known message, without needing to fake the rest of
 * schedule-core's internals.
 *
 * `@/lib/prisma` and `./email` are mocked with the same `Module.prototype.require` patch used by
 * tests/takeoff-convert-tax.test.ts and tests/change-order-manual-approval-core.test.ts (see the
 * former's header comment for the full rationale). Faked lookups: `changeOrder.findUnique` (routes
 * past the COST_PLUS branch and carries the manual-approval provenance), `companySettings.findUnique`
 * (returns null in most tests so the best-effort team-notification email never fires a real network
 * call — the tests that assert on subject/detail text set a notification email AND capture
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

/** Overridable per-test; defaults to a no-op success so tests that don't care about the
 * schedule hook (freshlyApproved: false, the default) never even reach it. Wired onto
 * fakePrisma.$transaction — the entry point applyChangeOrderToSchedule's real implementation
 * calls (via withTxRetry) — so throwing here reaches billing-core.ts as a genuine, non-retryable
 * Error, same as a real schedule failure would. */
let scheduleTransactionImpl: () => Promise<unknown> = async () => { throw new Error("scheduleTransactionImpl not configured for this test"); };

function resetFixture() {
    state.changeOrder = null;
    state.companySettings = null;
    sentEmails.length = 0;
    scheduleTransactionImpl = async () => { throw new Error("scheduleTransactionImpl not configured for this test"); };
}

const fakePrisma = {
    changeOrder: {
        findUnique: async () => state.changeOrder,
    },
    companySettings: {
        findUnique: async () => state.companySettings,
    },
    // Only reached by schedule-core.ts's applyChangeOrderToSchedule (via withTxRetry), when a
    // test sets opts.freshlyApproved: true — every other path in this file never calls it.
    $transaction: async (fn: any) => scheduleTransactionImpl(),
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
) => Promise<{ billed: boolean; sent: boolean; issues: string[]; awaitingActuals?: boolean; clientEmailSuppressed?: boolean }>;

const PRISMA_SPECIFIER = "@/lib/prisma";
const EMAIL_SPECIFIER = "./email";

before(async () => {
    const originalRequire = Module.prototype.require;
    let requirePatchHit = false;
    // Left installed for the rest of the process (this file only runs as its own node:test
    // child process) rather than reverted in a finally block: schedule-core.ts's own top-level
    // `import { prisma } from "@/lib/prisma"` executes lazily, the first time
    // handleChangeOrderApproved's `await import("./schedule-core")` runs inside a test — well
    // after this before() hook returns — and that require call needs the patch live to pick up
    // fakePrisma instead of the real client (see the file header comment for why the outer
    // dynamic import of "./schedule-core" itself can't be intercepted the same way).
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

    const mod: { handleChangeOrderApproved?: unknown } = await import("../src/lib/billing-core");

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

/** Portal-signed, COST_PLUS pricing — the "awaitingActuals" outcome regardless of manual
 * approval, used to test the schedule-hook-issue surfacing added in Round 4. */
function portalApprovedCostPlusCo() {
    return {
        ...portalApprovedCo(),
        pricingType: "COST_PLUS",
        markupPercent: 10,
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
    assert.equal(summary.clientEmailSuppressed, true);
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
    assert.equal(summary.clientEmailSuppressed, undefined);
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
    assert.equal(summary.clientEmailSuppressed, true);
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

test("email block: a manual approval with an extra issue beyond suppression (already-billed caution) gets the needs-a-look manual subject and includes the issue text", async () => {
    // Simulates any post-billing problem landing in summary.issues alongside a suppressed
    // manual approval — here produced via the already-injectable billChangeOrder fake returning
    // alreadyBilled:true, which pushes its own distinct "Already on invoice ..." caution through
    // the exact same summary.issues array the email block reads.
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

test("email block: a clean manual approval (no extra issues) keeps the ✅ manual subject and states no payment email was sent", async () => {
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
    assert.equal(summary.clientEmailSuppressed, true);
    assert.equal(sentEmails.length, 1);
    const email = sentEmails[0];
    assert.match(email.subject, /^✅ Change order manually approved by staff —/);
    assert.doesNotMatch(email.html, /needs a look/);
    // Sourced from the structural clientEmailSuppressed field, not from issues.
    assert.match(email.html, /No payment email was sent to the client/);
});

test("schedule hook failure on a freshly manually-approved CO flips the manual outcome to needs-a-look and surfaces the failure text", async () => {
    // Real exercise of the schedule hook, not a hand-pushed issue string: freshlyApproved
    // triggers billing-core's dynamic import("./schedule-core"), whose real
    // applyChangeOrderToSchedule (via withTxRetry) calls prisma.$transaction — forced here to
    // throw a plain (non-precondition) error, which handleChangeOrderApproved must push into
    // summary.issues rather than swallow.
    state.changeOrder = manualApprovedCo();
    state.companySettings = { notificationEmail: "team@example.com", companyName: "GTR", email: null };
    scheduleTransactionImpl = async () => {
        throw new Error("Project has no start date yet");
    };
    const billChangeOrder = async () => freshBillResult();
    const sendMilestoneInvoices = async () => {
        throw new Error("sendMilestoneInvoices must not be called on the suppressed manual-approval path");
    };

    const summary = await handleChangeOrderApproved(
        "co-1",
        { freshlyApproved: true },
        { billChangeOrder, sendMilestoneInvoices },
    );

    assert.equal(summary.billed, true);
    assert.equal(summary.clientEmailSuppressed, true);
    assert.ok(
        summary.issues.some((issue) => issue.includes("Project has no start date yet")),
        "the schedule failure should land in summary.issues",
    );

    assert.equal(sentEmails.length, 1);
    const email = sentEmails[0];
    assert.match(email.subject, /^⚠️ Change order manually approved — needs a look —/);
    assert.match(email.html, /Schedule update failed \(billing unaffected\).*Project has no start date yet/);
});

test("schedule hook failure on a freshly-approved cost-plus CO flips the awaitingActuals outcome to needs-a-look and lists the issue", async () => {
    // Symmetric case for the non-manual (portal-approved) awaitingActuals outcome: COST_PLUS
    // never calls billChangeOrder at all, so this proves the fix reaches the cost-plus branch
    // independently of the manual-approval "manual" outcome tested above.
    state.changeOrder = portalApprovedCostPlusCo();
    state.companySettings = { notificationEmail: "team@example.com", companyName: "GTR", email: null };
    scheduleTransactionImpl = async () => {
        throw new Error("Project has no start date yet");
    };
    const billChangeOrder = async () => {
        throw new Error("billChangeOrder must not be called for a COST_PLUS change order");
    };
    const sendMilestoneInvoices = async () => {
        throw new Error("sendMilestoneInvoices must not be called for a COST_PLUS change order");
    };

    const summary = await handleChangeOrderApproved(
        "co-1",
        { freshlyApproved: true },
        { billChangeOrder, sendMilestoneInvoices },
    );

    assert.equal(summary.awaitingActuals, true);
    assert.ok(
        summary.issues.some((issue) => issue.includes("Project has no start date yet")),
        "the schedule failure should land in summary.issues",
    );

    assert.equal(sentEmails.length, 1);
    const email = sentEmails[0];
    assert.match(email.subject, /^⚠️ Change order approved — awaiting actuals, needs a look —/);
    assert.match(email.html, /Schedule update failed \(billing unaffected\).*Project has no start date yet/);
});

test("clean cost-plus approval with no schedule hook attempt (freshlyApproved: false) keeps the plain awaiting-actuals subject", async () => {
    // Baseline for the two failure cases above: same COST_PLUS outcome, but the schedule hook
    // is never invoked at all (freshlyApproved: false, e.g. a replayed/non-transitioning call),
    // so summary.issues stays empty and the subject carries no ⚠️.
    state.changeOrder = portalApprovedCostPlusCo();
    state.companySettings = { notificationEmail: "team@example.com", companyName: "GTR", email: null };
    const billChangeOrder = async () => {
        throw new Error("billChangeOrder must not be called for a COST_PLUS change order");
    };
    const sendMilestoneInvoices = async () => {
        throw new Error("sendMilestoneInvoices must not be called for a COST_PLUS change order");
    };

    const summary = await handleChangeOrderApproved(
        "co-1",
        { freshlyApproved: false },
        { billChangeOrder, sendMilestoneInvoices },
    );

    assert.equal(summary.awaitingActuals, true);
    assert.deepEqual(summary.issues, []);
    assert.equal(sentEmails.length, 1);
    const email = sentEmails[0];
    assert.match(email.subject, /^Change order approved — awaiting actuals —/);
    assert.doesNotMatch(email.subject, /⚠️/);
    assert.doesNotMatch(email.subject, /needs a look/);
});

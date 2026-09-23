/**
 * A whole-invoice send ("Send Invoice to Client", resend_invoice) must ask
 * the client only for what's billed and unpaid — never Invoice.balanceDue,
 * which also counts milestones that are merely scheduled and were never
 * billed (src/lib/invoice-amount-due.ts, src/lib/billing-core.ts's
 * sendInvoiceToClientCore/resendInvoiceCore).
 *
 * computeInvoiceAmountDue/buildInvoiceDueEmail are pure — no Prisma — so
 * their tests import src/lib/invoice-amount-due.ts (and billing-core.ts's
 * buildInvoiceDueEmail, loaded the same way as the behavioral tests below)
 * directly. The behavioral tests load the REAL src/lib/billing-core module
 * under the same scoped require() patch as tests/ar-digest-listing.test.ts
 * (mock.module() is unusable here — CI pins Node 20), with only Prisma, the
 * email sender, and next/cache faked; everything else billing-core.ts
 * imports loads for real, unmocked.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";

import { computeInvoiceAmountDue, type InvoiceAmountDue } from "../src/lib/invoice-amount-due";
import type { ReceivableInvoiceInput, ReceivableMilestone } from "../src/lib/receivables";
import type { DueSnapshot } from "../src/lib/billing-core";

type Row = Record<string, any>;

// ── Fixture loading (tests/fixtures/ar-digest-2026-09-21.json) ─────────────

type RawMilestone = {
    id: string; name: string; amount: string; status: string;
    dueDate: string | null; createdAt: string;
    qbInvoiceId: string | null; qbInvoiceSentAt: string | null;
    qbSyncError: string | null; qbSyncedAt: string | null;
};
type RawInvoice = {
    code: string; status: string; totalAmount: string; balanceDue: string; issueDate: string | null;
    sentAt: string | null; createdAt: string; milestoneCount: number;
    payments: RawMilestone[]; progressBillings: unknown[];
};

function loadFixtures(): RawInvoice[] {
    const raw = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "ar-digest-2026-09-21.json"), "utf8"));
    return raw.invoices as RawInvoice[];
}
const FIXTURES = loadFixtures();
function rawFixture(code: string): RawInvoice {
    const raw = FIXTURES.find(inv => inv.code === code);
    if (!raw) throw new Error(`fixture ${code} not found`);
    return raw;
}

function parseDate(s: string | null): Date | null {
    return s == null ? null : new Date(s);
}

function toMilestone(m: RawMilestone): ReceivableMilestone {
    return {
        id: m.id, name: m.name, amount: m.amount, status: m.status,
        dueDate: parseDate(m.dueDate), createdAt: new Date(m.createdAt),
        qbInvoiceId: m.qbInvoiceId, qbInvoiceSentAt: parseDate(m.qbInvoiceSentAt),
        qbSyncError: m.qbSyncError, qbSyncedAt: parseDate(m.qbSyncedAt),
    };
}

// Shape for computeInvoiceAmountDue (pure — no Prisma involved).
function toInput(raw: RawInvoice): ReceivableInvoiceInput {
    return {
        status: raw.status,
        balanceDue: raw.balanceDue,
        issueDate: parseDate(raw.issueDate),
        sentAt: parseDate(raw.sentAt),
        createdAt: new Date(raw.createdAt),
        milestoneCount: raw.milestoneCount,
        payments: raw.payments.map(toMilestone),
        progressBillings: [],
    };
}

// Shape for the fake prisma.invoice.findUnique() result sendInvoiceToClientCore/
// loadInvoiceAmountDue expect: mirrors what the real `include`/`select` would
// return, filtered/ordered the same way RECEIVABLE_PAYMENTS_ARGS does
// (Pending-only). clientId/project are nulled out so the send path takes its
// no-portal-signing branch — the ?milestone= URL construction and portal
// signing are exercised by inspection (the rendered email preview script),
// not asserted here.
function toSendShape(raw: RawInvoice): Row {
    return {
        id: raw.code,
        code: raw.code,
        status: raw.status,
        totalAmount: raw.totalAmount,
        balanceDue: raw.balanceDue,
        issueDate: parseDate(raw.issueDate),
        sentAt: parseDate(raw.sentAt),
        createdAt: new Date(raw.createdAt),
        clientId: null,
        projectId: null,
        client: { name: "Sandi", email: "sandi@example.test", additionalEmail: null },
        project: null,
        _count: { payments: raw.milestoneCount },
        payments: raw.payments
            .filter(p => p.status === "Pending")
            .map(p => ({
                id: p.id, name: p.name, amount: p.amount, status: p.status,
                dueDate: parseDate(p.dueDate), createdAt: new Date(p.createdAt),
                qbInvoiceId: p.qbInvoiceId, qbInvoiceSentAt: parseDate(p.qbInvoiceSentAt),
                qbSyncError: p.qbSyncError, qbSyncedAt: parseDate(p.qbSyncedAt),
            })),
        progressBillings: [],
    };
}

// A hand-built invoice row in the same shape as toSendShape()'s output, for
// scenarios the JSON fixture doesn't cover (legacy zero-milestone, a
// milestone swap between preview and confirm). _count.payments defaults to
// payments.length unless explicitly overridden.
function syntheticInvoice(overrides: Partial<Row> & { id: string; code: string }): Row {
    const payments = overrides.payments ?? [];
    return {
        status: "Issued",
        totalAmount: "0.00",
        balanceDue: "0.00",
        issueDate: null,
        sentAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        clientId: null,
        projectId: null,
        client: { name: "Sandi", email: "sandi@example.test", additionalEmail: null },
        project: null,
        _count: { payments: payments.length },
        payments,
        progressBillings: [],
        ...overrides,
    };
}

const NOW = Date.parse("2026-09-21T15:00:00.000Z");

// ── computeInvoiceAmountDue (pure) ──────────────────────────────────────────

test("computeInvoiceAmountDue: INV-00246 -> 465120 cents, one item (Arrival / Mobilization Payment)", () => {
    const due = computeInvoiceAmountDue(toInput(rawFixture("INV-00246")), NOW);
    assert.equal(due.dueCents, 465_120);
    assert.equal(due.items.length, 1);
    assert.equal(due.items[0].kind, "milestone");
    assert.equal(due.items[0].label, "Arrival / Mobilization Payment");
    assert.equal(due.items[0].cents, 465_120);
});

test("computeInvoiceAmountDue: INV-00319 -> 0 cents, no items", () => {
    const due = computeInvoiceAmountDue(toInput(rawFixture("INV-00319")), NOW);
    assert.equal(due.dueCents, 0);
    assert.deepEqual(due.items, []);
});

test("computeInvoiceAmountDue: INV-00172 -> includes Progress Payment 1176000 cents (live QBO, never stamped)", () => {
    const due = computeInvoiceAmountDue(toInput(rawFixture("INV-00172")), NOW);
    assert.equal(due.dueCents, 1_176_000);
    assert.equal(due.items.length, 1);
    assert.equal(due.items[0].label, "Progress Payment");
    assert.equal(due.items[0].cents, 1_176_000);
});

test("computeInvoiceAmountDue: Draft milestone invoice with nothing requested -> 0", () => {
    const m: ReceivableMilestone = {
        id: "ms-draft-1", name: "Deposit", amount: "500.00", status: "Pending",
        dueDate: null, createdAt: new Date("2026-01-01T00:00:00.000Z"),
        qbInvoiceId: null, qbInvoiceSentAt: null, qbSyncError: null, qbSyncedAt: null,
    };
    const inv: ReceivableInvoiceInput = {
        status: "Draft", balanceDue: "500.00", issueDate: null, sentAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"), milestoneCount: 1,
        payments: [m], progressBillings: [],
    };
    const due = computeInvoiceAmountDue(inv, NOW);
    assert.equal(due.dueCents, 0);
    assert.deepEqual(due.items, []);
});

test("computeInvoiceAmountDue: Draft zero-milestone legacy invoice -> 0 due, no items (no Draft exception)", () => {
    // Owner-approved rule: "nothing billed means no email," with no promotion
    // of a Draft invoice to "as if issued." Flipped from the earlier version
    // of this test, which expected the balanceDue to become one billed item.
    const inv: ReceivableInvoiceInput = {
        status: "Draft", balanceDue: "750.00", issueDate: null, sentAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"), milestoneCount: 0,
        payments: [], progressBillings: [],
    };
    const due = computeInvoiceAmountDue(inv, NOW);
    assert.equal(due.dueCents, 0);
    assert.deepEqual(due.items, []);
});

test("computeInvoiceAmountDue: Canceled invoice -> 0", () => {
    const inv: ReceivableInvoiceInput = {
        status: "Canceled", balanceDue: "500.00", issueDate: null, sentAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"), milestoneCount: 0,
        payments: [], progressBillings: [],
    };
    const due = computeInvoiceAmountDue(inv, NOW);
    assert.equal(due.dueCents, 0);
    assert.deepEqual(due.items, []);
});

// ── Fake Prisma + email spy, for buildInvoiceDueEmail/sendInvoiceToClientCore/
//    resendInvoiceCore/selectMilestonesToRefresh (all loaded from the REAL,
//    patched billing-core.ts module) ─────────────────────────────────────────

let invoiceRows: Record<string, Row> = {};
const invoiceUpdateCalls: Row[] = [];
const paymentScheduleUpdateManyCalls: Row[] = [];
// Singular .update() is only ever called by resendInvoiceCore's QuickBooks
// link-refresh loop -- an empty array after a call is direct proof that
// step never ran (used by the expectedDue-mismatch test below).
const paymentScheduleUpdateCalls: Row[] = [];
const sentEmails: Row[] = [];
let forceEmailFailure = false;
let forceStampThrow = false;

const fakePrisma = {
    invoice: {
        findUnique: async (args: Row) => invoiceRows[args.where.id] ?? null,
        update: async (args: Row) => {
            invoiceUpdateCalls.push(args);
            const row = invoiceRows[args.where.id];
            if (row) Object.assign(row, args.data);
            return row;
        },
    },
    paymentSchedule: {
        updateMany: async (args: Row) => {
            paymentScheduleUpdateManyCalls.push(args);
            if (forceStampThrow) throw new Error("simulated DB failure");
            return { count: 0 };
        },
        update: async (args: Row) => {
            paymentScheduleUpdateCalls.push(args);
            return {};
        },
    },
    companySettings: {
        findUnique: async () => ({ companyName: "Test Co", email: null }),
    },
};

async function fakeSendNotification(to: string, subject: string, html: string, _attachments?: unknown, options?: Row) {
    sentEmails.push({ to, subject, html, options });
    if (forceEmailFailure) return { success: false };
    return { success: true, id: "fake-email-id" };
}

beforeEach(() => {
    invoiceRows = {};
    invoiceUpdateCalls.length = 0;
    paymentScheduleUpdateManyCalls.length = 0;
    paymentScheduleUpdateCalls.length = 0;
    sentEmails.length = 0;
    forceEmailFailure = false;
    forceStampThrow = false;
});

// ── Load billing-core under the patch (same technique as ar-digest-listing.test.ts) ──

let sendInvoiceToClientCore: (invoiceId: string, overrideEmail?: string, opts?: { expectedDue?: DueSnapshot }) => Promise<Row>;
let resendInvoiceCore: (invoiceId: string, overrideEmail?: string, deadline?: unknown, opts?: { expectedDue?: DueSnapshot }) => Promise<Row>;
let buildInvoiceDueEmail: (input: Row) => { subject: string; html: string };
let selectMilestonesToRefresh: (due: InvoiceAmountDue, payments: Row[]) => Row[];
let dueSnapshot: (due: InvoiceAmountDue) => DueSnapshot;
let resendConfirmPayload: (args: { invoiceId: string; recipient: string; due: InvoiceAmountDue }) => string;

before(async () => {
    const originalRequire = Module.prototype.require;
    const patched = new Set<string>();
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/prisma") { patched.add(id); return { prisma: fakePrisma }; }
        if (id === "./email") { patched.add(id); return { sendNotification: fakeSendNotification }; }
        if (id === "next/cache") { patched.add(id); return { revalidatePath: () => {} }; }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: Row;
    try {
        mod = await import("../src/lib/billing-core");
    } finally {
        Module.prototype.require = originalRequire;
    }
    for (const id of ["@/lib/prisma", "./email", "next/cache"]) {
        if (!patched.has(id)) throw new Error(`invoice-send-amount-due.test.ts: the mock of "${id}" never applied — billing-core would hit the real module`);
    }
    sendInvoiceToClientCore = mod.sendInvoiceToClientCore;
    resendInvoiceCore = mod.resendInvoiceCore;
    buildInvoiceDueEmail = mod.buildInvoiceDueEmail;
    selectMilestonesToRefresh = mod.selectMilestonesToRefresh;
    dueSnapshot = mod.dueSnapshot;
    resendConfirmPayload = mod.resendConfirmPayload;
});

// ── buildInvoiceDueEmail (pure) ──────────────────────────────────────────────

test("buildInvoiceDueEmail: INV-00246 shape - subject, amounts, escaping, singular wording, no em/en dashes", () => {
    const due = computeInvoiceAmountDue(toInput(rawFixture("INV-00246")), NOW);
    const { subject, html } = buildInvoiceDueEmail({
        companyName: "Golden Touch Remodeling",
        clientName: "Sandi <VIP>",
        projectName: "Commercial Siding",
        projectLocation: "123 Main St",
        invoiceCode: "INV-00246",
        due,
        portalUrl: "https://app.example.test/api/portal/verify?token=abc&next=%2Fportal%2Finvoices%2Finv-246",
    });
    assert.ok(subject.includes("INV-00246"), "subject should name the invoice code");
    assert.ok(subject.includes("$4,651.20 due"), "subject should show the billed amount, not the balance");
    assert.ok(html.includes("Arrival / Mobilization Payment"), "html should list the billed milestone");
    assert.ok(html.includes("$4,651.20"));
    assert.ok(!html.includes("6,511.68"), "must not show the invoice's balanceDue");
    assert.ok(!html.includes("9,302.40"), "must not show the invoice's totalAmount");
    assert.ok(html.includes("Sandi &lt;VIP&gt;"), "client name must be HTML-escaped");
    assert.ok(!html.includes("Sandi <VIP>"), "unescaped client name must not appear");
    assert.ok(html.includes("Only the payment above is due now."), "singular wording for one item");
    assert.ok(!/[—–]/.test(subject), "subject must contain no em/en dashes");
    assert.ok(!/[—–]/.test(html), "html must contain no em/en dashes");
});

test("buildInvoiceDueEmail: plural reference line when more than one item is due", () => {
    const due: InvoiceAmountDue = {
        dueCents: 150_000,
        items: [
            { kind: "milestone", id: "m1", label: "Deposit", cents: 100_000 },
            { kind: "milestone", id: "m2", label: "Rough-In", cents: 50_000 },
        ],
    };
    const { html } = buildInvoiceDueEmail({
        companyName: "Co", clientName: "Client", projectName: "Project", projectLocation: null,
        invoiceCode: "INV-X", due, portalUrl: "https://example.test/portal",
    });
    assert.ok(html.includes("Only the payments above are due now."), "plural wording for two items");
    assert.ok(!/[—–]/.test(html));
});

// ── sendInvoiceToClientCore (behavioral, patched Prisma/email) ──────────────

test("sendInvoiceToClientCore: INV-00246 sends only the billed amount and stamps only the billed milestone", async () => {
    const raw = rawFixture("INV-00246"); // status: "Partially Paid" -- the non-Draft invoice.update branch
    invoiceRows[raw.code] = toSendShape(raw);

    const result = await sendInvoiceToClientCore(raw.code);
    assert.equal(result.success, true);
    assert.equal(result.sentTo, "sandi@example.test");
    assert.equal(result.amountDue, 4651.2);
    assert.deepEqual(result.requested, [{ name: "Arrival / Mobilization Payment", amount: 4651.2 }]);

    assert.equal(sentEmails.length, 1);
    assert.ok(sentEmails[0].html.includes("$4,651.20"));
    assert.ok(!sentEmails[0].html.includes("6,511.68"));

    assert.equal(paymentScheduleUpdateManyCalls.length, 1);
    assert.deepEqual(paymentScheduleUpdateManyCalls[0].where, {
        invoiceId: raw.code, status: "Pending", id: { in: ["ms-INV-00246-2"] },
    });

    // Non-Draft: only sentAt is written, status/issueDate stay untouched.
    assert.equal(invoiceUpdateCalls.length, 1);
    assert.deepEqual(invoiceUpdateCalls[0].where, { id: raw.code });
    assert.deepEqual(Object.keys(invoiceUpdateCalls[0].data).sort(), ["sentAt"]);
    assert.ok(invoiceUpdateCalls[0].data.sentAt instanceof Date);
});

test("sendInvoiceToClientCore: a Draft invoice with a requested milestone flips to Issued and stamps issueDate + sentAt", async () => {
    // E23-shaped (receivables.test.ts): a Draft parent with an already
    // requested Pending milestone still counts as billed -- computeInvoiceAmountDue
    // no longer promotes Draft to Issued itself, but a milestone that IS
    // billed on its own evidence is unaffected by that removal.
    const inv = syntheticInvoice({
        id: "inv-draft-requested", code: "INV-DRAFT-REQ", status: "Draft",
        totalAmount: "500.00", balanceDue: "500.00",
        payments: [{
            id: "ms-draft-req-1", name: "Deposit", amount: "500.00", status: "Pending",
            dueDate: null, createdAt: new Date("2026-01-01T00:00:00.000Z"),
            qbInvoiceId: null, qbInvoiceSentAt: new Date("2026-01-05T00:00:00.000Z"),
            qbSyncError: null, qbSyncedAt: null,
        }],
    });
    invoiceRows[inv.code] = inv;

    const result = await sendInvoiceToClientCore(inv.code);
    assert.equal(result.success, true);

    assert.equal(invoiceUpdateCalls.length, 1);
    assert.deepEqual(invoiceUpdateCalls[0].where, { id: inv.code });
    assert.deepEqual(Object.keys(invoiceUpdateCalls[0].data).sort(), ["issueDate", "sentAt", "status"]);
    assert.equal(invoiceUpdateCalls[0].data.status, "Issued");
    assert.ok(invoiceUpdateCalls[0].data.issueDate instanceof Date);
    assert.ok(invoiceUpdateCalls[0].data.sentAt instanceof Date);
});

test("sendInvoiceToClientCore: portal link focuses on the billed milestone via the real signed-token path", async () => {
    // signClientPortalToken (src/lib/client-portal-auth.ts) needs only an HMAC
    // secret from env -- no DB, no network -- so the real signer runs here
    // instead of being mocked, letting this test decode a genuine token.
    const originalSecret = process.env.CLIENT_PORTAL_SECRET;
    process.env.CLIENT_PORTAL_SECRET = "test-secret-for-invoice-send-amount-due";
    try {
        const raw = rawFixture("INV-00246");
        const inv = toSendShape(raw);
        inv.clientId = "client-246";
        invoiceRows[raw.code] = inv;

        const result = await sendInvoiceToClientCore(raw.code);
        assert.equal(result.success, true);
        assert.equal(sentEmails.length, 1);

        const hrefMatch = (sentEmails[0].html as string).match(/href="([^"]+)"/);
        assert.ok(hrefMatch, "email should contain the portal link");
        const url = new URL(hrefMatch![1].replace(/&amp;/g, "&"));
        assert.equal(url.pathname, "/api/portal/verify");
        assert.equal(url.searchParams.get("next"), `/portal/invoices/${raw.code}?milestone=ms-INV-00246-2`);

        const { verifyClientPortalToken } = await import("../src/lib/client-portal-auth");
        const payload = await verifyClientPortalToken(url.searchParams.get("token")!);
        assert.equal(payload?.clientId, "client-246");
        assert.equal(payload?.email, "sandi@example.test");
    } finally {
        if (originalSecret === undefined) delete process.env.CLIENT_PORTAL_SECRET;
        else process.env.CLIENT_PORTAL_SECRET = originalSecret;
    }
});

test("sendInvoiceToClientCore: legacy zero-milestone Issued invoice emails its balanceDue as one Invoice balance item and stamps nothing", async () => {
    const inv = syntheticInvoice({ id: "inv-legacy-issued", code: "INV-LEGACY-1", status: "Issued", totalAmount: "500.00", balanceDue: "500.00" });
    invoiceRows[inv.code] = inv;

    const result = await sendInvoiceToClientCore(inv.code);
    assert.equal(result.success, true);
    assert.equal(result.amountDue, 500);
    assert.deepEqual(result.requested, [{ name: "Invoice balance", amount: 500 }]);

    assert.equal(sentEmails.length, 1);
    assert.ok(sentEmails[0].html.includes("Invoice balance"));
    assert.ok(sentEmails[0].html.includes("$500.00"));

    assert.equal(paymentScheduleUpdateManyCalls.length, 0, "no milestone to stamp");

    const hrefMatch = (sentEmails[0].html as string).match(/href="([^"]+)"/);
    assert.ok(hrefMatch);
    const href = hrefMatch![1].replace(/&amp;/g, "&");
    assert.ok(!href.includes("milestone="), "a legacy send must not carry a milestone focus query");
    // sendInvoiceToClientCore builds the path from the invoiceId argument it
    // was called with (inv.code here), not the row's own `id` field.
    assert.ok(href.includes(`/portal/invoices/${inv.code}`));
});

test("sendInvoiceToClientCore: legacy zero-milestone Draft invoice has nothing due and writes nothing", async () => {
    const inv = syntheticInvoice({ id: "inv-legacy-draft", code: "INV-LEGACY-2", status: "Draft", totalAmount: "750.00", balanceDue: "750.00" });
    invoiceRows[inv.code] = inv;

    const result = await sendInvoiceToClientCore(inv.code);
    assert.equal(result.success, false);
    assert.equal(result.nothingDue, true);

    assert.equal(sentEmails.length, 0);
    assert.equal(invoiceUpdateCalls.length, 0);
    assert.equal(paymentScheduleUpdateManyCalls.length, 0);
});

test("sendInvoiceToClientCore: INV-00319 (nothing billed) sends nothing and reports nothingDue", async () => {
    const raw = rawFixture("INV-00319");
    invoiceRows[raw.code] = toSendShape(raw);

    const result = await sendInvoiceToClientCore(raw.code);
    assert.equal(result.success, false);
    assert.equal(result.nothingDue, true);
    assert.match(result.error, /Nothing on INV-00319 is billed and unpaid/);
    assert.equal(result.sentTo, undefined);

    assert.equal(sentEmails.length, 0, "no email should be sent");
    assert.equal(invoiceUpdateCalls.length, 0, "no invoice status/sentAt write");
    assert.equal(paymentScheduleUpdateManyCalls.length, 0, "no stamp");
});

test("sendInvoiceToClientCore: email provider failure leaves no stamp", async () => {
    const raw = rawFixture("INV-00246");
    invoiceRows[raw.code] = toSendShape(raw);
    forceEmailFailure = true;

    const result = await sendInvoiceToClientCore(raw.code);
    assert.equal(result.success, false);
    assert.equal(result.nothingDue, undefined);
    assert.equal(sentEmails.length, 1, "the send was attempted");
    assert.equal(paymentScheduleUpdateManyCalls.length, 0, "a failed send must not stamp anything");
});

test("sendInvoiceToClientCore: a failed stamp is fail-soft -- still success, and the failure is logged", async () => {
    const raw = rawFixture("INV-00246");
    invoiceRows[raw.code] = toSendShape(raw);
    forceStampThrow = true;

    const originalConsoleError = console.error;
    const errorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => { errorCalls.push(args); };
    try {
        const result = await sendInvoiceToClientCore(raw.code);
        assert.equal(result.success, true, "a stamp failure must not fail the whole send -- the email already went out");
        assert.equal(sentEmails.length, 1);
        assert.equal(errorCalls.length, 1, "the stamp failure should be logged");
        assert.ok(String(errorCalls[0][0]).includes("stamp failed"));
    } finally {
        console.error = originalConsoleError;
    }
});

test("sendInvoiceToClientCore: expectedDue mismatch (milestone swapped for an equal-priced one) is refused as changed", async () => {
    // Codex's scenario: the preview showed milestone A billed; before confirm,
    // A got paid (drops off Pending) and an equal-priced milestone B got
    // billed instead. Same total, different milestone id -- a total-only
    // check would miss this, so it must not ride the stale approval.
    const inv = syntheticInvoice({
        id: "inv-swap", code: "INV-SWAP", totalAmount: "1000.00", balanceDue: "500.00",
        payments: [{
            id: "ms-B", name: "Milestone B", amount: "500.00", status: "Pending",
            dueDate: null, createdAt: new Date("2026-01-02T00:00:00.000Z"),
            qbInvoiceId: null, qbInvoiceSentAt: new Date("2026-01-03T00:00:00.000Z"),
            qbSyncError: null, qbSyncedAt: null,
        }],
    });
    invoiceRows[inv.code] = inv;

    const staleExpected: DueSnapshot = [{ id: "ms-A", cents: 50_000 }]; // the preview named A, not B
    const result = await sendInvoiceToClientCore(inv.code, undefined, { expectedDue: staleExpected });

    assert.equal(result.success, false);
    assert.equal(result.changed, true);
    assert.match(result.error, /changed since the preview/);

    assert.equal(sentEmails.length, 0);
    assert.equal(invoiceUpdateCalls.length, 0);
    assert.equal(paymentScheduleUpdateManyCalls.length, 0);
});

test("sendInvoiceToClientCore: expectedDue built from a differently-ordered due still matches and sends", async () => {
    const inv = syntheticInvoice({
        id: "inv-swap-2", code: "INV-SWAP-2", totalAmount: "1000.00", balanceDue: "500.00",
        payments: [
            {
                id: "ms-X", name: "Milestone X", amount: "300.00", status: "Pending",
                dueDate: null, createdAt: new Date("2026-01-01T00:00:01.000Z"),
                qbInvoiceId: null, qbInvoiceSentAt: new Date("2026-01-05T00:00:00.000Z"),
                qbSyncError: null, qbSyncedAt: null,
            },
            {
                id: "ms-Y", name: "Milestone Y", amount: "200.00", status: "Pending",
                dueDate: null, createdAt: new Date("2026-01-01T00:00:02.000Z"),
                qbInvoiceId: null, qbInvoiceSentAt: new Date("2026-01-05T00:00:00.000Z"),
                qbSyncError: null, qbSyncedAt: null,
            },
        ],
    });
    invoiceRows[inv.code] = inv;

    // dueSnapshot() is what actually produces a DueSnapshot in real code (the
    // MCP route calls it on the preview's `due`) -- so "a different order"
    // means feeding it a due whose items are listed in the opposite order
    // from what the live computation below will produce, and letting
    // dueSnapshot's own sort normalize both to the same canonical order.
    const reorderedDue: InvoiceAmountDue = {
        dueCents: 50_000,
        items: [
            { kind: "milestone", id: "ms-Y", label: "Milestone Y", cents: 20_000 },
            { kind: "milestone", id: "ms-X", label: "Milestone X", cents: 30_000 },
        ],
    };
    const result = await sendInvoiceToClientCore(inv.code, undefined, { expectedDue: dueSnapshot(reorderedDue) });

    assert.equal(result.success, true);
    assert.equal(sentEmails.length, 1);
});

// ── resendInvoiceCore (behavioral) ───────────────────────────────────────────

test("resendInvoiceCore: nothing billed returns the nothing-due result without sending or touching QuickBooks", async () => {
    const raw = rawFixture("INV-00319");
    invoiceRows[raw.code] = toSendShape(raw);

    const result = await resendInvoiceCore(raw.code);
    assert.equal(result.success, false);
    assert.equal(result.nothingDue, true);
    assert.match(result.error, /Nothing on INV-00319 is billed and unpaid/);
    assert.deepEqual(result.linkRefresh, []);

    assert.equal(sentEmails.length, 0);
    assert.equal(invoiceUpdateCalls.length, 0);
    assert.equal(paymentScheduleUpdateManyCalls.length, 0);
});

test("resendInvoiceCore: a mismatching expectedDue is refused before ever touching QuickBooks", async () => {
    const raw = rawFixture("INV-00246");
    invoiceRows[raw.code] = toSendShape(raw);

    const staleExpected: DueSnapshot = [{ id: "ms-does-not-exist", cents: 465_120 }];
    const result = await resendInvoiceCore(raw.code, undefined, undefined, { expectedDue: staleExpected });

    assert.equal(result.success, false);
    assert.equal(result.changed, true);
    assert.match(result.error, /changed since the preview/);
    assert.deepEqual(result.linkRefresh, []);

    assert.equal(sentEmails.length, 0);
    assert.equal(invoiceUpdateCalls.length, 0);
    assert.equal(paymentScheduleUpdateManyCalls.length, 0);
    // paymentSchedule.update (singular) is only ever called from the
    // QuickBooks link-refresh loop -- zero calls proves that loop never ran.
    assert.equal(paymentScheduleUpdateCalls.length, 0, "the QuickBooks refresh step must never run");
});

// ── resendConfirmPayload (pure) ──────────────────────────────────────────────

test("resendConfirmPayload: identical for the same due set regardless of item order", () => {
    const dueA: InvoiceAmountDue = { dueCents: 500, items: [
        { kind: "milestone", id: "m1", label: "A", cents: 300 },
        { kind: "milestone", id: "m2", label: "B", cents: 200 },
    ] };
    const dueB: InvoiceAmountDue = { dueCents: 500, items: [
        { kind: "milestone", id: "m2", label: "B", cents: 200 },
        { kind: "milestone", id: "m1", label: "A", cents: 300 },
    ] };
    const payloadA = resendConfirmPayload({ invoiceId: "inv-1", recipient: "a@example.test", due: dueA });
    const payloadB = resendConfirmPayload({ invoiceId: "inv-1", recipient: "a@example.test", due: dueB });
    assert.equal(payloadA, payloadB);
});

test("resendConfirmPayload: differs when one item id changes, even with the same total", () => {
    const dueA: InvoiceAmountDue = { dueCents: 500, items: [{ kind: "milestone", id: "m1", label: "A", cents: 500 }] };
    const dueC: InvoiceAmountDue = { dueCents: 500, items: [{ kind: "milestone", id: "m-other", label: "C", cents: 500 }] };
    const payloadA = resendConfirmPayload({ invoiceId: "inv-1", recipient: "a@example.test", due: dueA });
    const payloadC = resendConfirmPayload({ invoiceId: "inv-1", recipient: "a@example.test", due: dueC });
    assert.notEqual(payloadA, payloadC);
});

test("resendConfirmPayload: differs when the recipient changes", () => {
    const due: InvoiceAmountDue = { dueCents: 500, items: [{ kind: "milestone", id: "m1", label: "A", cents: 500 }] };
    const payloadA = resendConfirmPayload({ invoiceId: "inv-1", recipient: "a@example.test", due });
    const payloadB = resendConfirmPayload({ invoiceId: "inv-1", recipient: "b@example.test", due });
    assert.notEqual(payloadA, payloadB);
});

// ── selectMilestonesToRefresh (pure fallback for the QBO-refresh selection —
//    resendInvoiceCore's dynamic imports of quickbooks-payments/quickbooks
//    are impractical to intercept with the require() patch above) ───────────

test("selectMilestonesToRefresh: refreshes only billed milestones that have a QuickBooks invoice", () => {
    const due: InvoiceAmountDue = {
        dueCents: 150_000,
        items: [
            { kind: "milestone", id: "ms-voided-requested", label: "Voided but requested", cents: 100_000 },
            { kind: "milestone", id: "ms-live-qbo", label: "Live QBO, never requested", cents: 50_000 },
        ],
    };
    const payments = [
        // Billed via qbInvoiceSentAt even though its own QBO doc was voided
        // (qbInvoiceSentAt survives a QBO unlink) -- still refreshed.
        { id: "ms-voided-requested", name: "Voided but requested", qbInvoiceId: "qb-1" },
        // Billed via a live QBO link -- refreshed.
        { id: "ms-live-qbo", name: "Live QBO, never requested", qbInvoiceId: "qb-2" },
        // Voided AND never requested -- never became a billed item at all
        // (not in due.items), so it must be skipped even though it still
        // has a qbInvoiceId on file.
        { id: "ms-voided-never-requested", name: "Voided, never requested", qbInvoiceId: "qb-3" },
        // No QuickBooks id at all -- nothing to refresh.
        { id: "ms-no-qbo-id", name: "No QuickBooks id", qbInvoiceId: null },
    ];
    const selected = selectMilestonesToRefresh(due, payments);
    assert.deepEqual(selected.map(s => s.id).sort(), ["ms-live-qbo", "ms-voided-requested"]);
});

// ── SendInvoiceModal (interactive, jsdom -- pattern copied from
//    tests/time-entry-void-control.test.tsx, the repo's precedent for
//    click-and-await component tests under node --test) ────────────────────

test("SendInvoiceModal: a failed send shows the error toast and keeps the modal open", async () => {
    // The repo ships jsdom without its optional declaration package (same
    // note as tests/time-entry-void-control.test.tsx) -- require() here,
    // typed to only the browser surface this test exercises.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { JSDOM } = require("jsdom") as { JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis } };
    const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://example.test" });
    const globals = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"];
    const saved = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[key] });

    const originalRequire = Module.prototype.require;
    const toastCalls: string[] = [];
    let closeCalls = 0;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/actions") return { sendInvoiceToClient: async () => ({ success: false, error: "Nothing on INV-1 is billed and unpaid." }) };
        if (id === "sonner") return { toast: { error: () => toastCalls.push("error"), success: () => toastCalls.push("success") } };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let root: import("react-dom/client").Root | undefined;
    try {
        const { createRoot } = await import("react-dom/client");
        const { default: SendInvoiceModal } = await import("../src/components/SendInvoiceModal");
        root = createRoot(dom.window.document.getElementById("root")!);
        await act(async () => {
            root!.render(createElement(SendInvoiceModal, { invoiceId: "inv-1", clientEmail: "client@example.test", onClose: () => { closeCalls++; } }));
        });
        await act(async () => {
            dom.window.document.querySelector<HTMLButtonElement>("button.hui-btn-green")!.click();
        });
        assert.equal(closeCalls, 0, "the modal must stay open on a failed send");
        assert.deepEqual(toastCalls, ["error"]);
    } finally {
        Module.prototype.require = originalRequire;
        if (root) await act(async () => root!.unmount());
        for (const key of globals) { const d = saved.get(key); if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
        dom.window.close();
    }
});

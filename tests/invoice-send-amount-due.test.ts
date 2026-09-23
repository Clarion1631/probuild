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

import { computeInvoiceAmountDue, type InvoiceAmountDue } from "../src/lib/invoice-amount-due";
import type { ReceivableInvoiceInput, ReceivableMilestone } from "../src/lib/receivables";

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

test("computeInvoiceAmountDue: Draft zero-milestone legacy invoice -> its balanceDue as one legacyInvoice item", () => {
    const inv: ReceivableInvoiceInput = {
        status: "Draft", balanceDue: "750.00", issueDate: null, sentAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"), milestoneCount: 0,
        payments: [], progressBillings: [],
    };
    const due = computeInvoiceAmountDue(inv, NOW);
    assert.equal(due.dueCents, 75_000);
    assert.equal(due.items.length, 1);
    assert.equal(due.items[0].kind, "legacyInvoice");
    assert.equal(due.items[0].label, "Invoice balance");
    assert.equal(due.items[0].cents, 75_000);
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
const sentEmails: Row[] = [];
let forceEmailFailure = false;

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
            return { count: 0 };
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
    sentEmails.length = 0;
    forceEmailFailure = false;
});

// ── Load billing-core under the patch (same technique as ar-digest-listing.test.ts) ──

let sendInvoiceToClientCore: (invoiceId: string, overrideEmail?: string) => Promise<Row>;
let resendInvoiceCore: (invoiceId: string, overrideEmail?: string) => Promise<Row>;
let buildInvoiceDueEmail: (input: Row) => { subject: string; html: string };
let selectMilestonesToRefresh: (due: InvoiceAmountDue, payments: Row[]) => Row[];

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
    const raw = rawFixture("INV-00246");
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

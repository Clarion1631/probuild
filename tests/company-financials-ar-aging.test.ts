/**
 * Company financials AR aging chart — buildArAging() / getCompanyFinancialsChartData()
 * (ar-reports-spec.md Goal 4, tests/company-financials-ar-aging.test.ts).
 *
 * buildArAging() re-buckets the same billed-and-unpaid universe the AR digest
 * reports (src/lib/receivables.ts) by days-past-due instead of by invoice, so
 * this checks it two ways: against the digest's own hardcoded fixture totals,
 * and against synthetic cases for every boundary the spec calls out
 * (net-30 fallback, due-date grace, company-timezone day math, retainers).
 *
 * src/lib/company-financials-charts.ts imports "@/lib/prisma" at module
 * scope (and, transitively through resolveCompanyTimeZone, "./prisma" too),
 * so it is loaded under the same scoped CJS require() patch as
 * tests/company-financials-spend-attribution.test.ts (`mock.module()` is
 * unusable here — CI pins Node 20). src/lib/receivables.ts has no Prisma
 * import at runtime (only a type-only one), so it is imported directly,
 * unpatched, exactly like tests/receivables.test.ts does.
 *
 * All bucketing here is timezone-sensitive, so every test fixes both the
 * `now` instant AND uses "America/Los_Angeles" explicitly (never the host's
 * local zone) — matching the spec's instruction for this file.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
    RECEIVABLE_INVOICE_WHERE, RECEIVABLE_INVOICE_SELECT, DUE_DATE_GRACE_MS,
    type ReceivableInvoiceInput, type ReceivableMilestone,
} from "../src/lib/receivables";
import type { ArAgingBucket, CompanyFinancialsChartFilters } from "../src/lib/company-financials-charts";

type Row = Record<string, any>;

const TZ = "America/Los_Angeles";
const DAY = 86_400_000;

// Both endpoints of every relative-date computation below fall inside PDT
// (US DST: 2026-03-08 - 2026-11-01), so subtracting whole multiples of DAY
// from a fixed UTC instant also subtracts whole LA-calendar days — the same
// technique tests/receivables.test.ts relies on for its own day arithmetic.
const NOW = Date.parse("2026-09-21T15:00:00.000Z"); // 08:00 PDT

// ── Fixture loading (tests/fixtures/ar-digest-2026-09-21.json) ─────────────────

function loadFixtureFile(): { _digestInstant: string; invoices: Row[] } {
    return JSON.parse(readFileSync(path.join(__dirname, "fixtures", "ar-digest-2026-09-21.json"), "utf8"));
}
const FIXTURE_FILE = loadFixtureFile();
const FIXTURE_NOW = Date.parse(FIXTURE_FILE._digestInstant);

function parseDate(s: string | null): Date | null {
    return s == null ? null : new Date(s);
}

// Copied from tests/receivables.test.ts (not imported — importing a test
// file would re-register its tests).
function toMilestone(m: Row): ReceivableMilestone {
    return {
        id: m.id, name: m.name, amount: m.amount, status: m.status,
        dueDate: parseDate(m.dueDate), createdAt: new Date(m.createdAt),
        qbInvoiceId: m.qbInvoiceId, qbInvoiceSentAt: parseDate(m.qbInvoiceSentAt),
        qbSyncError: m.qbSyncError, qbSyncedAt: parseDate(m.qbSyncedAt),
    };
}
function toInput(inv: Row): ReceivableInvoiceInput {
    return {
        status: inv.status,
        balanceDue: inv.balanceDue,
        issueDate: parseDate(inv.issueDate),
        sentAt: parseDate(inv.sentAt),
        createdAt: new Date(inv.createdAt),
        milestoneCount: inv.milestoneCount,
        payments: inv.payments.map(toMilestone),
        progressBillings: [],
    };
}
const FIXTURE_INVOICES: ReceivableInvoiceInput[] = FIXTURE_FILE.invoices.map(toInput);

/** Shapes one raw fixture invoice into RECEIVABLE_INVOICE_SELECT's exact
 *  return shape — the chart's own AR query `select`s nothing else (no id/
 *  code/project/client, unlike the digest's and Open Invoices' own selects).
 *  Copied (not imported — importing a test file would re-register its tests)
 *  from tests/open-invoices-receivables.test.ts's toSelectShape(), trimmed to
 *  drop the fields that file's select adds and this one's doesn't. */
function toSelectShape(raw: Row): Row {
    return {
        status: raw.status,
        balanceDue: raw.balanceDue,
        issueDate: parseDate(raw.issueDate),
        sentAt: parseDate(raw.sentAt),
        createdAt: new Date(raw.createdAt),
        _count: { payments: raw.milestoneCount },
        payments: (raw.payments as Row[])
            .filter(p => p.status === "Pending")
            .map(p => ({
                id: p.id, name: p.name, amount: p.amount, status: p.status,
                dueDate: parseDate(p.dueDate), createdAt: new Date(p.createdAt),
                qbInvoiceId: p.qbInvoiceId, qbInvoiceSentAt: parseDate(p.qbInvoiceSentAt),
                qbSyncError: p.qbSyncError, qbSyncedAt: parseDate(p.qbSyncedAt),
            })),
        progressBillings: ((raw.progressBillings ?? []) as Row[])
            .filter(pb => pb.status === "Staged" || pb.status === "Sent")
            .map(pb => ({
                id: pb.id, code: pb.code, status: pb.status,
                qbInvoiceId: pb.qbInvoiceId, qbSyncError: pb.qbSyncError,
                qbSyncedAt: parseDate(pb.qbSyncedAt), qbInvoiceSentAt: parseDate(pb.qbInvoiceSentAt),
                sentAt: parseDate(pb.sentAt), createdAt: new Date(pb.createdAt),
                lines: pb.lines,
            })),
    };
}

// ── Synthetic milestone/invoice builders (copied from tests/receivables.test.ts) ──

let msSeq = 0;
function milestone(overrides: Partial<ReceivableMilestone> = {}): ReceivableMilestone {
    msSeq += 1;
    return {
        id: `synthetic-ms-${msSeq}`,
        name: `Milestone ${msSeq}`,
        amount: "100.00",
        status: "Pending",
        dueDate: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        qbInvoiceId: null,
        qbInvoiceSentAt: null,
        qbSyncError: null,
        qbSyncedAt: null,
        ...overrides,
    };
}
function invoiceOf(payments: ReceivableMilestone[], overrides: Partial<ReceivableInvoiceInput> = {}): ReceivableInvoiceInput {
    const balanceDue = payments.filter(p => p.status === "Pending").reduce((s, p) => s + Number(p.amount), 0);
    return {
        status: "Partially Paid",
        balanceDue,
        issueDate: null,
        sentAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        milestoneCount: payments.length,
        payments,
        progressBillings: [],
        ...overrides,
    };
}

// ── Fake Prisma + call capture (for the getCompanyFinancialsChartData test) ─

const invoiceCalls: Row[] = [];
const paymentScheduleCalls: Row[] = [];
// Settable by a test that needs invoice.findMany to return real (select-
// shaped) rows — e.g. the D.2 full-plumbing check below. Every other test
// never sets it, so invoice.findMany keeps returning [] exactly as before.
let invoiceFindManyRows: Row[] = [];

const fakePrisma = {
    companySettings: { findUnique: async () => ({ timeZone: TZ }) },
    invoice: {
        findMany: async (args: Row) => { invoiceCalls.push(args); return invoiceFindManyRows; },
    },
    paymentSchedule: {
        findMany: async (args: Row) => { paymentScheduleCalls.push(args); return []; },
    },
    retainer: { findMany: async () => [] },
    timeEntry: { findMany: async () => [] },
    estimate: { findMany: async () => [] },
    expense: {
        findMany: async () => [],
        groupBy: async () => [],
    },
};

// ── Load the real module under the patch ────────────────────────────────────

let buildArAging: (
    invoices: ReceivableInvoiceInput[],
    openRetainers: { balanceDue: unknown; dueDate: Date | null }[],
    now: number,
    timeZone: string,
) => ArAgingBucket[];
let getCompanyFinancialsChartData: (filters: CompanyFinancialsChartFilters, jobProjects: Row[]) => Promise<Row>;
// Loaded for the D.2 full-plumbing check: the chart's AR totals, produced
// through the fake-Prisma round trip, must match the real digest function's
// own totals over the same fixture rows.
let listReceivables: (now?: number) => Promise<Row>;

before(async () => {
    const originalRequire = Module.prototype.require;
    const patched = new Set<string>();
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/prisma" || id === "./prisma") {
            patched.add(id);
            return { prisma: fakePrisma };
        }
        // billing-core.ts (loaded below for listReceivables()) imports these
        // two at module scope regardless of which export is used — same
        // patch tests/open-invoices-receivables.test.ts applies.
        if (id === "./email") { patched.add(id); return { sendNotification: async () => ({ success: true, id: "fake" }) }; }
        if (id === "next/cache") { patched.add(id); return { revalidatePath: () => {} }; }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: Row;
    let billingCore: Row;
    try {
        mod = await import("../src/lib/company-financials-charts");
        billingCore = await import("../src/lib/billing-core");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (!patched.has("@/lib/prisma") && !patched.has("./prisma")) {
        throw new Error("company-financials-ar-aging.test.ts: the @/lib/prisma mock never applied — a real module would have loaded");
    }
    for (const id of ["./email", "next/cache"]) {
        if (!patched.has(id)) throw new Error(`company-financials-ar-aging.test.ts: the mock of "${id}" never applied — a real module would have loaded`);
    }
    buildArAging = mod.buildArAging;
    getCompanyFinancialsChartData = mod.getCompanyFinancialsChartData;
    listReceivables = billingCore.listReceivables;
});

// ── helpers ──────────────────────────────────────────────────────────────

function bucketAmount(buckets: ArAgingBucket[], label: string): number {
    return buckets.find(b => b.bucket === label)?.amount ?? 0;
}
function onlyNonZeroBucket(buckets: ArAgingBucket[]): string {
    const hits = buckets.filter(b => b.amount !== 0);
    if (hits.length !== 1) throw new Error(`expected exactly one non-zero bucket, got ${JSON.stringify(hits)}`);
    return hits[0].bucket;
}

// ── 1: fixture parity (no retainers) ────────────────────────────────────────

test("fixture parity: Σ bucket amounts and Σ '1-30'..'91+' match the digest's totals", () => {
    const buckets = buildArAging(FIXTURE_INVOICES, [], FIXTURE_NOW, TZ);
    const total = buckets.reduce((s, b) => s + b.amount, 0);
    const overdueTotal = buckets
        .filter(b => b.bucket === "1-30" || b.bucket === "31-60" || b.bucket === "61-90" || b.bucket === "91+")
        .reduce((s, b) => s + b.amount, 0);
    assert.equal(Math.round(total * 100), 1_741_418); // $17,414.18
    assert.equal(Math.round(overdueTotal * 100), 1_276_298); // $12,762.98
});

// ── 2: invoice item bucketing ────────────────────────────────────────────────

test("an unbilled Pending milestone contributes to no bucket at all", () => {
    const m = milestone({ amount: "500.00" }); // never sent, no QBO link -> backlog, not a billed item
    const buckets = buildArAging([invoiceOf([m])], [], NOW, TZ);
    assert.ok(buckets.every(b => b.amount === 0));
});

test("billed and not overdue -> 'Not yet due'", () => {
    const m = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY) });
    const buckets = buildArAging([invoiceOf([m])], [], NOW, TZ);
    assert.equal(onlyNonZeroBucket(buckets), "Not yet due");
    assert.equal(bucketAmount(buckets, "Not yet due"), 500);
});

test("a due date 45 days ago -> '31-60'", () => {
    const m = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 50 * DAY), dueDate: new Date(NOW - 45 * DAY) });
    const buckets = buildArAging([invoiceOf([m])], [], NOW, TZ);
    assert.equal(onlyNonZeroBucket(buckets), "31-60");
    assert.equal(bucketAmount(buckets, "31-60"), 500);
});

test("no due date, billed 45 days ago -> '1-30' (net-30 fallback: 45 - 30 = 15 days past due)", () => {
    const m = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 45 * DAY) });
    const buckets = buildArAging([invoiceOf([m])], [], NOW, TZ);
    assert.equal(onlyNonZeroBucket(buckets), "1-30");
    assert.equal(bucketAmount(buckets, "1-30"), 500);
});

test("no due date, ageDays exactly 30 -> 'Not yet due'; 31 -> '1-30'", () => {
    const notOverdue = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 30 * DAY) });
    const bucketsNotOverdue = buildArAging([invoiceOf([notOverdue])], [], NOW, TZ);
    assert.equal(onlyNonZeroBucket(bucketsNotOverdue), "Not yet due");

    const overdue = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 31 * DAY) });
    const bucketsOverdue = buildArAging([invoiceOf([overdue])], [], NOW, TZ);
    assert.equal(onlyNonZeroBucket(bucketsOverdue), "1-30");
});

// ── 3: due-date grace, in company-local time ────────────────────────────────

test("due-date grace: due yesterday at LA-local noon — 09:00 LA today is inside the 24h grace, 13:00 LA today is not", () => {
    const dueDate = new Date("2026-09-20T19:00:00.000Z"); // 2026-09-20T12:00 PDT
    const billedAt = new Date("2026-09-01T00:00:00.000Z"); // long billed; the due date governs
    const m = milestone({ amount: "500.00", dueDate, qbInvoiceSentAt: billedAt });
    const invoice = invoiceOf([m]);

    const nowInsideGrace = Date.parse("2026-09-21T16:00:00.000Z"); // 09:00 PDT today
    const insideGrace = buildArAging([invoice], [], nowInsideGrace, TZ);
    assert.equal(onlyNonZeroBucket(insideGrace), "Not yet due");

    const nowPastGrace = Date.parse("2026-09-21T20:00:00.000Z"); // 13:00 PDT today
    const pastGrace = buildArAging([invoice], [], nowPastGrace, TZ);
    assert.equal(onlyNonZeroBucket(pastGrace), "1-30"); // exactly 1 LA-calendar day past due
});

// ── 4: retainers keep the pre-existing ageBucket() rule ─────────────────────

test("retainers: a null due date still buckets as 'No due date'", () => {
    const buckets = buildArAging([], [{ balanceDue: "500.00", dueDate: null }], NOW, TZ);
    assert.equal(onlyNonZeroBucket(buckets), "No due date");
    assert.equal(bucketAmount(buckets, "No due date"), 500);
});

test("retainers: a past-due retainer is bucketed by its own due date, not net-30", () => {
    const buckets = buildArAging([], [{ balanceDue: "300.00", dueDate: new Date(NOW - 45 * DAY) }], NOW, TZ);
    assert.equal(onlyNonZeroBucket(buckets), "31-60");
    assert.equal(bucketAmount(buckets, "31-60"), 300);
});

// ── 5: half-cent inputs sum exactly in cents ────────────────────────────────

test("half-cent inputs (invoice items and a retainer) sum exactly in cents", () => {
    const sentAt = new Date(NOW - 5 * DAY);
    const m1 = milestone({ amount: "0.10", qbInvoiceSentAt: sentAt });
    const m2 = milestone({ amount: "0.20", qbInvoiceSentAt: sentAt });
    const buckets = buildArAging([invoiceOf([m1, m2])], [{ balanceDue: "1.005", dueDate: null }], NOW, TZ);

    assert.equal(Math.round(bucketAmount(buckets, "Not yet due") * 100), 30); // 0.10 + 0.20, not 0.30000000000000004
    assert.equal(Math.round(bucketAmount(buckets, "No due date") * 100), 101); // 1.005 rounds up to $1.01
});

// ── 6: getCompanyFinancialsChartData issues the new AR query, not the old one ──

test("getCompanyFinancialsChartData: AR query is invoice.findMany(AND:[RECEIVABLE_INVOICE_WHERE, projectId]); no paymentSchedule.findMany uses the old AR where", async () => {
    invoiceCalls.length = 0;
    paymentScheduleCalls.length = 0;

    const filters: CompanyFinancialsChartFilters = {
        preset: "6mo",
        from: new Date("2026-04-01T00:00:00.000Z"),
        to: new Date("2026-07-01T00:00:00.000Z"),
        projectIds: ["job-a", "job-b"],
        includeOverhead: false,
    };
    await getCompanyFinancialsChartData(filters, [
        { id: "job-a", name: "Job A" },
        { id: "job-b", name: "Job B" },
    ]);

    assert.equal(invoiceCalls.length, 1, "exactly one invoice.findMany call — the AR aging query");
    assert.deepEqual(invoiceCalls[0].where, { AND: [RECEIVABLE_INVOICE_WHERE, { projectId: { in: ["job-a", "job-b"] } }] });
    assert.deepEqual(invoiceCalls[0].select, RECEIVABLE_INVOICE_SELECT);

    for (const call of paymentScheduleCalls) {
        assert.notDeepEqual(call.where?.status, { notIn: ["Paid", "Canceled"] }, "the old AR paymentSchedule query must be gone");
    }
});

// ── 7: full plumbing — the fake returns real fixture rows this time, so the
//    chart's own totals can be checked against the real digest function ────

test("getCompanyFinancialsChartData: chart's AR totals match the real listReceivables() over the same fixture rows", async () => {
    invoiceFindManyRows = FIXTURE_FILE.invoices.map(toSelectShape);
    const realDateNow = Date.now;
    Date.now = () => FIXTURE_NOW;
    try {
        const filters: CompanyFinancialsChartFilters = {
            preset: "6mo",
            from: new Date("2026-04-01T00:00:00.000Z"),
            to: new Date("2026-07-01T00:00:00.000Z"),
            projectIds: ["job-a", "job-b"],
            includeOverhead: false,
        };
        const data = await getCompanyFinancialsChartData(filters, [
            { id: "job-a", name: "Job A" },
            { id: "job-b", name: "Job B" },
        ]);

        const chartTotalCents = Math.round(
            (data.arAging as ArAgingBucket[]).reduce((s, b) => s + b.amount, 0) * 100,
        );
        const chartPastDueCents = Math.round(
            (data.arAging as ArAgingBucket[])
                .filter(b => b.bucket === "1-30" || b.bucket === "31-60" || b.bucket === "61-90" || b.bucket === "91+")
                .reduce((s, b) => s + b.amount, 0) * 100,
        );

        // No retainers in this fixture, so the chart's invoice-only totals
        // must equal the digest's own totals exactly.
        const ar = await listReceivables(FIXTURE_NOW);
        assert.equal(chartTotalCents, Math.round(ar.totalOutstanding * 100));
        assert.equal(chartPastDueCents, Math.round(ar.overdueOutstanding * 100));
    } finally {
        Date.now = realDateNow;
        invoiceFindManyRows = [];
    }
});

// ── 8: chart past-due bucket boundaries ─────────────────────────────────────

test("due-date item exactly 30 days past due -> '1-30'; 31 -> '31-60'", () => {
    const m30 = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 90 * DAY), dueDate: new Date(NOW - 30 * DAY) });
    assert.equal(onlyNonZeroBucket(buildArAging([invoiceOf([m30])], [], NOW, TZ)), "1-30");

    const m31 = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 90 * DAY), dueDate: new Date(NOW - 31 * DAY) });
    assert.equal(onlyNonZeroBucket(buildArAging([invoiceOf([m31])], [], NOW, TZ)), "31-60");
});

test("due-date item exactly 60 days past due -> '31-60'; 61 -> '61-90'", () => {
    const m60 = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 90 * DAY), dueDate: new Date(NOW - 60 * DAY) });
    assert.equal(onlyNonZeroBucket(buildArAging([invoiceOf([m60])], [], NOW, TZ)), "31-60");

    const m61 = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 90 * DAY), dueDate: new Date(NOW - 61 * DAY) });
    assert.equal(onlyNonZeroBucket(buildArAging([invoiceOf([m61])], [], NOW, TZ)), "61-90");
});

test("due-date item exactly 90 days past due -> '61-90'; 91 -> '91+'", () => {
    const m90 = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 120 * DAY), dueDate: new Date(NOW - 90 * DAY) });
    assert.equal(onlyNonZeroBucket(buildArAging([invoiceOf([m90])], [], NOW, TZ)), "61-90");

    const m91 = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 120 * DAY), dueDate: new Date(NOW - 91 * DAY) });
    assert.equal(onlyNonZeroBucket(buildArAging([invoiceOf([m91])], [], NOW, TZ)), "91+");
});

test("net-30 item (no due date): ageDays 60 -> '1-30'; 61 -> '31-60'", () => {
    const m60 = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 60 * DAY) });
    assert.equal(onlyNonZeroBucket(buildArAging([invoiceOf([m60])], [], NOW, TZ)), "1-30");

    const m61 = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 61 * DAY) });
    assert.equal(onlyNonZeroBucket(buildArAging([invoiceOf([m61])], [], NOW, TZ)), "31-60");
});

// ── 9: grace edge, to the millisecond ───────────────────────────────────────

test("grace edge: now = dueDate + 24h exactly -> 'Not yet due'; +1ms -> '1-30'", () => {
    const dueDate = new Date("2026-09-20T19:00:00.000Z"); // 2026-09-20T12:00 PDT (LA-local noon)
    const billedAt = new Date("2026-09-01T00:00:00.000Z"); // long billed; the due date governs
    const invoice = invoiceOf([milestone({ amount: "500.00", dueDate, qbInvoiceSentAt: billedAt })]);

    const atGraceEdge = dueDate.getTime() + DUE_DATE_GRACE_MS;
    assert.equal(onlyNonZeroBucket(buildArAging([invoice], [], atGraceEdge, TZ)), "Not yet due");
    assert.equal(onlyNonZeroBucket(buildArAging([invoice], [], atGraceEdge + 1, TZ)), "1-30"); // exactly 1 LA-calendar day past due
});

// ── 10: DST fall-back ────────────────────────────────────────────────────────

test("DST fall-back (America/Los_Angeles): overdue with 0 calendar days past due clamps to '1-30'", () => {
    // 2026-11-01T00:15:00-07:00 — just before the 2am PDT->PST fall-back.
    const dueDate = new Date("2026-11-01T07:15:00.000Z");
    // 2026-11-01T23:30:00-08:00 — same LA calendar day as dueDate (Nov 1),
    // but already on the PST side of the fall-back.
    const now = new Date("2026-11-02T07:30:00.000Z");
    const billedAt = new Date("2026-10-01T00:00:00.000Z");
    const invoice = invoiceOf([milestone({ amount: "500.00", dueDate, qbInvoiceSentAt: billedAt })]);

    const buckets = buildArAging([invoice], [], now.getTime(), TZ);
    assert.equal(onlyNonZeroBucket(buckets), "1-30"); // Math.max(1, 0) clamp, not "Not yet due"
});

// ── 11: mixed invoice + retainer input ──────────────────────────────────────

test("mixed invoice + retainer input: total cents = Σ receivableCents + Σ retainer cents; a null-dueDate retainer still lands in 'No due date'", () => {
    const notYetDue = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY) });
    const pastDue = milestone({ amount: "300.00", qbInvoiceSentAt: new Date(NOW - 50 * DAY), dueDate: new Date(NOW - 45 * DAY) });
    const retainerNoDue = { balanceDue: "200.00", dueDate: null };
    const retainerPastDue = { balanceDue: "100.00", dueDate: new Date(NOW - 10 * DAY) };

    const buckets = buildArAging([invoiceOf([notYetDue]), invoiceOf([pastDue])], [retainerNoDue, retainerPastDue], NOW, TZ);

    const totalCents = Math.round(buckets.reduce((s, b) => s + b.amount, 0) * 100);
    assert.equal(totalCents, 50_000 + 30_000 + 20_000 + 10_000); // $500 + $300 invoice items, $200 + $100 retainers

    assert.equal(bucketAmount(buckets, "Not yet due"), 500);
    assert.equal(bucketAmount(buckets, "31-60"), 300);
    assert.equal(bucketAmount(buckets, "No due date"), 200);
    assert.equal(bucketAmount(buckets, "1-30"), 100);
});

/**
 * Open Invoices report — summarizeOpenInvoices() / queryOpenInvoicesData()
 * (ar-reports-spec.md Goal 4, tests/open-invoices-receivables.test.ts).
 *
 * summarizeOpenInvoices() must report exactly what the AR digest reports —
 * same universe, same billed predicate, same integer-cent amounts — just
 * re-bucketed per BILLED ITEM instead of per invoice. This file checks that
 * parity two ways: against the digest's own hardcoded totals (see
 * tests/receivables.test.ts R6 and tests/ar-digest-listing.test.ts L3), and
 * against a live call to the REAL listReceivables() fed the identical
 * fixture, so a future edit that moves both files in the same wrong
 * direction still fails here.
 *
 * src/lib/open-invoices-report.ts imports "@/lib/prisma" at module scope, so
 * it is loaded under the same scoped CJS require() patch as
 * tests/ar-digest-listing.test.ts (`mock.module()` is unusable here — CI
 * pins Node 20). src/lib/receivables.ts has no Prisma import at runtime
 * (only a type-only one), so it is imported directly, unpatched, exactly
 * like tests/receivables.test.ts does.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
    RECEIVABLE_INVOICE_WHERE, RECEIVABLE_INVOICE_SELECT, toCents,
    type ReceivableMilestone,
} from "../src/lib/receivables";
import type { OpenInvoicesSummary, OpenInvoiceRow, OpenInvoicesFilters } from "../src/lib/open-invoices-report";

type Row = Record<string, any>;

const DAY = 86_400_000;

// ── Fixture loading (tests/fixtures/ar-digest-2026-09-21.json) ─────────────────

function loadFixtureFile(): { _digestInstant: string; invoices: Row[] } {
    return JSON.parse(readFileSync(path.join(__dirname, "fixtures", "ar-digest-2026-09-21.json"), "utf8"));
}
const FIXTURE_FILE = loadFixtureFile();
const ALL_FIXTURES: Row[] = FIXTURE_FILE.invoices;
const NOW = Date.parse(FIXTURE_FILE._digestInstant);

function parseDate(s: string | null): Date | null {
    return s == null ? null : new Date(s);
}

/** Shapes one raw fixture invoice the way BOTH listReceivables()'s and
 *  queryOpenInvoicesData()'s Prisma `select` (RECEIVABLE_INVOICE_SELECT plus
 *  id/code/project/client) expect to consume it. Copied from
 *  tests/ar-digest-listing.test.ts's toSelectShape() rather than imported —
 *  importing a test file would re-register its tests. The fixture carries no
 *  client data at all, so `client: null` here is also deliberate coverage of
 *  "handle a null project/client without crashing". */
function toSelectShape(raw: Row): Row {
    return {
        id: raw.code,
        code: raw.code,
        status: raw.status,
        totalAmount: raw.totalAmount,
        balanceDue: raw.balanceDue,
        issueDate: parseDate(raw.issueDate),
        sentAt: parseDate(raw.sentAt),
        createdAt: new Date(raw.createdAt),
        project: { id: `${raw.code}-project`, name: raw.project },
        client: null,
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

// ── Synthetic invoice-row builder (mirrors tests/receivables.test.ts's
//    milestone()/invoiceOf(), copied+extended with the id/code/project/client
//    fields summarizeOpenInvoices() itself reads) ───────────────────────────

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

let invSeq = 0;
function openRow(payments: ReceivableMilestone[], overrides: Row = {}): OpenInvoiceRow {
    invSeq += 1;
    const code = `INV-SYN-${invSeq}`;
    const balanceDue = payments.filter(p => p.status === "Pending").reduce((s, p) => s + Number(p.amount), 0);
    return {
        id: code,
        code,
        status: "Partially Paid",
        balanceDue,
        issueDate: null,
        sentAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        project: { id: `${code}-project`, name: "Synthetic Project" },
        client: { id: `${code}-client`, name: "Synthetic Client" },
        _count: { payments: payments.length },
        payments,
        progressBillings: [],
        ...overrides,
    } as unknown as OpenInvoiceRow;
}

function assertInvariants(summary: OpenInvoicesSummary) {
    const bucketSum = summary.buckets.reduce((s, b) => s + b.cents, 0);
    assert.equal(bucketSum, summary.totalOutstandingCents, "sum of bucket cents must equal totalOutstandingCents");
    const overdueSum = summary.buckets
        .flatMap(b => b.rows)
        .filter(r => r.item.overdue)
        .reduce((s, r) => s + r.item.cents, 0);
    assert.equal(overdueSum, summary.overdueCents, "sum of overdue row cents must equal overdueCents");
}

// ── Fake Prisma + call capture ──────────────────────────────────────────────

let fixtureRows: Row[] = [];
const findManyCalls: Row[] = [];

const fakePrisma = {
    invoice: {
        findMany: async (args: Row) => {
            findManyCalls.push(args);
            return fixtureRows.map(toSelectShape);
        },
    },
};

beforeEach(() => {
    fixtureRows = [];
    findManyCalls.length = 0;
});

// ── Load the real modules under the patch ───────────────────────────────────

let listReceivables: (now?: number) => Promise<Row>;
let summarizeOpenInvoices: (invoices: OpenInvoiceRow[], now: number) => OpenInvoicesSummary;
let queryOpenInvoicesData: (filters: OpenInvoicesFilters) => Promise<OpenInvoiceRow[]>;

before(async () => {
    const originalRequire = Module.prototype.require;
    const patched = new Set<string>();
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/prisma") { patched.add(id); return { prisma: fakePrisma }; }
        // billing-core.ts (loaded below for the real listReceivables() cross-check)
        // imports these two at module scope regardless of which export is used.
        if (id === "./email") { patched.add(id); return { sendNotification: async () => ({ success: true, id: "fake" }) }; }
        if (id === "next/cache") { patched.add(id); return { revalidatePath: () => {} }; }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let billingCore: Row;
    let openInvoicesReport: Row;
    try {
        billingCore = await import("../src/lib/billing-core");
        openInvoicesReport = await import("../src/lib/open-invoices-report");
    } finally {
        Module.prototype.require = originalRequire;
    }
    for (const id of ["@/lib/prisma", "./email", "next/cache"]) {
        if (!patched.has(id)) throw new Error(`open-invoices-receivables.test.ts: the mock of "${id}" never applied — a real module would have loaded`);
    }
    listReceivables = billingCore.listReceivables;
    summarizeOpenInvoices = openInvoicesReport.summarizeOpenInvoices;
    queryOpenInvoicesData = openInvoicesReport.queryOpenInvoicesData;
});

// ── 1: fixture parity, checked against constants AND the real digest ───────

test("fixture parity: summarizeOpenInvoices matches the digest's hardcoded totals and the real listReceivables()", async () => {
    fixtureRows = ALL_FIXTURES;
    const rows = await queryOpenInvoicesData({ clientId: null, projectId: null, statuses: [] });
    const summary = summarizeOpenInvoices(rows, NOW);

    assert.equal(summary.totalOutstandingCents, 1_741_418);
    assert.equal(summary.overdueCents, 1_276_298);
    assert.equal(summary.unbilledCents, 28_345_060);
    assert.equal(summary.invoiceCount, 4);
    assertInvariants(summary);

    const ar = await listReceivables(NOW);
    assert.equal(Math.round(ar.totalOutstanding * 100), summary.totalOutstandingCents);
    assert.equal(Math.round(ar.overdueOutstanding * 100), summary.overdueCents);
    assert.equal(Math.round(ar.unbilledBacklog * 100), summary.unbilledCents);
    assert.equal(ar.invoiceCount, summary.invoiceCount);
});

// ── 2: regression against the OLD formula ───────────────────────────────────

test("regression: the old formula (Σ balanceDue, Issued/Overdue/Partially Paid) overstated by exactly the unbilled backlog", () => {
    const OLD_STATUSES = new Set(["Issued", "Overdue", "Partially Paid"]);
    const oldTotalCents = ALL_FIXTURES
        .filter(inv => OLD_STATUSES.has(inv.status))
        .reduce((sum, inv) => sum + toCents(inv.balanceDue), 0);
    assert.equal(oldTotalCents, 30_086_478);

    const rows = ALL_FIXTURES.map(toSelectShape) as unknown as OpenInvoiceRow[];
    const summary = summarizeOpenInvoices(rows, NOW);
    assert.equal(summary.totalOutstandingCents, 1_741_418);
    assert.equal(oldTotalCents - summary.totalOutstandingCents, 28_345_060);
});

// ── 3: per-item aging / unbilled / Canceled / legacy zero-milestone ────────

test("per-item aging: one invoice with two billed items of different ages lands in two buckets, split by cents", () => {
    const old = milestone({ amount: "1000.00", qbInvoiceSentAt: new Date(NOW - 45 * DAY) }); // ageDays 45 -> "31–60"
    const recent = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY) }); // ageDays 5 -> "0–30"
    const summary = summarizeOpenInvoices([openRow([old, recent])], NOW);

    const b31_60 = summary.buckets.find(b => b.label === "31–60")!;
    const b0_30 = summary.buckets.find(b => b.label === "0–30")!;
    assert.equal(b31_60.cents, 100_000);
    assert.equal(b31_60.rows.length, 1);
    assert.equal(b0_30.cents, 50_000);
    assert.equal(b0_30.rows.length, 1);
    assert.equal(summary.totalOutstandingCents, 150_000);
    assertInvariants(summary);
});

test("an unbilled Pending milestone is excluded from every bucket but still counted in unbilledCents", () => {
    const unbilled = milestone({ amount: "300.00" }); // never sent, no QBO link -> backlog
    const billed = milestone({ amount: "200.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY) });
    const summary = summarizeOpenInvoices([openRow([unbilled, billed])], NOW);

    assert.equal(summary.unbilledCents, 30_000);
    assert.equal(summary.totalOutstandingCents, 20_000);
    const totalRows = summary.buckets.reduce((s, b) => s + b.rows.length, 0);
    assert.equal(totalRows, 1, "only the billed item should appear in any bucket");
    assertInvariants(summary);
});

test("a Canceled invoice contributes nothing", () => {
    const m = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY) });
    const summary = summarizeOpenInvoices([openRow([m], { status: "Canceled", balanceDue: 0 })], NOW);

    assert.equal(summary.totalOutstandingCents, 0);
    assert.equal(summary.unbilledCents, 0);
    assert.equal(summary.buckets.reduce((s, b) => s + b.rows.length, 0), 0);
});

test("a legacy zero-milestone issued invoice counts its balance, aged from issueDate", () => {
    const issueDate = new Date(NOW - 40 * DAY); // -> ageDays 40 -> "31–60"
    const row = openRow([], { status: "Issued", balanceDue: "750.00", issueDate });
    const summary = summarizeOpenInvoices([row], NOW);

    const bucket = summary.buckets.find(b => b.label === "31–60")!;
    assert.equal(bucket.cents, 75_000);
    assert.equal(bucket.rows.length, 1);
    assert.equal(bucket.rows[0].item.kind, "legacyInvoice");
    assertInvariants(summary);
});

// ── 4: bucket boundaries ────────────────────────────────────────────────────

function bucketLabelForAge(ageDays: number): string {
    const billedAt = new Date(NOW - ageDays * DAY);
    const m = milestone({ amount: "100.00", qbInvoiceSentAt: billedAt });
    const summary = summarizeOpenInvoices([openRow([m])], NOW);
    const hit = summary.buckets.find(b => b.rows.length > 0);
    if (!hit) throw new Error(`ageDays=${ageDays} landed in no bucket at all`);
    return hit.label;
}

test("bucket boundaries: 30/31, 60/61, 90/91, and a negative ageDays", () => {
    assert.equal(bucketLabelForAge(30), "0–30");
    assert.equal(bucketLabelForAge(31), "31–60");
    assert.equal(bucketLabelForAge(60), "31–60");
    assert.equal(bucketLabelForAge(61), "61–90");
    assert.equal(bucketLabelForAge(90), "61–90");
    assert.equal(bucketLabelForAge(91), "91+");
    assert.equal(bucketLabelForAge(-5), "0–30");
});

// ── 6: queryOpenInvoicesData's where/select composition ─────────────────────

test("queryOpenInvoicesData: no filters -> where.AND holds RECEIVABLE_INVOICE_WHERE and no status clause", async () => {
    fixtureRows = [];
    await queryOpenInvoicesData({ clientId: null, projectId: null, statuses: [] });
    const args = findManyCalls[findManyCalls.length - 1];
    assert.deepEqual(args.where, { AND: [RECEIVABLE_INVOICE_WHERE] });
    for (const key of Object.keys(RECEIVABLE_INVOICE_SELECT)) {
        assert.ok(key in args.select, `select must include RECEIVABLE_INVOICE_SELECT's "${key}"`);
    }
    assert.equal(args.select.id, true);
    assert.equal(args.select.code, true);
    assert.deepEqual(args.select.project, { select: { id: true, name: true } });
    assert.deepEqual(args.select.client, { select: { id: true, name: true } });
});

test("queryOpenInvoicesData: status/client/project filters are AND-composed alongside RECEIVABLE_INVOICE_WHERE", async () => {
    fixtureRows = [];
    await queryOpenInvoicesData({ clientId: "client-1", projectId: "project-1", statuses: ["Issued", "Overdue"] });
    const args = findManyCalls[findManyCalls.length - 1];
    assert.deepEqual(args.where, {
        AND: [
            RECEIVABLE_INVOICE_WHERE,
            { status: { in: ["Issued", "Overdue"] } },
            { clientId: "client-1" },
            { projectId: "project-1" },
        ],
    });
});

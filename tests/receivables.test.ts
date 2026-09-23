/**
 * computeInvoiceReceivable — the pure per-invoice AR rule
 * (ar-fix-spec.md §1.7, §3.1, §4.1).
 *
 * `Invoice.balanceDue` is "whole contract minus paid milestones" and includes
 * milestones that were merely SCHEDULED, never billed. The AR digest used to
 * sum it directly, which reported unbilled backlog as money owed (INV-00319:
 * 189,800 reported, 0 actually billed). This module computes receivables per
 * BILLED item instead — a milestone counts only once the client was asked for
 * it (qbInvoiceSentAt) or a live QuickBooks invoice exists for it.
 *
 * No Prisma, no fetch, no session — this exercises src/lib/receivables.ts
 * directly against the committed prod snapshot (tests/fixtures/
 * ar-digest-2026-09-21.json, 9 invoices / 45 milestones, project names
 * neutralized) plus synthetic edge cases for every state the spec calls out.
 *
 * See tests/ar-digest-listing.test.ts for the behavioural half (listReceivables/
 * sendArDigest against a faked Prisma).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
    computeInvoiceReceivable,
    type ReceivableInvoiceInput,
    type ReceivableMilestone,
    type ReceivableProgressBilling,
} from "../src/lib/receivables";

// ── Fixture loading (tests/fixtures/ar-digest-2026-09-21.json) ─────────────────

const NOW = Date.parse("2026-09-21T15:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;

type RawMilestone = {
    id: string; name: string; amount: string; status: string;
    dueDate: string | null; createdAt: string;
    qbInvoiceId: string | null; qbInvoiceSentAt: string | null;
    qbSyncError: string | null; qbSyncedAt: string | null;
};
type RawInvoice = {
    code: string; status: string; balanceDue: string; issueDate: string | null;
    sentAt: string | null; createdAt: string; milestoneCount: number;
    payments: RawMilestone[]; progressBillings: unknown[];
};

function loadFixtures(): RawInvoice[] {
    const raw = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "ar-digest-2026-09-21.json"), "utf8"));
    return raw.invoices as RawInvoice[];
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

function toInput(inv: RawInvoice): ReceivableInvoiceInput {
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

const FIXTURES = loadFixtures();
function fixture(code: string): ReceivableInvoiceInput {
    const raw = FIXTURES.find(inv => inv.code === code);
    if (!raw) throw new Error(`fixture ${code} not found`);
    return toInput(raw);
}

// ── R1-R6: verbatim prod rows (spec §4.1) ───────────────────────────────────

test("R1: INV-00319 — five never-billed milestones report zero receivable", () => {
    const r = computeInvoiceReceivable(fixture("INV-00319"), NOW);
    assert.equal(r.receivableCents, 0);
    assert.equal(r.unbilledCents, 18_980_000); // 189800.00
    assert.deepEqual(r.items, []);
    assert.equal(r.ageDays, null);
    assert.equal(r.overdue, false);
});

test("R2: INV-00171 — unbilled Final Payment reports zero receivable", () => {
    const r = computeInvoiceReceivable(fixture("INV-00171"), NOW);
    assert.equal(r.receivableCents, 0);
    assert.equal(r.unbilledCents, 2_922_400); // 29224.00
});

test("R3: INV-00246 — billedAt is the qbSyncedAt link time, not the later send", () => {
    const r = computeInvoiceReceivable(fixture("INV-00246"), NOW);
    assert.equal(r.receivableCents, 465_120); // 4651.20
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].requested, true);
    assert.equal(r.items[0].inQuickBooks, true);
    assert.equal(r.items[0].billedAt.toISOString(), "2026-09-04T19:23:30.465Z");
    assert.equal(r.items[0].ageDays, 16);
    assert.equal(r.overdue, false);
    assert.equal(r.unbilledCents, 186_048); // 1860.48
});

test("R4: INV-00172 — QBO-only milestone counts and is flagged not requested", () => {
    const r = computeInvoiceReceivable(fixture("INV-00172"), NOW);
    assert.equal(r.receivableCents, 1_176_000); // 11760.00
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].requested, false);
    assert.equal(r.items[0].inQuickBooks, true);
    assert.equal(r.notRequestedCents, 1_176_000);
    assert.equal(r.ageDays, 89);
    assert.equal(r.overdue, true);
    assert.equal(r.unbilledCents, 0);
});

test("R5a: INV-00169 — requested CO milestone counts, unrequested Progress Payment does not", () => {
    const r = computeInvoiceReceivable(fixture("INV-00169"), NOW);
    assert.equal(r.receivableCents, 100_000); // 1000.00
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].requested, true);
    assert.equal(r.items[0].inQuickBooks, false);
    assert.equal(r.ageDays, 76);
    assert.equal(r.overdue, true);
    assert.equal(r.unbilledCents, 676_250); // 6762.50
});

test("R5b: INV-00174 — zero-amount rows are ignored and do not affect age", () => {
    const r = computeInvoiceReceivable(fixture("INV-00174"), NOW);
    assert.equal(r.receivableCents, 298); // 2.98
    assert.equal(r.ageDays, 82);
    assert.equal(r.unbilledCents, 892); // 8.92
});

test("R6: all 9 fixture invoices sum to the validated projection (spec §5.1)", () => {
    let receivableCents = 0, overdueCents = 0, unbilledCents = 0, withReceivable = 0;
    for (const raw of FIXTURES) {
        const r = computeInvoiceReceivable(toInput(raw), NOW);
        receivableCents += r.receivableCents;
        overdueCents += r.overdueCents;
        unbilledCents += r.unbilledCents;
        if (r.receivableCents > 0) withReceivable++;
    }
    assert.equal(receivableCents, 1_741_418);
    assert.equal(overdueCents, 1_276_298);
    assert.equal(unbilledCents, 28_345_060);
    assert.equal(withReceivable, 4);
});

// ── Synthetic edge cases (spec §4.1 table, E1-E25) ──────────────────────────

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

function progressBilling(overrides: Partial<ReceivableProgressBilling> = {}): ReceivableProgressBilling {
    return {
        id: "pb-synthetic",
        code: "PB-001",
        status: "Staged",
        qbInvoiceId: "qb-pb-1",
        qbSyncError: null,
        qbSyncedAt: new Date("2026-08-01T00:00:00.000Z"),
        qbInvoiceSentAt: null,
        sentAt: null,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        lines: [],
        ...overrides,
    };
}

test("E1: Pending with qbInvoiceSentAt and no QBO link counts as requested-only", () => {
    const m = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY) });
    const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
    assert.equal(r.receivableCents, 50_000);
    assert.equal(r.items[0].requested, true);
    assert.equal(r.items[0].inQuickBooks, false);
});

test("E2: approval deposit (qbInvoiceId+qbSyncedAt, never sent) counts as not-requested", () => {
    const m = milestone({ amount: "500.00", qbInvoiceId: "qb-1", qbSyncedAt: new Date(NOW - 5 * DAY) });
    const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
    assert.equal(r.receivableCents, 50_000);
    assert.equal(r.items[0].requested, false);
    assert.equal(r.notRequestedCents, 50_000);
});

test("E3: Paid milestone never counts even with send+QBO evidence", () => {
    const m = milestone({ amount: "500.00", status: "Paid", qbInvoiceSentAt: new Date(NOW - 5 * DAY), qbInvoiceId: "qb-1" });
    const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
    assert.equal(r.receivableCents, 0);
    assert.equal(r.items.length, 0);
});

test("E4: Canceled milestone never counts even with send+QBO evidence", () => {
    const m = milestone({ amount: "500.00", status: "Canceled", qbInvoiceSentAt: new Date(NOW - 5 * DAY), qbInvoiceId: "qb-1" });
    const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
    assert.equal(r.receivableCents, 0);
});

test("E5: Canceled parent invoice reports EMPTY regardless of Pending milestones (INV-00158 shape)", () => {
    const m = milestone({ amount: "464.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY) });
    const r = computeInvoiceReceivable(invoiceOf([m], { status: "Canceled", balanceDue: 0 }), NOW);
    assert.equal(r.receivableCents, 0);
    assert.equal(r.unbilledCents, 0);
    assert.deepEqual(r.items, []);
});

test("E6a: qbSyncError=voided with no send does not count", () => {
    const m = milestone({ amount: "500.00", qbInvoiceId: "qb-1", qbSyncError: "voided" });
    const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
    assert.equal(r.receivableCents, 0);
});

test("E6b: qbSyncError=voided PLUS a send still counts on the request leg", () => {
    const m = milestone({ amount: "500.00", qbInvoiceId: "qb-1", qbSyncError: "voided", qbInvoiceSentAt: new Date(NOW - 5 * DAY) });
    const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
    assert.equal(r.receivableCents, 50_000);
    assert.equal(r.items[0].inQuickBooks, false);
    assert.equal(r.items[0].requested, true);
});

test("E7: pending-deletion (plain or qualified) with no send does not count", () => {
    for (const qbSyncError of ["pending-deletion", "pending-deletion:claimed:x"]) {
        const m = milestone({ amount: "500.00", qbInvoiceId: "qb-1", qbSyncError });
        const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
        assert.equal(r.receivableCents, 0, qbSyncError);
    }
});

test("E8: paylink-pending/paylink-missing still count — only the link is missing", () => {
    for (const qbSyncError of ["paylink-pending:2", "paylink-missing"]) {
        const m = milestone({ amount: "500.00", qbInvoiceId: "qb-1", qbSyncError });
        const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
        assert.equal(r.receivableCents, 50_000, qbSyncError);
    }
});

test("E9: ambiguous-create with no qbInvoiceId and no send does not count", () => {
    const m = milestone({ amount: "500.00", qbInvoiceId: null, qbSyncError: "ambiguous-create" });
    const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
    assert.equal(r.receivableCents, 0);
});

test("E10a: a due date 2 days past is overdue even though billing is recent", () => {
    const m = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY), dueDate: new Date(NOW - 2 * DAY) });
    const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
    assert.equal(r.items[0].overdue, true);
});

test("E10b: a due date 12h past is inside the 24h grace — not overdue", () => {
    const m = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY), dueDate: new Date(NOW - 12 * HOUR) });
    const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
    assert.equal(r.items[0].overdue, false);
});

test("E10c: a future due date governs over 60 days of age — not overdue", () => {
    const m = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 60 * DAY), dueDate: new Date(NOW + 5 * DAY) });
    const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
    assert.equal(r.items[0].overdue, false);
});

test("E11: no due date — net-30 boundary is exactly 30 days, not 31", () => {
    const notOverdue = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - (30 * DAY + HOUR)) });
    const rNot = computeInvoiceReceivable(invoiceOf([notOverdue]), NOW);
    assert.equal(rNot.items[0].ageDays, 30);
    assert.equal(rNot.items[0].overdue, false);

    const overdue = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - (31 * DAY + HOUR)) });
    const rOver = computeInvoiceReceivable(invoiceOf([overdue]), NOW);
    assert.equal(rOver.items[0].ageDays, 31);
    assert.equal(rOver.items[0].overdue, true);
});

test("E12: invoice overdueCents sums only the overdue items, not the whole balance", () => {
    const old = milestone({ amount: "1000.00", qbInvoiceSentAt: new Date(NOW - 45 * DAY) });
    const recent = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY) });
    const r = computeInvoiceReceivable(invoiceOf([old, recent]), NOW);
    assert.equal(r.ageDays, 45); // oldest open item
    assert.equal(r.overdue, true);
    assert.equal(r.overdueCents, 100_000); // old only, not 150000
});

test("E13: linked then re-sent — billedAt stays the earlier link time", () => {
    const m = milestone({
        amount: "500.00", qbInvoiceId: "qb-1",
        qbSyncedAt: new Date(NOW - 40 * DAY),
        qbInvoiceSentAt: new Date(NOW - 2 * DAY),
    });
    const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
    assert.equal(r.items[0].ageDays, 40);
});

test("E14: portal-only (no QBO link) re-send restarts age — documents the known limitation", () => {
    const m = milestone({ amount: "500.00", qbInvoiceId: null, qbInvoiceSentAt: new Date(NOW - 2 * DAY) });
    const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
    assert.equal(r.items[0].ageDays, 2);
});

test("E15 (design review F1): a live Staged billing is evidence, not a separate item — two milestone items totalling 25,000", () => {
    const msA = milestone({ id: "ms-A", amount: "15000.00", qbInvoiceSentAt: new Date(NOW - 10 * DAY) });
    const msB = milestone({ id: "ms-B", amount: "10000.00" });
    const pb = progressBilling({ lines: [{ scheduleId: "ms-A" }, { scheduleId: "ms-B" }] });
    const inv = invoiceOf([msA, msB], { balanceDue: "25000.00", progressBillings: [pb] });
    const r = computeInvoiceReceivable(inv, NOW);
    assert.equal(r.receivableCents, 2_500_000);
    assert.equal(r.items.length, 2);
    assert.ok(r.items.every(it => it.kind === "milestone"));
    const a = r.items.find(it => it.id === "ms-A")!;
    const b = r.items.find(it => it.id === "ms-B")!;
    assert.equal(a.cents, 1_500_000);
    assert.equal(a.requested, true); // its own evidence
    assert.equal(b.cents, 1_000_000);
    assert.equal(b.inQuickBooks, true); // via the billing, even with no evidence of its own
    assert.equal(b.requested, false); // the billing itself was never sent/requested either
    assert.equal(a.progressBillingCode, "PB-001");
    assert.equal(b.progressBillingCode, "PB-001");
});

test("E16: the same billing in Draft does not cover its lines — each milestone stands alone", () => {
    const msA = milestone({ id: "ms-A", amount: "15000.00", qbInvoiceSentAt: new Date(NOW - 10 * DAY) });
    const msB = milestone({ id: "ms-B", amount: "10000.00" });
    const pb = progressBilling({ status: "Draft", lines: [{ scheduleId: "ms-A" }, { scheduleId: "ms-B" }] });
    const inv = invoiceOf([msA, msB], { balanceDue: "25000.00", progressBillings: [pb] });
    const r = computeInvoiceReceivable(inv, NOW);
    assert.equal(r.receivableCents, 1_500_000); // A only (requested); B is neither requested nor in QBO
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].progressBillingCode, null); // a Draft billing is not live evidence
});

test("E17 (design review F2 — latent: the hourly poller doesn't persist void/notFound onto ProgressBilling rows yet, so this pins the rule for when it does): a voided qbSyncError on a Staged billing is not a live link — its lines stand alone", () => {
    const msA = milestone({ id: "ms-A", amount: "15000.00", qbInvoiceSentAt: new Date(NOW - 10 * DAY) });
    const msB = milestone({ id: "ms-B", amount: "10000.00" });
    const pb = progressBilling({ status: "Staged", qbSyncError: "voided", lines: [{ scheduleId: "ms-A" }, { scheduleId: "ms-B" }] });
    const inv = invoiceOf([msA, msB], { balanceDue: "25000.00", progressBillings: [pb] });
    const r = computeInvoiceReceivable(inv, NOW);
    assert.equal(r.receivableCents, 1_500_000); // A only, on its own evidence; B has none
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].id, "ms-A");
    assert.equal(r.items[0].progressBillingCode, null);
});

test("E18: a materialized custom-line milestone is still covered by its billing — counted once, at its own amount", () => {
    const msCustom = milestone({ id: "ms-custom", amount: "5000.00" });
    const pb = progressBilling({ lines: [{ scheduleId: "ms-custom" }] });
    const inv = invoiceOf([msCustom], { balanceDue: "5000.00", progressBillings: [pb] });
    const r = computeInvoiceReceivable(inv, NOW);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].kind, "milestone");
    assert.equal(r.items[0].id, "ms-custom");
    assert.equal(r.items[0].inQuickBooks, true);
    assert.equal(r.receivableCents, 500_000);
});

test("F1 (design review, Codex's repro): a rebalanced covered milestone (A=$50) plus a requested one (B=$150) total 200, not 250", () => {
    // Before any rebalance the billing claimed A at its own `total` (frozen
    // at staging time). "Edit amounts" (updatePendingMilestoneAmountsCore)
    // then re-split the invoice's Pending milestones to A=$50 / B=$150
    // without knowing a progress billing exists — A's PaymentSchedule.amount
    // moved; nothing about the billing did. The old code counted the
    // billing's frozen total (100) PLUS B's new amount (150) = 250. This
    // counts A and B each once, at what they currently say: 50 + 150 = 200.
    const a = milestone({ id: "ms-A", amount: "50.00" }); // covered; already the rebalanced amount
    const b = milestone({ id: "ms-B", amount: "150.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY) });
    const pb = progressBilling({ lines: [{ scheduleId: "ms-A" }] });
    const inv = invoiceOf([a, b], { balanceDue: "200.00", progressBillings: [pb] });
    const r = computeInvoiceReceivable(inv, NOW);
    assert.equal(r.receivableCents, 20_000); // $200.00, not $250.00
    assert.equal(r.items.length, 2);
});

test("F1 (design review): a milestone covered by two live billings still counts once", () => {
    const m = milestone({ id: "ms-A", amount: "100.00" });
    const pb1 = progressBilling({ id: "pb-1", code: "PB-001", lines: [{ scheduleId: "ms-A" }] });
    const pb2 = progressBilling({ id: "pb-2", code: "PB-002", qbInvoiceSentAt: new Date(NOW - 3 * DAY), lines: [{ scheduleId: "ms-A" }] });
    const inv = invoiceOf([m], { balanceDue: "100.00", progressBillings: [pb1, pb2] });
    const r = computeInvoiceReceivable(inv, NOW);
    assert.equal(r.items.length, 1);
    assert.equal(r.receivableCents, 10_000);
    assert.equal(r.items[0].requested, true); // OR'd in from pb2's evidence
    assert.equal(r.items[0].progressBillingCode, "PB-001, PB-002");
});

test("F1 (design review): a covered milestone with its own live QBO link still counts once", () => {
    const m = milestone({ id: "ms-A", amount: "100.00", qbInvoiceId: "qb-own", qbSyncedAt: new Date(NOW - 8 * DAY) });
    const pb = progressBilling({ lines: [{ scheduleId: "ms-A" }] });
    const inv = invoiceOf([m], { balanceDue: "100.00", progressBillings: [pb] });
    const r = computeInvoiceReceivable(inv, NOW);
    assert.equal(r.items.length, 1);
    assert.equal(r.receivableCents, 10_000);
});

test("E19: a CO milestone counts only after it is sent, not merely when billed", () => {
    const notSent = milestone({ name: "CO-00019 — Added Items", amount: "1000.00" });
    const before = computeInvoiceReceivable(invoiceOf([notSent]), NOW);
    assert.equal(before.receivableCents, 0);

    const sent = milestone({ name: "CO-00019 — Added Items", amount: "1000.00", qbInvoiceSentAt: new Date(NOW - 1 * DAY) });
    const after = computeInvoiceReceivable(invoiceOf([sent]), NOW);
    assert.equal(after.receivableCents, 100_000);
});

test("E20 (design review F5): a zero-milestone non-Draft invoice counts its whole balanceDue once, requested only if it has evidence of being sent", () => {
    const issueDate = new Date(NOW - 10 * DAY);
    const inv = invoiceOf([], { status: "Issued", balanceDue: "500.00", milestoneCount: 0, issueDate, sentAt: null });
    const r = computeInvoiceReceivable(inv, NOW);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].kind, "legacyInvoice");
    assert.equal(r.items[0].cents, 50_000);
    assert.equal(r.items[0].billedAt.getTime(), issueDate.getTime());
    // No milestone to carry qbInvoiceSentAt, and sentAt is null here: there
    // is no evidence this was ever emailed, so it can't claim requested:true.
    assert.equal(r.items[0].requested, false);
    assert.equal(r.notRequestedCents, 50_000);
});

test("E21: a zero-milestone Draft invoice reports zero — the legacy branch requires non-Draft (INV-00135 shape)", () => {
    const inv = invoiceOf([], { status: "Draft", balanceDue: "23750.95", milestoneCount: 0 });
    const r = computeInvoiceReceivable(inv, NOW);
    assert.equal(r.receivableCents, 0);
    assert.equal(r.unbilledCents, 0);
});

test("E22: milestoneCount 2 (both Paid) never falls into the legacy zero-milestone branch, even with a drifted balance", () => {
    const m1 = milestone({ status: "Paid", amount: "5.00" });
    const m2 = milestone({ status: "Paid", amount: "5.00" });
    const inv = invoiceOf([m1, m2], { balanceDue: "10.00", milestoneCount: 2 });
    const r = computeInvoiceReceivable(inv, NOW);
    assert.equal(r.receivableCents, 0);
    assert.ok(r.items.every(it => it.kind !== "legacyInvoice"));
});

test("E23: a Draft parent with a requested milestone still counts that milestone", () => {
    const m = milestone({ amount: "500.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY) });
    const inv = invoiceOf([m], { status: "Draft" });
    const r = computeInvoiceReceivable(inv, NOW);
    assert.equal(r.receivableCents, 50_000);
});

test("E24: cents are summed per item, not from a float total — avoids 0.1+0.2 drift", () => {
    const sentAt = new Date(NOW - 5 * DAY);
    const m1 = milestone({ amount: "0.10", qbInvoiceSentAt: sentAt });
    const m2 = milestone({ amount: "0.20", qbInvoiceSentAt: sentAt });
    const m3 = milestone({ amount: { toString: () => "4651.20" }, qbInvoiceSentAt: sentAt });
    const r = computeInvoiceReceivable(invoiceOf([m1, m2, m3]), NOW);
    assert.equal(r.receivableCents, 465_150);
});

test("E25: three requested milestones of 13447.68 sum to the exact cent total", () => {
    const sentAt = new Date(NOW - 5 * DAY);
    const ms = [1, 2, 3].map(() => milestone({ amount: "13447.68", qbInvoiceSentAt: sentAt }));
    const r = computeInvoiceReceivable(invoiceOf(ms), NOW);
    assert.equal(r.receivableCents, 4_034_304);
});

test("E26 (design review C3): unbilled backlog is the sum of unbilled Pending milestones, not balanceDue minus receivable", () => {
    // balanceDue is deliberately drifted from Σ Pending: the two milestones
    // below total 800.00, but balanceDue claims 950.00 (a stale total, a
    // rounding bug elsewhere — the cause doesn't matter). The old subtraction
    // (950.00 - 300.00 receivable = 650.00) would have silently folded that
    // 150.00 of drift into "backlog" too.
    const unbilled = milestone({ amount: "500.00" }); // no billing evidence at all: backlog
    const billed = milestone({ amount: "300.00", qbInvoiceSentAt: new Date(NOW - 5 * DAY) }); // requested: receivable
    const inv = invoiceOf([unbilled, billed], { balanceDue: "950.00" });
    const r = computeInvoiceReceivable(inv, NOW);
    assert.equal(r.receivableCents, 30_000); // the requested milestone only
    // Exactly the one truly-unbilled milestone's amount (500.00) — NOT
    // 95000 - 30000 = 65000, which is what subtraction would have given.
    assert.equal(r.unbilledCents, 50_000);
});

test("F3 (design review): half-cent amounts round the same way the currency formatter would", () => {
    const sentAt = new Date(NOW - 1 * DAY);
    const cases = [
        { amount: 1.005, expectedCents: 101, label: "1.005 (number)" },
        { amount: "1.005", expectedCents: 101, label: '"1.005" (string)' },
        { amount: 2.675, expectedCents: 268, label: "2.675 (number)" },
        { amount: "0.125", expectedCents: 13, label: '"0.125" (string)' },
        { amount: { toString: () => "9.995" }, expectedCents: 1_000, label: "Decimal-like object (carries into the next dollar)" },
        { amount: 42, expectedCents: 4_200, label: "whole number" },
        { amount: "1234567.895", expectedCents: 123_456_790, label: "large value" },
    ];
    for (const { amount, expectedCents, label } of cases) {
        const m = milestone({ amount, qbInvoiceSentAt: sentAt });
        const r = computeInvoiceReceivable(invoiceOf([m]), NOW);
        assert.equal(r.receivableCents, expectedCents, label);
    }
});

/**
 * listReceivables()/sendArDigest() behavioural coverage (ar-fix-spec.md §4.2).
 *
 * Loads the REAL src/lib/billing-core module under the scoped CJS require()
 * patch used by tests/deposit-sweep.test.ts (`mock.module()` is unusable here
 * — CI pins Node 20), with only Prisma, the email sender, and next/cache
 * faked. Everything else billing-core.ts imports (qbo-create-markers,
 * quickbooks, utils, co-tax, prisma-helpers, company-timezone, time-entry-void,
 * tx-retry) loads for real, unmocked.
 *
 * RED against current main: listReceivables() sums Invoice.balanceDue, which
 * counts scheduled-but-never-billed milestones as receivable (L1/L2 below fail
 * on unmodified source — see the commit body for the actual failing numbers).
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

type Row = Record<string, any>;

// ── Fixture loading (tests/fixtures/ar-digest-2026-09-21.json) ─────────────────

function loadAllFixtures(): Row[] {
    const raw = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "ar-digest-2026-09-21.json"), "utf8"));
    return raw.invoices as Row[];
}
const ALL_FIXTURES = loadAllFixtures();

function fixturesByCode(...codes: string[]): Row[] {
    return codes.map(code => {
        const inv = ALL_FIXTURES.find(i => i.code === code);
        if (!inv) throw new Error(`fixture ${code} not found`);
        return inv;
    });
}

function parseDate(s: string | null): Date | null {
    return s == null ? null : new Date(s);
}

/** Shapes one raw fixture invoice the way listReceivables()'s Prisma `select`
 *  (post-fix) expects to consume it: parsed Dates, Pending-only nested
 *  payments (mirroring the real `payments: { where: { status: "Pending" } }`),
 *  and a `_count.payments` covering every milestone regardless of status. */
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
        progressBillings: (raw.progressBillings ?? []) as Row[],
    };
}

// ── Fake Prisma + email spy ─────────────────────────────────────────────────

let fixtureRows: Row[] = [];
const findManyCalls: Row[] = [];
const sentEmails: Row[] = [];

const fakePrisma = {
    invoice: {
        findMany: async (args: Row) => {
            findManyCalls.push(args);
            return fixtureRows.map(toSelectShape);
        },
    },
    companySettings: {
        findUnique: async () => ({ notificationEmail: "team@example.test", email: null, companyName: "Test Co" }),
    },
};

async function fakeSendNotification(to: string, subject: string, html: string, _attachments?: unknown, options?: Row) {
    sentEmails.push({ to, subject, html, options });
    return { success: true, id: "fake-email-id" };
}

beforeEach(() => {
    fixtureRows = [];
    findManyCalls.length = 0;
    sentEmails.length = 0;
});

// ── Load billing-core under the patch ───────────────────────────────────────

let listReceivables: (now?: number) => Promise<Row>;
let sendArDigest: () => Promise<Row>;

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
        if (!patched.has(id)) throw new Error(`ar-digest-listing.test.ts: the mock of "${id}" never applied — billing-core would hit the real module`);
    }
    listReceivables = mod.listReceivables;
    sendArDigest = mod.sendArDigest;
});

// ── L1-L4 (spec §4.2) ────────────────────────────────────────────────────────

const NOW = Date.parse("2026-09-21T15:00:00.000Z");

test("L1: never-billed milestones report zero outstanding, not their scheduled amount", async () => {
    fixtureRows = fixturesByCode("INV-00319", "INV-00171");
    const ar = await listReceivables(NOW);
    assert.equal(ar.totalOutstanding, 0);
    assert.equal(ar.invoiceCount, 0);
    assert.equal(ar.overdueOutstanding, 0);
    assert.equal(ar.unbilledBacklog, 219_024);
});

test("L2: sendArDigest sends nothing when nothing is actually billed", async () => {
    fixtureRows = fixturesByCode("INV-00319", "INV-00171");
    const result = await sendArDigest();
    assert.equal(result.sent, false);
    assert.equal(result.reason, "nothing outstanding");
    assert.equal(sentEmails.length, 0);
});

test("L3: all 9 fixtures — totals, row order, and the email body", async () => {
    fixtureRows = ALL_FIXTURES;
    const ar = await listReceivables(NOW);
    assert.equal(ar.totalOutstanding, 17_414.18);
    assert.equal(ar.overdueOutstanding, 12_762.98);
    assert.equal(ar.invoiceCount, 4);
    assert.deepEqual(ar.invoices.map((r: Row) => r.code), ["INV-00172", "INV-00174", "INV-00169", "INV-00246"]);
    assert.equal(ar.unbilledBacklog, 283_450.60);

    const result = await sendArDigest();
    assert.equal(result.sent, true);
    assert.equal(sentEmails.length, 1);
    const html = sentEmails[0].html as string;
    assert.ok(html.includes("$17,414.18"), "email should show the new total");
    assert.ok(!html.includes("$189,800.00"), "email must not show the old unbilled figure");
    const notEmailedCount = html.split("not emailed from ProBuild").length - 1;
    assert.equal(notEmailedCount, 1, 'expected "not emailed from ProBuild" exactly once (INV-00172)');
});

test("L4: the recorded findMany args select enough columns to compute receivables and no longer exclude Draft (select tripwire)", async () => {
    fixtureRows = ALL_FIXTURES;
    await listReceivables(NOW);
    const args = findManyCalls[findManyCalls.length - 1];
    assert.deepEqual(args.where, { balanceDue: { gt: 0 }, status: { not: "Canceled" } });
    assert.equal(args.select?._count?.select?.payments, true);
    const paymentsSelect = args.select?.payments?.select ?? {};
    for (const field of ["qbInvoiceId", "qbInvoiceSentAt", "qbSyncError", "qbSyncedAt", "dueDate", "createdAt", "status"]) {
        assert.equal(paymentsSelect[field], true, `payments.select.${field} must be selected`);
    }
    assert.ok(args.select?.progressBillings?.select?.lines, "select.progressBillings.select.lines must be requested");
});

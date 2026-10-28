/**
 * Reverse booking against a REAL Postgres.
 *
 * tests/receipt-intake-reverse-booking.test.ts drives the core against an
 * in-memory fake. This file proves what a fake cannot: that the migrated
 * schema accepts REVERSED (the state CHECK), that the lock helpers' SQL runs,
 * that the expense really is deleted while its receipt row survives with
 * expenseId null, and that the partial unique index on dedupStrongKey still
 * holds a REVERSED row's key, so a re-sent copy of the same file cannot claim
 * it (while a VOID row would have let go of it).
 *
 * Opt-in by URL, like the other DB tests: it needs a THROWAWAY database and it
 * writes rows. The migrations CI job supplies RECEIPT_INTAKE_DB_TEST_URL.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { reverseReceiptBookingCore, REVERSED_STATE, type ReverseBookingDbClient } from "../src/lib/receipt-intake/reverse-booking";

const url = process.env.RECEIPT_INTAKE_DB_TEST_URL ?? process.env.MIGRATION_HISTORY_TEST_URL;
const looksLikeProd = !!url && /supabase\.(co|com)/i.test(url);
const skip = !url
    ? "set RECEIPT_INTAKE_DB_TEST_URL to a disposable PostgreSQL URL"
    : looksLikeProd
        ? "refusing to run against what looks like production"
        : false;

const db = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;

const P = "revbook-db";
const CLIENT = `${P}-client`;
const PROJECT = `${P}-project`;
const CODE = `${P}-code`;
const ESTIMATE = `${P}-estimate`;
const ITEM = `${P}-item`;
const INTAKE_EXPENSE = `${P}-exp-intake`;
const QBO_EXPENSE = `${P}-exp-qbo`;
const OTHER_EXPENSE = `${P}-exp-other`;
const INTAKE = `${P}-ri`;
const RESENT = `${P}-ri-resent`;
const STRONG_KEY = `${P}-strong-key`;
const actor = { id: null, email: "admin@example.test" };

async function cleanup() {
    await db!.receiptIntake.deleteMany({ where: { id: { in: [INTAKE, RESENT] } } });
    await db!.automationEvent.deleteMany({ where: { kind: "receipt-reversed", vendor: `${P} Vendor` } });
    await db!.expense.deleteMany({ where: { id: { in: [INTAKE_EXPENSE, QBO_EXPENSE, OTHER_EXPENSE] } } });
    await db!.estimateItem.deleteMany({ where: { id: ITEM } });
    await db!.estimate.deleteMany({ where: { id: ESTIMATE } });
    await db!.costCode.deleteMany({ where: { id: CODE } });
    await db!.project.deleteMany({ where: { id: PROJECT } });
    await db!.client.deleteMany({ where: { id: CLIENT } });
}

const intakeRow = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    source: "drive",
    sourceRef: `drive:${id}`,
    state: "RECEIVED",
    dryRun: false,
    storagePath: `receipts/intake/${id}.jpg`,
    mimeType: "image/jpeg",
    fileSize: 10,
    fileSha256: "a".repeat(64),
    ...over,
});

before(async () => {
    if (skip) return;
    await cleanup();
    await db!.client.create({ data: { id: CLIENT, name: "Reverse Booking DB", initials: "RB" } });
    await db!.project.create({ data: { id: PROJECT, name: "Reverse Booking DB", clientId: CLIENT, status: "In Progress" } });
    await db!.costCode.create({ data: { id: CODE, code: `${P}-03-PLUMB`, name: "Plumbing", isActive: true } });
    await db!.estimate.create({
        data: { id: ESTIMATE, title: "Reverse Booking DB", code: `EST-${P}`, projectId: PROJECT, status: "Approved", totalAmount: 5000, balanceDue: 5000 },
    });
    await db!.estimateItem.create({ data: { id: ITEM, estimateId: ESTIMATE, name: "rough-in", costCodeId: CODE } });
    // The receipt-intake copy, with a phase, and its BOOKED receipt row.
    await db!.expense.create({
        data: {
            id: INTAKE_EXPENSE, estimateId: ESTIMATE, projectId: PROJECT, costCodeId: CODE,
            amount: 250, vendor: `${P} Vendor`, status: "Pending", receiptUrl: "receipt-intake://x",
        },
    });
    // Its QuickBooks-import twin: same amount, no phase.
    await db!.expense.create({
        data: {
            id: QBO_EXPENSE, estimateId: ESTIMATE, projectId: PROJECT,
            amount: 250, vendor: `${P} Vendor`, status: "Reviewed", qbPurchaseId: `${P}-qb-1`, qbSyncToken: "1",
        },
    });
    await db!.expense.create({
        data: { id: OTHER_EXPENSE, estimateId: ESTIMATE, projectId: PROJECT, amount: 100, vendor: "Other", status: "Pending" },
    });
    await db!.receiptIntake.create({
        data: intakeRow(INTAKE, { state: "BOOKED", expenseId: INTAKE_EXPENSE, dedupStrongKey: STRONG_KEY, bookedAt: new Date() }),
    });
});

after(async () => {
    if (skip) return;
    await cleanup();
    await db!.$disconnect();
});

test("reverse a real BOOKED row: expense gone, row REVERSED, phase carried, job cost down", { skip }, async () => {
    const before = await db!.expense.aggregate({ where: { projectId: PROJECT }, _sum: { amount: true } });
    const result = await reverseReceiptBookingCore(db as unknown as ReverseBookingDbClient, {
        receiptIntakeId: INTAKE,
        expectedExpenseId: INTAKE_EXPENSE,
        expectedProjectId: PROJECT,
        reasonKind: "duplicate-of-qbo",
        keptExpenseId: QBO_EXPENSE,
        actor,
    });
    assert.equal(result.removedExpenseId, INTAKE_EXPENSE);
    assert.equal(result.phaseCarried, true);

    assert.equal(await db!.expense.findUnique({ where: { id: INTAKE_EXPENSE } }), null, "the expense is deleted");
    const after = await db!.expense.aggregate({ where: { projectId: PROJECT }, _sum: { amount: true } });
    assert.equal(Number(before._sum.amount) - Number(after._sum.amount), 250, "job cost drops by exactly the amount");

    const row = await db!.receiptIntake.findUniqueOrThrow({ where: { id: INTAKE } });
    assert.equal(row.state, REVERSED_STATE);
    assert.equal(row.expenseId, null);
    assert.equal(row.dedupStrongKey, STRONG_KEY, "the dedup key is kept");
    assert.match(row.stateReason ?? "", /^reversed: duplicate of QuickBooks import /);

    // The kept QuickBooks import took the phase and the receipt file, nothing else.
    const kept = await db!.expense.findUniqueOrThrow({ where: { id: QBO_EXPENSE } });
    assert.equal(kept.costCodeId, CODE);
    // Rebuilt from the intake row's current storagePath, not copied.
    assert.equal(kept.receiptUrl, `receipt-intake://receipt-intake/receipts/intake/${INTAKE}.jpg`);
    assert.equal(Number(kept.amount), 250);
    assert.equal(kept.qbPurchaseId, `${P}-qb-1`);

    const events = await db!.automationEvent.findMany({ where: { kind: "receipt-reversed", vendor: `${P} Vendor` } });
    assert.equal(events.length, 1);
    assert.equal(JSON.parse(events[0].detail ?? "{}").expenseId, INTAKE_EXPENSE);
});

test("a second reversal of the same row is refused", { skip }, async () => {
    await assert.rejects(
        reverseReceiptBookingCore(db as unknown as ReverseBookingDbClient, {
            receiptIntakeId: INTAKE, expectedExpenseId: INTAKE_EXPENSE, expectedProjectId: PROJECT,
            reasonKind: "customer-payment", actor,
        }),
        /Only a booked receipt can be reversed/,
    );
});

test("a re-sent copy of the same file cannot claim the reversed row's strong key", { skip }, async () => {
    await assert.rejects(
        db!.receiptIntake.create({ data: intakeRow(RESENT, { dedupStrongKey: STRONG_KEY }) }),
        (error: unknown) => (error as { code?: string }).code === "P2002",
        "the partial unique index must reject a second live owner of the key",
    );
    // Contrast: had the row been VOID, the key would have been free.
    await db!.receiptIntake.update({ where: { id: INTAKE }, data: { state: "VOID" } });
    await db!.receiptIntake.create({ data: intakeRow(RESENT, { dedupStrongKey: STRONG_KEY }) });
    await db!.receiptIntake.delete({ where: { id: RESENT } });
    await db!.receiptIntake.update({ where: { id: INTAKE }, data: { state: REVERSED_STATE } });
});

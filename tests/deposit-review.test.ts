import assert from "node:assert/strict";
import test from "node:test";
import { toDepositReviewItem } from "@/lib/deposit-review";

test("toDepositReviewItem exposes review facts without trusting malformed extraction", () => {
    const item = toDepositReviewItem({
        id: "deposit-1",
        status: "unmatched",
        extracted: JSON.stringify({
            fileId: "drive-file-1",
            fileUrl: "https://drive.example/deposit.jpg",
            projectName: "Smith Kitchen",
            payerName: "Jane Smith",
            amount: 1250.5,
            checkDate: "2026-08-20",
            checkNumber: "1042",
        }),
        paymentScheduleId: null,
        qbPaymentId: null,
        officeTaskId: "task-1",
        attempts: 2,
        lastError: "no pending milestone matches $1250.5",
        createdAt: new Date("2026-08-20T12:00:00Z"),
        updatedAt: new Date("2026-08-20T12:01:00Z"),
    });

    assert.deepEqual(item, {
        id: "deposit-1",
        status: "unmatched",
        fileId: "drive-file-1",
        fileUrl: "https://drive.example/deposit.jpg",
        projectName: "Smith Kitchen",
        payerName: "Jane Smith",
        amountCents: 125050,
        checkDate: "2026-08-20",
        checkNumber: "1042",
        paymentScheduleId: null,
        candidate: null,
        source: null,
        qbPaymentId: null,
        officeTaskId: "task-1",
        attempts: 2,
        reason: "no pending milestone matches $1250.5",
        updatedAt: "2026-08-20T12:01:00.000Z",
    });
});

test("toDepositReviewItem fails closed on a corrupt or oversized extraction", () => {
    const common = {
        id: "deposit-2", status: "reconcile", paymentScheduleId: "schedule-2", qbPaymentId: null,
        officeTaskId: null, attempts: 8, lastError: "reconcile required",
        createdAt: new Date("2026-08-20T12:00:00Z"), updatedAt: new Date("2026-08-20T12:01:00Z"),
    };

    assert.deepEqual(toDepositReviewItem({ ...common, extracted: "not-json" }), {
        id: "deposit-2", status: "reconcile", fileId: null, fileUrl: null, projectName: null,
        payerName: null, amountCents: null, checkDate: null, checkNumber: null,
        paymentScheduleId: "schedule-2", candidate: null, source: null, qbPaymentId: null, officeTaskId: null, attempts: 8,
        reason: "reconcile required", updatedAt: "2026-08-20T12:01:00.000Z",
    });

    assert.equal(toDepositReviewItem({ ...common, extracted: JSON.stringify({ amount: 10 ** 100 }) }).amountCents, null);
});

test("the review projection names the matched milestone for a suggest-only bank row", async t => {
    const base = {
        id: "di-1",
        status: "proposed",
        extracted: JSON.stringify({ fileId: "bank:26236015002406", amount: 13447.68, checkDate: "2026-08-24", checkNumber: "26236015002406" }),
        paymentScheduleId: "sched-1",
        qbPaymentId: null,
        officeTaskId: null,
        attempts: 1,
        lastError: 'suggest-only: DEPOSIT_SWEEP_LIVE_APPLY is not "true"',
        createdAt: new Date("2026-08-26T00:00:00Z"),
        updatedAt: new Date("2026-08-26T00:00:00Z"),
    };

    await t.test("with the schedule joined, the candidate is human-readable", () => {
        const item = toDepositReviewItem({
            ...base,
            source: "bank",
            paymentSchedule: {
                name: "Rough In complete",
                invoice: { code: "INV-00173", project: { name: "Hoppe Hall Bath" } },
            },
        });
        assert.equal(item.candidate, '"Rough In complete" (Hoppe Hall Bath, INV-00173)');
        assert.equal(item.source, "bank");
        // The reason a human acts on was already projected; it stays.
        assert.match(String(item.reason), /suggest-only/);
        assert.equal(item.status, "proposed");
    });

    await t.test("without it, the candidate is null rather than a wrong answer", () => {
        const item = toDepositReviewItem(base);
        assert.equal(item.candidate, null);
        assert.equal(item.source, null, "a photo row carries no source");
    });

    await t.test("a milestone with no invoice or project still gets a name", () => {
        const item = toDepositReviewItem({
            ...base,
            paymentSchedule: { name: "Deposit", invoice: null },
        });
        assert.equal(item.candidate, '"Deposit"');
    });
});

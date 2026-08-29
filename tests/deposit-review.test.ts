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
        paymentScheduleId: "schedule-2", qbPaymentId: null, officeTaskId: null, attempts: 8,
        reason: "reconcile required", updatedAt: "2026-08-20T12:01:00.000Z",
    });

    assert.equal(toDepositReviewItem({ ...common, extracted: JSON.stringify({ amount: 10 ** 100 }) }).amountCents, null);
});

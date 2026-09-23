import assert from "node:assert/strict";
import test from "node:test";
import {
    QboManagedExpenseError,
    assertExpenseMutableOutsideQbo,
} from "../src/lib/qbo-expense-guard";
import { isReceiptBookedExpense } from "../src/lib/receipt-intake/booked-expense-rules";
import { ReceiptMoveRefusedError, isReceiptMoveRefusedError } from "../src/lib/receipt-intake/booked-expense";

test("manual expenses remain mutable while QBO imports are rejected", () => {
    assert.doesNotThrow(() => assertExpenseMutableOutsideQbo({ qbPurchaseId: null }));
    assert.throws(
        () => assertExpenseMutableOutsideQbo({ qbPurchaseId: "purchase-1" }),
        QboManagedExpenseError,
    );
});

test("isReceiptBookedExpense: the truth table", () => {
    assert.equal(isReceiptBookedExpense({ qbPurchaseId: null, receiptIntake: { id: "ri-1" } }), true);
    assert.equal(isReceiptBookedExpense({ qbPurchaseId: "p", receiptIntake: { id: "ri-1" } }), false);
    assert.equal(isReceiptBookedExpense({ qbPurchaseId: null, receiptIntake: null }), false);
});

test("isReceiptMoveRefusedError recognizes the error by name", () => {
    assert.equal(isReceiptMoveRefusedError(new ReceiptMoveRefusedError("nope")), true);
    // NAME-based, not instanceof: a same-named Error from a differently-loaded
    // copy of this module must still be recognized (the reason this file gives
    // for QboManagedExpenseError applies here too).
    const impostor = new Error("nope");
    impostor.name = "ReceiptMoveRefusedError";
    assert.equal(isReceiptMoveRefusedError(impostor), true);
    assert.equal(isReceiptMoveRefusedError(new Error("something else")), false);
    assert.equal(isReceiptMoveRefusedError(new QboManagedExpenseError()), false);
});

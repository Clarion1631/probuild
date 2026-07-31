import assert from "node:assert/strict";
import test from "node:test";
import {
    QboManagedExpenseError,
    assertExpenseMutableOutsideQbo,
} from "../src/lib/qbo-expense-guard";

test("manual expenses remain mutable while QBO imports are rejected", () => {
    assert.doesNotThrow(() => assertExpenseMutableOutsideQbo({ qbPurchaseId: null }));
    assert.throws(
        () => assertExpenseMutableOutsideQbo({ qbPurchaseId: "purchase-1" }),
        QboManagedExpenseError,
    );
});

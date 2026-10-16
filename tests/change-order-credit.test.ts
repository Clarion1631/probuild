/**
 * Credit (negative) change orders: the pure rules in src/lib/change-order-credit.ts.
 *
 * The parity block is the proof that shown = signed = billed to the cent: the credit's
 * cents use exactly the formula the editor, portal, PDF and send email display, and the
 * positive biller's formula would NOT (it lands a cent away for some negative values).
 * Fixture names are generic; the repo is public.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyCoTotal, coSignedAmount, coTaxRate } from "../src/lib/co-tax";
import {
    buildCreditTargets,
    coCreditCents,
    coCreditCostPlusError,
    coCreditNoEligibleMilestoneError,
    coCreditNoInvoiceError,
    coCreditScheduleRowsError,
    coCreditTargetIneligibleError,
    coCreditTargetNotOnInvoiceError,
    coCreditTooBigError,
    coZeroSubtotalError,
    creditIneligibleReason,
    creditTargetError,
    planCreditReduction,
    rankCreditMilestones,
    type CreditMilestoneInput,
} from "../src/lib/change-order-credit";

// ── Cents parity (brute force) ───────────────────────────────────────────────

const RATE_PERCENTS = [0, 6.5, 7, 8, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 9, 9.5, 10];
const LITERAL_RATES = [0, 0.065, 0.07, 0.08, 0.084, 0.085, 0.086, 0.087, 0.088, 0.089, 0.09, 0.095, 0.1];

/** The display formula, verbatim from the editor / portal / PDF / send email. */
function displayTaxCents(subtotalDollars: number, rate: number): number {
    const subtotal = Math.round(subtotalDollars * 100) / 100;
    const tax = Math.round(subtotal * rate * 100) / 100;
    return Math.round(tax * 100);
}

test("credit cents match the displayed tax and total for every cent from -$20,000.00 to -$0.01 at the app's rates", () => {
    const billingDivergence: Record<string, number> = {};
    for (const pct of RATE_PERCENTS) {
        // The rate exactly as the app derives it (8.8 -> 0.08800000000000001, not 0.088).
        const estimate = { taxExempt: false, taxRatePercent: pct };
        const rate = coTaxRate(estimate);
        let mismatches = 0;
        let firstMismatch: number | null = null;
        let diverged = 0;
        for (let c = -2_000_000; c <= -1; c++) {
            const dollars = c / 100;
            const credit = coCreditCents(dollars, rate);
            const shownTotalCents = Math.round(coSignedAmount(dollars, estimate) * 100);
            if (credit.pretaxCents !== c
                || credit.taxCents !== displayTaxCents(dollars, rate)
                || credit.totalCents !== shownTotalCents
                || credit.totalCents !== credit.pretaxCents + credit.taxCents) {
                mismatches++;
                firstMismatch ??= c;
            }
            // billChangeOrderInTx's formula for a positive CO.
            if (Math.round(c * rate) !== credit.taxCents) diverged++;
        }
        assert.equal(mismatches, 0, `${pct}%: first mismatch at ${firstMismatch} cents`);
        billingDivergence[String(pct)] = diverged;
    }
    // The positive biller's formula disagrees with the display on negatives at these rates,
    // which is why the credit path must not use it. 8.8% (the default) happens to agree.
    for (const pct of ["6.5", "7", "8.4", "8.5", "8.9", "9.5", "10"]) {
        assert.ok(billingDivergence[pct] > 0, `${pct}% expected divergence, got ${billingDivergence[pct]}`);
    }
    assert.equal(billingDivergence["8.8"], 0);
    assert.equal(billingDivergence["0"], 0);
});

test("credit cents match the display formula at the literal rates too", () => {
    for (const rate of LITERAL_RATES) {
        let mismatches = 0;
        for (let c = -2_000_000; c <= -1; c++) {
            const credit = coCreditCents(c / 100, rate);
            if (credit.taxCents !== displayTaxCents(c / 100, rate) || credit.totalCents !== c + credit.taxCents) mismatches++;
        }
        assert.equal(mismatches, 0, `rate ${rate}`);
    }
});

test("a known divergent value: -$19,999.45 at 10% is -$1,999.95 tax as displayed, not the biller's -$1,999.94", () => {
    const credit = coCreditCents(-19999.45, coTaxRate({ taxRatePercent: 10 }));
    assert.deepEqual(credit, { pretaxCents: -1_999_945, taxCents: -199_995, totalCents: -2_199_940 });
    assert.equal(Math.round(-1_999_945 * 0.1), -199_994, "the positive biller's formula lands a cent away");
});

test("a tax-exempt credit has +0 tax, never -0", () => {
    const credit = coCreditCents(-3020, coTaxRate({ taxExempt: true }));
    assert.ok(Object.is(credit.taxCents, 0));
    assert.deepEqual(credit, { pretaxCents: -302_000, taxCents: 0, totalCents: -302_000 });
});

// ── Worked example ───────────────────────────────────────────────────────────

test("worked example: -$3,020 at 8.8% comes off an $8,965.12 milestone to $5,679.36", () => {
    const credit = coCreditCents(-3020, coTaxRate({ taxRatePercent: 8.8 }));
    assert.deepEqual(credit, { pretaxCents: -302_000, taxCents: -26_576, totalCents: -328_576 });

    const legacy = planCreditReduction({ name: "Final", amount: 8965.12 }, credit);
    assert.equal(legacy.fits, true);
    assert.equal(legacy.amountCents, 896_512);
    assert.equal(legacy.newAmountCents, 567_936);
    assert.deepEqual(legacy.after, { pretaxCents: null, taxCents: null }, "a legacy row changes amount only");

    const split = planCreditReduction({ name: "Final", amount: 8965.12, pretaxAmount: 8240, taxAmount: 725.12 }, credit);
    assert.equal(split.newAmountCents, 567_936);
    assert.deepEqual(split.before, { pretaxCents: 824_000, taxCents: 72_512 });
    assert.deepEqual(split.after, { pretaxCents: 522_000, taxCents: 45_936 });
});

// ── Eligibility ──────────────────────────────────────────────────────────────

function milestone(overrides: Partial<CreditMilestoneInput> = {}): CreditMilestoneInput {
    return {
        id: "ms-final", name: "Final", invoiceId: "inv-1", amount: 8965.12, pretaxAmount: null, taxAmount: null, status: "Pending",
        qbInvoiceId: null, qbSyncError: null, qbInvoiceSentAt: null, lastReminderAt: null,
        stripeSessionId: null, stripePaymentIntentId: null, paidAt: null,
        sourceChangeOrderId: null, sourceCoScheduleId: null, sourceScheduleId: null, coBilling: null,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        ...overrides,
    };
}

test("an untouched Pending milestone is eligible", () => {
    assert.equal(creditIneligibleReason(milestone()), null);
});

test("every eligibility field refuses on its own, with a reason", () => {
    const at = new Date("2026-09-10T00:00:00.000Z");
    const cases: Array<[Partial<CreditMilestoneInput>, RegExp]> = [
        [{ status: "Paid" }, /it is Paid/],
        [{ status: "Canceled" }, /it is Canceled/],
        [{ qbInvoiceId: "qb-1" }, /already in QuickBooks/],
        [{ qbSyncError: "voided" }, /QuickBooks marker/],
        [{ qbInvoiceSentAt: at }, /already sent to the customer/],
        [{ lastReminderAt: at }, /reminder/],
        [{ stripeSessionId: "cs_1" }, /payment is in progress/],
        [{ stripePaymentIntentId: "pi_1" }, /payment is in progress/],
        [{ paidAt: at }, /payment recorded/],
        [{ sourceChangeOrderId: "co-9" }, /another change order/],
        [{ sourceCoScheduleId: "cos-9" }, /another change order/],
        [{ coBilling: { id: "cob-9" } }, /another change order/],
    ];
    for (const [override, reason] of cases) {
        const why = creditIneligibleReason(milestone(override));
        assert.ok(why, `${JSON.stringify(override)} should be ineligible`);
        assert.match(why!, reason);
    }
});

// ── Ranking and default ──────────────────────────────────────────────────────

test("ranking follows the estimate schedule order, not creation order", () => {
    const rows = [
        milestone({ id: "b", name: "Final", sourceScheduleId: "eps-3", createdAt: "2026-09-01T00:00:00.000Z" }),
        milestone({ id: "c", name: "Deposit", sourceScheduleId: "eps-1", createdAt: "2026-09-01T00:00:00.000Z" }),
        milestone({ id: "a", name: "Cabinets", sourceScheduleId: "eps-2", createdAt: "2026-09-01T00:00:00.000Z" }),
    ];
    const order = new Map([["eps-1", 0], ["eps-2", 1], ["eps-3", 2]]);
    assert.deepEqual(rankCreditMilestones(rows, order).map((row) => row.name), ["Deposit", "Cabinets", "Final"]);
});

test("ties fall back to createdAt, then id", () => {
    const rows = [
        milestone({ id: "z", createdAt: "2026-09-02T00:00:00.000Z" }),
        milestone({ id: "y", createdAt: "2026-09-01T00:00:00.000Z" }),
        milestone({ id: "x", createdAt: "2026-09-01T00:00:00.000Z" }),
    ];
    assert.deepEqual(rankCreditMilestones(rows, new Map()).map((row) => row.id), ["x", "y", "z"]);
    // Same estimate order on two rows (clones made in one transaction): createdAt, then id.
    const tied = [
        milestone({ id: "q", sourceScheduleId: "eps-1", createdAt: "2026-09-01T00:00:00.000Z" }),
        milestone({ id: "p", sourceScheduleId: "eps-2", createdAt: "2026-09-01T00:00:00.000Z" }),
    ];
    assert.deepEqual(rankCreditMilestones(tied, new Map([["eps-1", 4], ["eps-2", 4]])).map((row) => row.id), ["p", "q"]);
});

test("the default target is the last eligible row, and stays the contract's Final when a later extra charge is eligible", () => {
    const credit = coCreditCents(-1000, 0.1);
    const rows = [
        milestone({ id: "ms-extra", name: "Extra charge", sourceScheduleId: null, createdAt: "2026-10-01T00:00:00.000Z" }),
        milestone({ id: "ms-final", name: "Final", sourceScheduleId: "eps-3", createdAt: "2026-09-01T00:00:00.000Z" }),
        milestone({ id: "ms-deposit", name: "Deposit", sourceScheduleId: "eps-1", createdAt: "2026-09-01T00:00:00.000Z" }),
    ];
    const order = new Map([["eps-1", 0], ["eps-3", 2]]);
    const targets = buildCreditTargets(rows, order, credit);
    assert.deepEqual(targets.rows.map((row) => row.name), ["Extra charge", "Deposit", "Final"]);
    assert.equal(targets.defaultId, "ms-final");
});

test("an ineligible last row is skipped for the default; no eligible row means no default", () => {
    const credit = coCreditCents(-1000, 0.1);
    const order = new Map([["eps-1", 0], ["eps-2", 1]]);
    const rows = [
        milestone({ id: "ms-1", name: "Deposit", sourceScheduleId: "eps-1" }),
        milestone({ id: "ms-2", name: "Final", sourceScheduleId: "eps-2", qbInvoiceSentAt: new Date() }),
    ];
    const targets = buildCreditTargets(rows, order, credit);
    assert.equal(targets.defaultId, "ms-1");
    assert.equal(targets.rows.find((row) => row.id === "ms-2")!.eligible, false);

    const none = buildCreditTargets([milestone({ status: "Paid" })], new Map(), credit);
    assert.equal(none.defaultId, null);
});

// ── Fit ──────────────────────────────────────────────────────────────────────

test("a credit equal to the milestone is refused; one cent smaller fits", () => {
    const credit = coCreditCents(-1000, 0.1); // -$1,100.00 incl. tax
    const equal = planCreditReduction({ name: "Final", amount: 1100 }, credit);
    assert.equal(equal.fits, false);
    assert.equal(equal.newAmountCents, 0);
    assert.equal(equal.reason, "The credit ($1,100.00 incl. tax) is not smaller than Final ($1,100.00). Pick a larger unpaid milestone.");
    assert.equal(planCreditReduction({ name: "Final", amount: 1100.01 }, credit).fits, true);
    assert.equal(planCreditReduction({ name: "Final", amount: 500 }, credit).fits, false);
});

test("a split row refuses a credit that would push its pretax to zero or its tax below zero", () => {
    const credit = coCreditCents(-1000, 0.1); // pretax -100000, tax -10000
    // Tax-exempt milestone: amount fits, but its tax would go negative and QuickBooks gets the split verbatim.
    const exempt = planCreditReduction({ name: "Final", amount: 5000, pretaxAmount: 5000, taxAmount: 0 }, credit);
    assert.equal(exempt.fits, false);
    assert.match(exempt.reason!, /credit's tax \(\$100\.00\) is more than the tax on Final \(\$0\.00\)/);
    // Pretax exactly consumed while tax keeps the amount positive: still refused.
    const pretax = planCreditReduction({ name: "Final", amount: 1200, pretaxAmount: 1000, taxAmount: 200 }, credit);
    assert.equal(pretax.fits, false);
    assert.match(pretax.reason!, /not smaller than Final/);
    // The same amounts on a legacy row (no split) fit.
    assert.equal(planCreditReduction({ name: "Final", amount: 1200 }, credit).fits, true);
});

// ── Refusal text ─────────────────────────────────────────────────────────────

test("target refusals: no invoice, nothing eligible, not on the invoice, ineligible, too big", () => {
    const credit = coCreditCents(-1000, 0.1);
    const targets = { invoice: { code: "INV-00001" }, ...buildCreditTargets([
        milestone({ id: "ms-paid", name: "Deposit", status: "Paid" }),
        milestone({ id: "ms-small", name: "Tile", amount: 500, createdAt: "2026-09-02T00:00:00.000Z" }),
        milestone({ id: "ms-final", name: "Final", amount: 8965.12, createdAt: "2026-09-03T00:00:00.000Z" }),
    ], new Map(), credit) };

    assert.equal(creditTargetError("CO-00001", targets, null), null, "the default (Final) fits");
    assert.equal(creditTargetError("CO-00001", targets, "ms-final"), null);
    assert.equal(creditTargetError("CO-00001", { invoice: null, rows: [], defaultId: null }, null), coCreditNoInvoiceError("CO-00001"));
    assert.equal(
        creditTargetError("CO-00001", { invoice: { code: "INV-00001" }, rows: [], defaultId: null }, null),
        coCreditNoEligibleMilestoneError("CO-00001", "INV-00001"),
    );
    assert.equal(creditTargetError("CO-00001", targets, "ms-elsewhere"), coCreditTargetNotOnInvoiceError("INV-00001"));
    assert.equal(creditTargetError("CO-00001", targets, "ms-paid"), coCreditTargetIneligibleError("Deposit", "it is Paid"));
    assert.equal(creditTargetError("CO-00001", targets, "ms-small"), coCreditTooBigError(-110_000, "Tile", 50_000));
});

test("the shared refusal strings read plainly", () => {
    assert.equal(coZeroSubtotalError("CO-00001"), "Change order CO-00001 has a $0 subtotal. Price it before it can be approved.");
    assert.match(coCreditScheduleRowsError("CO-00001"), /^Change order CO-00001 is a credit .* can't have a payment schedule/);
    assert.match(coCreditScheduleRowsError(), /^This change order is a credit/);
    assert.match(coCreditCostPlusError("CO-00001"), /cost-plus change order can't be a credit/);
    assert.equal(coCreditTooBigError(-328_576, "Final", 300_000), "The credit ($3,285.76 incl. tax) is not smaller than Final ($3,000.00). Pick a larger unpaid milestone.");
});

// ── classifyCoTotal ──────────────────────────────────────────────────────────

test("classifyCoTotal: a matching negative total is ok, $0 is unpriced", () => {
    assert.equal(classifyCoTotal(-3020, -3020, -3285.76, 1, 0), "ok");
    assert.equal(classifyCoTotal(0, 0, 0, 1, 0), "unpriced");
    assert.equal(classifyCoTotal(-3020, 0, 0, 1, 0), "unpriced");
    assert.equal(classifyCoTotal(-3020, -3020, -3285.76, 1, 0, "COST_PLUS"), "cost-plus");
});

/**
 * Job-cost variance rules (src/lib/job-variance.ts).
 *
 * This is money-path logic: if it is wrong, Justin makes bidding and staffing
 * decisions off a wrong number. The tests below encode the four product rules —
 * especially TRUST (never flatter a job) and AGENCY (never present a guess as a
 * measurement).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    computeProjectVariance,
    isLaborItem,
    type VarianceEstimateItem,
    type VarianceExpense,
    type VarianceTimeEntry,
} from "../src/lib/job-variance";

function item(over: Partial<VarianceEstimateItem> & { id: string; total: number }): VarianceEstimateItem {
    return {
        name: over.name ?? over.id,
        costCodeId: over.costCodeId ?? "cc-demo",
        costCode: over.costCode ?? { code: "01-DEMO", name: "Demolition" },
        costTypeName: over.costTypeName ?? "Material",
        type: over.type ?? null,
        ...over,
    } as VarianceEstimateItem;
}
const time = (o: Partial<VarianceTimeEntry>): VarianceTimeEntry =>
    ({ costCodeId: null, estimateItemId: null, laborCost: 0, burdenCost: 0, ...o });
const spend = (o: Partial<VarianceExpense>): VarianceExpense =>
    ({ costCodeId: null, itemId: null, amount: 0, ...o });

// ── labor vs material classification ────────────────────────────────────────

test("cost type decides labor; the legacy `type` string is the fallback", () => {
    assert.equal(isLaborItem({ costTypeName: "Labor", type: null }), true);
    assert.equal(isLaborItem({ costTypeName: "Material", type: "Labor" }), false, "costType must win");
    assert.equal(isLaborItem({ costTypeName: null, type: "Labor" }), true);
    assert.equal(isLaborItem({ costTypeName: null, type: null }), false);
});

// ── THE BUG THE OLD PAGE HAD ────────────────────────────────────────────────

test("EXPENSES COUNT AS ACTUAL COST — the old report ignored them and flattered every job", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 10000, costTypeName: "Material" })],
        timeEntries: [],
        expenses: [spend({ costCodeId: "cc-demo", amount: 12000 })],
    });
    // Old behaviour would have reported +$10,000 favourable. The truth is -$2,000.
    assert.equal(result.totalActual, 12000);
    assert.equal(result.variance, -2000);
    assert.equal(result.phases[0].actualMaterial, 12000);
});

test("labor and materials both roll into one job number", () => {
    const result = computeProjectVariance({
        items: [
            item({ id: "lab", total: 5000, costTypeName: "Labor" }),
            item({ id: "mat", total: 5000, costTypeName: "Material" }),
        ],
        timeEntries: [time({ costCodeId: "cc-demo", laborCost: 3000, burdenCost: 900 })],
        expenses: [spend({ costCodeId: "cc-demo", amount: 4000 })],
    });
    assert.equal(result.laborBudget, 5000);
    assert.equal(result.materialBudget, 5000);
    assert.equal(result.actualLabor, 3900, "burden is part of the real cost of labor");
    assert.equal(result.actualMaterial, 4000);
    assert.equal(result.variance, 10000 - 7900);
});

// ── sign convention (a wrong sign here is a catastrophic misread) ───────────

test("NEGATIVE variance means OVER budget", () => {
    const over = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [],
        expenses: [spend({ costCodeId: "cc-demo", amount: 1500 })],
    });
    assert.ok(over.variance < 0, "over budget must be negative");
    assert.equal(over.variance, -500);

    const under = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [],
        expenses: [spend({ costCodeId: "cc-demo", amount: 400 })],
    });
    assert.ok(under.variance > 0);
    assert.equal(under.variance, 600);
});

// ── item-level attribution: the whole point ─────────────────────────────────

test("cost linked to an estimate item lands on that item AND its phase", () => {
    const result = computeProjectVariance({
        items: [
            item({ id: "i1", total: 1000, name: "Bath fan" }),
            item({ id: "i2", total: 2000, name: "Panel swap" }),
        ],
        timeEntries: [time({ estimateItemId: "i1", costCodeId: "cc-demo", laborCost: 1200 })],
        expenses: [spend({ itemId: "i2", costCodeId: "cc-demo", amount: 500 })],
    });
    const phase = result.phases[0];
    const i1 = phase.items.find((i) => i.itemId === "i1")!;
    const i2 = phase.items.find((i) => i.itemId === "i2")!;
    assert.equal(i1.actual, 1200);
    assert.equal(i1.variance, -200, "i1 is over by 200");
    assert.equal(i2.actual, 500);
    assert.equal(i2.variance, 1500);
    assert.equal(phase.totalActual, 1700);
});

test("an item link implies its phase even when costCodeId was not sent", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000, costCodeId: "cc-frame", costCode: { code: "02-FRAME", name: "Framing" } })],
        timeEntries: [time({ estimateItemId: "i1", laborCost: 300 })],
        expenses: [],
    });
    assert.equal(result.coverage.unattributedLabor, 0, "must not be counted as unattributed");
    assert.equal(result.phases[0].code, "02-FRAME");
    assert.equal(result.phases[0].actualLabor, 300);
});

test("phase-coded actuals are NEVER allocated down onto items — they are flagged instead", () => {
    // AGENCY rule: spreading $900 across two items would invent per-item numbers
    // nobody measured, and the report would look complete when it is not.
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 }), item({ id: "i2", total: 1000 })],
        timeEntries: [time({ costCodeId: "cc-demo", laborCost: 900 })],
        expenses: [],
    });
    const phase = result.phases[0];
    assert.equal(phase.actualLabor, 900);
    for (const i of phase.items) {
        assert.equal(i.actual, 0, "no allocation onto items");
        assert.equal(i.phaseHasUnassignedActuals, true, "item rows must be marked as floors");
    }
    assert.equal(result.coverage.phaseOnlyActuals, 900);
});

test("when every actual IS item-linked, items are not flagged as floors", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [time({ estimateItemId: "i1", costCodeId: "cc-demo", laborCost: 900 })],
        expenses: [],
    });
    assert.equal(result.phases[0].items[0].phaseHasUnassignedActuals, false);
    assert.equal(result.coverage.phaseOnlyActuals, 0);
});

// ── coverage: the number that says how much to trust the rest ───────────────

test("unattributed spend is reported, never silently dropped or spread", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 10000 })],
        timeEntries: [time({ laborCost: 500 })],                 // no code, no item
        expenses: [spend({ amount: 1500 }), spend({ costCodeId: "cc-demo", amount: 2000 })],
    });
    assert.equal(result.coverage.unattributedLabor, 500);
    assert.equal(result.coverage.unattributedMaterial, 1500);
    assert.equal(result.coverage.unattributedTotal, 2000);
    // It still counts against the job total — the money WAS spent.
    assert.equal(result.totalActual, 4000);
    assert.equal(result.coverage.attributedShare, 0.5);
});

test("a job with no actuals at all reports full coverage, not divide-by-zero", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })], timeEntries: [], expenses: [],
    });
    assert.equal(result.coverage.attributedShare, 1);
    assert.equal(result.totalActual, 0);
    assert.equal(result.percentUsed, 0);
});

test("percentUsed is null (never Infinity/NaN) when there is no budget", () => {
    const result = computeProjectVariance({
        items: [], timeEntries: [time({ costCodeId: "cc-x", laborCost: 700 })], expenses: [],
    });
    assert.equal(result.percentUsed, null);
    assert.equal(result.phases[0].percentUsed, null);
    assert.ok(Number.isFinite(result.variance));
});

// ── uncoded budget = estimate cleanup, not a phase ──────────────────────────

test("uncodedPositiveBudget is GROSS, so a credit cannot net an uncoded hole away", () => {
    // A $6,000 uncoded charge and a $6,000 uncoded credit NET to zero. That is
    // the right answer for totalBudget (the job really does cost $1,000 net),
    // and the wrong answer for "how much of this estimate did we fail to code"
    // -- which is what the percent-complete trust gate asks. Netted, a
    // two-thirds-uncoded estimate reports as fully coded.
    const result = computeProjectVariance({
        items: [
            item({ id: "coded", total: 1000 }),
            item({ id: "uncoded-charge", total: 6000, costCodeId: null, costCode: null }),
            item({ id: "uncoded-credit", total: -6000, costCodeId: null, costCode: null }),
        ],
        timeEntries: [], expenses: [],
    });
    assert.equal(result.uncodedBudget, 0, "net is unchanged -- existing consumers must not move");
    assert.equal(result.uncodedPositiveBudget, 6000, "gross is what the trust gate needs");
    assert.equal(result.totalBudget, 1000);
});

test("an all-negative uncoded set reports zero gross, not a negative", () => {
    const result = computeProjectVariance({
        items: [
            item({ id: "coded", total: 1000 }),
            item({ id: "uncoded-credit", total: -500, costCodeId: null, costCode: null }),
        ],
        timeEntries: [], expenses: [],
    });
    assert.equal(result.uncodedBudget, -500);
    assert.equal(result.uncodedPositiveBudget, 0);
});

test("budget on an uncoded item is kept in the job total but NOT folded into a phase", () => {
    const result = computeProjectVariance({
        items: [
            item({ id: "coded", total: 1000 }),
            item({ id: "uncoded", total: 5000, costCodeId: null, costCode: null }),
        ],
        timeEntries: [], expenses: [],
    });
    assert.equal(result.uncodedBudget, 5000);
    assert.equal(result.uncodedPositiveBudget, 5000, "no credits here, so gross equals net");
    assert.equal(result.totalBudget, 6000, "the job still costs 6000 to build");
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].totalBudget, 1000, "uncoded money must not inflate a phase");
});

// ── unbudgeted work: the expensive surprise ─────────────────────────────────

test("actuals on a phase with NO budget surface as a full overrun, not a silent drop", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [],
        expenses: [spend({ costCodeId: "cc-surprise", amount: 3000 })],
    });
    const surprise = result.phases.find((p) => p.costCodeId === "cc-surprise")!;
    assert.equal(surprise.totalBudget, 0);
    assert.equal(surprise.totalActual, 3000);
    assert.equal(surprise.variance, -3000);
    assert.equal(surprise.name, "Unbudgeted phase");
    assert.equal(surprise.code, "N/A", "no label supplied -> degrades gracefully");
});

test("an unbudgeted phase is NAMED when a cost-code label is supplied", () => {
    // Otherwise the most surprising costs on a job are the least legible rows.
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [time({ costCodeId: "cc-surprise", laborCost: 400 })],
        expenses: [spend({ costCodeId: "cc-surprise", amount: 3000 })],
        costCodeLabels: new Map([["cc-surprise", { code: "21-PERMITS", name: "Permits & Inspections" }]]),
    });
    const surprise = result.phases.find((p) => p.costCodeId === "cc-surprise")!;
    assert.equal(surprise.code, "21-PERMITS");
    assert.equal(surprise.name, "Permits & Inspections");
    assert.equal(surprise.totalActual, 3400, "labor and materials both land on it");
});

test("a label for a BUDGETED phase never overrides the estimate's own cost code", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [],
        expenses: [spend({ costCodeId: "cc-demo", amount: 100 })],
        costCodeLabels: new Map([["cc-demo", { code: "WRONG", name: "Wrong" }]]),
    });
    assert.equal(result.phases[0].code, "01-DEMO");
});

// ── ordering: the report must open on the problem ───────────────────────────

test("phases sort worst-overrun first", () => {
    const result = computeProjectVariance({
        items: [
            item({ id: "a", total: 1000, costCodeId: "cc-a", costCode: { code: "01-A", name: "A" } }),
            item({ id: "b", total: 1000, costCodeId: "cc-b", costCode: { code: "02-B", name: "B" } }),
            item({ id: "c", total: 1000, costCodeId: "cc-c", costCode: { code: "03-C", name: "C" } }),
        ],
        timeEntries: [],
        expenses: [
            spend({ costCodeId: "cc-a", amount: 900 }),   // +100
            spend({ costCodeId: "cc-b", amount: 2500 }),  // -1500  worst
            spend({ costCodeId: "cc-c", amount: 1200 }),  // -200
        ],
    });
    assert.deepEqual(result.phases.map((p) => p.code), ["02-B", "03-C", "01-A"]);
    assert.deepEqual(result.phases[0].items.map((i) => i.itemId), ["b"]);
});

test("items within a phase also sort worst-first", () => {
    const result = computeProjectVariance({
        items: [
            item({ id: "ok", total: 5000 }),
            item({ id: "bad", total: 100 }),
        ],
        timeEntries: [],
        expenses: [spend({ itemId: "bad", costCodeId: "cc-demo", amount: 900 })],
    });
    assert.deepEqual(result.phases[0].items.map((i) => i.itemId), ["bad", "ok"]);
});

// ── arithmetic integrity ────────────────────────────────────────────────────

test("phase actuals plus unattributed always equal the job actual (nothing lost, nothing double-counted)", () => {
    const result = computeProjectVariance({
        items: [
            item({ id: "i1", total: 1000, costTypeName: "Labor" }),
            item({ id: "i2", total: 2000, costCodeId: "cc-frame", costCode: { code: "02-FRAME", name: "Framing" } }),
        ],
        timeEntries: [
            time({ estimateItemId: "i1", costCodeId: "cc-demo", laborCost: 400, burdenCost: 100 }),
            time({ costCodeId: "cc-frame", laborCost: 250 }),
            time({ laborCost: 75 }),
        ],
        expenses: [
            spend({ itemId: "i2", costCodeId: "cc-frame", amount: 1800 }),
            spend({ costCodeId: "cc-demo", amount: 300 }),
            spend({ amount: 125 }),
        ],
    });
    const phaseSum = result.phases.reduce((a, p) => a + p.totalActual, 0);
    assert.equal(phaseSum + result.coverage.unattributedTotal, result.totalActual);
    assert.equal(result.totalActual, 400 + 100 + 250 + 75 + 1800 + 300 + 125);
    assert.equal(result.variance, result.totalBudget - result.totalActual);
    for (const p of result.phases) {
        assert.equal(p.totalActual, p.actualLabor + p.actualMaterial);
        assert.equal(p.variance, p.totalBudget - p.totalActual);
    }
});

test("zero-dollar rows never create phantom phases or items", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [time({ costCodeId: "cc-ghost", laborCost: 0, burdenCost: 0 })],
        expenses: [spend({ costCodeId: "cc-ghost2", amount: 0 })],
    });
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].costCodeId, "cc-demo");
});

// ── review findings: item/phase mismatch (CRITICAL) ─────────────────────────

test("REVIEW BUG 1: a cost coded to phase A but linked to an item under phase B is not split across both", () => {
    // Found in peer review. The explicit costCodeId won for the PHASE while the
    // item link won for the ITEM, so the money landed on phase A's total and on
    // an item sitting under phase B. That breaks the core invariant below and
    // silently clears the "floor" warning on an item nobody actually measured.
    const result = computeProjectVariance({
        items: [
            item({ id: "demoItem", total: 1000, costCodeId: "cc-demo", costCode: { code: "01-DEMO", name: "Demolition" } }),
            item({ id: "frameItem", total: 1000, costCodeId: "cc-frame", costCode: { code: "02-FRAME", name: "Framing" } }),
        ],
        // Mismatch: says phase FRAME, but the item belongs to phase DEMO.
        timeEntries: [time({ costCodeId: "cc-frame", estimateItemId: "demoItem", laborCost: 500 })],
        expenses: [spend({ costCodeId: "cc-frame", itemId: "demoItem", amount: 300 })],
    });

    // INVARIANT: every phase's actual must equal the sum of its own items'
    // actuals plus whatever is genuinely unassigned within that phase.
    for (const phase of result.phases) {
        const itemSum = phase.items.reduce((a, i) => a + i.actual, 0);
        assert.ok(
            itemSum <= phase.totalActual + 0.005,
            `phase ${phase.code}: items sum to ${itemSum} but phase actual is ${phase.totalActual}`
        );
    }
    // And the money must be counted exactly once overall.
    assert.equal(result.totalActual, 800);
});

test("REVIEW BUG 1b: a mismatched link never silently clears the floor warning", () => {
    const result = computeProjectVariance({
        items: [
            item({ id: "demoItem", total: 1000, costCodeId: "cc-demo", costCode: { code: "01-DEMO", name: "Demolition" } }),
            item({ id: "frameItem", total: 1000, costCodeId: "cc-frame", costCode: { code: "02-FRAME", name: "Framing" } }),
        ],
        timeEntries: [time({ costCodeId: "cc-frame", estimateItemId: "demoItem", laborCost: 500 })],
        expenses: [],
    });
    const frame = result.phases.find((p) => p.code === "02-FRAME")!;
    // The $500 sits on FRAME but on no FRAME item, so frameItem is a floor.
    assert.equal(frame.items.find((i) => i.itemId === "frameItem")!.phaseHasUnassignedActuals, true);
});

test("REVIEW BUG 4: negative expenses (refunds/credits) never push coverage outside 0..1", () => {
    // Expense.amount can be negative — refunds, credits, voided purchases.
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [],
        expenses: [
            spend({ amount: 900 }),                        // unattributed
            spend({ costCodeId: "cc-demo", amount: -800 }), // a refund nets the total down
        ],
    });
    assert.ok(result.coverage.attributedShare >= 0 && result.coverage.attributedShare <= 1,
        `attributedShare out of range: ${result.coverage.attributedShare}`);
});

test("REVIEW BUG 4b: a fully refunded job reports a sane coverage share", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [],
        expenses: [spend({ amount: 500 }), spend({ costCodeId: "cc-demo", amount: -500 })],
    });
    // totalActual nets to 0 — must not divide by zero or emit Infinity.
    assert.ok(Number.isFinite(result.coverage.attributedShare));
    assert.ok(result.coverage.attributedShare >= 0 && result.coverage.attributedShare <= 1);
});

test("a refund reduces the phase actual rather than being dropped", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [],
        expenses: [
            spend({ costCodeId: "cc-demo", amount: 900 }),
            spend({ costCodeId: "cc-demo", amount: -200 }),
        ],
    });
    assert.equal(result.phases[0].actualMaterial, 700, "a credit must net against the phase");
    assert.equal(result.variance, 300);
});

// ── review findings 4-7: coverage honesty ───────────────────────────────────

test("REVIEW BUG 4c: a net-zero job from refunds does NOT report 100% attributed", () => {
    // The old guard fell through to 1 ("Trustworthy") on data that was 0% placed.
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [],
        expenses: [spend({ amount: 500 }), spend({ amount: -500 })], // both UNattributed
    });
    assert.equal(result.coverage.attributedShare, 0,
        "no dollars were attributed, so coverage must be 0 — not 1");
});

test("REVIEW BUG 4d: signed refunds cannot inflate coverage above the real share", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [],
        expenses: [spend({ amount: 500 }), spend({ costCodeId: "cc-demo", amount: -400 })],
    });
    // Absolute dollars moved: 500 unattributed + 400 attributed.
    assert.ok(Math.abs(result.coverage.attributedShare - 400 / 900) < 1e-9,
        `expected ~0.444, got ${result.coverage.attributedShare}`);
});

test("REVIEW BUG 5: a phase with a NEGATIVE budget is flagged, not silently blanked", () => {
    const result = computeProjectVariance({
        items: [
            item({ id: "i1", total: 400 }),
            item({ id: "credit", total: -500 }), // a discount/credit line
        ],
        timeEntries: [],
        expenses: [spend({ costCodeId: "cc-demo", amount: 100 })],
    });
    const phase = result.phases[0];
    assert.ok(phase.totalBudget < 0);
    assert.equal(phase.percentUsed, null);
    assert.equal(phase.hasNegativeBudget, true, "UI needs this to explain the missing % used");
});

test("a normal phase is never flagged as having a negative budget", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [], expenses: [spend({ costCodeId: "cc-demo", amount: 100 })],
    });
    assert.equal(result.phases[0].hasNegativeBudget, false);
});

test("REVIEW BUG 7: an unreadable amount is COUNTED and reported, never treated as $0 spend", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [time({ costCodeId: "cc-demo", laborCost: Number.NaN, burdenCost: 0 })],
        expenses: [spend({ costCodeId: "cc-demo", amount: Number.NaN })],
    });
    assert.equal(result.coverage.malformedRows, 2, "both bad rows must be surfaced");
    // And they must not poison the arithmetic.
    assert.ok(Number.isFinite(result.totalActual));
    assert.ok(Number.isFinite(result.variance));
});

test("clean data reports zero malformed rows", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [time({ costCodeId: "cc-demo", laborCost: 100 })],
        expenses: [spend({ costCodeId: "cc-demo", amount: 50 })],
    });
    assert.equal(result.coverage.malformedRows, 0);
});

// ── second review round (Kimi 3, post-deploy) ───────────────────────────────

test("KIMI 1: a NEGATIVE remainder does NOT flag items as floors", () => {
    // Regression on my own earlier fix. Math.abs() was added to catch float
    // residue in either direction, but a negative remainder means the ITEMS
    // account for more than the phase nets — they are fully attributed, and
    // flagging them warns about unmeasured money that does not exist.
    //
    // To drive the remainder negative the item-linked total must exceed the
    // phase total, so the phase carries a NON-item-linked refund: the phase nets
    // $100 while its one item accounts for $500.
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [],
        expenses: [
            spend({ costCodeId: "cc-demo", itemId: "i1", amount: 500 }), // on the item
            spend({ costCodeId: "cc-demo", amount: -400 }),              // phase-level refund
        ],
    });
    const phase = result.phases[0];
    const itemSum = phase.items.reduce((a, i) => a + i.actual, 0);
    assert.equal(phase.totalActual, 100);
    assert.equal(itemSum, 500);
    assert.ok(phase.totalActual - itemSum < 0, "precondition: the remainder is negative");
    assert.equal(phase.items[0].phaseHasUnassignedActuals, false,
        "items fully account for the phase — must NOT be marked as a floor");
});

test("a POSITIVE remainder still flags items as floors", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 1000 })],
        timeEntries: [],
        expenses: [
            spend({ costCodeId: "cc-demo", itemId: "i1", amount: 100 }),
            spend({ costCodeId: "cc-demo", amount: 400 }), // phase-only, no item
        ],
    });
    assert.equal(result.phases[0].items[0].phaseHasUnassignedActuals, true);
});

test("KIMI 2: gross unattributed is reported so the trust bar cannot contradict itself", () => {
    // A $1,000 uncoded charge plus a $1,000 uncoded refund NET to $0, which read
    // "$0 spent with no phase" right beside "0% attributed" — both true, and
    // flatly contradictory.
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 5000 })],
        timeEntries: [],
        expenses: [spend({ amount: 1000 }), spend({ amount: -1000 })],
    });
    assert.equal(result.coverage.unattributedTotal, 0, "net is genuinely zero");
    assert.equal(result.coverage.unattributedGross, 2000, "but $2,000 of activity was unplaced");
    assert.equal(result.coverage.attributedShare, 0, "and coverage correctly reads 0%");
});

test("gross and net unattributed agree when there are no refunds", () => {
    const result = computeProjectVariance({
        items: [item({ id: "i1", total: 5000 })],
        timeEntries: [],
        expenses: [spend({ amount: 300 }), spend({ costCodeId: "cc-demo", amount: 700 })],
    });
    assert.equal(result.coverage.unattributedTotal, 300);
    assert.equal(result.coverage.unattributedGross, 300);
});

test("an empty project produces zeros, not NaN", () => {
    const result = computeProjectVariance({ items: [], timeEntries: [], expenses: [] });
    for (const v of [result.totalBudget, result.totalActual, result.variance, result.uncodedBudget]) {
        assert.equal(v, 0);
    }
    assert.equal(result.phases.length, 0);
});

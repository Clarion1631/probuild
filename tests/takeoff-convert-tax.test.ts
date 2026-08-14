/**
 * Route-level test for POST /api/takeoffs/convert-to-estimate.
 *
 * takeoff-tax-split.test.ts pins the CONTRACT of splitTakeoffTax() in isolation, but the route
 * itself is where the double-tax fix actually has to hold: it's the route that decides what gets
 * PERSISTED (the Estimate row, its line items, and its payment schedules). A local mirror of the
 * math passing tells us nothing about whether the route wired the real values through correctly —
 * this test drives the actual POST handler against a mocked Prisma and asserts on what was written.
 *
 * `@/lib/prisma` is mocked ONCE at module scope (not per-test / not re-imported) because
 * re-registering the mock for the same specifier across multiple dynamic re-imports of the route
 * was observed to silently keep serving the FIRST test's mocked prisma object instead of a fresh
 * one — the route module doesn't seem to actually re-evaluate its `@/lib/prisma` import on a
 * cache-busted re-import. Instead, the fake Prisma's behavior reads from a single mutable `state`
 * object that each test overwrites before calling the (single, statically loaded) route handler.
 *
 * HOW THE MOCK IS APPLIED — and why this is a manual `Module.prototype.require` patch rather than
 * `node:test`'s own `mock.module()`, even though `--experimental-test-module-mocks` sounds like
 * exactly the built-in tool for this job:
 *
 * This suite passed locally (this workstation runs Node 24) on every run while failing in CI
 * (pinned to Node 20 — see .github/workflows/ci.yml) on every run, always with the same symptom:
 * `TypeError: POST is not a function` across all 15 tests. Reproducing CI's exact Node version
 * directly (not just "some Linux box" — Node 20.19.0 on a real Linux filesystem) isolated the
 * cause precisely:
 *
 *   - tsx compiles this test file (and the route it dynamically imports) to CommonJS —
 *     `typeof __dirname === "string"` at runtime here proves it — and route.ts's static
 *     `import { prisma } from "@/lib/prisma"` transpiles to a literal `require("@/lib/prisma")`
 *     call, alias text left untouched (tsx defers "@/..." alias resolution to its own require
 *     hook rather than rewriting the string at transform time). Confirmed by monkey-patching
 *     `Module.prototype.require` and logging every call made while importing the route.
 *   - `node:test`'s `mock.module()` does not merely fail to intercept that CJS `require()` call on
 *     Node 20 — calling it AT ALL (even wrapped in try/catch, even when its own registration call
 *     doesn't throw) corrupts something in the require chain such that a subsequent, otherwise-
 *     working manual `require()` patch for the same specifier stops taking effect too. Confirmed
 *     by an A/B run on Node 20.19.0: identical test file, only the `mock.module()` call present vs
 *     removed — present: all 15 fail with `POST is not a function`; removed (require-patch only):
 *     all 15 pass. Node 22+ does not exhibit this — `mock.module()` alone was already sufficient
 *     there, which is exactly why this was invisible on every local run.
 *
 * Given `mock.module()` is actively unsafe here on the Node version this repo's CI actually runs,
 * this file does not call it at all, and `--experimental-test-module-mocks` has been dropped from
 * `test:unit` in package.json (no other file in that script uses `mock.module` — verified by grep
 * across every file `test:unit` runs before making that change). The mock is instead a plain
 * `Module.prototype.require` override scoped to the exact literal specifier route.ts uses
 * ("@/lib/prisma"), restored immediately after the route's one-time synchronous load. This is
 * fully deterministic — it doesn't depend on any module resolver's notion of what "@/lib/prisma"
 * resolves to, only on Node's own `require()` dispatch, which both Node 20 and Node 22+ interpose
 * on. See `before()` below.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { derivedMarginPct } from "../src/lib/budget-math";

type CreateCall<T> = { data: T };

const calls = {
    estimateCreates: [] as CreateCall<any>[],
    estimateItemCreates: [] as CreateCall<any>[],
    estimatePaymentScheduleCreates: [] as CreateCall<any>[],
    takeoffUpdates: [] as CreateCall<any>[],
};

const state: { takeoff: any; companySettings: any } = { takeoff: null, companySettings: null };

function resetFixture() {
    calls.estimateCreates.length = 0;
    calls.estimateItemCreates.length = 0;
    calls.estimatePaymentScheduleCreates.length = 0;
    calls.takeoffUpdates.length = 0;
    state.takeoff = null;
    state.companySettings = null;
}

let estimateSeq = 0;
let itemSeq = 0;
let scheduleSeq = 0;

const fakePrisma = {
    takeoff: {
        findUnique: async () => state.takeoff,
        update: async (args: CreateCall<any>) => {
            calls.takeoffUpdates.push(args);
            return { ...state.takeoff, ...args.data };
        },
    },
    companySettings: {
        findUnique: async () => state.companySettings,
    },
    estimate: {
        create: async (args: CreateCall<any>) => {
            calls.estimateCreates.push(args);
            estimateSeq += 1;
            return { id: `est-${estimateSeq}`, ...args.data };
        },
    },
    estimateItem: {
        create: async (args: CreateCall<any>) => {
            calls.estimateItemCreates.push(args);
            itemSeq += 1;
            return { id: `item-${itemSeq}`, ...args.data };
        },
    },
    estimatePaymentSchedule: {
        create: async (args: CreateCall<any>) => {
            calls.estimatePaymentScheduleCreates.push(args);
            scheduleSeq += 1;
            return { id: `sched-${scheduleSeq}`, ...args.data };
        },
    },
};

// Top-level await isn't usable here (tsx transpiles this file to CJS), so the mock registration
// and the route's dynamic import both happen in `before()` instead; `POST` is populated by the
// time any test body runs.
let POST: (req: Request) => Promise<Response>;

// The literal specifier route.ts uses for its own `import { prisma } from "@/lib/prisma"` — see
// the file-header comment for why the mock below is keyed on this exact string (route.ts's own
// unresolved import text, confirmed by intercepting every require() call while loading it) rather
// than any path the test file itself computes for where it thinks that module lives.
const PRISMA_SPECIFIER = "@/lib/prisma";

before(async () => {
    // A manual CJS require() patch — see the file-header comment for why this replaces
    // node:test's own `mock.module()` entirely rather than supplementing it. Scoped narrowly to
    // the literal "@/lib/prisma" string so it can never shadow any other module, and restored in
    // `finally` immediately after the route's one-time synchronous load — everything the route
    // needs from prisma is captured into its closures at that moment, so nothing downstream
    // depends on the patch staying in place.
    const originalRequire = Module.prototype.require;
    let requirePatchHit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === PRISMA_SPECIFIER) {
            requirePatchHit = true;
            return { prisma: fakePrisma };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let routeModule: { POST?: unknown };
    try {
        routeModule = await import("../src/app/api/takeoffs/convert-to-estimate/route");
    } finally {
        Module.prototype.require = originalRequire;
    }

    // Loud, explicit guard: a mock that silently fails to apply must never again surface as 15
    // mysterious "POST is not a function" failures scattered across every test body. If the patch
    // above never actually reached route.ts's "@/lib/prisma" import, fail here, once, with the
    // exact specifier it was keyed on and whether the patch even fired.
    if (typeof routeModule.POST !== "function") {
        throw new Error(
            `takeoff-convert-tax.test.ts: mock of "${PRISMA_SPECIFIER}" did not apply — ` +
                `route module's POST export is ${typeof routeModule.POST}, not a function. ` +
                `The require() patch scoped to "${PRISMA_SPECIFIER}" ` +
                `${requirePatchHit ? "WAS" : "was NOT"} hit while importing ` +
                `"../src/app/api/takeoffs/convert-to-estimate/route". ` +
                `If this fires, the route's "@/lib/prisma" import is resolving to something other ` +
                `than the literal string "${PRISMA_SPECIFIER}" on this Node/tsx combination — ` +
                `update PRISMA_SPECIFIER (and the require() patch's match) to whatever it resolves ` +
                `to here instead of silently letting these tests fail downstream.`,
        );
    }
    POST = routeModule.POST as any;
});

beforeEach(() => {
    resetFixture();
});

function postRequest(takeoffId: string) {
    return new Request("http://localhost/api/takeoffs/convert-to-estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ takeoffId }),
    }) as any;
}

// --- canonical case: tax split applies -------------------------------------------------------

function canonicalTakeoff() {
    // aiData.totalEstimate deliberately drifts from the raw item sum (108450 vs 108400) — this is
    // the exact shape that exposes the milestone bug: milestones computed upstream against
    // totalEstimate, while the route now stores finalTotal (derived from the split), so trusting
    // the stored milestone amounts would leave the schedule not summing to the persisted total.
    const items = [
        { costCode: "01-DEMO", name: "Demo", total: 40000, unitCost: 40000, quantity: 1 },
        // baseCost + unitCost set deliberately unequal so the derived-margin assertion below can
        // tell the true-markup -> gross-margin conversion actually ran, rather than the item just
        // falling through to the 25% default.
        { costCode: "02-FRAME", name: "Frame", total: 35000, baseCost: 20000, unitCost: 35000, quantity: 2 },
        { costCode: "03-FINISH", name: "Finish", total: 25000, unitCost: 25000, quantity: 1 },
        { costCode: "99-TAX", name: "WA Sales Tax", total: 8400, unitCost: 8400, quantity: 1 },
    ];
    const aiEstimateData = {
        items,
        totalEstimate: 108450,
        paymentMilestones: [
            { name: "Deposit", percentage: "30", amount: "32535" },
            { name: "Progress", percentage: "40", amount: "43380" },
            { name: "Final", percentage: "30", amount: "32535" },
        ],
    };
    return {
        id: "takeoff-1",
        name: "Kitchen Remodel",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify(aiEstimateData),
    };
}

function canonicalCompanySettings() {
    return { salesTaxes: JSON.stringify([{ name: "Clark County WA", rate: 8.4 }]) };
}

test("canonical conversion: tax row stripped from line items, rate/name/total persisted correctly, milestones tie to the stored total", async () => {
    state.takeoff = canonicalTakeoff();
    state.companySettings = canonicalCompanySettings();

    const res = await POST(postRequest("takeoff-1"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    // No tax row reached EstimateItem.
    assert.equal(calls.estimateItemCreates.length, 3);
    for (const call of calls.estimateItemCreates) {
        assert.notEqual(call.data.name, "WA Sales Tax");
    }

    // Estimate.taxRatePercent / taxRateName as expected — exactly one configured tax matched 8.4%.
    assert.equal(calls.estimateCreates.length, 1);
    const estimateData = calls.estimateCreates[0].data;
    assert.equal(estimateData.taxRatePercent, 8.4);
    assert.equal(estimateData.taxRateName, "Clark County WA");

    // Estimate.totalAmount / balanceDue are the tax-INCLUSIVE total: preTaxSubtotal(100000) +
    // taxAmount(8400) = 108400 — NOT aiData.totalEstimate (108450), which was the AI's own
    // (drifted) tax-inclusive figure.
    assert.equal(estimateData.totalAmount, 108400);
    assert.equal(estimateData.balanceDue, 108400);

    // Payment schedule amounts sum EXACTLY to the persisted total, not to the stale
    // aiData-totalEstimate-based amounts (32535/43380/32535 -> 108450).
    assert.equal(calls.estimatePaymentScheduleCreates.length, 3);
    const amounts = calls.estimatePaymentScheduleCreates.map((c) => c.data.amount);
    const amountSum = amounts.reduce((s, a) => s + a, 0);
    assert.equal(Math.round(amountSum * 100) / 100, estimateData.totalAmount);
    assert.deepEqual(amounts, [32520, 43360, 32520]);
    const percentages = calls.estimatePaymentScheduleCreates.map((c) => c.data.percentage);
    assert.deepEqual(percentages, [30, 40, 30]);

    // Item monetary fields, not just count/name: the Frame row carries baseCost/unitCost that
    // imply a real margin, and must store derivedMarginPct(baseCost, unitCost) — NOT the 25%
    // default a broken conversion would silently fall back to.
    const frameCall = calls.estimateItemCreates.find((c) => c.data.name === "Frame");
    assert.ok(frameCall, "expected a Frame line item");
    assert.equal(frameCall!.data.quantity, 2);
    assert.equal(frameCall!.data.baseCost, 20000);
    assert.equal(frameCall!.data.unitCost, 35000);
    assert.equal(frameCall!.data.total, 35000);
    const expectedFrameMargin = derivedMarginPct(20000, 35000);
    assert.equal(frameCall!.data.markupPercent, expectedFrameMargin);
    assert.notEqual(expectedFrameMargin, 25); // proves this isn't just the default

    // The takeoff itself must be linked to the new estimate and marked Completed.
    assert.equal(calls.takeoffUpdates.length, 1);
    assert.equal(calls.takeoffUpdates[0].data.estimateId, "est-1");
    assert.equal(calls.takeoffUpdates[0].data.status, "Completed");
});

// --- bail-out case: no usable rate ------------------------------------------------------------

function bailOutTakeoff() {
    // Tax row implies a 40% rate — outside the (0, 30] trust bound — so splitTakeoffTax bails out
    // and the route must fall back to its pre-existing (legacy) behavior verbatim.
    const items = [
        { costCode: "01-DEMO", name: "Demo", total: 1000, unitCost: 1000, quantity: 1 },
        { costCode: "99-TAX", name: "Suspicious Tax Line", total: 400, unitCost: 400, quantity: 1 },
    ];
    const aiEstimateData = {
        items,
        totalEstimate: 1400,
        paymentMilestones: [{ name: "Payment in full", percentage: "100", amount: "1400" }],
    };
    return {
        id: "takeoff-2",
        name: "Small Job",
        projectId: null,
        leadId: "lead-1",
        aiEstimateData: JSON.stringify(aiEstimateData),
    };
}

test("bail-out path: tax row persists as a line item, taxRatePercent left unset, legacy milestone amounts kept", async () => {
    state.takeoff = bailOutTakeoff();

    const res = await POST(postRequest("takeoff-2"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    // The tax row is still a real line item.
    assert.equal(calls.estimateItemCreates.length, 2);
    assert.ok(calls.estimateItemCreates.some((c) => c.data.name === "Suspicious Tax Line"));

    // taxRatePercent / taxRateName were never set on the create payload.
    const estimateData = calls.estimateCreates[0].data;
    assert.equal("taxRatePercent" in estimateData, false);
    assert.equal("taxRateName" in estimateData, false);
    assert.equal(estimateData.totalAmount, 1400);

    // Legacy behavior: milestone amount/percentage read straight off the stored strings.
    assert.equal(calls.estimatePaymentScheduleCreates.length, 1);
    assert.equal(calls.estimatePaymentScheduleCreates[0].data.amount, 1400);
    assert.equal(calls.estimatePaymentScheduleCreates[0].data.percentage, 100);
});

// --- bail-out with a milestone split that does NOT tie to the total ---------------------------

function bailOutMismatchedMilestonesTakeoff() {
    // Same 40%-implied-rate bail-out shape as bailOutTakeoff, but the stored milestone
    // percentage/amount strings deliberately do NOT sum to the total. The bail-out path
    // deliberately does not recompute milestones (that's legacy, pre-existing behavior) — this
    // fixture proves it by making a naive recompute change the numbers if it ever ran.
    const items = [
        { costCode: "01-DEMO", name: "Demo", total: 1000, unitCost: 1000, quantity: 1 },
        { costCode: "99-TAX", name: "Suspicious Tax Line", total: 400, unitCost: 400, quantity: 1 },
    ];
    const aiEstimateData = {
        items,
        totalEstimate: 1400,
        paymentMilestones: [
            { name: "Deposit", percentage: "50", amount: "700.55" },
            { name: "Final", percentage: "50", amount: "800.10" },
        ],
    };
    return {
        id: "takeoff-3",
        name: "Mismatched Job",
        projectId: null,
        leadId: "lead-1",
        aiEstimateData: JSON.stringify(aiEstimateData),
    };
}

test("bail-out path: mismatched milestone amounts are preserved VERBATIM, not recomputed to tie", async () => {
    state.takeoff = bailOutMismatchedMilestonesTakeoff();

    const res = await POST(postRequest("takeoff-3"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    assert.equal(calls.estimatePaymentScheduleCreates.length, 2);
    const amounts = calls.estimatePaymentScheduleCreates.map((c) => c.data.amount);
    // Verbatim parseFloat of the stored strings — 700.55 + 800.10 = 1500.65, which does NOT equal
    // the estimate total (1400). That mismatch is the point: the bail-out path is documented to
    // leave milestones exactly as the legacy data had them.
    assert.deepEqual(amounts, [700.55, 800.1]);
    const sum = amounts.reduce((s, a) => s + a, 0);
    assert.notEqual(Math.round(sum * 100) / 100, calls.estimateCreates[0].data.totalAmount);
});

// --- zero-total tax row (explicitly untaxed, including on a bail-adjacent shape) ---------------

function zeroTaxTakeoff() {
    const items = [
        { costCode: "01-DEMO", name: "Demo", total: 40000, unitCost: 40000, quantity: 1 },
        { costCode: "99-TAX", name: "WA Sales Tax", total: 0, unitCost: 0, quantity: 1 },
    ];
    const aiEstimateData = {
        items,
        totalEstimate: 40000,
        paymentMilestones: [{ name: "Payment in full", percentage: "100", amount: "40000" }],
    };
    return {
        id: "takeoff-zero-tax",
        name: "Untaxed Job",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify(aiEstimateData),
    };
}

test("zero-total 99-TAX row: taxRatePercent persists as 0 (not absent), no tax line item, total is the pre-tax subtotal", async () => {
    state.takeoff = zeroTaxTakeoff();
    state.companySettings = null;

    const res = await POST(postRequest("takeoff-zero-tax"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    // The route's route-level conditions must use `!= null`, not truthiness — a truthy check
    // would treat a real `taxRatePercent: 0` the same as "no rate", silently reverting to the
    // legacy (tax-row-kept, no-rate) shape.
    assert.equal(calls.estimateItemCreates.length, 1);
    assert.ok(calls.estimateItemCreates.every((c) => c.data.name !== "WA Sales Tax"));

    const estimateData = calls.estimateCreates[calls.estimateCreates.length - 1].data;
    assert.equal("taxRatePercent" in estimateData, true);
    assert.equal(estimateData.taxRatePercent, 0);
    assert.equal(estimateData.totalAmount, 40000);
    assert.equal(estimateData.balanceDue, 40000);
});

// --- milestone residual absorption --------------------------------------------------------------

function residualMilestoneTakeoff() {
    // Three equal thirds of a total that doesn't divide evenly: 33.3333% each. Without the
    // last-milestone-absorbs-the-residual behavior, 33.33 + 33.33 + 33.33 = 99.99, four cents shy
    // of the 100 total below.
    const items = [
        { costCode: "01-DEMO", name: "Demo", total: 100, unitCost: 100, quantity: 1 },
        { costCode: "99-TAX", name: "WA Sales Tax", total: 0, unitCost: 0, quantity: 1 },
    ];
    const aiEstimateData = {
        items,
        totalEstimate: 100,
        paymentMilestones: [
            { name: "First", percentage: "33.3333", amount: "33.33" },
            { name: "Second", percentage: "33.3333", amount: "33.33" },
            { name: "Third", percentage: "33.3333", amount: "33.33" },
        ],
    };
    return {
        id: "takeoff-residual",
        name: "Residual Job",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify(aiEstimateData),
    };
}

test("milestone residual: an uneven three-way split still sums EXACTLY to the total", async () => {
    state.takeoff = residualMilestoneTakeoff();
    state.companySettings = null;

    const res = await POST(postRequest("takeoff-residual"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const estimateData = calls.estimateCreates[calls.estimateCreates.length - 1].data;
    assert.equal(estimateData.totalAmount, 100);

    const amounts = calls.estimatePaymentScheduleCreates.map((c) => c.data.amount);
    const sum = amounts.reduce((s, a) => s + a, 0);
    assert.equal(Math.round(sum * 100) / 100, 100);
    // The last milestone absorbs the rounding residual, so it is not simply "33.33" like the
    // other two.
    assert.deepEqual(amounts, [33.33, 33.33, 33.34]);
});

// --- percentage normalization -------------------------------------------------------------------

function nonNormalizedPercentageTakeoff() {
    // Percentages sum to 90, not 100 — must be normalized so both the stored percentages and the
    // resulting amounts sum correctly.
    const items = [
        { costCode: "01-DEMO", name: "Demo", total: 1000, unitCost: 1000, quantity: 1 },
        { costCode: "99-TAX", name: "WA Sales Tax", total: 0, unitCost: 0, quantity: 1 },
    ];
    const aiEstimateData = {
        items,
        totalEstimate: 1000,
        paymentMilestones: [
            { name: "Deposit", percentage: "20", amount: "200" },
            { name: "Progress", percentage: "30", amount: "300" },
            { name: "Final", percentage: "40", amount: "400" },
        ],
    };
    return {
        id: "takeoff-normalize",
        name: "Normalize Job",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify(aiEstimateData),
    };
}

test("milestone percentages that sum to 90 are normalized to sum to 100, amounts still sum to the total", async () => {
    state.takeoff = nonNormalizedPercentageTakeoff();
    state.companySettings = null;

    const res = await POST(postRequest("takeoff-normalize"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const estimateData = calls.estimateCreates[calls.estimateCreates.length - 1].data;
    assert.equal(estimateData.totalAmount, 1000);

    const percentages = calls.estimatePaymentScheduleCreates.map((c) => c.data.percentage);
    const percentageSum = Math.round(percentages.reduce((s, p) => s + p, 0) * 100) / 100;
    assert.equal(percentageSum, 100);
    assert.notDeepEqual(percentages, [20, 30, 40]);

    const amounts = calls.estimatePaymentScheduleCreates.map((c) => c.data.amount);
    const amountSum = Math.round(amounts.reduce((s, a) => s + a, 0) * 100) / 100;
    assert.equal(amountSum, 1000);
    assert.deepEqual(percentages, [22.22, 33.33, 44.45]);
    assert.deepEqual(amounts, [222.2, 333.3, 444.5]);
});

// --- zero milestones and a single milestone -----------------------------------------------------

function zeroMilestoneTakeoff() {
    const items = [
        { costCode: "01-DEMO", name: "Demo", total: 500, unitCost: 500, quantity: 1 },
        { costCode: "99-TAX", name: "WA Sales Tax", total: 0, unitCost: 0, quantity: 1 },
    ];
    const aiEstimateData = { items, totalEstimate: 500, paymentMilestones: [] };
    return {
        id: "takeoff-zero-milestones",
        name: "No Milestones Job",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify(aiEstimateData),
    };
}

test("zero milestones: no crash, no schedule rows created", async () => {
    state.takeoff = zeroMilestoneTakeoff();
    state.companySettings = null;

    const res = await POST(postRequest("takeoff-zero-milestones"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(calls.estimatePaymentScheduleCreates.length, 0);
});

function singleMilestoneTakeoff() {
    const items = [
        { costCode: "01-DEMO", name: "Demo", total: 500, unitCost: 500, quantity: 1 },
        { costCode: "99-TAX", name: "WA Sales Tax", total: 0, unitCost: 0, quantity: 1 },
    ];
    const aiEstimateData = {
        items,
        totalEstimate: 500,
        paymentMilestones: [{ name: "Payment in full", percentage: "100", amount: "500" }],
    };
    return {
        id: "takeoff-single-milestone",
        name: "One Milestone Job",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify(aiEstimateData),
    };
}

test("a single milestone gets the full total, no crash", async () => {
    state.takeoff = singleMilestoneTakeoff();
    state.companySettings = null;

    const res = await POST(postRequest("takeoff-single-milestone"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(calls.estimatePaymentScheduleCreates.length, 1);
    assert.equal(calls.estimatePaymentScheduleCreates[0].data.amount, 500);
    assert.equal(calls.estimatePaymentScheduleCreates[0].data.percentage, 100);
});

// --- salesTaxes Array.isArray guard --------------------------------------------------------------

function taxedTakeoffForNaming(id: string) {
    const items = [
        { costCode: "01-DEMO", name: "Demo", total: 10000, unitCost: 10000, quantity: 1 },
        { costCode: "99-TAX", name: "WA Sales Tax", total: 840, unitCost: 840, quantity: 1 },
    ];
    const aiEstimateData = {
        items,
        totalEstimate: 10840,
        paymentMilestones: [{ name: "Payment in full", percentage: "100", amount: "10840" }],
    };
    return {
        id,
        name: "Naming Job",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify(aiEstimateData),
    };
}

test("companySettings.salesTaxes of 'null' does not crash the conversion and names the rate 'Sales Tax'", async () => {
    state.takeoff = taxedTakeoffForNaming("takeoff-salestax-null");
    state.companySettings = { salesTaxes: "null" };

    const res = await POST(postRequest("takeoff-salestax-null"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const estimateData = calls.estimateCreates[calls.estimateCreates.length - 1].data;
    assert.equal(estimateData.taxRatePercent, 8.4);
    assert.equal(estimateData.taxRateName, "Sales Tax");
});

test("companySettings.salesTaxes of '{}' does not crash the conversion and names the rate 'Sales Tax'", async () => {
    state.takeoff = taxedTakeoffForNaming("takeoff-salestax-object");
    state.companySettings = { salesTaxes: "{}" };

    const res = await POST(postRequest("takeoff-salestax-object"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const estimateData = calls.estimateCreates[calls.estimateCreates.length - 1].data;
    assert.equal(estimateData.taxRatePercent, 8.4);
    assert.equal(estimateData.taxRateName, "Sales Tax");
});

// --- tax jurisdiction naming branches --------------------------------------------------------

test("ambiguous match: two configured taxes at the same derived rate names it 'Sales Tax', not either jurisdiction", async () => {
    state.takeoff = taxedTakeoffForNaming("takeoff-salestax-ambiguous");
    state.companySettings = {
        salesTaxes: JSON.stringify([
            { name: "Clark County WA", rate: 8.4 },
            { name: "Vancouver WA", rate: 8.4 },
        ]),
    };

    const res = await POST(postRequest("takeoff-salestax-ambiguous"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const estimateData = calls.estimateCreates[calls.estimateCreates.length - 1].data;
    assert.equal(estimateData.taxRatePercent, 8.4);
    assert.equal(estimateData.taxRateName, "Sales Tax");
});

test("a near-miss rate (8.409%) does NOT inherit a configured 8.4% jurisdiction's name (tight tolerance)", async () => {
    const items = [
        { costCode: "01-DEMO", name: "Demo", total: 100000, unitCost: 100000, quantity: 1 },
        { costCode: "99-TAX", name: "WA Sales Tax", total: 8409, unitCost: 8409, quantity: 1 },
    ];
    const aiEstimateData = {
        items,
        totalEstimate: 108409,
        paymentMilestones: [{ name: "Payment in full", percentage: "100", amount: "108409" }],
    };
    state.takeoff = {
        id: "takeoff-near-miss-rate",
        name: "Near Miss Job",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify(aiEstimateData),
    };
    state.companySettings = { salesTaxes: JSON.stringify([{ name: "Clark County WA", rate: 8.4 }]) };

    const res = await POST(postRequest("takeoff-near-miss-rate"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const estimateData = calls.estimateCreates[calls.estimateCreates.length - 1].data;
    assert.equal(estimateData.taxRatePercent, 8.409);
    // Old (0.01) tolerance would have matched Clark County WA here; the tightened (0.0001)
    // tolerance must not, since 8.409% genuinely is not Clark County's 8.4% rate.
    assert.equal(estimateData.taxRateName, "Sales Tax");
});

test("no match: a configured tax list with no matching rate names it 'Sales Tax'", async () => {
    state.takeoff = taxedTakeoffForNaming("takeoff-salestax-nomatch");
    state.companySettings = { salesTaxes: JSON.stringify([{ name: "Some Other County", rate: 6.5 }]) };

    const res = await POST(postRequest("takeoff-salestax-nomatch"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const estimateData = calls.estimateCreates[calls.estimateCreates.length - 1].data;
    assert.equal(estimateData.taxRatePercent, 8.4);
    assert.equal(estimateData.taxRateName, "Sales Tax");
});

// --- aiData.items Array.isArray guard, and the numOr'd legacy total fallback -------------------

test("a non-array aiData.items does not throw a 500 — falls back to zero items", async () => {
    const aiEstimateData = { items: "not-an-array", totalEstimate: 5000, paymentMilestones: [] };
    state.takeoff = {
        id: "takeoff-nonarray-items",
        name: "Malformed Job",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify(aiEstimateData),
    };
    state.companySettings = null;

    const res = await POST(postRequest("takeoff-nonarray-items"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(calls.estimateItemCreates.length, 0);
    assert.equal(calls.estimateCreates[calls.estimateCreates.length - 1].data.totalAmount, 5000);
});

test("the legacy totalEstimate fallback sums stringy totals numerically, not by string concatenation", async () => {
    // No aiData.totalEstimate at all, and no tax row (so the split bails and the route falls back
    // to summing raw item totals itself) — `"0" + "1000"` would concatenate to "01000" under the
    // old `i.total || 0` reducer; numOr must sum these as 1000 + 500 = 1500.
    const aiEstimateData = {
        items: [
            { costCode: "01-DEMO", name: "Demo", total: "1000", unitCost: "1000", quantity: 1 },
            { costCode: "02-FRAME", name: "Frame", total: "500", unitCost: "500", quantity: 1 },
        ],
        paymentMilestones: [],
    };
    state.takeoff = {
        id: "takeoff-stringy-totals",
        name: "Stringy Totals Job",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify(aiEstimateData),
    };
    state.companySettings = null;

    const res = await POST(postRequest("takeoff-stringy-totals"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const estimateData = calls.estimateCreates[calls.estimateCreates.length - 1].data;
    assert.equal(estimateData.totalAmount, 1500);
    assert.equal(typeof estimateData.totalAmount, "number");
});

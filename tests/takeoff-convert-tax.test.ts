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
    /** How many times the route opened an interactive transaction. */
    transactions: 0,
    /** `SELECT ... FOR UPDATE` row locks taken, in order. */
    rowLocks: [] as string[],
};

const state: {
    takeoff: any;
    /**
     * What `takeoff.findUnique` returns for the route's RE-READ inside the transaction, when that
     * must differ from the outer read (concurrent conversion / concurrent delete). `undefined`
     * means "same as `takeoff`"; `null` means the row is gone.
     */
    takeoffInTx: any;
    companySettings: any;
    /** Estimates the fake DB already holds, keyed by id — for the already-converted path. */
    estimates: Record<string, any>;
    /** When set, `estimateItem.create` throws on the Nth (1-based) call, mid-conversion. */
    failItemCreateOn: number | null;
} = { takeoff: null, takeoffInTx: undefined, companySettings: null, estimates: {}, failItemCreateOn: null };

function resetFixture() {
    calls.estimateCreates.length = 0;
    calls.estimateItemCreates.length = 0;
    calls.estimatePaymentScheduleCreates.length = 0;
    calls.takeoffUpdates.length = 0;
    calls.rowLocks.length = 0;
    calls.transactions = 0;
    ops.length = 0;
    state.takeoff = null;
    state.takeoffInTx = undefined;
    state.companySettings = null;
    state.estimates = {};
    state.failItemCreateOn = null;
}

let estimateSeq = 0;
let itemSeq = 0;
let scheduleSeq = 0;

/**
 * Every operation, in the order it happened, tagged with which client issued it.
 *
 * `via: "root"` means the operation went through the top-level `prisma` object; `via: "tx"` means
 * it went through the client the `$transaction` callback was handed. Those are DISTINCT objects in
 * this fake (as they are in real Prisma) precisely so that a write which calls `prisma.x.create()`
 * from inside the callback is caught: it is lexically "inside the transaction" but does NOT run in
 * it, and would not be rolled back.
 */
const ops: { op: string; via: "root" | "tx" }[] = [];

/** Ops issued through the root client — everything here escapes the transaction. */
function opsOutsideTx() {
    return ops.filter((o) => o.via === "root");
}

/**
 * One set of model methods, bound to a client identity. The root client and the transaction client
 * are two separate instances so the `via` tag is meaningful.
 */
function makeClient(via: "root" | "tx") {
    const record = (op: string) => ops.push({ op, via });
    return {
        takeoff: {
            findUnique: async () => {
                record("takeoff.findUnique");
                return via === "tx" && state.takeoffInTx !== undefined ? state.takeoffInTx : state.takeoff;
            },
            update: async (args: CreateCall<any>) => {
                record("takeoff.update");
                calls.takeoffUpdates.push(args);
                return { ...state.takeoff, ...args.data };
            },
        },
        companySettings: {
            findUnique: async () => {
                record("companySettings.findUnique");
                return state.companySettings;
            },
        },
        estimate: {
            create: async (args: CreateCall<any>) => {
                record("estimate.create");
                calls.estimateCreates.push(args);
                estimateSeq += 1;
                return { id: `est-${estimateSeq}`, ...args.data };
            },
            findUnique: async (args: { where: { id: string } }) => {
                record("estimate.findUnique");
                return state.estimates[args.where.id] ?? null;
            },
        },
        estimateItem: {
            // The route bulk-inserts; the fake fans the rows back out into the same per-row shape
            // the assertions below have always used.
            createMany: async (args: { data: any[] }) => {
                record("estimateItem.createMany");
                for (const row of args.data) {
                    calls.estimateItemCreates.push({ data: row });
                    itemSeq += 1;
                    if (state.failItemCreateOn != null && calls.estimateItemCreates.length === state.failItemCreateOn) {
                        throw new Error("simulated mid-conversion failure");
                    }
                }
                return { count: args.data.length };
            },
        },
        estimatePaymentSchedule: {
            createMany: async (args: { data: any[] }) => {
                record("estimatePaymentSchedule.createMany");
                for (const row of args.data) {
                    calls.estimatePaymentScheduleCreates.push({ data: row });
                    scheduleSeq += 1;
                }
                return { count: args.data.length };
            },
        },
        // Tagged-template call: `tx.$queryRaw`SELECT id FROM "Takeoff" WHERE id = ${id} FOR UPDATE``
        // arrives as (templateStrings, ...values). Record the joined SQL so a test can assert the
        // row lock is actually taken, and taken FIRST.
        // The route reads this result as its existence check, so the fake must answer honestly:
        // a row when the takeoff exists, nothing when it doesn't. Always returning `[]` (or always
        // returning a row) would make the missing-row branch untestable.
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            record("$queryRaw");
            calls.rowLocks.push(strings.join("?").trim() + ` [${values.join(",")}]`);
            const row = via === "tx" && state.takeoffInTx !== undefined ? state.takeoffInTx : state.takeoff;
            return row ? [{ id: values[0] }] : [];
        },
    };
}

const txClient = makeClient("tx");

const fakePrisma = {
    ...makeClient("root"),
    // The fake can't roll anything back, so tests assert on what the route ATTEMPTED: a failure
    // inside the callback must propagate (no partial commit is possible in the real DB because the
    // statements share one transaction) and must leave the later steps unexecuted.
    $transaction: async (fn: (tx: any) => Promise<any>) => {
        calls.transactions += 1;
        return await fn(txClient);
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

// --- marginPercentFor: negative-costing rows -------------------------------------------------

test("credit row: cost and price both negative derive the SAME margin the positive pair would", async () => {
    // No 99-TAX row, so splitTakeoffTax never runs and finalTotal falls back to the raw
    // totalEstimate — the only thing under test here is marginPercentFor's own branch, not the
    // tax split.
    const items = [{ costCode: "02-FRAME", name: "Credit Frame", total: -35000, baseCost: -20000, unitCost: -35000, quantity: 1 }];
    state.takeoff = {
        id: "takeoff-credit",
        name: "Credit Job",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify({
            items,
            totalEstimate: -35000,
            paymentMilestones: [{ name: "Refund", percentage: "100", amount: "-35000" }],
        }),
    };

    const res = await POST(postRequest("takeoff-credit"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    assert.equal(calls.estimateItemCreates.length, 1);
    const row = calls.estimateItemCreates[0].data;
    assert.equal(row.baseCost, -20000); // sign preserved on the stored cost/price themselves
    assert.equal(row.unitCost, -35000);
    // Same margin as the canonical positive Frame row (baseCost 20000, unitCost 35000) above —
    // flipping both signs before deriving must not change the implied margin.
    const expectedMargin = derivedMarginPct(20000, 35000);
    assert.equal(row.markupPercent, expectedMargin);
    assert.notEqual(row.markupPercent, 25); // proves this derived, rather than hit the default
});

test("mixed-sign cost/price (no stated markup) is genuinely underivable and stores 0%, not the fabricated default", async () => {
    const items = [{ costCode: "02-FRAME", name: "Mixed Sign Item", total: -1000, baseCost: 500, unitCost: -1000, quantity: 1 }];
    state.takeoff = {
        id: "takeoff-mixed",
        name: "Mixed Sign Job",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify({
            items,
            totalEstimate: -1000,
            paymentMilestones: [{ name: "Full", percentage: "100", amount: "-1000" }],
        }),
    };

    const res = await POST(postRequest("takeoff-mixed"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    assert.equal(calls.estimateItemCreates.length, 1);
    assert.equal(calls.estimateItemCreates[0].data.markupPercent, 0);
});

test("mixed-sign cost/price WITH a stated markupPercent still converts the stated markup, rather than jumping straight to 0", async () => {
    // markupPercent 25 (true markup) here converts to a 20% margin — proves the markup-conversion
    // branch is still consulted before the mixed-sign fallback, not bypassed by it.
    const items = [
        { costCode: "02-FRAME", name: "Mixed Sign With Markup", total: -1000, baseCost: 500, unitCost: -1000, quantity: 1, markupPercent: 25 },
    ];
    state.takeoff = {
        id: "takeoff-mixed-markup",
        name: "Mixed Sign Job With Markup",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify({
            items,
            totalEstimate: -1000,
            paymentMilestones: [{ name: "Full", percentage: "100", amount: "-1000" }],
        }),
    };

    const res = await POST(postRequest("takeoff-mixed-markup"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    assert.equal(calls.estimateItemCreates.length, 1);
    assert.equal(calls.estimateItemCreates[0].data.markupPercent, 20);
});

test("no costing data at all (no baseCost/unitCost pair, no stated markup) still defaults to 25% — unaffected by the negative-costing fix", async () => {
    const items = [{ costCode: "02-FRAME", name: "No Costing Data", total: 1000, quantity: 1 }];
    state.takeoff = {
        id: "takeoff-legacy",
        name: "Legacy Job",
        projectId: "project-1",
        leadId: null,
        aiEstimateData: JSON.stringify({
            items,
            totalEstimate: 1000,
            paymentMilestones: [{ name: "Full", percentage: "100", amount: "1000" }],
        }),
    };

    const res = await POST(postRequest("takeoff-legacy"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    assert.equal(calls.estimateItemCreates.length, 1);
    assert.equal(calls.estimateItemCreates[0].data.markupPercent, 25);
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

// --- atomicity ---------------------------------------------------------------------------------
//
// Before the fix, the four write groups (Estimate, its items, its schedules, the Takeoff link) ran
// as four independent statements. A failure partway through returned a 500 while leaving a
// complete, findable Estimate carrying real money with no payment schedules and no takeoff link.

test("every write happens inside ONE transaction, opened by locking the Takeoff row first", async () => {
    state.takeoff = canonicalTakeoff();
    state.companySettings = canonicalCompanySettings();

    const res = await POST(postRequest("takeoff-1"));
    assert.equal(res.status, 200, JSON.stringify(await res.json()));

    assert.equal(calls.transactions, 1, "expected exactly one interactive transaction");
    // NOTHING may go through the root prisma client — not the reads either. A read taken outside
    // the transaction is the stale-snapshot bug: the row it saw can change before the write lands.
    assert.deepEqual(opsOutsideTx(), [], "every operation must go through the transaction client");

    // The row lock must be the very FIRST operation. Ordering is the whole guarantee: if the
    // takeoff is read before it is locked, two requests can both read `estimateId = null`, then
    // serialize on the lock and each create an Estimate. Asserting "a lock happened" would not
    // catch that, so assert its POSITION.
    assert.equal(ops[0].op, "$queryRaw", `expected the row lock first, got: ${ops.map((o) => o.op).join(" -> ")}`);
    assert.equal(ops[1].op, "takeoff.findUnique", "the takeoff must be read only after the lock is held");
    assert.equal(calls.rowLocks.length, 1);
    assert.match(calls.rowLocks[0], /SELECT id FROM "Takeoff"[\s\S]*FOR UPDATE/);
    assert.match(calls.rowLocks[0], /\[takeoff-1\]/);

    // And the writes still all landed.
    assert.equal(calls.estimateCreates.length, 1);
    assert.equal(calls.estimateItemCreates.length, 3);
    assert.equal(calls.estimatePaymentScheduleCreates.length, 3);
    assert.equal(calls.takeoffUpdates.length, 1);
});

test("a failure mid-way through the line items aborts the whole conversion: no schedules, no takeoff link", async () => {
    state.takeoff = canonicalTakeoff();
    state.companySettings = canonicalCompanySettings();
    // Blow up on the 2nd of 3 line items — after the Estimate row was created, which is exactly
    // the window that used to leave an orphaned money document behind.
    state.failItemCreateOn = 2;

    const res = await POST(postRequest("takeoff-1"));
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error, "simulated mid-conversion failure");

    // Everything after the failure point must be unreached — in the real DB the transaction rolls
    // back, so the Estimate row attempted above never becomes visible either.
    assert.equal(calls.estimateItemCreates.length, 2);
    assert.equal(calls.estimatePaymentScheduleCreates.length, 0, "schedules must not be written after a failed item");
    assert.equal(calls.takeoffUpdates.length, 0, "takeoff must not be linked/Completed by a failed conversion");
    assert.deepEqual(opsOutsideTx(), []);
});

test("the estimate is built from the takeoff as it exists UNDER THE LOCK, not from an earlier read", async () => {
    // `state.takeoff` is what an un-locked read would have seen; `state.takeoffInTx` is the row as
    // it actually is once the lock is held — a concurrent request reassigned the takeoff to another
    // project and re-ran its AI estimate. Reading any conversion input before the lock would create
    // an estimate for project-1 with the old $108,400 of items and then link the project-2 takeoff
    // to it.
    state.takeoff = canonicalTakeoff();
    state.takeoffInTx = {
        name: "Reassigned Job",
        projectId: "project-2",
        leadId: null,
        estimateId: null,
        aiEstimateData: JSON.stringify({
            items: [{ costCode: "01-DEMO", name: "Fresh Demo", total: 7000, unitCost: 7000, quantity: 1 }],
            totalEstimate: 7000,
            paymentMilestones: [{ name: "Payment in full", percentage: "100", amount: "7000" }],
        }),
    };
    state.companySettings = canonicalCompanySettings();

    const res = await POST(postRequest("takeoff-1"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const estimateData = calls.estimateCreates[0].data;
    assert.equal(estimateData.projectId, "project-2", "ownership must come from the locked read");
    assert.equal(estimateData.title, "Reassigned Job — AI Estimate");
    assert.equal(estimateData.totalAmount, 7000);
    assert.equal(calls.estimateItemCreates.length, 1);
    assert.equal(calls.estimateItemCreates[0].data.name, "Fresh Demo");
    // The redirect follows the same locked read, so the client is not sent to the old project.
    assert.equal(body.redirectUrl, `/projects/project-2/estimates/${body.estimateId}`);
});

// --- idempotency -------------------------------------------------------------------------------
//
// Before the fix the route never checked `takeoff.estimateId`, so a second POST minted a SECOND
// Estimate and relinked the takeoff to it, orphaning the first with its real money and milestones.
// `Takeoff.estimateId` being @unique does not prevent that: the unique index forbids two takeoffs
// pointing at one estimate, but happily allows one takeoff to be repointed at a second estimate.

function alreadyConvertedTakeoff() {
    const t = canonicalTakeoff();
    return { ...t, id: "takeoff-converted", estimateId: "est-existing", status: "Completed" };
}

test("converting an already-converted takeoff returns the EXISTING estimate and writes nothing", async () => {
    state.takeoff = alreadyConvertedTakeoff();
    state.companySettings = canonicalCompanySettings();
    state.estimates = {
        "est-existing": {
            id: "est-existing",
            code: "EST-1234",
            totalAmount: 108400,
            projectId: "project-1",
            leadId: null,
            _count: { items: 3 },
        },
    };

    const res = await POST(postRequest("takeoff-converted"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(opsOutsideTx(), [], "the existing-estimate lookup must also run in the transaction");

    // The pre-existing estimate is handed back, flagged so the caller can tell it wasn't new.
    assert.equal(body.estimateId, "est-existing");
    assert.equal(body.code, "EST-1234");
    assert.equal(body.totalAmount, 108400);
    assert.equal(typeof body.totalAmount, "number");
    assert.equal(body.itemCount, 3);
    assert.equal(body.alreadyConverted, true);
    assert.equal(body.redirectUrl, "/projects/project-1/estimates/est-existing");

    // NOTHING was written — no second estimate, no duplicate items or milestones, and the takeoff
    // was not relinked.
    assert.equal(calls.estimateCreates.length, 0);
    assert.equal(calls.estimateItemCreates.length, 0);
    assert.equal(calls.estimatePaymentScheduleCreates.length, 0);
    assert.equal(calls.takeoffUpdates.length, 0);
});

test("a takeoff converted by a concurrent request that commits first does not get a second estimate", async () => {
    // A concurrent conversion commits while this one waits on the row lock, so the state visible
    // once the lock is finally held already carries an estimateId. Reading `estimateId` anywhere
    // but under the lock is precisely the interleaving that creates the orphan.
    state.takeoff = canonicalTakeoff();
    state.takeoffInTx = { estimateId: "est-raced" };
    state.companySettings = canonicalCompanySettings();
    state.estimates = {
        "est-raced": {
            id: "est-raced",
            code: "EST-9999",
            totalAmount: 108400,
            projectId: "project-1",
            leadId: null,
            _count: { items: 3 },
        },
    };

    const res = await POST(postRequest("takeoff-1"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    assert.equal(body.estimateId, "est-raced");
    assert.equal(body.alreadyConverted, true);
    assert.equal(calls.estimateCreates.length, 0);
    assert.equal(calls.takeoffUpdates.length, 0);
    assert.deepEqual(opsOutsideTx(), []);
});

test("the already-converted redirect follows the ESTIMATE's owner, not the takeoff's current one", async () => {
    // The takeoff was reassigned to project-2 after it produced this estimate. The estimate still
    // lives under project-1, which is where the client has to be sent — routing by the takeoff
    // would build a URL for a project that does not hold this estimate.
    state.takeoff = { ...alreadyConvertedTakeoff(), projectId: "project-2" };
    state.companySettings = canonicalCompanySettings();
    state.estimates = {
        "est-existing": {
            id: "est-existing",
            code: "EST-1234",
            totalAmount: 108400,
            projectId: "project-1",
            leadId: null,
            _count: { items: 3 },
        },
    };

    const res = await POST(postRequest("takeoff-converted"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.redirectUrl, "/projects/project-1/estimates/est-existing");
});

test("a takeoff deleted before the lock is acquired returns 404, decided by the lock's own result", async () => {
    state.takeoff = canonicalTakeoff();
    state.takeoffInTx = null;
    state.companySettings = canonicalCompanySettings();

    const res = await POST(postRequest("takeoff-1"));
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.error, "Takeoff not found");
    assert.equal(calls.estimateCreates.length, 0);
    // `FOR UPDATE` locks nothing when the row is absent, so the route must stop on the EMPTY LOCK
    // rather than proceeding to an unlocked read. Proving that means proving it never read at all.
    assert.deepEqual(
        ops.map((o) => o.op),
        ["$queryRaw"],
    );
});

test("a takeoff whose estimateId points at a missing estimate self-heals: it converts again", async () => {
    // Not reachable through the app (the FK nulls the link when an estimate is deleted), but if a
    // dangling link ever exists, failing forever would strand the takeoff. Convert and relink.
    state.takeoff = alreadyConvertedTakeoff();
    state.companySettings = canonicalCompanySettings();
    state.estimates = {}; // est-existing is gone

    const res = await POST(postRequest("takeoff-converted"));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    assert.equal(body.alreadyConverted, undefined);
    assert.equal(calls.estimateCreates.length, 1);
    assert.equal(calls.estimateItemCreates.length, 3);
    assert.equal(calls.takeoffUpdates.length, 1);
    assert.equal(calls.takeoffUpdates[0].data.estimateId, body.estimateId);
    assert.deepEqual(opsOutsideTx(), []);
});

test("companySettings is not queried when there is no tax split to name", async () => {
    // The configured sales taxes exist only to NAME a derived rate. A conversion with no tax row
    // must not spend a query — or inherit that query's failure mode — inside the lock.
    state.takeoff = bailOutTakeoff();
    state.companySettings = canonicalCompanySettings();

    const res = await POST(postRequest("takeoff-2"));
    assert.equal(res.status, 200, JSON.stringify(await res.json()));
    assert.equal(
        ops.filter((o) => o.op === "companySettings.findUnique").length,
        0,
        "the bail-out path derives no rate, so there is nothing to name",
    );
});

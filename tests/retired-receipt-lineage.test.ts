import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    RETIREMENT_MARKER,
    LineageQueryOverflowError,
    buildRetiredReceiptLineage,
    isRetiredZeroReceiptExpense,
    lineageFingerprint,
    loadRetiredReceiptLineage,
    subsetLineage,
    type LineageBankLineRow,
    type LineageDb,
    type LineageExpenseRow,
    type LineageObservationRow,
    type LineageRows,
} from "../src/lib/retired-receipt-lineage";
import {
    componentVersionOf,
    componentVersionsMatch,
    planReceiptRequests,
    resolveBoundLineage,
    type ReceiptEvidenceExpense,
    type ReceiptEvidenceIntake,
    type ReceiptRequestBankLine,
} from "../src/lib/receipt-requests";

// Canned synthetic data throughout. No real ids.

const NOW = new Date("2026-08-20T09:00:00Z");
const CENTS = 12_345;
const URL = "https://example.supabase.co/storage/v1/object/receipts/r-1.jpg";

const bankLine = (over: Partial<LineageBankLineRow> = {}): LineageBankLineRow => ({
    id: "bl-1", account: "acct-1", amountCents: -CENTS, qbTxnId: null, ...over,
});
const observation = (over: Partial<LineageObservationRow> = {}): LineageObservationRow => ({
    id: "obs-1", bankLineId: "bl-1", source: "QBO_REGISTER", sourceDocumentId: "QBO_REGISTER",
    sourceLineId: "555", account: "acct-1", amountCents: -CENTS, ...over,
});
const retiredExpense = (over: Partial<LineageExpenseRow> = {}): LineageExpenseRow => ({
    id: "exp-1", qbPurchaseId: "555", amount: "0.00", receiptUrl: URL, status: "Reviewed",
    description: RETIREMENT_MARKER, taxAmount: null, taxSource: null, installedAtCustomer: null,
    taxDeductibleBase: null, taxDeductibleBaseSource: null, taxAtSource: false, needsTaxReview: false, ...over,
});
const rows = (over: Partial<LineageRows> = {}): LineageRows => ({
    lineIds: ["bl-1"], lines: [bankLine()], observations: [observation()], claims: [observation()], expenses: [retiredExpense()], ...over,
});

const line = (over: Partial<ReceiptRequestBankLine> = {}): ReceiptRequestBankLine => ({
    id: "bl-1", postedDate: "2026-08-01", amountCents: -CENTS, rawDescriptor: "LOWES #02516 POS DEB C#8516", checkNumber: null, ...over,
});
/** The retired Expense as the ORDINARY date-window query sees it. */
const zeroExpense = (over: Partial<ReceiptEvidenceExpense> = {}): ReceiptEvidenceExpense => ({
    id: "exp-1", qbPurchaseId: "555", hasReceipt: true, amountCents: 0, date: "2026-08-16", vendor: "Lowe's Home Improvement", ...over,
});
const intake = (over: Partial<ReceiptEvidenceIntake> = {}): ReceiptEvidenceIntake => ({
    id: "int-1", qbPurchaseId: "555", totalCents: CENTS, txnDate: "2026-08-16", vendor: "Lowes", state: "BOOKED", ...over,
});

test("exact-bound retired zero Expense closes ONLY its bound line, whatever the dates say", () => {
    const lineage = buildRetiredReceiptLineage(rows());
    assert.equal(lineage.snapshot.lines[0].verdict, "bound");
    assert.deepEqual(lineage.evidence, {
        bound: [{ unit: "purchase:555", bankLineId: "bl-1", amountCents: CENTS, expenseId: "exp-1", qbPurchaseId: "555", observationId: "obs-1" }],
        reservedUnits: ["expense:exp-1"],
    });
    // bl-1 is 15 days from the Expense's date; bl-2 is the same day and the same
    // payee. The binding, not the date, decides.
    const result = planReceiptRequests({
        bankLines: [line({ id: "bl-1", postedDate: "2026-08-01" }), line({ id: "bl-2", postedDate: "2026-08-16" })],
        expenses: [zeroExpense()],
        intakes: [],
        openIssueKeys: ["bl-1", "bl-2"],
        boundLineage: lineage.evidence,
        now: NOW,
    });
    assert.deepEqual(result.close, ["bl-1"]);
    assert.deepEqual(result.open.map(item => item.targetKey), ["bl-2"]);
});

test("missing lineage, or an unlinked same-source observation, leaves the line open (existing behaviour)", async t => {
    await t.test("no observation at all", () => {
        const lineage = buildRetiredReceiptLineage(rows({ observations: [], claims: [] }));
        assert.equal(lineage.snapshot.lines[0].verdict, "no-eligible-observation");
        assert.deepEqual(lineage.evidence, { bound: [], reservedUnits: [] });
        const result = planReceiptRequests({
            bankLines: [line()], expenses: [zeroExpense({ date: "2026-08-01" })], intakes: [],
            openIssueKeys: ["bl-1"], boundLineage: lineage.evidence, now: NOW,
        });
        assert.equal(result.open.length, 1, "a zero Expense is not fuzzy evidence, and nothing binds it");
    });
    await t.test("observation carrying the source id but linked to nothing", () => {
        const unlinked = observation({ bankLineId: null });
        const lineage = buildRetiredReceiptLineage(rows({ observations: [unlinked], claims: [unlinked] }));
        assert.equal(lineage.snapshot.lines[0].verdict, "no-eligible-observation");
        assert.deepEqual(lineage.evidence.bound, []);
    });
});

test("anything short of exact proof is rejected", async t => {
    const cases: Array<[string, Partial<LineageRows>, string, string[]]> = [
        ["wrong observation source", { observations: [observation({ source: "WTB_CSV" })] }, "no-eligible-observation", []],
        ["wrong source document", { observations: [observation({ sourceDocumentId: "WTB_STATEMENT" })] }, "no-eligible-observation", []],
        ["split suffix is not a purchase id", { observations: [observation({ sourceLineId: "555#1" })], claims: [observation({ sourceLineId: "555#1" })] }, "no-eligible-observation", []],
        ["account mismatch", { observations: [observation({ account: "acct-2" })], claims: [observation({ account: "acct-2" })] }, "observation-mismatch", ["purchase:555"]],
        ["cents mismatch", { observations: [observation({ amountCents: -CENTS - 1 })], claims: [observation({ amountCents: -CENTS - 1 })] }, "observation-mismatch", ["purchase:555"]],
        ["positive cents", { lines: [bankLine({ amountCents: CENTS })], observations: [observation({ amountCents: CENTS })], claims: [observation({ amountCents: CENTS })] }, "observation-mismatch", ["purchase:555"]],
        ["qbTxnId names a different purchase", { lines: [bankLine({ qbTxnId: "999" })] }, "qb-txn-mismatch", ["purchase:555"]],
        ["two eligible observations on the line", { observations: [observation(), observation({ id: "obs-2", sourceLineId: "556" })], claims: [observation(), observation({ id: "obs-2", sourceLineId: "556" })] }, "multiple-observations", ["purchase:555"]],
        ["two Expenses for the purchase", { expenses: [retiredExpense(), retiredExpense({ id: "exp-2" })] }, "multiple-expenses", ["purchase:555"]],
        ["no Expense", { expenses: [] }, "no-expense", []],
        ["not retired (status)", { expenses: [retiredExpense({ status: "Pending" })] }, "expense-not-retired-receipt", []],
        ["no retirement marker", { expenses: [retiredExpense({ description: "Lowe's" })] }, "expense-not-retired-receipt", []],
        ["empty receipt", { expenses: [retiredExpense({ receiptUrl: "   " })] }, "expense-not-retired-receipt", []],
        ["null receipt", { expenses: [retiredExpense({ receiptUrl: null })] }, "expense-not-retired-receipt", []],
        ["non-zero amount", { expenses: [retiredExpense({ amount: "123.45" })] }, "expense-not-retired-receipt", []],
        ["taxAmount populated", { expenses: [retiredExpense({ taxAmount: "0.00" })] }, "expense-not-retired-receipt", []],
        ["taxSource populated", { expenses: [retiredExpense({ taxSource: "qbo" })] }, "expense-not-retired-receipt", []],
        ["installedAtCustomer populated", { expenses: [retiredExpense({ installedAtCustomer: false })] }, "expense-not-retired-receipt", []],
        ["taxDeductibleBase populated", { expenses: [retiredExpense({ taxDeductibleBase: "0.00" })] }, "expense-not-retired-receipt", []],
        ["taxDeductibleBaseSource populated", { expenses: [retiredExpense({ taxDeductibleBaseSource: "qbo" })] }, "expense-not-retired-receipt", []],
        ["taxAtSource true", { expenses: [retiredExpense({ taxAtSource: true })] }, "expense-not-retired-receipt", []],
        ["needsTaxReview true", { expenses: [retiredExpense({ needsTaxReview: true })] }, "expense-not-retired-receipt", []],
        ["canonical line missing", { lines: [] }, "no-canonical-line", ["purchase:555"]],
    ];
    for (const [label, over, verdict, reserved] of cases) {
        await t.test(label, () => {
            const lineage = buildRetiredReceiptLineage(rows(over));
            assert.equal(lineage.snapshot.lines[0].verdict, verdict);
            assert.deepEqual(lineage.evidence.bound, []);
            assert.deepEqual(lineage.evidence.reservedUnits, reserved.length ? ["expense:exp-1", ...(label === "two Expenses for the purchase" ? ["expense:exp-2"] : []), ...reserved] : reserved);
        });
    }
    await t.test("qbTxnId naming the SAME purchase is fine", () => {
        assert.equal(buildRetiredReceiptLineage(rows({ lines: [bankLine({ qbTxnId: "555" })] })).snapshot.lines[0].verdict, "bound");
    });
    await t.test("the retirement predicate, directly", () => {
        assert.equal(isRetiredZeroReceiptExpense(retiredExpense()), true);
        assert.equal(isRetiredZeroReceiptExpense(retiredExpense({ amount: "0" })), true);
        assert.equal(isRetiredZeroReceiptExpense(retiredExpense({ amount: "-0.00" })), false);
        assert.equal(isRetiredZeroReceiptExpense(retiredExpense({ amount: "" })), false);
    });
});

test("a duplicate global claim on the purchase id blocks the binding and reserves the unit", () => {
    const elsewhere = observation({ id: "obs-9", bankLineId: "bl-7", account: "acct-2" });
    const lineage = buildRetiredReceiptLineage(rows({ claims: [observation(), elsewhere] }));
    assert.equal(lineage.snapshot.lines[0].verdict, "duplicate-claim");
    assert.deepEqual(lineage.snapshot.lines[0].claims.map(c => c.id), ["obs-1", "obs-9"], "the collision is in the snapshot");
    assert.deepEqual(lineage.evidence, { bound: [], reservedUnits: ["expense:exp-1", "purchase:555"] });

    // The reserved unit is unusable by ANYONE, including the fuzzy path that
    // would otherwise have closed bl-2 on the intake.
    const input = {
        bankLines: [line({ id: "bl-1" }), line({ id: "bl-2", postedDate: "2026-08-16" })],
        expenses: [], intakes: [intake()], openIssueKeys: ["bl-1", "bl-2"], now: NOW,
    };
    assert.deepEqual(planReceiptRequests(input).close, ["bl-2"], "sanity: without lineage the intake closes bl-2");
    const withLineage = planReceiptRequests({ ...input, boundLineage: lineage.evidence });
    assert.deepEqual(withLineage.close, []);
    assert.deepEqual(withLineage.open.map(item => item.targetKey), ["bl-1", "bl-2"]);
});

test("conflicting bound input grants zero matches and keeps the units reserved", async t => {
    const bound = (unit: string, bankLineId: string) => ({ unit, bankLineId, amountCents: CENTS, expenseId: `e-${unit}`, qbPurchaseId: unit.slice(9), observationId: `o-${bankLineId}` });
    await t.test("one unit, two targets", () => {
        const resolved = resolveBoundLineage({ bound: [bound("purchase:555", "bl-1"), bound("purchase:555", "bl-2")], reservedUnits: [] });
        assert.deepEqual(resolved.bound, []);
        assert.deepEqual([...resolved.excludedUnits].sort(), ["expense:e-purchase:555", "purchase:555"]);
        const result = planReceiptRequests({
            bankLines: [line({ id: "bl-1" }), line({ id: "bl-2", postedDate: "2026-08-16" })],
            expenses: [zeroExpense()], intakes: [intake()], openIssueKeys: ["bl-1", "bl-2"], now: NOW,
            boundLineage: { bound: [bound("purchase:555", "bl-1"), bound("purchase:555", "bl-2")], reservedUnits: [] },
        });
        assert.deepEqual(result.close, []);
        assert.equal(result.open.length, 2);
    });
    await t.test("one target, two units", () => {
        const resolved = resolveBoundLineage({ bound: [bound("purchase:555", "bl-1"), bound("purchase:556", "bl-1")], reservedUnits: [] });
        assert.deepEqual(resolved.bound, []);
        assert.deepEqual([...resolved.excludedUnits].sort(), ["expense:e-purchase:555", "expense:e-purchase:556", "purchase:555", "purchase:556"]);
    });
    await t.test("the same binding listed twice is one unit", () => {
        const resolved = resolveBoundLineage({ bound: [bound("purchase:555", "bl-1"), bound("purchase:555", "bl-1")], reservedUnits: [] });
        assert.equal(resolved.bound.length, 1);
        assert.equal(resolved.bound[0].targetBankLineId, "bl-1");
    });
    await t.test("the builder itself refuses one unit bound to two lines", () => {
        const lineage = buildRetiredReceiptLineage(rows({
            lineIds: ["bl-1", "bl-2"],
            lines: [bankLine(), bankLine({ id: "bl-2" })],
            observations: [observation(), observation({ id: "obs-2", bankLineId: "bl-2" })],
            // A claims query that somehow returned only each line's own row.
            claims: [],
        }));
        assert.deepEqual(lineage.snapshot.lines.map(entry => entry.verdict), ["duplicate-claim", "duplicate-claim"]);
        assert.deepEqual(lineage.evidence, { bound: [], reservedUnits: ["expense:exp-1", "purchase:555"] });
    });
});

test("zero Expense + same-unit intake: the unit appears once, pinned, and adds no capacity", () => {
    const lineage = buildRetiredReceiptLineage(rows());
    const result = planReceiptRequests({
        bankLines: [line({ id: "bl-1" }), line({ id: "bl-2", postedDate: "2026-08-16" })],
        // Before this feature the zero Expense won the unit fold and HID the
        // intake, so neither line closed. Now the unit answers bl-1 exactly once.
        expenses: [zeroExpense()], intakes: [intake()], openIssueKeys: ["bl-1", "bl-2"],
        boundLineage: lineage.evidence, now: NOW,
    });
    assert.deepEqual(result.close, ["bl-1"]);
    assert.deepEqual(result.open.map(item => item.targetKey), ["bl-2"], "the intake is the SAME receipt and cannot also answer bl-2");
});

test("an unbound line cannot steal a bound unit, even on the same day with the same payee", () => {
    const lineage = buildRetiredReceiptLineage(rows());
    const result = planReceiptRequests({
        bankLines: [line({ id: "bl-2", postedDate: "2026-08-16" }), line({ id: "bl-1", postedDate: "2026-08-01" })],
        expenses: [zeroExpense()], intakes: [intake({ txnDate: "2026-08-16", vendor: "LOWES #02516" })],
        openIssueKeys: ["bl-2"], boundLineage: lineage.evidence, now: NOW,
    });
    assert.deepEqual(result.close, [], "bl-2 stays open");
    assert.deepEqual(result.open.map(item => item.targetKey), ["bl-2"], "bl-1 is answered, bl-2 is not");
});

test("a bound unit whose target is resolved is still not lent to a fuzzy line", () => {
    const lineage = buildRetiredReceiptLineage(rows());
    const result = planReceiptRequests({
        bankLines: [line({ id: "bl-1" }), line({ id: "bl-2", postedDate: "2026-08-16" })],
        expenses: [zeroExpense()], intakes: [intake()], openIssueKeys: ["bl-2"], resolvedIssueKeys: ["bl-1"],
        boundLineage: lineage.evidence, now: NOW,
    });
    assert.deepEqual(result.open.map(item => item.targetKey), ["bl-2"]);
});

test("the ordinary matcher is unchanged when no lineage is supplied", () => {
    const result = planReceiptRequests({
        bankLines: [line({ id: "bl-2", postedDate: "2026-08-16" })],
        expenses: [], intakes: [intake()], openIssueKeys: ["bl-2"], now: NOW,
    });
    assert.deepEqual(result.close, ["bl-2"]);
});

test("the fingerprint moves with every fact the rule read", async t => {
    const base = lineageFingerprint(buildRetiredReceiptLineage(rows()).snapshot);
    const variants: Array<[string, Partial<LineageRows>]> = [
        ["receipt URL", { expenses: [retiredExpense({ receiptUrl: URL.replace("r-1", "r-2") })] }],
        ["retirement status", { expenses: [retiredExpense({ status: "Pending" })] }],
        ["retirement marker", { expenses: [retiredExpense({ description: "Lowe's" })] }],
        ["tax tuple", { expenses: [retiredExpense({ taxAtSource: true })] }],
        ["Expense amount", { expenses: [retiredExpense({ amount: "1.00" })] }],
        ["observation link", { observations: [observation({ bankLineId: "bl-9" })] }],
        ["source id", { observations: [observation({ sourceLineId: "556" })] }],
        ["observation cents", { observations: [observation({ amountCents: -1 })] }],
        ["canonical qbTxnId", { lines: [bankLine({ qbTxnId: "555" })] }],
        ["a new global claim", { claims: [observation(), observation({ id: "obs-9", bankLineId: "bl-9" })] }],
    ];
    for (const [label, over] of variants) {
        await t.test(label, () => {
            assert.notEqual(lineageFingerprint(buildRetiredReceiptLineage(rows(over)).snapshot), base);
        });
    }
    await t.test("stable across input order", () => {
        const shuffled = buildRetiredReceiptLineage(rows({
            lineIds: ["bl-2", "bl-1"], lines: [bankLine({ id: "bl-2" }), bankLine()],
        })).snapshot;
        const ordered = buildRetiredReceiptLineage(rows({
            lineIds: ["bl-1", "bl-2"], lines: [bankLine(), bankLine({ id: "bl-2" })],
        })).snapshot;
        assert.equal(lineageFingerprint(shuffled), lineageFingerprint(ordered));
    });
    await t.test("a subset equals a fresh build of the same ids", () => {
        const whole = buildRetiredReceiptLineage(rows({
            lineIds: ["bl-1", "bl-2"], lines: [bankLine(), bankLine({ id: "bl-2" })],
        })).snapshot;
        const alone = buildRetiredReceiptLineage(rows()).snapshot;
        assert.equal(lineageFingerprint(subsetLineage(whole, ["bl-1"])), lineageFingerprint(alone));
        assert.notEqual(lineageFingerprint(whole), lineageFingerprint(alone));
    });
    await t.test("the snapshot carries the actual URL, not a boolean", () => {
        assert.equal(buildRetiredReceiptLineage(rows()).snapshot.lines[0].expenses[0].receiptUrl, URL);
    });
});

test("the component version includes the lineage, and old fixtures still agree with themselves", () => {
    const a = lineageFingerprint(buildRetiredReceiptLineage(rows()).snapshot);
    const b = lineageFingerprint(buildRetiredReceiptLineage(rows({ expenses: [retiredExpense({ receiptUrl: null })] })).snapshot);
    const fixture = { issues: [], intakes: [], lines: [{ id: "bl-1", rawDescriptor: "LOWES", updatedAt: new Date(0) }], expenses: [] };
    const withA = componentVersionOf({ ...fixture, lineageFingerprint: a });
    const withB = componentVersionOf({ ...fixture, lineageFingerprint: b });
    assert.equal(withA.lineageHash, a);
    assert.equal(componentVersionsMatch(withA, withA), true);
    assert.equal(componentVersionsMatch(withA, withB), false, "a retired receipt going away is a moved component");
    assert.equal(componentVersionsMatch(componentVersionOf(fixture), componentVersionOf(fixture)), true);
    assert.equal(componentVersionOf(fixture).lineageHash, "");
    assert.equal(componentVersionsMatch(componentVersionOf(fixture), withA), false);
});

// ── The loader, with injected fakes ───────────────────────────────────────

interface Call { model: string; args: Record<string, unknown> }

function fakeDb(data: {
    lines?: LineageBankLineRow[];
    observations?: LineageObservationRow[];
    claims?: LineageObservationRow[];
    expenses?: LineageExpenseRow[];
}): { db: LineageDb; calls: Call[] } {
    const calls: Call[] = [];
    const db: LineageDb = {
        bankLine: { findMany: async args => { calls.push({ model: "bankLine", args }); return data.lines ?? []; } },
        bankLineObservation: {
            findMany: async args => {
                const where = args.where as Record<string, unknown>;
                const linked = where.bankLineId !== undefined;
                calls.push({ model: linked ? "observations" : "claims", args });
                return linked ? data.observations ?? [] : data.claims ?? [];
            },
        },
        expense: {
            findMany: async args => {
                calls.push({ model: "expense", args });
                // Prisma hands back a Decimal, not a string.
                return (data.expenses ?? []).map(e => ({ ...e, amount: { toString: () => e.amount } }));
            },
        },
    };
    return { db, calls };
}

test("loader: queries by id (never by date), across accounts, and decides from what came back", async () => {
    const { db, calls } = fakeDb({ lines: [bankLine()], observations: [observation()], claims: [observation()], expenses: [retiredExpense()] });
    const lineage = await loadRetiredReceiptLineage(db, ["bl-1", "bl-1"]);
    assert.equal(lineage.evidence.bound.length, 1);
    assert.equal(lineage.evidence.bound[0].amountCents, CENTS);
    assert.deepEqual(calls.map(call => call.model), ["bankLine", "observations", "claims", "expense"]);
    const [lines, observations, claims, expenses] = calls.map(call => call.args);
    assert.deepEqual((lines.where as Record<string, unknown>).id, { in: ["bl-1"] }, "dedupes the ids");
    assert.deepEqual((observations.where as Record<string, unknown>).bankLineId, { in: ["bl-1"] });
    assert.deepEqual(claims.where, { source: "QBO_REGISTER", sourceLineId: { in: ["555"] } }, "no bankLineId or account filter — every claimant anywhere");
    assert.deepEqual(expenses.where, { qbPurchaseId: { in: ["555"] } }, "no date window — a retired Expense outside it still counts");
    for (const args of [lines, observations, claims, expenses]) assert.equal(typeof args.take, "number");
    assert.equal(lineage.snapshot.lines[0].expenses[0].amount, "0.00", "Decimal read through its string form");
});

test("loader: an ineligible observation queries no claims and no Expenses", async () => {
    const { db, calls } = fakeDb({ lines: [bankLine()], observations: [observation({ sourceLineId: "555#1" })] });
    const lineage = await loadRetiredReceiptLineage(db, ["bl-1"]);
    assert.deepEqual(calls.map(call => call.model), ["bankLine", "observations"]);
    assert.equal(lineage.snapshot.lines[0].verdict, "no-eligible-observation");
});

test("loader: no ids means no queries and an empty lineage", async () => {
    const { db, calls } = fakeDb({});
    const lineage = await loadRetiredReceiptLineage(db, []);
    assert.deepEqual(calls, []);
    assert.deepEqual(lineage, { snapshot: { lines: [], units: [] }, evidence: { bound: [], reservedUnits: [] } });
});

test("loader: a query past its cap THROWS rather than truncating", async t => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => observation({ id: `obs-${i}`, bankLineId: `bl-${i}` }));
    await t.test("claims overflow", async () => {
        const { db } = fakeDb({ lines: [bankLine()], observations: [observation()], claims: many(4), expenses: [retiredExpense()] });
        await assert.rejects(loadRetiredReceiptLineage(db, ["bl-1"], { cap: 3 }), (error: unknown) =>
            error instanceof LineageQueryOverflowError && error.query === "bankLineObservation.claims" && error.cap === 3);
    });
    await t.test("ids overflow, before any query", async () => {
        const { db, calls } = fakeDb({});
        await assert.rejects(loadRetiredReceiptLineage(db, ["a", "b", "c", "d"], { cap: 3 }), LineageQueryOverflowError);
        assert.deepEqual(calls, []);
    });
    await t.test("take is cap + 1, so overflow is detectable", async () => {
        const { db, calls } = fakeDb({ lines: [bankLine()] });
        await loadRetiredReceiptLineage(db, ["bl-1"], { cap: 7 });
        assert.equal(calls[0].args.take, 8);
    });
});

// ── The four route paths consume the same helper ──────────────────────────

test("route: batch planning, planned version, locked re-read and recompute all use the helper", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    const count = (needle: string) => source.split(needle).length - 1;
    assert.ok(source.includes('from "@/lib/retired-receipt-lineage"'));
    // Two read-only loads: one in processBatch, one in recomputeCodesFor.
    assert.equal(count("loadRetiredReceiptLineage(prisma, "), 2);
    // Both plans receive the bound evidence.
    assert.equal(count("boundLineage: lineage.evidence,"), 2);
    // The planned version hashes the component's subset...
    assert.equal(count("lineageFingerprint(subsetLineage(lineage.snapshot, component.lineIds,"), 1);
    // ...and the locked re-read calls the helper inside the transaction.
    assert.equal(count("loadRetiredReceiptLineage(tx, component.lineIds,"), 1);
    // Lock order in the component transaction: evidence, identity, component.
    const txStart = source.indexOf("await lockReceiptEvidence(tx);");
    assert.ok(txStart > 0);
    const identity = source.indexOf("await lockBankLineIdentity(tx);", txStart);
    const component = source.indexOf("pg_advisory_xact_lock(hashtext(${`${COMPONENT_LOCK_PREFIX}", txStart);
    assert.ok(identity > txStart && identity < component, "identity lock sits between the evidence lock and the component lock");
    // The version re-read happens after both locks and before the verdict check.
    const reread = source.indexOf("loadRetiredReceiptLineage(tx, component.lineIds,");
    const check = source.indexOf("if (!componentVersionsMatch(planned, current))");
    assert.ok(identity < reread && reread < check);
    // Nothing here calls QBO or imports the source-refresh project guard.
    assert.ok(!source.includes("bank-source-refresh"));
});


test("candidate unit bound outside this component cannot be borrowed through duplicate intake", async () => {
    const elsewhere = observation({ bankLineId: "elsewhere" });
    const { db, calls } = fakeDb({ lines: [bankLine()], observations: [], claims: [elsewhere], expenses: [retiredExpense()] });
    const lineage = await loadRetiredReceiptLineage(db, ["bl-1"], { candidatePurchaseIds: ["555"] });
    assert.deepEqual(lineage.evidence, { bound: [], reservedUnits: ["expense:exp-1", "purchase:555"] });
    const input = { bankLines: [line({ postedDate: "2026-08-16" })], expenses: [], intakes: [intake()], openIssueKeys: ["bl-1"], now: NOW };
    assert.deepEqual(planReceiptRequests(input).close, ["bl-1"]);
    assert.deepEqual(planReceiptRequests({ ...input, boundLineage: lineage.evidence }).close, []);
    assert.deepEqual(calls.find(c => c.model === "expense")?.args.where, { qbPurchaseId: { in: ["555"] } });
    const changed = buildRetiredReceiptLineage(rows({ observations: [], claims: [elsewhere], candidatePurchaseIds: ["555"], expenses: [retiredExpense({ receiptUrl: null })] }));
    assert.notEqual(lineageFingerprint(lineage.snapshot), lineageFingerprint(changed.snapshot));
});

test("ordinary positive Expense is never reserved by the retired rule", () => {
    const result = buildRetiredReceiptLineage(rows({ candidatePurchaseIds: ["555"], expenses: [retiredExpense({ amount: "123.45" })] }));
    assert.deepEqual(result.evidence, { bound: [], reservedUnits: [] });
});

test("exact retirement marker excludes appended or prepended owner text", () => {
    for (const description of [`note ${RETIREMENT_MARKER}`, `${RETIREMENT_MARKER} note`]) {
        assert.equal(isRetiredZeroReceiptExpense(retiredExpense({ description })), false);
    }
});

test("an explicitly reserved unit cannot be reinstated by a bound input", () => {
    const result = resolveBoundLineage({ bound: [{ unit: "purchase:555", bankLineId: "bl-1", amountCents: CENTS, expenseId: "exp-1", qbPurchaseId: "555", observationId: "obs-1" }], reservedUnits: ["expense:exp-1", "purchase:555"] });
    assert.equal(result.bound.length, 0);
});


test("an intake carrying only the exact Expense alias cannot add a second receipt", () => {
    const lineage = buildRetiredReceiptLineage(rows());
    const plan = planReceiptRequests({ bankLines: [line(), line({ id: "bl-2", postedDate: "2026-08-16" })], expenses: [], intakes: [intake({ qbPurchaseId: null, expenseId: "exp-1" })], openIssueKeys: ["bl-1", "bl-2"], now: NOW, boundLineage: lineage.evidence });
    assert.deepEqual(plan.close, ["bl-1"]);
});

test("an intake with a conflicting purchase id cannot reuse an exact-bound Expense alias", () => {
    const lineage = buildRetiredReceiptLineage(rows());
    const plan = planReceiptRequests({ bankLines: [line(), line({ id: "bl-2", postedDate: "2026-08-16" })], expenses: [], intakes: [intake({ qbPurchaseId: "999", expenseId: "exp-1" })], openIssueKeys: ["bl-1", "bl-2"], now: NOW, boundLineage: lineage.evidence });
    assert.deepEqual(plan.close, ["bl-1"]);
});

test("outside-window retired Expense is discovered through intake Expense alias and reserved", async () => {
    const { db, calls } = fakeDb({ lines: [bankLine()], observations: [], claims: [observation({ bankLineId: "elsewhere" })], expenses: [retiredExpense()] });
    const result = await loadRetiredReceiptLineage(db, ["bl-1"], { candidateExpenseIds: ["exp-1"] });
    assert.deepEqual(calls[0].args.where, { id: { in: ["exp-1"] } });
    assert.ok(result.evidence.reservedUnits.includes("purchase:555"));
    assert.ok(result.evidence.reservedUnits.includes("expense:exp-1"));
    assert.equal(lineageFingerprint(subsetLineage(result.snapshot, ["bl-1"], [], ["exp-1"])), lineageFingerprint(result.snapshot));
    const input = { bankLines: [line({ postedDate: "2026-08-16" })], expenses: [], intakes: [intake({ qbPurchaseId: null, expenseId: "exp-1" })], openIssueKeys: ["bl-1"], now: NOW };
    assert.deepEqual(planReceiptRequests(input).close, ["bl-1"]);
    assert.deepEqual(planReceiptRequests({ ...input, boundLineage: result.evidence }).close, []);
});

// tests/reviewed-pair-census.test.ts
// Global identity census for a POSITIVE reviewed exact-pair Expense. Entirely synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
    REVIEWED_PAIR_CENSUS_CAP,
    ReviewedPairCensusOverflowError,
    buildReviewedPairCensus,
    loadReviewedPairCensus,
    pairCensusFingerprint,
    reviewedPairCensusKeys,
    subsetPairCensus,
    type PairCensusDb,
    type PairCensusExpenseRow,
    type PairCensusIntakeRow,
    type PairCensusKey,
    type PairCensusLineRow,
    type PairCensusObservationRow,
    type PairCensusRows,
} from "../src/lib/reviewed-pair-census";
import { componentVersionOf, componentVersionsMatch, planReceiptRequests } from "../src/lib/receipt-requests";

const NOW = new Date("2026-09-10T12:00:00Z");
const RECEIPT_URL = "https://example.invalid/storage/v1/object/public/receipts/pair-0.pdf";
const key = (over: Partial<PairCensusKey> = {}): PairCensusKey => ({
    expenseId: "synthetic-pair-expense-0", targetBankLineId: "synthetic-pair-line-0", qbPurchaseId: "2000",
    receiptUrl: RECEIPT_URL, sourceFileId: null, sourceGroupIndex: null, ...over,
});
const lineRow = (over: Partial<PairCensusLineRow> = {}): PairCensusLineRow => ({
    id: "synthetic-other-line", account: "WTB-9999", state: "MATCHED", qbTxnId: "2000", probuildExpenseId: null, ...over,
});
const obs = (over: Partial<PairCensusObservationRow> = {}): PairCensusObservationRow => ({
    id: "obs-0", bankLineId: null, source: "QBO_REGISTER", sourceDocumentId: "QBO_REGISTER", sourceLineId: "2000", account: "WTB-0723", amountCents: -55555, ...over,
});
const selfExpense = (over: Partial<PairCensusExpenseRow> = {}): PairCensusExpenseRow => ({
    id: "synthetic-pair-expense-0", qbPurchaseId: "2000", receiptUrl: RECEIPT_URL, sourceFileId: null, sourceGroupIndex: null, status: "Reviewed", amount: "555.55", ...over,
});
const intakeRow = (over: Partial<PairCensusIntakeRow> = {}): PairCensusIntakeRow => ({
    id: "intake-x", state: "BOOKED", stateReason: null, expenseId: null, qbPurchaseId: "2000", postVoidQbPurchaseId: null, ...over,
});
const rows = (over: Partial<PairCensusRows> = {}): PairCensusRows => ({
    keys: [key()], lines: [], observations: [obs()], expenses: [selfExpense()], intakes: [], ...over,
});

// ── The rule ────────────────────────────────────────────────────────────────

test("a pair whose only global claims are its own is eligible and reserves nothing", () => {
    const census = buildReviewedPairCensus(rows());
    assert.equal(census.snapshot.pairs.length, 1);
    assert.deepEqual(census.snapshot.pairs[0].conflicts, []);
    assert.equal(census.snapshot.pairs[0].eligible, true);
    assert.deepEqual(census.evidence, { eligible: ["synthetic-pair-expense-0"], reservedUnits: [] });
    // The target line itself carrying the pair's own link is confirmation, not a conflict.
    const own = buildReviewedPairCensus(rows({ lines: [lineRow({ id: "synthetic-pair-line-0", account: "WTB-0723", state: "POSTED", qbTxnId: "2000", probuildExpenseId: "synthetic-pair-expense-0" })] }));
    assert.equal(own.evidence.eligible.length, 1);
    // A dead-state duplicate document pointing at this receipt is not capacity.
    const dup = buildReviewedPairCensus(rows({ intakes: [intakeRow({ state: "DUPLICATE", expenseId: "synthetic-pair-expense-0" })] }));
    assert.equal(dup.evidence.eligible.length, 1);
    assert.equal(dup.snapshot.pairs[0].intakes.length, 1, "still recorded, so the fingerprint sees it");
});

test("every competing global claim makes the pair ineligible and reserves both unit aliases, whatever its account, state or date", async t => {
    const cases: Array<[string, Partial<PairCensusRows>, string]> = [
        ["a canonical line in another account already linked to the purchase", { lines: [lineRow()] }, "canonical-link-elsewhere"],
        ["a closed canonical line linked to the Expense", { lines: [lineRow({ qbTxnId: null, probuildExpenseId: "synthetic-pair-expense-0", state: "TAX_VALIDATED" })] }, "canonical-link-elsewhere"],
        ["the target line linked to a different purchase", { lines: [lineRow({ id: "synthetic-pair-line-0", qbTxnId: "2999", probuildExpenseId: "synthetic-pair-expense-0" })] }, "target-link-mismatch"],
        ["a QBO observation of the purchase linked to another line", { observations: [obs({ bankLineId: "synthetic-other-line" })] }, "observation-linked-elsewhere"],
        ["two observations claiming the purchase", { observations: [obs(), obs({ id: "obs-1", account: "WTB-9999" })] }, "duplicate-observation-claim"],
        ["the pinned Expense is gone", { expenses: [] }, "expense-missing"],
        ["the pinned Expense now names another purchase", { expenses: [selfExpense({ qbPurchaseId: "2999" })] }, "expense-drift"],
        ["the pinned Expense now carries another receipt", { expenses: [selfExpense({ receiptUrl: RECEIPT_URL.replace("pair-0", "pair-9") })] }, "expense-drift"],
        ["another Expense reuses the receipt URL (any date)", { expenses: [selfExpense(), selfExpense({ id: "synthetic-far-expense", qbPurchaseId: "2999" })] }, "receipt-url-reuse"],
        ["another Expense claims the purchase id", { expenses: [selfExpense(), selfExpense({ id: "synthetic-far-expense", receiptUrl: null })] }, "purchase-alias-reuse"],
        ["a live intake claims the purchase without being this Expense's intake", { intakes: [intakeRow()] }, "intake-alias-reuse"],
        ["a live intake claims this Expense under a different purchase", { intakes: [intakeRow({ expenseId: "synthetic-pair-expense-0", qbPurchaseId: "2999" })] }, "intake-alias-reuse"],
        ["a live intake claims this Expense with no purchase at all", { intakes: [intakeRow({ expenseId: "synthetic-pair-expense-0", qbPurchaseId: null })] }, "intake-alias-reuse"],
        ["an intake records the purchase as post-void, dead or not", { intakes: [intakeRow({ state: "VOID", qbPurchaseId: null, postVoidQbPurchaseId: "2000" })] }, "purchase-post-void"],
    ];
    for (const [label, over, conflict] of cases) {
        await t.test(label, () => {
            const census = buildReviewedPairCensus(rows(over));
            assert.ok(census.snapshot.pairs[0].conflicts.includes(conflict as never), `${label}: ${census.snapshot.pairs[0].conflicts.join(",")}`);
            assert.equal(census.snapshot.pairs[0].eligible, false);
            assert.deepEqual(census.evidence, { eligible: [], reservedUnits: ["expense:synthetic-pair-expense-0", "purchase:2000"] });
        });
    }
});

test("source-file identity: only two KNOWN, UNEQUAL groups are a split; the same or an unknown group on either side is the same page", async t => {
    const FILE = "synthetic-drive-file";
    const alias = (group: number | null) => selfExpense({ id: "synthetic-alias", qbPurchaseId: "2999", receiptUrl: null, sourceFileId: FILE, sourceGroupIndex: group });
    const census = (own: number | null, other: number | null) => buildReviewedPairCensus(rows({
        keys: [key({ sourceFileId: FILE, sourceGroupIndex: own })],
        expenses: [selfExpense({ sourceFileId: FILE, sourceGroupIndex: own }), alias(other)],
    })).snapshot.pairs[0];
    await t.test("known 0 vs known 1: distinct split, eligible", () => {
        assert.deepEqual(census(0, 1).conflicts, []);
        assert.equal(census(0, 1).eligible, true);
    });
    await t.test("known 0 vs known 0: the same page", () => assert.ok(census(0, 0).conflicts.includes("source-group-reuse")));
    await t.test("unknown (pinned null) vs known 0: not proof of a separate receipt", () => assert.ok(census(null, 0).conflicts.includes("source-group-reuse")));
    await t.test("known 0 vs unknown alias: not proof of a separate receipt", () => assert.ok(census(0, null).conflicts.includes("source-group-reuse")));
    await t.test("unknown vs unknown: the same page", () => assert.ok(census(null, null).conflicts.includes("source-group-reuse")));
    await t.test("a different file with any group is unrelated", () => {
        const other = buildReviewedPairCensus(rows({
            keys: [key({ sourceFileId: FILE, sourceGroupIndex: null })],
            expenses: [selfExpense({ sourceFileId: FILE, sourceGroupIndex: null }), selfExpense({ id: "synthetic-alias", qbPurchaseId: "2999", receiptUrl: null, sourceFileId: "synthetic-other-file", sourceGroupIndex: null })],
        })).snapshot.pairs[0];
        assert.deepEqual(other.conflicts, []);
    });
    await t.test("a pinned source identity that no longer matches the row is drift", () => {
        const drifted = buildReviewedPairCensus(rows({ keys: [key({ sourceFileId: FILE, sourceGroupIndex: 0 })], expenses: [selfExpense({ sourceFileId: null })] }));
        assert.ok(drifted.snapshot.pairs[0].conflicts.includes("expense-drift"));
    });
});

test("each pair is decided from its own rows only, so a subset equals a fresh build and the fingerprint is order-independent", () => {
    const k2 = key({ expenseId: "synthetic-pair-expense-1", targetBankLineId: "synthetic-pair-line-1", qbPurchaseId: "2001", receiptUrl: RECEIPT_URL.replace("pair-0", "pair-1") });
    const e2 = selfExpense({ id: "synthetic-pair-expense-1", qbPurchaseId: "2001", receiptUrl: RECEIPT_URL.replace("pair-0", "pair-1") });
    const both = buildReviewedPairCensus(rows({ keys: [k2, key()], expenses: [e2, selfExpense()], observations: [obs({ id: "obs-1", sourceLineId: "2001" }), obs()] }));
    const alone = buildReviewedPairCensus(rows());
    assert.equal(pairCensusFingerprint(subsetPairCensus(both.snapshot, ["synthetic-pair-expense-0"])), pairCensusFingerprint(alone.snapshot));
    assert.notEqual(pairCensusFingerprint(both.snapshot), pairCensusFingerprint(alone.snapshot));
    const reordered = buildReviewedPairCensus(rows({ keys: [key(), k2], expenses: [selfExpense(), e2], observations: [obs(), obs({ id: "obs-1", sourceLineId: "2001" })] }));
    assert.equal(pairCensusFingerprint(reordered.snapshot), pairCensusFingerprint(both.snapshot));
    assert.deepEqual(both.evidence.eligible, ["synthetic-pair-expense-0", "synthetic-pair-expense-1"]);
});

test("the fingerprint moves with every fact the census read", async t => {
    const base = pairCensusFingerprint(buildReviewedPairCensus(rows()).snapshot);
    const variants: Array<[string, Partial<PairCensusRows>]> = [
        ["a new claim line", { lines: [lineRow()] }],
        ["a claim line's link state", { lines: [lineRow({ id: "synthetic-pair-line-0", qbTxnId: "2000" })] }],
        ["an observation link", { observations: [obs({ bankLineId: "synthetic-pair-line-0" })] }],
        ["a second observation", { observations: [obs(), obs({ id: "obs-1" })] }],
        ["the Expense sync-relevant fields", { expenses: [selfExpense({ status: "Pending" })] }],
        ["the Expense amount", { expenses: [selfExpense({ amount: "1.00" })] }],
        ["a dead intake alias appearing", { intakes: [intakeRow({ state: "DUPLICATE", expenseId: "synthetic-pair-expense-0" })] }],
        ["an intake alias state change", { intakes: [intakeRow({ state: "BOOKED", expenseId: "synthetic-pair-expense-0" })] }],
    ];
    for (const [label, over] of variants) {
        await t.test(label, () => assert.notEqual(pairCensusFingerprint(buildReviewedPairCensus(rows(over)).snapshot), base));
    }
});

test("the component version includes the census, and old fixtures still agree with themselves", () => {
    const a = pairCensusFingerprint(buildReviewedPairCensus(rows()).snapshot);
    const b = pairCensusFingerprint(buildReviewedPairCensus(rows({ lines: [lineRow()] })).snapshot);
    const fixture = { issues: [], intakes: [], lines: [{ id: "bl-1", rawDescriptor: "SYNTH", updatedAt: new Date(0) }], expenses: [] };
    const withA = componentVersionOf({ ...fixture, pairCensusFingerprint: a });
    const withB = componentVersionOf({ ...fixture, pairCensusFingerprint: b });
    assert.equal(withA.pairCensusHash, a);
    assert.equal(componentVersionsMatch(withA, withA), true);
    assert.equal(componentVersionsMatch(withA, withB), false, "a claim landing between plan and commit is a moved component");
    assert.equal(componentVersionOf(fixture).pairCensusHash, "");
    assert.equal(componentVersionsMatch(componentVersionOf(fixture), componentVersionOf(fixture)), true);
    assert.equal(componentVersionsMatch(componentVersionOf(fixture), withA), false);
});

// ── The loader, with injected fakes ───────────────────────────────────────

interface Call { model: string; args: Record<string, unknown> }

function fakeDb(data: { lines?: PairCensusLineRow[]; observations?: PairCensusObservationRow[]; expenses?: PairCensusExpenseRow[]; intakes?: PairCensusIntakeRow[] }): { db: PairCensusDb; calls: Call[] } {
    const calls: Call[] = [];
    const db: PairCensusDb = {
        bankLine: { findMany: async args => { calls.push({ model: "bankLine", args }); return data.lines ?? []; } },
        bankLineObservation: { findMany: async args => { calls.push({ model: "bankLineObservation", args }); return data.observations ?? []; } },
        // Prisma hands back a Decimal, not a string.
        expense: { findMany: async args => { calls.push({ model: "expense", args }); return (data.expenses ?? []).map(e => ({ ...e, amount: { toString: () => e.amount } })); } },
        receiptIntake: { findMany: async args => { calls.push({ model: "receiptIntake", args }); return data.intakes ?? []; } },
    };
    return { db, calls };
}

test("loader: queries every alias by exact identity across all accounts, states and dates, and decides from what came back", async () => {
    const { db, calls } = fakeDb({ observations: [obs()], expenses: [selfExpense()] });
    const census = await loadReviewedPairCensus(db, [key(), key()]);
    assert.deepEqual(census.evidence, { eligible: ["synthetic-pair-expense-0"], reservedUnits: [] });
    assert.deepEqual(calls.map(c => c.model), ["bankLine", "bankLineObservation", "expense", "receiptIntake"]);
    const [lines, observations, expenses, intakes] = calls.map(c => c.args);
    assert.deepEqual(lines.where, { OR: [{ id: { in: ["synthetic-pair-line-0"] } }, { qbTxnId: { in: ["2000"] } }, { probuildExpenseId: { in: ["synthetic-pair-expense-0"] } }] }, "the target itself plus every link alias; no account, state or date filter");
    assert.deepEqual(observations.where, { source: "QBO_REGISTER", sourceLineId: { in: ["2000"] } }, "no bankLineId or account filter");
    assert.deepEqual(expenses.where, { OR: [{ id: { in: ["synthetic-pair-expense-0"] } }, { qbPurchaseId: { in: ["2000"] } }, { receiptUrl: { in: [RECEIPT_URL] } }] }, "exact receipt URL, never a substring; no date window");
    assert.deepEqual(intakes.where, { OR: [{ qbPurchaseId: { in: ["2000"] } }, { postVoidQbPurchaseId: { in: ["2000"] } }, { expenseId: { in: ["synthetic-pair-expense-0"] } }] }, "every alias, any state");
    for (const args of [lines, observations, expenses, intakes]) assert.equal(args.take, REVIEWED_PAIR_CENSUS_CAP + 1);
    assert.equal(census.snapshot.pairs[0].expenses[0].amount, "555.55", "Decimal read through its string form");
});

test("loader: a pinned source file id widens the Expense query to the file's whole group, and an unknown group on either side conflicts", async () => {
    const FILE = "synthetic-drive-file";
    const { db, calls } = fakeDb({ expenses: [selfExpense({ sourceFileId: FILE, sourceGroupIndex: 0 })] });
    await loadReviewedPairCensus(db, [key({ sourceFileId: FILE, sourceGroupIndex: 0 })]);
    const expenses = calls.find(c => c.model === "expense")!.args;
    assert.deepEqual((expenses.where as { OR: unknown[] }).OR[3], { sourceFileId: { in: [FILE] } });
    // Through the real loader, both null/known directions and the known-unequal split.
    const alias = (group: number | null) => selfExpense({ id: "synthetic-alias", qbPurchaseId: "2999", receiptUrl: null, sourceFileId: FILE, sourceGroupIndex: group });
    const loaded = async (own: number | null, other: number | null) =>
        (await loadReviewedPairCensus(fakeDb({ expenses: [selfExpense({ sourceFileId: FILE, sourceGroupIndex: own }), alias(other)] }).db, [key({ sourceFileId: FILE, sourceGroupIndex: own })])).evidence;
    assert.deepEqual(await loaded(null, 0), { eligible: [], reservedUnits: ["expense:synthetic-pair-expense-0", "purchase:2000"] }, "pinned unknown group vs known alias group");
    assert.deepEqual(await loaded(0, null), { eligible: [], reservedUnits: ["expense:synthetic-pair-expense-0", "purchase:2000"] }, "pinned known group vs unknown alias group");
    assert.deepEqual(await loaded(null, null), { eligible: [], reservedUnits: ["expense:synthetic-pair-expense-0", "purchase:2000"] });
    assert.deepEqual(await loaded(0, 1), { eligible: ["synthetic-pair-expense-0"], reservedUnits: [] }, "two known, unequal groups stay a legitimate split");
});

test("loader: the target line's own link state is censused, and a target relinked to foreign ids conflicts", async () => {
    const relinked = lineRow({ id: "synthetic-pair-line-0", account: "WTB-0723", state: "POSTED", qbTxnId: "2999", probuildExpenseId: "synthetic-other-expense" });
    const census = await loadReviewedPairCensus(fakeDb({ lines: [relinked], observations: [obs()], expenses: [selfExpense()] }).db, [key()]);
    assert.deepEqual(census.snapshot.pairs[0].conflicts, ["target-link-mismatch"]);
    assert.deepEqual(census.evidence.eligible, []);
    // The target carrying exactly its own links is confirmation.
    const own = lineRow({ id: "synthetic-pair-line-0", account: "WTB-0723", state: "POSTED", qbTxnId: "2000", probuildExpenseId: "synthetic-pair-expense-0" });
    assert.deepEqual((await loadReviewedPairCensus(fakeDb({ lines: [own], observations: [obs()], expenses: [selfExpense()] }).db, [key()])).evidence.eligible, ["synthetic-pair-expense-0"]);
});

test("loader: no pairs means no queries and an empty census; overflow throws rather than truncating", async () => {
    const empty = fakeDb({});
    assert.deepEqual(await loadReviewedPairCensus(empty.db, []), { snapshot: { pairs: [] }, evidence: { eligible: [], reservedUnits: [] } });
    assert.deepEqual(empty.calls, []);
    const flood = fakeDb({ lines: Array.from({ length: 3 }, (_, i) => lineRow({ id: `line-${i}` })) });
    await assert.rejects(loadReviewedPairCensus(flood.db, [key()], { cap: 2 }), (e: unknown) => e instanceof ReviewedPairCensusOverflowError && e.name === "ReviewedPairCensusOverflowError");
    let budgetChecks = 0;
    await loadReviewedPairCensus(fakeDb({ expenses: [selfExpense()] }).db, [key()], { checkBudget: () => { budgetChecks++; } });
    assert.ok(budgetChecks >= 8, "budget checked before and after every read");
});

// ── Planner integration through the real loader ───────────────────────────

const RAW = "MISCELLANEOUS DEBIT PAYWEB *SYNTHMART 555-0100  NY C#1111 DBT CRD 0900 06/14/25 11111111";
const fact = {
    targetBankLineId: "synthetic-pair-line-0",
    target: { account: "WTB-0723", sourceOfRecord: "STATEMENT", postedDate: "2025-06-16", amountCents: -55555, rawDescriptor: RAW, checkNumber: null, bankAuthDate: "2025-06-14" },
    bankPayee: "PAYWEB *SYNTHMART 555-0100 NY", cardTail: "1111", purchaseDate: "2025-06-13", amountCents: 55555,
    expenseId: "synthetic-pair-expense-0", qbPurchaseId: "2000", receiptUrl: RECEIPT_URL, sourceFileId: null, sourceGroupIndex: null,
    sourceFactDigest: "a".repeat(64),
} as const;
const line = () => ({ id: "synthetic-pair-line-0", account: "WTB-0723", sourceOfRecord: "STATEMENT", postedDate: "2025-06-16", amountCents: -55555, rawDescriptor: RAW, checkNumber: null, qbTxnId: null, probuildExpenseId: null });
const expense = () => ({ id: "synthetic-pair-expense-0", qbPurchaseId: "2000", hasReceipt: true, amountCents: 55555, date: "2025-06-13", vendor: "SYNTHMART", linkedIntakeId: null, reviewedPairFact: fact });
// An ordinary competitor for the same unit, two days after the receipt, lone brand token.
const twin = () => ({ ...line(), id: "synthetic-twin", postedDate: "2025-06-15", rawDescriptor: "SYNTHMART ONLINE C#1111 DBT CRD 0900 06/14/25 22222222" });

test("planner: the pair closes only when the real census finds no competing global claim", async () => {
    const keys = reviewedPairCensusKeys([expense()]);
    assert.deepEqual(keys, [key()]);
    const clean = await loadReviewedPairCensus(fakeDb({ observations: [obs()], expenses: [selfExpense()] }).db, keys);
    const plan = planReceiptRequests({ sourceRecognitionEnabled: true, bankLines: [line()], expenses: [expense()], intakes: [], openIssueKeys: ["synthetic-pair-line-0"], pairCensus: clean.evidence, now: NOW });
    assert.deepEqual(plan.close, ["synthetic-pair-line-0"]);
    // No census at all is unknown, and unknown withholds the edge.
    const none = planReceiptRequests({ sourceRecognitionEnabled: true, bankLines: [line()], expenses: [expense()], intakes: [], openIssueKeys: ["synthetic-pair-line-0"], now: NOW });
    assert.deepEqual(none.close, []);
});

test("planner: a positive canonical claim or linked observation OUTSIDE the component reserves the unit from everyone", async () => {
    const worlds = [
        { lines: [lineRow({ id: "synthetic-far-line", account: "WTB-0723", state: "MATCHED", qbTxnId: "2000" })], observations: [obs()], expenses: [selfExpense()] },
        { observations: [obs({ bankLineId: "synthetic-far-line" })], expenses: [selfExpense()] },
        { observations: [obs()], expenses: [selfExpense(), selfExpense({ id: "synthetic-far-expense", qbPurchaseId: "2999" })] },
        { observations: [obs()], expenses: [selfExpense()], intakes: [intakeRow({ id: "synthetic-far-intake", qbPurchaseId: "2999", expenseId: "synthetic-pair-expense-0" })] },
        { observations: [obs()], expenses: [selfExpense()], intakes: [intakeRow({ id: "synthetic-far-intake", state: "NEEDS_REVIEW" })] },
    ];
    for (const world of worlds) {
        const census = await loadReviewedPairCensus(fakeDb(world).db, reviewedPairCensusKeys([expense()]));
        assert.equal(census.evidence.eligible.length, 0, JSON.stringify(world));
        const plan = planReceiptRequests({
            sourceRecognitionEnabled: true, bankLines: [line(), twin()], expenses: [expense()], intakes: [],
            openIssueKeys: ["synthetic-pair-line-0", "synthetic-twin"], pairCensus: census.evidence, now: NOW,
        });
        // Neither the named line (pair edge) nor the ordinary twin may spend a disputed receipt.
        assert.deepEqual(plan.close, [], JSON.stringify(world));
        assert.equal(plan.open.length, 2, JSON.stringify(world));
    }
});

test("planner: a target relinked to an unrelated purchase AND Expense is refused by the predicate even when the census sees no target row", async () => {
    // A fake whose line query returns nothing — the census cannot observe the target's
    // links at all and reports the pair eligible. The planner predicate must still
    // refuse the line, because the line it is judging carries foreign link state.
    const blind = await loadReviewedPairCensus(fakeDb({ observations: [obs()], expenses: [selfExpense()] }).db, reviewedPairCensusKeys([expense()]));
    assert.deepEqual(blind.evidence, { eligible: ["synthetic-pair-expense-0"], reservedUnits: [] });
    const relinked = { ...line(), qbTxnId: "2999", probuildExpenseId: "synthetic-other-expense" };
    const plan = planReceiptRequests({ sourceRecognitionEnabled: true, bankLines: [relinked], expenses: [expense()], intakes: [], openIssueKeys: [relinked.id], pairCensus: blind.evidence, now: NOW });
    assert.deepEqual(plan.close, []);
    assert.deepEqual(plan.open.map(o => o.targetKey), [relinked.id]);
    // And through the production bulk adapter, from the selected columns.
    const src = readFileSync(new URL("../src/app/api/cron/receipt-requests/route.ts", import.meta.url), "utf8");
    const expression = src.match(/bankLines: (lines\.map\(row => \(\{[\s\S]*?\}\)\)),/);
    assert.ok(expression);
    const adapt = new Function("lines", `return ${expression[1]};`) as (lines: unknown[]) => any[];
    const mapped = adapt([{ ...relinked, postedDate: new Date("2025-06-16T00:00:00Z"), updatedAt: new Date() }]);
    assert.equal(mapped[0].qbTxnId, "2999");
    assert.deepEqual(planReceiptRequests({ sourceRecognitionEnabled: true, bankLines: mapped, expenses: [expense()], intakes: [], openIssueKeys: [relinked.id], pairCensus: blind.evidence, now: NOW }).close, []);
    // The same line with its own links, through the same adapter, closes.
    const ownLinks = adapt([{ ...line(), qbTxnId: "2000", probuildExpenseId: "synthetic-pair-expense-0", postedDate: new Date("2025-06-16T00:00:00Z"), updatedAt: new Date() }]);
    assert.deepEqual(planReceiptRequests({ sourceRecognitionEnabled: true, bankLines: ownLinks, expenses: [expense()], intakes: [], openIssueKeys: [line().id], pairCensus: blind.evidence, now: NOW }).close, [line().id]);
});

test("planner: drift between the planned census and the locked re-read is a moved component", async () => {
    const keys = reviewedPairCensusKeys([expense()]);
    const planned = await loadReviewedPairCensus(fakeDb({ observations: [obs()], expenses: [selfExpense()] }).db, keys);
    const locked = await loadReviewedPairCensus(fakeDb({ observations: [obs({ bankLineId: "synthetic-far-line" })], expenses: [selfExpense()] }).db, keys);
    const stamp = (census: typeof planned) => componentVersionOf({ issues: [], intakes: [], lines: [], expenses: [], pairCensusFingerprint: pairCensusFingerprint(census.snapshot) });
    assert.equal(componentVersionsMatch(stamp(planned), stamp(planned)), true);
    assert.equal(componentVersionsMatch(stamp(planned), stamp(locked)), false);
});

// ── Route wiring ───────────────────────────────────────────────────────────

test("route: both adapters, the planned stamp and the locked re-read load the same census and feed it to the planner", () => {
    const src = readFileSync(new URL("../src/app/api/cron/receipt-requests/route.ts", import.meta.url), "utf8");
    assert.match(src, /@\/lib\/reviewed-pair-census/);
    assert.equal((src.match(/await loadReviewedPairCensus\(prisma, /g) ?? []).length, 2, "recompute and batch planning");
    assert.equal((src.match(/await loadReviewedPairCensus\(tx, /g) ?? []).length, 1, "locked re-read inside the component transaction");
    assert.equal((src.match(/pairCensus: pairCensus\.evidence,/g) ?? []).length, 2, "both planner calls consume the census verdicts");
    assert.equal((src.match(/pairCensusFingerprint: pairCensusFingerprint\(/g) ?? []).length, 2, "planned stamp and locked stamp");
    assert.match(src, /pairCensusFingerprint\(subsetPairCensus\(pairCensus\.snapshot, /, "the planned stamp takes this component's share");
    // The locked census keys come from the locked Expense rows, resolved through the same adapter.
    assert.match(src, /reviewedPairCensusKeys\(currentExpenses\.flatMap\(/);
    // The three Expense selects carry the pinned source identity the census and resolver compare.
    assert.equal((src.match(/receiptUrl: true, qbSyncToken: true, status: true, description: true, sourceFileId: true, sourceGroupIndex: true/g) ?? []).length, 3);
});

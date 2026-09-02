import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    appendCardRecord,
    competingLineFilter,
    evidenceUnitKey,
    hasResolution,
    mergeReceiptRequestDetails,
    payeeMatches,
    planReceiptRequests,
    type ReceiptEvidenceExpense,
    type ReceiptRequestBankLine,
} from "../src/lib/receipt-requests";

/**
 * Round-2 matcher rules: one-to-one evidence assignment, generic legal-suffix
 * tokens, resolutions that must not reopen, and the 14-day card history.
 * (Split from receipt-requests-matcher.test.ts only to keep that file readable.)
 */

const NOW = new Date("2026-08-20T09:00:00Z");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const line = (over: Partial<ReceiptRequestBankLine> = {}): ReceiptRequestBankLine => ({
    id: "bl-1",
    postedDate: "2026-08-16",
    amountCents: -12_345,
    rawDescriptor: "LOWES #02516 POS DEB C#8516",
    checkNumber: null,
    ...over,
});

const expense = (over: Partial<ReceiptEvidenceExpense> = {}): ReceiptEvidenceExpense => ({
    id: "exp-1",
    hasReceipt: true,
    amountCents: 12_345,
    date: "2026-08-16",
    vendor: "Lowe's Home Improvement",
    ...over,
});

function plan(over: {
    bankLines?: ReceiptRequestBankLine[];
    expenses?: ReceiptEvidenceExpense[];
    openIssueKeys?: string[];
    resolvedIssueKeys?: string[];
} = {}) {
    return planReceiptRequests({
        bankLines: over.bankLines ?? [line()],
        expenses: over.expenses ?? [],
        intakes: [],
        openIssueKeys: over.openIssueKeys ?? [],
        resolvedIssueKeys: over.resolvedIssueKeys ?? [],
        now: NOW,
    });
}

// ── One-to-one evidence assignment (Codex real issue 8) ─────────────────────

test("one receipt cannot answer for two identical charges", () => {
    const result = plan({
        bankLines: [line({ id: "bl-a" }), line({ id: "bl-b" })],
        expenses: [expense()],
    });
    assert.equal(result.open.length, 1, "the second charge is still chased");
    assert.equal(result.open[0].targetKey, "bl-b", "the lower-id line took the evidence");
});

test("two receipts answer two charges", () => {
    const result = plan({
        bankLines: [line({ id: "bl-a" }), line({ id: "bl-b" })],
        expenses: [expense({ id: "e1" }), expense({ id: "e2" })],
        openIssueKeys: ["bl-a", "bl-b"],
    });
    assert.deepEqual(result.open, []);
    assert.deepEqual([...result.close].sort(), ["bl-a", "bl-b"]);
});

test("closest date wins, so the far row stays free for the line it actually fits", () => {
    const result = plan({
        bankLines: [line({ id: "bl-a", postedDate: "2026-08-16" }), line({ id: "bl-b", postedDate: "2026-08-14" })],
        expenses: [expense({ id: "e-far", date: "2026-08-14" }), expense({ id: "e-near", date: "2026-08-16" })],
        openIssueKeys: ["bl-a", "bl-b"],
    });
    assert.deepEqual(result.open, [], "a greedy first-fit would have stranded one of these");
    assert.equal(result.close.length, 2);
});

test("input order never changes the outcome", () => {
    const lines = [line({ id: "bl-b", postedDate: "2026-08-16" }), line({ id: "bl-a", postedDate: "2026-08-15" })];
    const forward = plan({ bankLines: lines, expenses: [expense({ date: "2026-08-15" })] });
    const reversed = plan({ bankLines: [...lines].reverse(), expenses: [expense({ date: "2026-08-15" })] });
    assert.deepEqual(forward.open.map(o => o.targetKey), reversed.open.map(o => o.targetKey));
    assert.deepEqual(forward.open.map(o => o.targetKey), ["bl-b"]);
});

// ── Generic legal-suffix tokens (Codex real issue 8) ────────────────────────

test("a shared legal suffix is not merchant identity", async t => {
    await t.test("ACME LLC vs ZENITH LLC", () => assert.equal(payeeMatches("ACME LLC", "ZENITH LLC"), false));
    await t.test("THE", () => assert.equal(payeeMatches("THE ACME", "THE ZENITH"), false));
    await t.test("AND", () => assert.equal(payeeMatches("ACME AND SONS", "ZENITH AND DAUGHTERS"), false));
    await t.test("INC", () => assert.equal(payeeMatches("ACME INC", "ZENITH INC"), false));
    await t.test("CORP", () => assert.equal(payeeMatches("ACME CORP", "ZENITH CORP"), false));
    await t.test("the real name still matches through a suffix", () => {
        assert.equal(payeeMatches("ACME LLC", "Acme Supply"), true);
    });
    await t.test("a payee that is ONLY a suffix has no identity at all", () => {
        assert.equal(payeeMatches("LLC", "LLC"), false);
    });
});

// ── Resolutions (Codex blocker 4) ───────────────────────────────────────────

test("a resolved issue is answered evidence — it never reopens", () => {
    // The line is still unmatched, so without this it reopens every night and
    // the memo the owner signed to stop the nagging stops nothing.
    assert.deepEqual(plan({ resolvedIssueKeys: ["bl-1"] }), { open: [], close: [] });
});

test("clearing the resolution puts the line back in the chase", () => {
    assert.equal(plan({ resolvedIssueKeys: [] }).open.length, 1);
});

test("a resolved line is not reopened even when it also carries an open issue", () => {
    const result = plan({ resolvedIssueKeys: ["bl-1"], openIssueKeys: ["bl-1"] });
    assert.deepEqual(result, { open: [], close: [] });
});

test("mergeReceiptRequestDetails keeps answers and refreshes facts", () => {
    const merged = mergeReceiptRequestDetails(
        { owner: "CJ", amountCents: -1, resolution: "memo-signed", pdfUrl: "https://x/memo.pdf", cards: [{ n: 1 }], stale: "gone" },
        { owner: "Richard", amountCents: -12_345, payee: "LOWES" },
    );
    assert.equal(merged.owner, "Richard", "facts are recomputed nightly");
    assert.equal(merged.amountCents, -12_345);
    assert.equal(merged.resolution, "memo-signed", "the answer survives the sweep");
    assert.equal(merged.pdfUrl, "https://x/memo.pdf");
    assert.deepEqual(merged.cards, [{ n: 1 }]);
    assert.equal(merged.stale, undefined, "un-preserved keys are not carried forward");
});

test("hasResolution is exact — an empty string is not an answer", () => {
    assert.equal(hasResolution({ resolution: "memo-signed" }), true);
    assert.equal(hasResolution({ resolution: "" }), false);
    assert.equal(hasResolution({}), false);
    assert.equal(hasResolution(null), false);
});

// ── Card history retention (Codex blocker 6) ────────────────────────────────

const rec = (date: string, n = 1) => ({
    threadName: `t/${date}`, messageName: `m/${date}`, n, date, requestId: `receipt-req-CJ-${date}`,
});

test("appendCardRecord keeps 14 days of threads, not just the latest", () => {
    let details = appendCardRecord({}, rec("2026-08-18"), NOW);
    details = appendCardRecord(details, rec("2026-08-20", 3), NOW);
    assert.equal((details.cards as unknown[]).length, 2, "a reply in Monday's thread must still resolve");
    assert.equal((details.card as { n: number }).n, 3, "the single slot tracks the latest");
});

test("history older than the window drops out", () => {
    const aged = appendCardRecord({ cards: [rec("2026-08-01")] }, rec("2026-08-20"), NOW);
    assert.equal((aged.cards as unknown[]).length, 1);
    assert.equal((aged.cards as Array<{ date: string }>)[0].date, "2026-08-20");
});

test("a same-day repost replaces rather than stacking", () => {
    const again = { threadName: "t/2", messageName: "m/2", n: 1, date: "2026-08-20", requestId: "r" };
    const details = appendCardRecord({ cards: [rec("2026-08-20")] }, again, NOW);
    assert.equal((details.cards as unknown[]).length, 1);
    assert.equal((details.cards as Array<{ threadName: string }>)[0].threadName, "t/2");
});

test("a corrupt cards entry is dropped, never thrown on", () => {
    const details = appendCardRecord(
        { cards: ["nonsense", null, { date: 42 }, rec("2026-08-19")] },
        rec("2026-08-20", 2),
        NOW,
    );
    assert.equal((details.cards as unknown[]).length, 2);
});

test("appendCardRecord seeds cards[] from the legacy single slot", () => {
    // Rows written before cards[] existed carry a single `card`. Starting from
    // an empty array on their first write silently discarded the thread they
    // were last asked in — and every reply still sitting in it.
    const legacy = { card: { threadName: "t/old", messageName: "m/old", n: 1, date: "2026-08-19", requestId: "r" } };
    const details = appendCardRecord(legacy, rec("2026-08-20", 2), NOW);
    const cards = details.cards as Array<{ threadName: string }>;
    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map(c => c.threadName), ["t/old", "t/2026-08-20"]);
});

test("a legacy slot older than the window is still dropped on seeding", () => {
    const legacy = { card: { threadName: "t/ancient", messageName: "m", n: 1, date: "2026-07-01", requestId: "r" } };
    const details = appendCardRecord(legacy, rec("2026-08-20"), NOW);
    assert.equal((details.cards as unknown[]).length, 1);
});

test("seeding does not double-count when cards[] already exists", () => {
    const both = { cards: [rec("2026-08-19")], card: rec("2026-08-19") };
    const details = appendCardRecord(both, rec("2026-08-20", 2), NOW);
    assert.equal((details.cards as unknown[]).length, 2);
});

// ── One evidence UNIT per receipt (Codex round-2 item 7) ────────────────────

test("a booked intake and its Expense are ONE receipt, not two", () => {
    // Counting them separately let one piece of paper satisfy two charges —
    // the exact failure the one-to-one rule exists to prevent.
    const result = planReceiptRequests({
        bankLines: [line({ id: "bl-a" }), line({ id: "bl-b" })],
        expenses: [{ id: "exp-1", qbPurchaseId: "QB-1", hasReceipt: true, amountCents: 12_345, date: "2026-08-16", vendor: "Lowe's Home Improvement" }],
        intakes: [{ id: "int-1", expenseId: "exp-1", qbPurchaseId: "QB-1", totalCents: 12_345, txnDate: "2026-08-16", vendor: "Lowes", state: "BOOKED" }],
        openIssueKeys: [],
        resolvedIssueKeys: [],
        now: NOW,
    });
    assert.equal(result.open.length, 1, "one receipt answers exactly one charge");
});

test("they fold on qbPurchaseId alone when the expense link is absent", () => {
    const result = planReceiptRequests({
        bankLines: [line({ id: "bl-a" }), line({ id: "bl-b" })],
        expenses: [{ id: "exp-1", qbPurchaseId: "QB-1", hasReceipt: true, amountCents: 12_345, date: "2026-08-16", vendor: "Lowe's Home Improvement" }],
        intakes: [{ id: "int-1", expenseId: null, qbPurchaseId: "QB-1", totalCents: 12_345, txnDate: "2026-08-16", vendor: "Lowes", state: "BOOKED" }],
        openIssueKeys: [],
        resolvedIssueKeys: [],
        now: NOW,
    });
    assert.equal(result.open.length, 1);
});

test("an UNBOOKED intake and an unrelated expense stay two units", () => {
    // No shared identity — they really are two separate pieces of evidence.
    const result = planReceiptRequests({
        bankLines: [line({ id: "bl-a" }), line({ id: "bl-b" })],
        expenses: [{ id: "exp-1", qbPurchaseId: null, hasReceipt: true, amountCents: 12_345, date: "2026-08-16", vendor: "Lowe's Home Improvement" }],
        intakes: [{ id: "int-1", expenseId: null, qbPurchaseId: null, totalCents: 12_345, txnDate: "2026-08-16", vendor: "Lowes", state: "READ" }],
        openIssueKeys: [],
        resolvedIssueKeys: [],
        now: NOW,
    });
    assert.deepEqual(result.open, [], "two receipts, two charges");
});

test("evidenceUnitKey prefers the purchase id, then the expense link", () => {
    // Purchase id first because BOTH rows carry it once the receipt has booked,
    // so it is the identity they reliably agree on. The expense link only
    // exists when the intake happens to carry it — the email-fallback path
    // books an Expense with no intake at all.
    assert.equal(evidenceUnitKey({ expenseId: "e1", qbPurchaseId: "QB-1" }), "purchase:QB-1");
    assert.equal(evidenceUnitKey({ expenseId: "e1", qbPurchaseId: null }), "expense:e1");
    assert.equal(evidenceUnitKey({}), null, "unlinked rows are their own units");
});

test("they fold on the expense link when neither has a purchase id", () => {
    const result = planReceiptRequests({
        bankLines: [line({ id: "bl-a" }), line({ id: "bl-b" })],
        expenses: [{ id: "exp-1", qbPurchaseId: null, hasReceipt: true, amountCents: 12_345, date: "2026-08-16", vendor: "Lowe's Home Improvement" }],
        intakes: [{ id: "int-1", expenseId: "exp-1", qbPurchaseId: null, totalCents: 12_345, txnDate: "2026-08-16", vendor: "Lowes", state: "BOOKED" }],
        openIssueKeys: [],
        resolvedIssueKeys: [],
        now: NOW,
    });
    assert.equal(result.open.length, 1);
});

// ── Only real receipt evidence closes a chase (Codex round-3 P0 2) ──────────

test("a QBO-synced Expense with no receipt does NOT close the chase", () => {
    // The 4-hourly QBO sync creates an Expense for every finalized purchase,
    // receipt or no receipt. Counting those as evidence closed precisely the
    // cases this chaser exists to find.
    const result = plan({
        expenses: [expense({ hasReceipt: false, qbPurchaseId: "QB-1" })],
        openIssueKeys: [],
    });
    assert.equal(result.open.length, 1, "a receiptless expense IS the missing receipt");
});

test("the same Expense WITH a receiptUrl closes it", () => {
    const result = plan({ expenses: [expense({ hasReceipt: true })], openIssueKeys: ["bl-1"] });
    assert.deepEqual(result.open, []);
    assert.deepEqual(result.close, ["bl-1"]);
});

test("an open issue is NOT closed by a receiptless expense", () => {
    const result = plan({ expenses: [expense({ hasReceipt: false })], openIssueKeys: ["bl-1"] });
    assert.deepEqual(result.close, [], "closing here would silence a real gap");
    assert.equal(result.open.length, 1);
});

test("a live ReceiptIntake still closes it on its own — an intake IS a receipt", () => {
    const result = planReceiptRequests({
        bankLines: [line()],
        expenses: [expense({ hasReceipt: false })],
        intakes: [{ id: "int-1", totalCents: 12_345, txnDate: "2026-08-16", vendor: "Lowes", state: "READ" }],
        openIssueKeys: ["bl-1"],
        resolvedIssueKeys: [],
        now: NOW,
    });
    assert.deepEqual(result.close, ["bl-1"]);
});

test("the cron derives hasReceipt from receiptUrl OR a linked intake", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /hasReceipt: !!row\.receiptUrl \|\| row\.receiptIntake !== null/);
    assert.match(source, /receiptIntake: \{ select: \{ id: true \} \}/);
});

// ── Two charges, one receipt, under concurrency (Codex round-4 item 2) ──────

test("the competing set is what must be recomputed together, never one line", () => {
    // One-to-one assignment is a property of the BATCH. Two identical charges
    // and one receipt resolve differently depending on which is considered
    // first, so a retry that recomputed a single line saw "a receipt exists"
    // and closed a charge whose receipt had already gone to its twin.
    const a = line({ id: "bl-a", postedDate: "2026-08-16" });
    const b = line({ id: "bl-b", postedDate: "2026-08-16" });

    const batch = plan({ bankLines: [a, b], expenses: [expense()], openIssueKeys: ["bl-a", "bl-b"] });
    assert.equal(batch.open.length, 1, "exactly one of the two keeps its chase");
    assert.deepEqual(batch.close, ["bl-a"], "and exactly one closes");
    const stillOpen = batch.open[0].targetKey;
    assert.equal(stillOpen, "bl-b");

    // The isolated recompute — what the retry path used to do — reaches the
    // OPPOSITE verdict for the line that should stay open.
    const isolated = plan({ bankLines: [b], expenses: [expense()], openIssueKeys: ["bl-b"] });
    assert.deepEqual(isolated.close, ["bl-b"], "this is the bug: in isolation it closes");
    assert.equal(isolated.open.length, 0);

    // Recomputing the whole competing set reproduces the batch's verdict.
    const wholeSet = plan({ bankLines: [a, b], expenses: [expense()], openIssueKeys: ["bl-a", "bl-b"] });
    assert.ok(wholeSet.open.some(o => o.targetKey === stillOpen), "the set-wide answer is stable");
});

test("competingLineFilter spans both directions of the match window", () => {
    const f = competingLineFilter({ amountCents: -12_345, postedDate: "2026-08-16" });
    assert.equal(f.amountCents, -12_345, "a different amount can never claim the same receipt");
    // Twice the ±2-day match window, so a competitor that could reach the same
    // evidence from the far side is still in the set.
    assert.equal(f.from, "2026-08-12");
    assert.equal(f.to, "2026-08-20");
});

test("two concurrent sweeps cannot both give one receipt away", async () => {
    // A durable lease is what makes this true: the second run does no work at
    // all. Modelled here as the lease's observable consequence — exactly one
    // run reconciles, so the batch verdict is applied once.
    const applied: string[][] = [];
    let leaseHeld = false;
    const runSweep = async () => {
        if (leaseHeld) return null;          // takeRunLease returned null
        leaseHeld = true;
        // The lease is held ACROSS the work, not released in the same tick —
        // that is the difference from the advisory claim it replaced, and
        // without this the fake would not model the bug at all.
        await new Promise(resolve => setTimeout(resolve, 0));
        try {
            const result = plan({
                bankLines: [line({ id: "bl-a" }), line({ id: "bl-b" })],
                expenses: [expense()],
                openIssueKeys: [],
            });
            applied.push(result.open.map(o => o.targetKey));
            return result;
        } finally {
            leaseHeld = false;
        }
    };
    const [first, second] = await Promise.all([runSweep(), runSweep()]);
    assert.ok(first !== null, "one run does the work");
    assert.equal(second, null, "the other does nothing at all");
    assert.equal(applied.length, 1);
    assert.deepEqual(applied[0], ["bl-b"], "one charge keeps its chase, exactly once");
});

test("the sweep holds a DURABLE lease, not a released advisory claim", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    // The lease now lives in the shared src/lib/cron-lease.ts helper.
    assert.match(source, /takeLease\(LEASE_KEY, RUN_LEASE_MS, now, leaseToken\)/);
    // Taken before the work and released after it, not committed away first.
    const takeAt = source.indexOf("await takeLease(LEASE_KEY");
    const workAt = source.indexOf("return await runSweep(now);");
    const releaseAt = source.indexOf("await releaseLease(LEASE_KEY");
    assert.ok(takeAt > 0 && workAt > takeAt && releaseAt > workAt);
    // And the retry path recomputes the SET.
    assert.match(source, /competingLineFilter\(/);
    assert.match(source, /prisma\.bankLine\.findMany\(\{\s*\n\s*where: \{ amountCents: competing\.amountCents/);
});

test("the sweep resumes from a durable cursor, oldest-first", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /orderBy: \[\{ postedDate: "asc" \}, \{ id: "asc" \}\]/,
        "newest-first silently abandoned older candidates behind the cap");
    assert.match(source, /const resumeFrom = await readCursor\(\);/);
    assert.match(source, /cursor: \{ id: resumeFrom \}, skip: 1/);
    assert.match(source, /await writeCursor\(batchWasFull \? lastId : null\);/);
});

// ── Allocation spans the whole cohort, not one page (round-5 item 3) ────────

test("a receipt allocated on one page cannot be re-allocated on the next", () => {
    // Paging split competing lines across runs, so the same receipt satisfied a
    // second charge and that chase closed for good. The cron expands every page
    // to its cohort before the matcher runs; this is the property that buys.
    const page1 = [line({ id: "bl-a", postedDate: "2026-08-16" })];
    const page2 = [line({ id: "bl-b", postedDate: "2026-08-16" })];
    const receipt = [expense()];

    // Naive paging: each page sees the receipt and both close. That is the bug.
    assert.deepEqual(plan({ bankLines: page1, expenses: receipt, openIssueKeys: ["bl-a"] }).close, ["bl-a"]);
    assert.deepEqual(plan({ bankLines: page2, expenses: receipt, openIssueKeys: ["bl-b"] }).close, ["bl-b"]);

    // Cohort-expanded: one closes, one keeps its chase.
    const cohort = plan({ bankLines: [...page1, ...page2], expenses: receipt, openIssueKeys: ["bl-a", "bl-b"] });
    assert.deepEqual(cohort.close, ["bl-a"]);
    assert.equal(cohort.open.length, 1);
    assert.equal(cohort.open[0].targetKey, "bl-b");
});

test("the cohort holds across a MAX_BANK_LINES-sized gap", () => {
    // The two competitors are 2000 rows apart in id order but share an
    // identity, so they must still be judged together.
    const filler = Array.from({ length: 2_000 }, (_, i) =>
        line({ id: `bl-filler-${String(i).padStart(4, "0")}`, amountCents: -900 - i, postedDate: "2026-08-16" }));
    const result = plan({
        bankLines: [line({ id: "bl-a" }), ...filler, line({ id: "bl-z" })],
        expenses: [expense()],
        openIssueKeys: ["bl-a", "bl-z"],
    });
    assert.deepEqual(result.close, ["bl-a"], "the first competitor takes the receipt");
    assert.ok(result.open.some(o => o.targetKey === "bl-z"), "the far one is still chased");
});

test("the sweep expands each page to its competing cohort before matching", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /const cohortFilters = windowLines\.map\(row => competingLineFilter\(/);
    // And the cohort is merged in before planReceiptRequests is called.
    // lastIndexOf: recomputeCodesFor calls the matcher too, earlier in the file.
    const cohortAt = source.indexOf("const cohortRows =");
    const planAt = source.lastIndexOf("const plan = planReceiptRequests(");
    assert.ok(cohortAt > 0 && planAt > cohortAt, "the cohort must be merged in BEFORE the sweep's match");
});

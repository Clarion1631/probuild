import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    appendCardRecord,
    competingLineFilter,
    evidenceComponents,
    groupCompetingLines,
    isComponentKey,
    isDurableArtifactUrl,
    pageComponents,
    payeeSignificantTokens,
    payeeTokens,
    GENERIC_PAYEE_TOKENS,
    PAYEE_STOP_WORDS,
    matchEvidenceToLines,
    evidenceUnitKey,
    hasResolution,
    mergeReceiptRequestDetails,
    payeeMatches,
    planReceiptRequests,
    type ReceiptEvidenceExpense,
    type ReceiptRequestBankLine,
} from "../src/lib/receipt-requests";
import { NO_ARTIFACT_STATE_REASONS } from "../src/lib/receipt-intake/route-state";

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
    assert.deepEqual(plan({ resolvedIssueKeys: ["bl-1"] }), { open: [], close: [], undecided: [] });
});

test("clearing the resolution puts the line back in the chase", () => {
    assert.equal(plan({ resolvedIssueKeys: [] }).open.length, 1);
});

test("a resolved line is never REOPENED, whatever its issue state", () => {
    for (const openIssueKeys of [[], ["bl-1"]]) {
        assert.deepEqual(plan({ resolvedIssueKeys: ["bl-1"], openIssueKeys }).open, [], JSON.stringify(openIssueKeys));
    }
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
    // Wide enough to contain a whole CHAIN, not just direct neighbours: A and C
    // may never touch each other yet both touch B, and splitting that component
    // across two queries matches it wrongly in each.
    assert.equal(f.from, "2026-08-08");
    assert.equal(f.to, "2026-08-24");
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
    const workAt = source.indexOf("return await runSweep(now");
    const releaseAt = source.indexOf("await releaseLease(LEASE_KEY");
    assert.ok(takeAt > 0 && workAt > takeAt && releaseAt > workAt);
    // And the retry path recomputes the SET.
    assert.match(source, /competingLineFilter\(/);
    // The retry path now walks the component to closure rather than querying a
    // fixed window — same intent, and the walk carries the seed's amount.
    assert.match(source, /loadComponentToClosure\(/);
    assert.match(source, /amountCents: seed\.amountCents,/);
});

test("the sweep resumes from a durable cursor, oldest-first", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(source, /orderBy: \[\{ postedDate: "asc" \}, \{ id: "asc" \}\]/,
        "newest-first silently abandoned older candidates behind the cap");
    assert.match(source, /let cursor = await readCursor\(\);/);
    // The cursor is a COMPONENT KEY, not a line id: resuming inside a
    // competition set is what let one receipt close two charges.
    assert.match(source, /const resumeFrom = isComponentKey\(cursor\) \? cursor : null;/);
    assert.match(source, /components\.filter\(component => component\.key > resumeFrom\)/);
    assert.doesNotMatch(source, /cursor: \{ id: cursor \}, skip: 1/, "id paging is gone");
    // Checkpointed after EVERY page, so a run that dies loses one page.
    assert.match(source, /cursor = page\[page\.length - 1\]\.key;\s*\n\s*await writeCursor\(cursor\);/);
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
    assert.match(source, /const cohortFilters = batch\.map\(row => competingLineFilter\(/);
    // COHORT, then EVIDENCE for the cohort's span, then DECIDE — in that order.
    // The window branch: the LINE pass still uses the cheap same-amount query.
    const cohortAt = source.indexOf("const cohortFilters = batch.map(row => competingLineFilter(");
    // Searched AFTER the cohort: the recompute path has its own evidence load,
    // earlier in the file, and this test is about the BATCH path's ordering.
    const evidenceAt = source.indexOf("const \[expenseRows, intakeRows\] = await Promise.all([".replace(/\\/g, ""), cohortAt);
    const planAt = source.indexOf("const fullPlan = planReceiptRequests({", cohortAt);
    assert.ok(cohortAt > 0 && evidenceAt > cohortAt, "evidence must be loaded AFTER the cohort is known");
    assert.ok(planAt > evidenceAt, "and the decision comes last");
    // The loaded window is declared, so the matcher can decline to judge
    // anything it falls outside.
    assert.match(source, /evidenceLoadedFrom: fromYmd/);
});

// ── No decision without a fully-loaded evidence window (round-6 item 8) ─────

test("a line whose evidence window was not fully loaded emits NO decision", () => {
    // "No receipt found" must never be able to mean "we did not look". Judging
    // a line against evidence the caller never loaded opens a chase for a
    // charge that is perfectly well documented.
    const result = planReceiptRequests({
        bankLines: [line({ id: "bl-edge", postedDate: "2026-08-16" })],
        expenses: [],
        intakes: [],
        openIssueKeys: [],
        resolvedIssueKeys: [],
        // The line needs 08-14..08-18; only 08-15 onward was loaded.
        evidenceLoadedFrom: "2026-08-15",
        evidenceLoadedTo: "2026-08-30",
        now: NOW,
    });
    assert.deepEqual(result.open, [], "not opened");
    assert.deepEqual(result.close, [], "and not closed either");
    assert.deepEqual(result.undecided, ["bl-edge"], "reported, so the cursor cannot skip it");
});

test("the boundary is EXACT: window fully covered decides, one day short does not", () => {
    const judge = (from: string, to: string) => planReceiptRequests({
        bankLines: [line({ id: "bl-edge", postedDate: "2026-08-16" })],
        expenses: [], intakes: [], openIssueKeys: [], resolvedIssueKeys: [],
        evidenceLoadedFrom: from, evidenceLoadedTo: to, now: NOW,
    });

    // Exactly ±2 days is enough.
    const covered = judge("2026-08-14", "2026-08-18");
    assert.deepEqual(covered.undecided, []);
    assert.equal(covered.open.length, 1);

    // One day short on either side is not.
    assert.deepEqual(judge("2026-08-15", "2026-08-18").undecided, ["bl-edge"]);
    assert.deepEqual(judge("2026-08-14", "2026-08-17").undecided, ["bl-edge"]);
});

test("omitting the bounds means 'everything was loaded'", () => {
    // Callers that genuinely load every row must not be forced to declare it.
    const result = plan();
    assert.deepEqual(result.undecided, []);
    assert.equal(result.open.length, 1);
});

test("an undecided line is not counted as satisfied — its evidence stays free", () => {
    // The undecided line must not silently consume the receipt its neighbour
    // needs, or skipping it would corrupt the neighbour's verdict too.
    const result = planReceiptRequests({
        bankLines: [
            line({ id: "bl-edge", postedDate: "2026-08-16" }),
            line({ id: "bl-ok", postedDate: "2026-08-20" }),
        ],
        expenses: [expense({ date: "2026-08-20" })],
        intakes: [], openIssueKeys: ["bl-ok"], resolvedIssueKeys: [],
        evidenceLoadedFrom: "2026-08-17", evidenceLoadedTo: "2026-08-30",
        now: new Date("2026-08-25T09:00:00Z"),
    });
    assert.deepEqual(result.undecided, ["bl-edge"]);
    assert.deepEqual(result.close, ["bl-ok"], "the in-window line still gets its receipt");
});

// ── Maximum-cardinality matching (round-7 item 2) ──────────────────────────

test("the 14/16 vs 12/15 counterexample: greedy loses a match, this does not", () => {
    // Charges on the 14th and 16th; receipts on the 12th and 15th.
    // Greedy nearest-first: the 14th takes the 15th (distance 1), leaving the
    // 16th only the 12th — four days out, outside the window — so it opens a
    // chase for a receipt sitting right there. 14↔12 and 16↔15 answers both.
    const result = planReceiptRequests({
        bankLines: [
            line({ id: "bl-14", postedDate: "2026-08-14" }),
            line({ id: "bl-16", postedDate: "2026-08-16" }),
        ],
        expenses: [
            expense({ id: "e-12", date: "2026-08-12" }),
            expense({ id: "e-15", date: "2026-08-15" }),
        ],
        intakes: [],
        openIssueKeys: ["bl-14", "bl-16"],
        resolvedIssueKeys: [],
        now: NOW,
    });
    assert.deepEqual(result.open, [], "both charges are answered");
    assert.deepEqual([...result.close].sort(), ["bl-14", "bl-16"]);
});

test("matching is deterministic across runs and input orders", () => {
    const build = (reverse: boolean) => {
        const lines = [
            line({ id: "bl-14", postedDate: "2026-08-14" }),
            line({ id: "bl-16", postedDate: "2026-08-16" }),
        ];
        const ev = [
            expense({ id: "e-12", date: "2026-08-12" }),
            expense({ id: "e-15", date: "2026-08-15" }),
        ];
        return planReceiptRequests({
            bankLines: reverse ? [...lines].reverse() : lines,
            expenses: reverse ? [...ev].reverse() : ev,
            intakes: [], openIssueKeys: ["bl-14", "bl-16"], resolvedIssueKeys: [], now: NOW,
        });
    };
    assert.deepEqual([...build(false).close].sort(), [...build(true).close].sort());
});

test("a genuinely unmatchable line still opens", () => {
    // One receipt, two charges: maximum matching answers ONE of them, never
    // both and never neither.
    const result = planReceiptRequests({
        bankLines: [
            line({ id: "bl-a", postedDate: "2026-08-16" }),
            line({ id: "bl-b", postedDate: "2026-08-16" }),
        ],
        expenses: [expense()],
        intakes: [], openIssueKeys: ["bl-a", "bl-b"], resolvedIssueKeys: [], now: NOW,
    });
    assert.equal(result.close.length, 1);
    assert.equal(result.open.length, 1);
});

test("matchEvidenceToLines assigns each evidence unit at most once", () => {
    const assigned = matchEvidenceToLines(
        [
            { id: "bl-14", postedDate: "2026-08-14", payee: "LOWES #02516", amountCents: -12_345 },
            { id: "bl-16", postedDate: "2026-08-16", payee: "LOWES #02516", amountCents: -12_345 },
        ],
        [
            { id: "expense:e-12", unit: "expense:e-12", amountCents: 12_345, date: "2026-08-12", vendor: "Lowe's Home Improvement" },
            { id: "expense:e-15", unit: "expense:e-15", amountCents: 12_345, date: "2026-08-15", vendor: "Lowe's Home Improvement" },
        ],
    );
    assert.equal(assigned.size, 2);
    const units = [...assigned.values()].map(row => row.unit);
    assert.equal(new Set(units).size, units.length, "no unit is handed to two lines");
});

// ── Competition is a CONNECTED COMPONENT (round-10 item 4) ─────────────────

test("the 1/5/9 vs 3/7 chain: every charge is answered", () => {
    // Charges on the 1st, 5th and 9th; receipts on the 3rd and 7th.
    // Reachability (±2 days): 1↔3, 5↔3, 5↔7, 9↔7. The 1st and the 9th share no
    // candidate at all, yet both compete with the 5th — so they are ONE
    // component and have to be matched together. Two receipts, three charges:
    // the right answer is exactly two closes and one open, and WHICH one stays
    // open must not depend on the order they were seen in.
    const result = planReceiptRequests({
        bankLines: [
            line({ id: "bl-1", postedDate: "2026-08-01" }),
            line({ id: "bl-5", postedDate: "2026-08-05" }),
            line({ id: "bl-9", postedDate: "2026-08-09" }),
        ],
        expenses: [
            expense({ id: "e-3", date: "2026-08-03" }),
            expense({ id: "e-7", date: "2026-08-07" }),
        ],
        intakes: [],
        openIssueKeys: ["bl-1", "bl-5", "bl-9"],
        resolvedIssueKeys: [],
        now: new Date("2026-08-20T09:00:00Z"),
    });
    // MAXIMUM CARDINALITY is the property that matters: two receipts must
    // answer two charges. A date-ordered pass over a same-amount bucket can
    // strand a receipt here and answer only one.
    assert.equal(result.close.length, 2, "both receipts are used");
    assert.equal(result.open.length, 1, "and exactly one charge is still chased");
    // WHICH one is left over is a free choice between equally-maximum
    // matchings; the contract is that it is the same one every run (see the
    // determinism test below), not that it is any particular charge.
    assert.equal(new Set([...result.close, result.open[0].targetKey]).size, 3);
});

test("the chain's outcome does not depend on input order", () => {
    const build = (order: string[]) => planReceiptRequests({
        bankLines: order.map(id => line({ id: `bl-${id}`, postedDate: `2026-08-0${id}` })),
        expenses: [expense({ id: "e-3", date: "2026-08-03" }), expense({ id: "e-7", date: "2026-08-07" })],
        intakes: [], openIssueKeys: [], resolvedIssueKeys: [],
        now: new Date("2026-08-20T09:00:00Z"),
    });
    const a = build(["1", "5", "9"]).open.map(o => o.targetKey);
    const b = build(["9", "5", "1"]).open.map(o => o.targetKey);
    assert.deepEqual(a, b, "the same charge is left over whatever order they arrive in");
    assert.equal(a.length, 1);
});

test("evidenceComponents links lines through a SHARED receipt, not by date bucket", () => {
    const ev = (unit: string, date: string) => ({
        id: unit, unit, amountCents: 12_345, date, vendor: "Lowe's Home Improvement",
    });
    const candidates = new Map([
        ["bl-1", [ev("e-3", "2026-08-03")]],
        ["bl-5", [ev("e-3", "2026-08-03"), ev("e-7", "2026-08-07")]],
        ["bl-9", [ev("e-7", "2026-08-07")]],
    ]);
    const components = evidenceComponents([{ id: "bl-1" }, { id: "bl-5" }, { id: "bl-9" }], candidates);
    assert.equal(components.length, 1, "the chain is ONE component");
    assert.deepEqual([...components[0]].sort(), ["bl-1", "bl-5", "bl-9"]);
});

test("lines that share no evidence are SEPARATE components", () => {
    const ev = (unit: string, date: string) => ({
        id: unit, unit, amountCents: 1, date, vendor: "V",
    });
    const components = evidenceComponents(
        [{ id: "a" }, { id: "b" }],
        new Map([["a", [ev("e-a", "2026-08-01")]], ["b", [ev("e-b", "2026-08-20")]]]),
    );
    assert.equal(components.length, 2);
});

test("a line with no candidate evidence is its own component", () => {
    const components = evidenceComponents([{ id: "lonely" }], new Map());
    assert.deepEqual(components, [["lonely"]]);
});

test("the query filter is wide enough to CONTAIN a chain", () => {
    // A ±2-day filter around the 1st would stop at the 3rd and never reach the
    // 9th, so the component would be split across two queries and matched
    // wrongly in each.
    const f = competingLineFilter({ amountCents: -12_345, postedDate: "2026-08-05" });
    assert.ok(f.from <= "2026-08-01", `${f.from} must reach the chain's far end`);
    assert.ok(f.to >= "2026-08-09", `${f.to} must reach the chain's far end`);
});

// ── Competition components, computed BEFORE paging (round-11 item 1) ────────

test("competing lines land in ONE component even when they straddle a page", () => {
    // THE BUG: pages were cut by line id, so a set of lines competing for one
    // receipt could fall either side of the 200th row. Each half then matched
    // against the same evidence without knowing about the other, and one
    // receipt closed two charges.
    const BATCH = 200;
    const filler = Array.from({ length: 260 }, (_, i) => ({
        // Distinct amounts, so filler never competes with anything.
        id: `L${String(i).padStart(4, "0")}`,
        postedDate: "2026-08-10",
        amountCents: -(1_000 + i),
    }));
    // Two charges for the same amount, one day apart, whose ids sit either side
    // of the batch boundary in id order.
    const twinA = { id: "L0198", postedDate: "2026-08-10", amountCents: -4_600 };
    const twinB = { id: "L0203", postedDate: "2026-08-11", amountCents: -4_600 };
    const lines = [...filler.filter(l => l.id !== twinA.id && l.id !== twinB.id), twinA, twinB];

    const components = groupCompetingLines(lines);
    const withTwinA = components.find(c => c.lineIds.includes("L0198"));
    assert.ok(withTwinA);
    assert.deepEqual(withTwinA.lineIds, ["L0198", "L0203"], "the twins are ONE component");

    const pages = pageComponents(components, BATCH);
    const pageOfA = pages.findIndex(page => page.some(c => c.lineIds.includes("L0198")));
    const pageOfB = pages.findIndex(page => page.some(c => c.lineIds.includes("L0203")));
    assert.equal(pageOfA, pageOfB, "and one component is never split across pages");

    // The control: the OLD scheme really did split them, so this test would
    // have failed before the fix rather than passing for free.
    const idOrder = [...lines].sort((a, b) => (a.id < b.id ? -1 : 1)).map(l => l.id);
    assert.notEqual(
        Math.floor(idOrder.indexOf("L0198") / BATCH),
        Math.floor(idOrder.indexOf("L0203") / BATCH),
        "id-order paging put the twins on different pages",
    );

    // Every line is still accounted for, exactly once.
    const paged = pages.flatMap(page => page.flatMap(c => c.lineIds)).sort();
    assert.deepEqual(paged, lines.map(l => l.id).sort());
});

test("component membership is TRANSITIVE along the date chain", () => {
    // 1st ↔ 3rd ↔ 5th: the 1st and the 5th share no candidate directly (4 days
    // is the widest a single receipt can reach), but re-housing the 1st frees
    // the only receipt the 5th can take.
    const amountCents = -4_600;
    const components = groupCompetingLines([
        { id: "a", postedDate: "2026-08-01", amountCents },
        { id: "b", postedDate: "2026-08-03", amountCents },
        { id: "c", postedDate: "2026-08-05", amountCents },
        // Same amount, far away: a different component.
        { id: "far", postedDate: "2026-08-20", amountCents },
        // Same day, different amount: also a different component.
        { id: "other", postedDate: "2026-08-03", amountCents: -4_601 },
    ]);
    const keyed = new Map(components.map(c => [c.lineIds.join(","), c]));
    assert.ok(keyed.has("a,b,c"), `expected a,b,c together; got ${[...keyed.keys()].join(" | ")}`);
    assert.ok(keyed.has("far"));
    assert.ok(keyed.has("other"));
});

test("a component larger than the page size gets its own page, never a split", () => {
    const amountCents = -4_600;
    const big = Array.from({ length: 7 }, (_, i) => ({
        id: `big-${i}`,
        postedDate: `2026-08-${String(i + 1).padStart(2, "0")}`,
        amountCents,
    }));
    const pages = pageComponents(groupCompetingLines(big), 3);
    assert.equal(pages.length, 1);
    assert.equal(pages[0][0].lineIds.length, 7, "correctness beats page size");
});

test("component keys sort chronologically and survive as a resume cursor", () => {
    const components = groupCompetingLines([
        { id: "z", postedDate: "2026-08-20", amountCents: -1 },
        { id: "a", postedDate: "2026-08-01", amountCents: -2 },
    ]);
    assert.deepEqual(components.map(c => c.key), ["2026-08-01|a", "2026-08-20|z"]);
    assert.equal(isComponentKey("2026-08-01|a"), true);
    // A cursor left by the OLD id-paging build is not a component key, so the
    // sweep restarts the cycle instead of silently skipping the whole window.
    assert.equal(isComponentKey("cmpd6xca1009x1iizdf4suln3"), false);
    assert.equal(isComponentKey(null), false);
});

// ── A signed memo needs a durable artifact (round-11 item 6) ────────────────

test("only a Drive or Storage URL counts as a durable artifact", () => {
    for (const good of [
        "https://drive.google.com/file/d/1abc/view",
        "https://docs.google.com/document/d/1abc/edit",
        "https://lh3.googleusercontent.com/d/1abc",
        "https://ghzdbzdnwjxazvmcefbh.supabase.co/storage/v1/object/sign/secure-docs/memo.pdf",
    ]) {
        assert.equal(isDurableArtifactUrl(good), true, good);
    }
    for (const bad of [
        // Not https.
        "http://drive.google.com/file/d/1abc/view",
        // Not an artifact host at all — this is the case that used to close a
        // chase on nothing but a forwarder's say-so.
        "https://example.com/memo.pdf",
        // Our own project, but not an object path.
        "https://ghzdbzdnwjxazvmcefbh.supabase.co/",
        // Look-alike hosts.
        "https://drive.google.com.evil.test/file",
        "https://notgoogleusercontent.com/d/1abc",
        "",
        "not a url",
        null,
        undefined,
        42,
        `https://drive.google.com/${"x".repeat(2_100)}`,
    ]) {
        assert.equal(isDurableArtifactUrl(bad), false, String(bad).slice(0, 60));
    }
});

// ── Payee identity is a NAME, not a shared token (round-14 item 4) ──────────

test("adversarial: near-miss merchants must NOT agree", () => {
    // Each of these shares a token, and the old rule matched on exactly that —
    // so a chase closed against a receipt belonging to a different shop.
    for (const [a, b, why] of [
        ["HOME DEPOT #4718", "HOME GOODS", "HOME is an industry word, not a merchant"],
        ["HOME DEPOT", "HOME GOODS #12", "same, other way round"],
        ["PACIFIC PLUMBING", "PACIFIC SUPPLY", "a regional prefix plus two different trades"],
        ["PACIFIC PLUMBING SUPPLY", "PACIFIC ELECTRIC SUPPLY", "shared prefix AND shared suffix"],
        ["ACME", "ZENITH HARDWARE", "nothing in common at all"],
        ["ACME HARDWARE", "ZENITH HARDWARE", "only the trade in common"],
        ["ACME LLC", "ZENITH LLC", "only a legal suffix in common"],
        ["SEATTLE MARKET", "TACOMA MARKET", "only the trade in common"],
        ["HOME", "HOME DEPOT", "a lone INDUSTRY word may never carry a match"],
        ["SUPPLY", "PACIFIC SUPPLY", "same"],
        ["STORE 4718", "SHOP 4718", "a store number is not identity"],
    ] as const) {
        assert.equal(payeeMatches(a, b), false, `${a} ↔ ${b} — ${why}`);
        assert.equal(payeeMatches(b, a), false, `${b} ↔ ${a} (symmetric)`);
    }
});

test("the real-world shapes still agree", () => {
    for (const [a, b, why] of [
        ["LOWES #02516", "Lowe's Home Improvement", "lone brand token leads the vendor name"],
        ["LOWES #02516 POS DEB C#8516", "Lowes", "same name once the rail noise is gone"],
        ["HOME DEPOT #4718", "Home Depot", "identical bigram, store number dropped"],
        ["HOMEDEPOT.COM", "Home Depot", "one word or two, plus a TLD that names nothing"],
        ["ACME HARDWARE", "ACME HARDWARE INC", "a legal suffix changes no identity"],
        ["PACIFIC PLUMBING SUPPLY", "PACIFIC PLUMBING", "leading bigram agrees"],
        ["MCDONALD'S", "MCDONALDS", "a possessive BINDS, it does not split"],
    ] as const) {
        assert.equal(payeeMatches(a, b), true, `${a} ↔ ${b} — ${why}`);
        assert.equal(payeeMatches(b, a), true, `${b} ↔ ${a} (symmetric)`);
    }
});

test("the token lists say what they are for", () => {
    // Stop words name nothing and are dropped outright; industry words are real
    // parts of a name but may not carry a match alone — which is why DEPOT is
    // in the generic list and "HOME DEPOT" still matches "HOME DEPOT".
    for (const word of ["LLC", "INC", "THE", "STORE", "COM"]) {
        assert.ok(PAYEE_STOP_WORDS.has(word), word);
        assert.deepEqual(payeeTokens(`ACME ${word}`), ["ACME"], `${word} is dropped`);
    }
    for (const word of ["HOME", "SUPPLY", "HARDWARE", "PLUMBING", "MARKET", "DEPOT"]) {
        assert.ok(GENERIC_PAYEE_TOKENS.has(word), word);
        assert.ok(payeeTokens(`ACME ${word}`).includes(word), `${word} survives tokenizing`);
        assert.ok(!payeeSignificantTokens(`ACME ${word}`).includes(word), `${word} names no merchant`);
    }
    assert.equal(payeeMatches("HOME DEPOT", "HOME DEPOT"), true, "DEPOT is fine inside a bigram");
});

// ── A row is not a receipt (round-14 item 1) ───────────────────────────────

test("an intake whose document could not be verified is NOT evidence", () => {
    const line = {
        id: "bl-1", postedDate: "2026-08-16", amountCents: -12_345,
        rawDescriptor: "LOWES #02516 POS DEB C#8516", checkNumber: null,
    };
    const base = {
        bankLines: [line],
        expenses: [],
        openIssueKeys: ["bl-1"],
        now: new Date("2026-08-20T12:00:00Z"),
    };
    const intake = (stateReason: string | null) => ({
        id: "int-1", totalCents: 12_345, txnDate: "2026-08-16",
        vendor: "Lowes", state: "NEEDS_REVIEW", stateReason,
    });

    // The bytes are gone from storage, or they no longer hash to what was
    // verified at intake. Either way the row outlived its document, and closing
    // the chase on it means nobody is ever asked for the receipt again.
    for (const reason of [...NO_ARTIFACT_STATE_REASONS]) {
        const plan = planReceiptRequests({ ...base, intakes: [intake(reason)] });
        assert.deepEqual(plan.close, [], reason);
        assert.equal(plan.open.length, 1, `${reason} must keep the chase open`);
    }

    // Everything else book.ts parks is about the row's METADATA — the document
    // is still there, still verified, and still proves a receipt exists.
    for (const reason of ["no-estimate", "refund-or-zero", "invalid-date", "qbo-fault", null]) {
        const plan = planReceiptRequests({ ...base, intakes: [intake(reason)] });
        assert.deepEqual(plan.close, ["bl-1"], `${reason} is still evidence`);
    }
});

test("book.ts and the chaser share ONE list of no-evidence reasons", () => {
    // Spelled out at both ends they drift, and the drift is silent and
    // one-directional: the chaser closes a chase for a receipt whose bytes are
    // gone.
    assert.deepEqual([...NO_ARTIFACT_STATE_REASONS].sort(), ["content-changed", "receipt-bytes-missing"]);
    const book = readFileSync(join(repoRoot, "src/lib/receipt-intake/book.ts"), "utf8");
    assert.match(book, /parkedBeforeSend\(NO_ARTIFACT_PARK_REASONS\.bytesMissing\)/);
    assert.match(book, /parkedBeforeSend\(NO_ARTIFACT_PARK_REASONS\.contentChanged\)/);
    assert.doesNotMatch(book, /parkedBeforeSend\("receipt-bytes-missing"\)/);
    const worker = readFileSync(join(repoRoot, "src/lib/receipt-intake/worker.ts"), "utf8");
    assert.match(worker, /parkTerminal\(row, deps, NO_ARTIFACT_PARK_REASONS\.contentChanged\)/);
    // And the cron actually SELECTS the column the predicate needs.
    const cron = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    const selects = cron.match(/state: true, stateReason: true/g) ?? [];
    assert.equal(selects.length, 2, "the batch pass and the recompute pass");
});

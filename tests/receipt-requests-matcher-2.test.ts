import assert from "node:assert/strict";
import test from "node:test";
import {
    appendCardRecord,
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

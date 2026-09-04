import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    REQUIRED_ASSOCIATION_FIELDS,
    matchCardAssociation,
    missingAssociationFields,
} from "../src/lib/receipt-card-history";
import {
    MEMO_CONFLICT_RESOLUTION,
    MEMO_SIGNED_RESOLUTION,
    PRESERVED_DETAIL_KEYS,
    hasBackedResolution,
    hasResolution,
    mergeReceiptRequestDetails,
} from "../src/lib/receipt-requests";
import { memoReopenDecision } from "../src/app/api/cron/receipt-requests/route";

/**
 * Codex PR #443, adversarial gate round 38.
 *
 *  1. THE MEMO ASSOCIATION WAS NOT ITEM-SPECIFIC. `n` and `request_id` were
 *     optional and only narrowed a match when present, while one card lists
 *     several charges in ONE thread and two same-amount charges mint memos with
 *     interchangeable filenames. An answer that simply omitted `n` was matched
 *     by the thread alone and could close either charge.
 *  2. AN UNBACKED `memo-signed` COULD STAY CLOSED FOR EVER. Planning uses
 *     `hasBackedResolution`, so such a row is planned as a reopen — but the
 *     apply transaction's own guard asked `hasResolution`, saw a resolution and
 *     turned that reopen into a no-op. Reachable for real in the window between
 *     running the migration and deploying this build, while the old build could
 *     still write a memo resolution with no artifact row. And
 *     `PRESERVED_DETAIL_KEYS` dropped `pdfId` on every recompute, which turns a
 *     BACKED memo into an unbacked one all by itself.
 *  3. ROUND 37'S WORDING PASS MISSED FOUR PLACES that still described the
 *     pull's source as the bank feed, or said canonical lines are minted only
 *     from statements.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. An answer must name ONE item ─────────────────────────────────────────

const THREAD = "spaces/x/threads/y";
const REQUEST_ID = "receipt-req-CJ-2026-08-16";

/** One card, one thread, TWO charges of the same amount — the replay setup. */
const twoItemCard = {
    amountCents: -12_345,
    cards: [
        { n: 1, date: "2026-08-16", threadName: THREAD, messageName: "spaces/x/messages/z", requestId: REQUEST_ID },
    ],
};
const siblingCard = {
    amountCents: -12_345,
    cards: [
        { n: 2, date: "2026-08-16", threadName: THREAD, messageName: "spaces/x/messages/z", requestId: REQUEST_ID },
    ],
};

test("an answer that does not say WHICH item is refused, and names what the bridge omitted", () => {
    assert.deepEqual(missingAssociationFields({ thread: THREAD, n: null, requestId: REQUEST_ID }), ["n"]);
    assert.deepEqual(missingAssociationFields({ thread: THREAD, n: 1, requestId: null }), ["request_id"]);
    assert.deepEqual(missingAssociationFields({ thread: null, n: null, requestId: null }), ["thread", "n", "request_id"]);
    assert.deepEqual(missingAssociationFields({ thread: "   ", n: 1, requestId: "  " }), ["thread", "request_id"]);
    assert.deepEqual([...REQUIRED_ASSOCIATION_FIELDS], ["thread", "n", "request_id"]);

    const verdict = matchCardAssociation(twoItemCard, { thread: THREAD, n: null, requestId: REQUEST_ID });
    assert.equal(verdict.kind, "incomplete");
    assert.match((verdict as { detail: string }).detail, /missing n/);
});

test("two same-amount charges on ONE card: an answer without n resolves NEITHER", () => {
    /**
     * The replay this closes. Item 1 and item 2 are the same amount in the same
     * thread, so their memo filenames are interchangeable — the thread says
     * which CARD, never which charge. Before the fix, an answer that omitted
     * `n` matched both issues' card records and could close either.
     */
    const answerWithoutN = { thread: THREAD, n: null, requestId: REQUEST_ID };
    for (const [name, details] of [["item 1", twoItemCard], ["item 2", siblingCard]] as const) {
        const verdict = matchCardAssociation(details, answerWithoutN);
        assert.equal(verdict.kind, "incomplete", `${name} must not be resolvable by an answer that names no item`);
    }

    // PRE-FIX CONTROL: the old rule — thread must match, n/requestId only
    // narrow when present — accepted the same answer against BOTH issues.
    const preFix = (details: typeof twoItemCard, answer: { thread: string; n: number | null; requestId: string | null }) => {
        let candidates = details.cards.filter(record => record.threadName === answer.thread);
        if (answer.n !== null) candidates = candidates.filter(record => record.n === answer.n);
        if (answer.requestId !== null) candidates = candidates.filter(record => record.requestId === answer.requestId);
        return candidates.length > 0;
    };
    assert.equal(preFix(twoItemCard, answerWithoutN), true, "the old rule matched item 1");
    assert.equal(preFix(siblingCard, answerWithoutN), true, "and item 2 — one memo, two closable charges");
});

test("the exact triple resolves exactly one item, and a sibling number does not", () => {
    const exact = matchCardAssociation(twoItemCard, { thread: THREAD, n: 1, requestId: REQUEST_ID });
    assert.equal(exact.kind, "matched");
    assert.equal((exact as { record: { n: number } }).record.n, 1);

    // The same answer against the SIBLING issue: right thread, right request,
    // wrong item.
    assert.equal(matchCardAssociation(siblingCard, { thread: THREAD, n: 1, requestId: REQUEST_ID }).kind, "wrong-thread");
    // A different card's request id in the right thread is refused too.
    assert.equal(
        matchCardAssociation(twoItemCard, { thread: THREAD, n: 1, requestId: "receipt-req-CJ-2026-08-17" }).kind,
        "wrong-thread",
    );
    // An issue nobody carded stays "never-carded", not "incomplete": they are
    // different operator problems.
    assert.equal(
        matchCardAssociation({ amountCents: -1 }, { thread: THREAD, n: 1, requestId: REQUEST_ID }).kind,
        "never-carded",
    );
});

test("the bridge is GIVEN the request id it must echo back", () => {
    // The threads export is the only place a Chat reply can learn the card's
    // request id — it is ours, derived from owner + Pacific date, and no reply
    // carries it. Requiring the field without exporting it would refuse every
    // legitimate answer.
    const cards = readFileSync(join(repoRoot, "src/lib/receipt-request-cards.ts"), "utf8");
    const threads = readFileSync(join(repoRoot, "src/app/api/automation/receipt-requests/threads/route.ts"), "utf8");
    assert.match(cards, /request_id: card\.requestId,/);
    assert.match(threads, /requestId: requestIdFor\(card\.owner, card\.pacificDate\),/);

    const answers = readFileSync(join(repoRoot, "src/app/api/automation/receipt-requests/answers/route.ts"), "utf8");
    // Refused BEFORE the Drive round trip, and recorded where the digest sees it.
    assert.match(answers, /const missingAssociation = missingAssociationFields\(association\);/);
    assert.match(answers, /await recordAnswerRejection\(bankLineId, "association-incomplete", detail\);/);
    assert.match(answers, /kind: "receipt-memo-answer",[\s\S]{0,80}status: "error",/);
});

// ── 2. An unbacked memo resolution reopens ──────────────────────────────────

test("the apply transaction reopens a memo resolution with no artifact of its own", () => {
    /**
     * The deployment-window state: the migration has run (so the artifact table
     * exists and the losing side of a duplicate was quarantined) and the OLD
     * build is still serving — it can still write `memo-signed` with no
     * artifact row. The nightly cron plans a reopen; this guard used to cancel
     * it.
     */
    const oldBuildWrote = { amountCents: -12_345, resolution: MEMO_SIGNED_RESOLUTION, pdfId: "pdf-1" };
    const decision = memoReopenDecision(oldBuildWrote, null, ["MISSING_RECEIPT"]);
    assert.equal(decision.suppressReopen, false, "an answer nothing can vouch for must not hold the chase closed");
    assert.equal(decision.quarantine, true, "and it is quarantined so the next run cannot re-suppress from the same blob");

    // PRE-FIX CONTROL: the guard as it was — `hasResolution` on the blob alone.
    assert.equal(hasResolution(oldBuildWrote), true, "which is exactly why the reopen became a no-op");

    // The quarantine's own shape, and that a second pass leaves it alone.
    const quarantined = { ...oldBuildWrote, resolution: MEMO_CONFLICT_RESOLUTION };
    assert.equal(hasResolution(quarantined), false);
    const second = memoReopenDecision(quarantined, null, ["MISSING_RECEIPT"]);
    assert.equal(second.suppressReopen, false);
    assert.equal(second.quarantine, false, "already quarantined — nothing left to rewrite");
});

test("a BACKED memo resolution still stops the reopen", () => {
    const backed = { amountCents: -12_345, resolution: MEMO_SIGNED_RESOLUTION, pdfId: "pdf-1" };
    const decision = memoReopenDecision(backed, "pdf-1", ["MISSING_RECEIPT"]);
    assert.equal(decision.suppressReopen, true, "a memo the artifact table binds to THIS charge is a real answer");
    assert.equal(decision.quarantine, false);

    // A binding for a DIFFERENT memo is not this one's evidence.
    assert.equal(memoReopenDecision(backed, "pdf-2", ["MISSING_RECEIPT"]).suppressReopen, false);
    // And a close (no codes) never quarantines anything.
    assert.deepEqual(memoReopenDecision(backed, null, []), { suppressReopen: false, quarantine: false });

    // PRE-FIX CONTROL for the other half: without `pdfId` preserved, the same
    // backed memo reads as unbacked after one nightly recompute.
    const strippedByRecompute = { ...backed } as Record<string, unknown>;
    delete strippedByRecompute.pdfId;
    assert.equal(hasBackedResolution(strippedByRecompute, "pdf-1"), false, "no id, nothing to compare");
});

test("a recompute keeps the pdfId a memo resolution names", () => {
    // `mergeReceiptRequestDetails` is what every nightly recompute runs. The
    // resolution survived it and the id did not, so the artifact check had
    // nothing to compare and reopened a chase the owner had already answered.
    assert.ok(PRESERVED_DETAIL_KEYS.includes("pdfId"), "pdfId rides with resolution");
    const merged = mergeReceiptRequestDetails(
        { resolution: MEMO_SIGNED_RESOLUTION, pdfId: "pdf-1", amountCents: -12_345 },
        { amountCents: -12_345, owner: "CJ", payee: "LOWES" },
    );
    assert.equal(merged.resolution, MEMO_SIGNED_RESOLUTION);
    assert.equal(merged.pdfId, "pdf-1");
    assert.equal(hasBackedResolution(merged, "pdf-1"), true, "still backed after the recompute the bug ran through");
});

test("the apply transaction reads the binding under its own tx, not from the snapshot", () => {
    const route = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(
        route,
        /const boundPdfId = \(await tx\.receiptMemoArtifact\.findUnique\(\{[\s\S]{0,400}\}\)\)\?\.pdfId \?\? null;[\s\S]{0,120}const guard = memoReopenDecision\(freshDetails, boundPdfId, codes\);/,
        "the lookup and the decision belong to the same transaction as the write",
    );
    assert.doesNotMatch(
        route,
        /if \(codes\.length > 0 && hasResolution\(freshDetails\)\)/,
        "the blob-only guard is what let an unbacked memo hold a chase closed",
    );
});

// ── 3. The source is named honestly everywhere ──────────────────────────────

test("no file still calls the pull's source the bank feed", () => {
    const files = [
        "src/lib/bank-register-pull.ts",
        "src/lib/bank-line-mint.ts",
        "src/lib/qbo-bank-register.ts",
        "src/app/api/cron/bank-register-pull/route.ts",
        "prisma/schema.prisma",
        "scripts/apply-phase2-receipt-queue.mjs",
        "docs/plans/PHASE-2-QUEUE-AND-MEMOS-SPEC.md",
    ];
    for (const file of files) {
        const source = readFileSync(join(repoRoot, file), "utf8").replace(/\r\n/g, "\n");
        assert.doesNotMatch(
            source, /the QBO bank feed\s*(?:\n\s*(?:\*|\/\/|---)\s*)?is bank\s*(?:\n\s*(?:\*|\/\/|---)\s*)?truth/i,
            `${file} still claims the bank feed is the source`,
        );
        assert.doesNotMatch(
            source, /minted ONLY from STATEMENT observations/,
            `${file} still says statements are the only minter`,
        );
    }
});

test("the four files round 37 missed now describe the posted register and the remaining gap", () => {
    const expectations: Array<[string, RegExp[]]> = [
        ["src/lib/bank-register-pull.ts", [/GENERAL LEDGER postings/, /pending, excluded or unmatched/, /it does not close it/]],
        ["prisma/schema.prisma", [/GENERAL LEDGER/, /only\n\s*\/\/\/ source that sees a charge QuickBooks has not posted/]],
        ["scripts/apply-phase2-receipt-queue.mjs", [/GENERAL\n\/\/\s+LEDGER/, /only source for a cleared charge QuickBooks never posted/]],
        ["src/lib/bank-line-mint.ts", [/GENERAL LEDGER report/, /statement import/]],
    ];
    for (const [file, patterns] of expectations) {
        const source = readFileSync(join(repoRoot, file), "utf8").replace(/\r\n/g, "\n");
        for (const pattern of patterns) {
            assert.match(source, pattern, `${file} must describe the source honestly (${pattern})`);
        }
    }
});

test("the schema edit is a COMMENT edit — no column may move with it", () => {
    // A doc comment is not DDL, so the committed migrations and
    // check-migrations-match stay untouched by it. This pins that the wording
    // fix stayed inside `///` lines.
    const schema = readFileSync(join(repoRoot, "prisma/schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model BankLine {"));
    const body = model.slice(0, model.indexOf("\n}"));
    assert.match(body, /sourceOfRecord\s+String\s+@default\("STATEMENT"\)/, "the column itself is unchanged");
});

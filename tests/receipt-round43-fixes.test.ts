import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fenceAndWritePhase } from "../src/app/api/cron/receipt-requests/route";
import { pullContinuationPending } from "../src/app/api/cron/bank-register-pull/route";
import { RECEIPT_EVIDENCE_EPOCH_KEY, RECEIPT_EVIDENCE_EPOCH_ZERO } from "../src/lib/receipt-evidence-lock";

/**
 * Codex PR #443, adversarial gate round 43 — what round 42's fence left open.
 *
 *  1. THE DAILY CLAIM WAS TAKEN AFTER THE IRREVERSIBLE SEND. `deliveredOn` was
 *     written with the POSTED result, so two concurrent runs both passed the
 *     in-memory check, both called Chat, and only then collided on the unique
 *     index — two messages already in the space. A Chat message cannot be
 *     recalled, so the claim has to be taken while losing it is still free.
 *  2. THE WORKER BYPASSED THE FENCE WHEN MARKING DUPLICATES. A row becoming
 *     DUPLICATE is a receipt ceasing to exist as far as the sweep is concerned,
 *     and that transition went through the chain guard rather than through the
 *     worker's own locked helper — so it took no evidence lock at all.
 *  3. THE ADMIN PATHS INVERTED THE LOCK ORDER. The chain guard took `FOR
 *     UPDATE` row locks first and the bodies took the evidence lock inside,
 *     which is the opposite order to the sweep: a real AB-BA deadlock.
 *  4. THE COMPLETION FENCE COULD NOT SEE EVIDENCE MOVE. Each component released
 *     the evidence lock after committing, but certification only fenced
 *     `bankLedgerEpoch` — so an intake voided after its component ran let the
 *     cycle stamp itself done over an issue closed on evidence that was gone.
 *  5. AMBIGUITY BLOCKED THE STAMP AND SCHEDULED NOTHING. Unresolved
 *     same-identity groups stopped the freshness stamp without making the run
 *     incomplete, so `continuationPending` was written false and no later slot
 *     ever came back to try again.
 *  6. THE VERIFIER DID NOT KNOW ABOUT THE NEW CLAIM. The apply script created
 *     `ReceiptRequestCard_owner_deliveredOn_key` and never checked it.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

// ═══ 1. The day is reserved BEFORE Chat is called ═══════════════════════════

test("the delivery-day claim is taken in the POSTING write, before the webhook", () => {
    const cards = read("src/app/api/cron/receipt-request-cards/route.ts");

    const markAt = cards.indexOf('data: { status: "POSTING", itemsJson: JSON.stringify(card.items), deliveredOn: date }');
    const postAt = cards.indexOf("const result = await postOwnerCard(webhookUrl, card, { timeoutMs: sendTimeoutMs });");
    assert.ok(markAt > 0, "the reservation rides on the POSTING write");
    assert.ok(postAt > markAt, "and that write happens BEFORE the send, not after it");

    // Losing the claim means sending nothing — and only a P2002 counts as
    // losing it. A bare catch would read every broken write as "someone beat
    // me to it" and silently skip the card.
    assert.match(cards, /if \(\(error as \{ code\?: string \}\)\?\.code !== "P2002"\) throw error;/);
    assert.match(cards, /dayTaken\.push\(card\.owner\);\s*\n\s*continue;/);
});

test("only a DEFINITE rejection gives the day back", () => {
    const cards = read("src/app/api/cron/receipt-request-cards/route.ts");

    // The rejection branch releases it...
    assert.match(
        cards,
        /lastError: `rejected:\$\{result\.reason\}`,[\s\S]{0,400}?deliveredOn: null,/,
        "Chat provably did not take it, so the owner's day is genuinely free",
    );

    // ...and the uncertain branch does NOT. This is the asymmetry the whole
    // mechanism rests on: a card that MIGHT be in the space must not be
    // followed by a second one.
    const uncertainAt = cards.indexOf('if (result.kind === "unknown") {');
    const postedAt = cards.indexOf('status: "POSTED"', uncertainAt);
    assert.ok(uncertainAt > 0 && postedAt > uncertainAt);
    const uncertainBranch = cards.slice(uncertainAt, postedAt);
    assert.doesNotMatch(uncertainBranch, /deliveredOn: null/,
        "an uncertain delivery keeps the claim — a duplicate card is worse than a missing one");
});

// ═══ 2, 3. One wrapper, one lock order, every caller ════════════════════════

test("there is no way to take the chain's row locks without the evidence lock", () => {
    const guard = read("src/lib/receipt-intake/duplicate-guard.ts");

    // The combined wrapper is the only export, so the order is not a
    // convention any caller has to remember.
    assert.match(guard, /export async function withEvidenceAndChainLocks<T>\(/);
    assert.doesNotMatch(guard, /export async function withDuplicateChainLock/);
    assert.match(
        guard,
        /await lockReceiptEvidence\(tx\);[\s\S]{0,400}?return body\(tx, await lockWithInboundDuplicates\(tx, ids\)\);/,
        "evidence lock first, row locks second",
    );

    // All three callers go through it, and none of them takes the evidence
    // lock itself any more — taking it inside the body is what put the row
    // locks first.
    const actions = read("src/lib/actions.ts");
    assert.equal((actions.match(/withEvidenceAndChainLocks\(fn => prisma\.\$transaction\(fn\)/g) ?? []).length, 2);
    assert.doesNotMatch(actions, /withEvidenceAndChainLocks\([\s\S]{0,400}?await lockReceiptEvidence\(tx\)/);

    const worker = read("src/app/api/cron/receipt-intake-worker/route.ts");
    assert.match(worker, /applyDuplicateTransition: async \(rowId, decision, patch, ownership\) => withEvidenceAndChainLocks\(/,
        "the worker's duplicate transition is fenced too — it was not, at all");
});

test("the sweep takes the two locks in the SAME order the wrapper does", () => {
    // The other half of an AB-BA: it is only an inversion relative to
    // something. This pins the something.
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    const txAt = sweep.indexOf("await withTxRetry(() => prisma.$transaction(async tx => {");
    const evidenceAt = sweep.indexOf("await lockReceiptEvidence(tx);", txAt);
    const rowLockAt = sweep.indexOf("FOR UPDATE", evidenceAt);
    assert.ok(txAt > 0 && evidenceAt > txAt && rowLockAt > evidenceAt,
        "evidence lock, then row locks — the order every writer now shares");
});

// ═══ 4. The completion fence sees evidence move ════════════════════════════

/** The fence with both epochs under test control, and no database. */
function fence(input: { epochNow: string; evidenceEpochNow: string; appeared: number }) {
    const written: Array<{ phase: string; completedAt: string | undefined }> = [];
    let countedLines = false;
    return {
        written,
        get countedLines() { return countedLines; },
        run: (snapshotEpoch: string, snapshotEvidenceEpoch: string) => fenceAndWritePhase(
            {
                snapshotEpoch,
                snapshotEvidenceEpoch,
                computedPhase: "done",
                bankPullStale: false,
                now: new Date("2026-09-03T14:00:00Z"),
            },
            fn => fn({
                lockEpoch: async () => input.epochNow,
                lockEvidenceEpoch: async () => input.evidenceEpochNow,
                countNewLines: async () => { countedLines = true; return input.appeared; },
                writePhase: async (phase, completedAt) => { written.push({ phase, completedAt }); },
            }),
        ),
    };
}

test("evidence moving under a cycle withholds certification", async () => {
    const f = fence({ epochNow: "5", evidenceEpochNow: "12", appeared: 0 });
    const decision = await f.run("5", "11");

    assert.equal(decision.complete, false, "an intake voided mid-cycle means the cycle judged evidence that is gone");
    assert.equal(decision.ledgerMoved, true, "and it is reported as movement, so the continuation re-runs");
    assert.equal(f.written[0].completedAt, undefined, "no stamp");
    assert.equal(f.countedLines, false,
        "and it short-circuits: once something moved, counting lines cannot change the answer");
});

test("PRE-FIX CONTROL: with only the ledger fenced, that same cycle certifies", async () => {
    // Identical inputs, except the evidence epoch matches — which is exactly
    // what the old fence saw, because it never asked.
    const f = fence({ epochNow: "5", evidenceEpochNow: "11", appeared: 0 });
    const decision = await f.run("5", "11");

    assert.equal(decision.complete, true);
    assert.equal(f.written[0].completedAt, "2026-09-03T14:00:00.000Z", "the stamp the cards cron reads");
});

test("the ledger epoch still disqualifies on its own", async () => {
    const f = fence({ epochNow: "6", evidenceEpochNow: "11", appeared: 0 });
    const decision = await f.run("5", "11");
    assert.equal(decision.complete, false, "the round-37 fence is intact — this widened it, not replaced it");
});

test("the evidence epoch is read under the evidence lock, and bumped by every writer", () => {
    const lock = read("src/lib/receipt-evidence-lock.ts");
    assert.equal(RECEIPT_EVIDENCE_EPOCH_KEY, "receiptEvidenceEpoch");
    assert.equal(RECEIPT_EVIDENCE_EPOCH_ZERO, "0",
        "'never written' and 'unchanged' must be the same answer, or a fresh database never certifies");

    // The wrapper every bare write goes through bumps it, so a writer cannot
    // fall behind the counter that describes it.
    assert.match(lock, /await lockReceiptEvidence\(tx\);\s*\n\s*const result = await body\(tx\);[\s\S]{0,600}?await bumpReceiptEvidenceEpoch\(/);

    // And the three transactions that hold the lock directly bump it themselves.
    for (const rel of [
        "src/lib/receipt-intake/book.ts",
        "src/lib/receipt-intake/storage-cleanup.ts",
        "src/lib/receipt-intake/duplicate-guard.ts",
    ]) {
        const source = read(rel);
        const lockAt = source.indexOf("await lockReceiptEvidence(tx);");
        const bumpAt = source.indexOf("await bumpReceiptEvidenceEpoch(tx);");
        assert.ok(lockAt > 0 && bumpAt > lockAt, `${rel} bumps the epoch inside the lock it took`);
    }

    // The sweep reads it and does NOT bump it: it writes ReviewIssue rows, not
    // evidence, and a sweep that moved the epoch would invalidate its own cycle.
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    assert.match(sweep, /const snapshotEvidenceEpoch = await readReceiptEvidenceEpoch\(prisma\);/);
    assert.doesNotMatch(sweep, /bumpReceiptEvidenceEpoch/);
});

// ═══ 5. Ambiguity leaves a continuation obligation ══════════════════════════

test("an unresolved ambiguity is unfinished work the resume pass can see", () => {
    /** A settled window: nothing outstanding on any of the six markers. */
    const settled = { highWater: "2026-09-01", lastFullSweep: "2026-09-01" };

    assert.equal(pullContinuationPending({ ...settled, continuationPending: true }), true);
    // The reason rides along so "incomplete" and "complete but unstampable"
    // are distinguishable in the state, not just in a log line.
    assert.equal(
        pullContinuationPending({ ...settled, continuationPending: true, continuationReason: "ambiguity" }),
        true,
    );
    assert.equal(pullContinuationPending(settled), false, "and a settled state wakes nothing");
});

test("a complete run blocked ONLY by ambiguity still schedules its continuation", () => {
    const route = read("src/app/api/cron/bank-register-pull/route.ts");

    // The stamp is blocked...
    assert.match(route, /const stampWarranted = summary\.ok && summary\.complete && summary\.clearedProbeOk && ambiguousCount === 0/);
    // ...and the obligation is written down, which is what was missing: this
    // run IS complete, so the state save wrote continuationPending: false.
    assert.match(
        route,
        /if \(summary\.ok && ambiguousCount > 0\) \{\s*\n\s*statePatch\.continuationPending = true;\s*\n\s*statePatch\.continuationReason = "ambiguity";/,
    );

    // PRE-FIX CONTROL: the save inside the pull keys the flag on `complete`
    // alone, which an ambiguity-blocked run satisfies. That is why the widening
    // has to happen in the route, AFTER that save.
    const lib = read("src/lib/bank-register-pull.ts");
    assert.match(lib, /continuationPending: !summary\.complete && clearedProbeOk,/);
    const saveAt = route.indexOf("const statePatch: Record<string, unknown> = {};");
    const pullAt = route.indexOf("const summary = await runBankRegisterPull(");
    assert.ok(pullAt > 0 && saveAt > pullAt, "the merge is the run's LAST write, so it cannot be overwritten");

    // And the reason survives a reload, or the continuation cannot act on it.
    assert.match(route, /continuationReason: typeof parsed\.continuationReason === "string" \? parsed\.continuationReason : null,/);
});

// ═══ 6. The verifier knows about the claim ═════════════════════════════════

test("the apply script verifies the delivery-day index, on all three properties", () => {
    const apply = read("scripts/apply-phase2-receipt-queue.mjs");

    assert.match(apply, /name: "ReceiptRequestCard_owner_deliveredOn_key",/);
    assert.match(apply, /mustMatch: \[\/CREATE UNIQUE INDEX\/, \/\\\("owner", "deliveredOn"\\\)\/\],/,
        "it must exist, be UNIQUE, and be on those two columns in that order");
    assert.match(apply, /mustNotMatch: \[\/ WHERE \/\],/,
        "and NOT be partial — Prisma cannot see a partial index, so CI would report it missing forever");

    // The check has to actually run, not just be declared.
    assert.match(apply, /for \(const \{ name, mustMatch, mustNotMatch = \[\] \} of expectedUniqueIndexes\)/);
    assert.match(apply, /if \(pattern\.test\(row\.indexdef\)\) \{\s*\n\s*console\.error\(`VERIFY FAILED: index \$\{name\} must NOT match/);
});

test("migration, apply script and schema describe the SAME index", () => {
    // The parity failure that started this: schema declared the unique, the
    // migration created a PARTIAL one, and Prisma's diff engine — which cannot
    // represent partial indexes — reported it as missing on every CI run.
    const schema = read("prisma/schema.prisma");
    const migration = read("prisma/migrations/20260901120000_phase2_receipt_queue/migration.sql");
    const apply = read("scripts/apply-phase2-receipt-queue.mjs");

    assert.match(schema, /@@unique\(\[owner, deliveredOn\]\)/);
    for (const [name, source] of [["migration", migration], ["apply script", apply]] as const) {
        assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptRequestCard_owner_deliveredOn_key"/, name);
        assert.doesNotMatch(source, /WHERE "deliveredOn" IS NOT NULL/, `${name} must not be partial`);
    }
});

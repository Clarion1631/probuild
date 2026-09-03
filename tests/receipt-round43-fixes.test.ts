import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cursorUsableAt, fenceAndWritePhase, formatSweepCursor, parseSweepCursor } from "../src/app/api/cron/receipt-requests/route";
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

    // The rejection branch releases it — BOTH the card column and, since round
    // 44's finding 2, the immutable delivery row that actually enforces the
    // rule. Deleting one is legal on this path and nowhere else.
    assert.match(
        cards,
        /lastError: `rejected:\$\{result\.reason\}`,[\s\S]{0,900}?deliveredOn: null,/,
        "Chat provably did not take it, so the owner's day is genuinely free",
    );
    // Retracted in the SAME TRANSACTION as the return to PENDING (round-45
    // gate, finding 7) — separately, a failure between them left the card
    // sendable while its reservation still held the owner's only slot.
    assert.match(
        cards,
        /await prisma\.\$transaction\(async tx => \{\s*\n\s*const released = await tx\.receiptRequestCard\.updateMany\([\s\S]{0,1400}?tx\.receiptRequestCardDelivery\.deleteMany\([\s\S]{0,200}?deliveryDay: date/,
        "and the reservation is retracted with it, atomically",
    );
    assert.match(cards, /if \(released\.count === 0\) return;/,
        "and only when this run still owned the card");
    assert.equal((cards.match(/receiptRequestCardDelivery\.deleteMany/g) ?? []).length, 1,
        "exactly one path may delete a delivery record");

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

// ═══ Round 44, finding 1: the snapshot must cover the WHOLE cycle ══════════

test("the epochs are captured BEFORE the open-issue pass, not after it", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");

    const runSweepAt = sweep.indexOf("async function runSweep(");
    const ledgerAt = sweep.indexOf("const snapshotEpoch = await readBankLedgerEpoch(prisma);", runSweepAt);
    const evidenceAt = sweep.indexOf("const snapshotEvidenceEpoch = await readReceiptEvidenceEpoch(prisma);", runSweepAt);
    const openPassAt = sweep.indexOf('while (startPhase !== "lines" && Date.now() - startedAt < RUN_BUDGET_MS)', runSweepAt);

    assert.ok(runSweepAt > 0 && ledgerAt > runSweepAt && evidenceAt > runSweepAt);
    assert.ok(openPassAt > ledgerAt && openPassAt > evidenceAt,
        "both epochs are read before the open-issue pass — reading them after made them blind to it");

    // Exactly one capture of each, so a second one cannot quietly re-snapshot
    // mid-cycle and hand the fence a moving target.
    assert.equal((sweep.match(/await readBankLedgerEpoch\(prisma\)/g) ?? []).length, 1);
    assert.equal((sweep.match(/await readReceiptEvidenceEpoch\(prisma\)/g) ?? []).length, 1);
});

test("a continuation whose stored epochs disagree restarts from the open-issue pass", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");

    // Both cursors are read, both are checked against BOTH epochs, and a
    // mismatch discards both and forces the open-issue pass — the only pass
    // that re-checks an issue the 60-day line window cannot even see.
    // Widened in round 45 (finding 1): the CYCLE RECORD is checked as well as
    // the cursors, because a cursor is cleared the moment its pass completes.
    assert.match(sweep, /const stale = !cycleStillValid\(cycle, snapshotEpoch, snapshotEvidenceEpoch\)/);
    assert.match(sweep, /\|\| storedCursors\.some\(cursor => !cursorUsableAt\(cursor, snapshotEpoch, snapshotEvidenceEpoch\)\)/);
    const staleAt = sweep.indexOf("const stale = !cycleStillValid(cycle, snapshotEpoch, snapshotEvidenceEpoch)");
    const clearAt = sweep.indexOf("await Promise.all([writeCursor(null), writeOpenCursor(null)]);", staleAt);
    const restartAt = sweep.indexOf('effectiveStartPhase = "open-issues";', clearAt);
    assert.ok(staleAt > 0 && clearAt > staleAt && restartAt > clearAt,
        "a stale pair discards BOTH cursors and forces the open-issue pass");

    // And the OPEN cursor carries the pair too — a resume into that pass has to
    // prove the same thing the line pass does.
    assert.match(sweep, /await writeOpenCursor\(formatSweepCursor\(\{ key: openCursor, epoch: snapshotEpoch, evidenceEpoch: snapshotEvidenceEpoch \}\)\)/);
});

test("MULTI-INVOCATION: evidence landing behind both cursors withholds certification", async () => {
    /**
     * Codex PR #443 gate round 44, finding 1, as a sequence rather than a
     * shape.
     *
     * Invocation 1 finishes the open-issue pass and parks a line cursor.
     * Between then and invocation 2 a receipt is booked for an issue the first
     * pass already decided — and that issue is OLDER than the 60-day line
     * window, so the line pass cannot look at it either. Under round 43 the
     * `"lines"` continuation skipped the open-issue pass, matched the only
     * epoch it stored, finished, and stamped the cycle complete. The 14:30
     * cards then asked somebody for a receipt they had already filed.
     */
    const CYCLE = { epoch: "5", evidence: "11" };

    // Invocation 1's checkpoints, written against the cycle's snapshot.
    const lineCursor = formatSweepCursor({ key: "2026-06-01|old", epoch: CYCLE.epoch, evidenceEpoch: CYCLE.evidence });
    const openCursor = formatSweepCursor({ key: "issue-42", epoch: CYCLE.epoch, evidenceEpoch: CYCLE.evidence });
    assert.ok(lineCursor && openCursor);

    // Invocation 2 starts. The ledger has not moved; a receipt has landed.
    const nowEvidence = "12";
    const stored = [parseSweepCursor(lineCursor), parseSweepCursor(openCursor)];
    const stale = stored.some(cursor => !cursorUsableAt(cursor, CYCLE.epoch, nowEvidence));
    assert.equal(stale, true, "the cycle restarts from the open-issue pass instead of resuming into the lines");

    // And certification is refused on the same fact, so nothing can stamp even
    // if a resumed pass got that far.
    const f = fence({ epochNow: CYCLE.epoch, evidenceEpochNow: nowEvidence, appeared: 0 });
    const decision = await f.run(CYCLE.epoch, CYCLE.evidence);
    assert.equal(decision.complete, false, "no certification");
    assert.equal(f.written[0].completedAt, undefined, "no stamp — so the cards cron sends nothing today");

    /**
     * PRE-FIX CONTROL: the round-43 cursor, which stored only the ledger epoch.
     * The ledger did not move, so it resumes happily — straight past the
     * open-issue pass and into a completion it has not earned.
     */
    const roundFortyThree = `e${CYCLE.epoch}|2026-06-01|old`;
    const legacy = parseSweepCursor(roundFortyThree);
    assert.equal(legacy.evidenceEpoch, null, "there was nothing to disagree with");
    const oldStyleUsable = legacy.key !== null && legacy.epoch === CYCLE.epoch;
    assert.equal(oldStyleUsable, false,
        "and because the two-part format is now required, that cursor no longer resumes at all");
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
    const lib = read("src/lib/bank-register-pull.ts");

    // The stamp is blocked...
    assert.match(route, /const stampWarranted = summary\.ok && summary\.complete && summary\.clearedProbeOk && ambiguousCount === 0/);
    // ...and the obligation is written down, which is what was missing: this
    // run IS complete, so the state save wrote continuationPending: false.
    // ONE WRITE since round 45 (finding 4): the decision is made where the
    // reconcile result already is, so the obligation and the state that implies
    // it commit together. A crash between two writes used to leave the stamp
    // withheld with nothing scheduled to come back for it.
    assert.match(lib, /const windowAmbiguous = \(summary\.reconciled\?\.ambiguous\?\.length \?\? 0\) > 0;/);
    assert.match(lib, /continuationPending: \(!summary\.complete && clearedProbeOk\) \|\| windowAmbiguous,/);
    assert.doesNotMatch(route, /statePatch\.continuationReason = "ambiguity"/,
        "the second write is gone");

    // PRE-FIX CONTROL: the save inside the pull keys the flag on `complete`
    // alone, which an ambiguity-blocked run satisfies. That is why the widening
    // has to happen in the route, AFTER that save.
    // PRE-FIX CONTROL: the round-43 shape keyed the flag on `complete` alone,
    // which an ambiguity-blocked run satisfies — that is why the obligation was
    // added by a second write, and why a crash between the two lost it.
    assert.doesNotMatch(lib, /continuationPending: !summary\.complete && clearedProbeOk,/);
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
    // It must exist, be UNIQUE, and be on those two columns IN THAT ORDER —
    // now asserted against the catalog rather than a rendered definition, since
    // Postgres quotes identifiers only when it has to (round-46 landing).
    assert.match(apply, /table: "ReceiptRequestCard",[\s]*columns: \["owner", "deliveredOn"\],[\s]*partial: false,/);
    // And NOT partial: a partial unique index enforces the same rule but is
    // invisible to Prisma's diff engine, so CI would report it missing forever.
    assert.match(apply, /\(i\.indpred IS NOT NULL\) AS "partial"/);
    assert.match(apply, /i\.indisunique AS "unique"/);

    // The check has to actually run, not just be declared.
    assert.match(apply, /for \(const \{ name, table, columns, partial \} of expectedUniqueIndexes\)/);
    assert.match(apply, /VERIFY FAILED: index \$\{name\} is not what this script requires/);
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
        const create = /CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptRequestCard_owner_deliveredOn_key"[^;`]*/.exec(source);
        assert.ok(create, `${name} creates the index`);
        // Scoped to the CREATE INDEX statement, not the whole file: the
        // round-45 backfill legitimately selects `WHERE "deliveredOn" IS NOT
        // NULL`, and a file-wide assertion would read that as a partial index.
        assert.doesNotMatch(create[0], /WHERE/, `${name}'s index must not be partial`);
    }
});

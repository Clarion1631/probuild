import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chaserCompletedFor } from "../src/lib/receipt-sweep-marker";
import { outstandingQuarantine, parseAcceptedQuarantine, parseQuarantine } from "../src/lib/pipeline-health";
import { convertRegisterRows, splitSuffix } from "../src/lib/bank-register-pull";

/**
 * Codex PR #443, adversarial gate round 46.
 *
 * Four findings, and three of them are the same mistake round 45 made in a new
 * place: a fact was attached to something that does not last as long as the
 * fact. A split identity derived from mutable content; a full-run request
 * cleared before the thing it asked for existed; a completion stamp that
 * outlived the cycle it described.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

// ═══ 1. Split identity is ordinal; a manifest tells the cases apart ════════

test("a restatement keeps its identity, so it updates rather than minting a second row", () => {
    /**
     * Round 45 derived the id from the split CONTENT, so a QuickBooks
     * correction looked like a brand new observation: a second BankLine was
     * minted and the stale one stayed.
     */
    const before = [
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "T1", docNum: null, name: "LOWES", memo: null, amountCents: -100 },
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "T1", docNum: null, name: "LOWES", memo: null, amountCents: -200 },
    ];
    const first = convertRegisterRows(before);
    assert.deepEqual(first.lines.map(line => line.qbTxnId), ["T1#0", "T1#1"]);

    // QuickBooks restates the second split.
    const after = [before[0], { ...before[1], amountCents: -250 }];
    const second = convertRegisterRows(after, first.manifest);

    assert.deepEqual(second.lines.map(line => line.qbTxnId), ["T1#0", "T1#1"],
        "the same two identities — the ingest updates what it already has");
    assert.deepEqual(second.restated, ["T1#1"], "and the change is reported");
    assert.deepEqual(second.quarantined, []);

    // PRE-FIX CONTROL: a content-derived suffix moves when the content does,
    // which is exactly how a correction became a second row.
    const oldId = splitSuffix(JSON.stringify(["2026-08-12", -200, "LOWES", null]));
    const newId = splitSuffix(JSON.stringify(["2026-08-12", -250, "LOWES", null]));
    assert.notEqual(oldId, newId, "the round-45 identity would have changed here");
});

test("a 1-to-N cardinality change is quarantined, never guessed at", () => {
    const one = [
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "T2", docNum: null, name: "HD", memo: null, amountCents: -500 },
    ];
    const two = [
        one[0],
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "T2", docNum: null, name: "HD", memo: null, amountCents: -600 },
    ];

    // 1 -> N. Every ordinal may now mean something different, so no id can be
    // trusted to still name the posting it named yesterday.
    const oneThenTwo = convertRegisterRows(two, convertRegisterRows(one).manifest);
    assert.deepEqual(oneThenTwo.quarantined, [{ qbTxnId: "T2", reason: "split-cardinality-changed", count: 2 }]);
    assert.deepEqual(oneThenTwo.lines, [], "nothing from that transaction posts on a guess");

    // N -> 1, the same rule from the other direction.
    const twoThenOne = convertRegisterRows(one, convertRegisterRows(two).manifest);
    assert.deepEqual(twoThenOne.quarantined, [{ qbTxnId: "T2", reason: "split-cardinality-changed", count: 1 }]);
});

test("identical splits keep distinct ordinals", () => {
    // Round 45 collapsed these by content, which threw away a real posting.
    const rows = [
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "T5", docNum: null, name: "A", memo: null, amountCents: -100 },
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "T5", docNum: null, name: "A", memo: null, amountCents: -100 },
    ];
    const result = convertRegisterRows(rows);
    assert.deepEqual(result.lines.map(line => line.qbTxnId), ["T5#0", "T5#1"]);
    assert.equal(result.collapsed, 0, "nothing collapses by content any more");
});

test("a single-row transaction keeps its BARE id, so nothing stored is orphaned", () => {
    const rows = [
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "T3", docNum: null, name: "NAPA", memo: null, amountCents: -100 },
    ];
    assert.deepEqual(convertRegisterRows(rows).lines.map(line => line.qbTxnId), ["T3"]);
});

test("the manifest remembers transactions this window did not reach", () => {
    // A narrow window must not erase what a wide one learned, or the next wide
    // window reads every transaction as new and quarantines nothing.
    const wide = convertRegisterRows([
        { date: "2026-08-12", qbType: "Expense", qbTxnId: "T4", docNum: null, name: "A", memo: null, amountCents: -1 },
    ]);
    const narrow = convertRegisterRows([], wide.manifest);
    assert.deepEqual(Object.keys(narrow.manifest), ["T4"]);
});

// ═══ 2. A quarantine blocks certification until somebody accepts it ════════

test("a quarantine is durable, blocks the stamp, and is reported in health", () => {
    const route = read("src/app/api/cron/bank-register-pull/route.ts");

    // Persisted, then used as a gate. Round 45 only logged it, so the state
    // advanced, the clock stamped, and the chaser released cards over a
    // register that was short by exactly those rows.
    assert.match(route, /const quarantine = await persistQuarantine\(summary\.quarantined \?\? \[\]\);/);
    // And a store this run could not READ or WRITE blocks too (round-48 gate,
    // finding 2): "we do not know what is held" and "nothing is held" were the
    // same answer before, and the first one certified a short ledger.
    assert.match(route, /const quarantineBlocked = !quarantine\.ok;/);
    assert.match(route, /quarantineHeld\.length === 0 && !quarantineBlocked/);


    // A write failure still holds the stamp: the alternative is certifying over
    // rows nobody can see.
    assert.match(route, /return blocker\(QUARANTINE_UNWRITABLE_REASON, merged\);/,
        "a write failure preserves the KNOWN entries, not just this fetch");

    const health = read("src/lib/pipeline-health.ts");
    assert.match(health, /reasons\.push\(`bank-quarantine:\$\{input\.bankPull\.quarantinedCount\}`\);/);
});

test("accepting a quarantine releases the pipeline without un-missing the rows", () => {
    const entries = [
        { qbTxnId: "A", reason: "implausible-split-count", count: 30, firstSeenAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-03T00:00:00Z", version: 1 },
        { qbTxnId: "B", reason: "split-cardinality-changed", count: 2, firstSeenAt: "2026-09-02T00:00:00Z", lastSeenAt: "2026-09-03T00:00:00Z", version: 1 },
    ];
    const accept = (qbTxnId: string, version = 1) => ({ qbTxnId, version });
    assert.deepEqual(outstandingQuarantine(entries, []).map(entry => entry.qbTxnId), ["A", "B"]);
    assert.deepEqual(outstandingQuarantine(entries, [accept("A")]).map(entry => entry.qbTxnId), ["B"]);
    assert.deepEqual(outstandingQuarantine(entries, [accept("A"), accept("B")]), [],
        "accepted, so the pipeline moves");

    /**
     * AN ACCEPTANCE IS BOUND TO A VERSION (round-48 gate, finding 2). Accepting
     * "B as a 2-split cardinality change" must not silently accept B after it
     * becomes something else — the condition changed, so a human is asked again.
     */
    const changed = [{ ...entries[1], count: 40, reason: "implausible-split-count", version: 2 }];
    assert.deepEqual(outstandingQuarantine(changed, [accept("B", 1)]).map(e => e.qbTxnId), ["B"],
        "the old acceptance does not cover the new condition");
    assert.deepEqual(outstandingQuarantine(changed, [accept("B", 2)]), [], "accepting the new one does");

    // Unreadable state is NULL, not empty — reading a malformed store as
    // "nothing quarantined" is what let a run certify a ledger with rows
    // missing, and then overwrite the record of what was held.
    assert.equal(parseAcceptedQuarantine("not json"), null);
    assert.deepEqual(parseAcceptedQuarantine(null), [], "absent really is none");
    assert.equal(parseQuarantine("not json"), null);
    assert.equal(parseQuarantine(JSON.stringify([{ qbTxnId: "A" }])), null, "a half-typed entry is not readable");
    assert.equal(parseQuarantine(JSON.stringify(entries))?.length, 2);
    // A pre-round-48 acceptance was a bare string; it is honoured at version 1.
    assert.deepEqual(parseAcceptedQuarantine(JSON.stringify(["A"])), [{ qbTxnId: "A", version: 1 }]);
});

// ═══ 3. The full-run handoff is durable ═══════════════════════════════════

test("the full-run request outlives the reset, and a persisted cycle is work in progress", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");

    // The request is discharged only after the new cycle record is durable —
    // the first moment anything else could pick the work up.
    const resetAt = sweep.indexOf("await Promise.all([writeCursor(null), writeOpenCursor(null), writeCycle(null)]);");
    const writeCycleAt = sweep.indexOf("await writeCycle(cycle);");
    const clearAt = sweep.indexOf("if (clearFullRunRequestOnStart) await writeFullRunRequested(null);");
    assert.ok(resetAt > 0 && writeCycleAt > 0 && clearAt > writeCycleAt,
        "the cycle record is durable BEFORE the request that asked for it is cleared");

    // And a persisted cycle keeps a continuation alive even with no cursor
    // parked — which is the state a crash mid-handoff leaves behind.
    assert.match(sweep, /const cycleOpen = persistedCycle !== null;/);
    assert.match(sweep, /if \(!fullRunOwed && !cycleOpen && !shouldResumeSweep\(/);
});

test("PRE-FIX CONTROL: clearing the request inside the reset loses the day", () => {
    /**
     * The round-45 order, stated as the sequence of durable facts an observer
     * would see. A crash after the reset and before `runSweep` wrote the new
     * cycle left phase "done", no completion, no cursor and no request — and
     * every later continuation read that as nothing-in-progress.
     */
    const afterResetOldWay = { phase: "done", cursor: null, cycle: null, fullRunRequested: false };
    const wouldResumeOld = afterResetOldWay.cursor !== null
        || afterResetOldWay.cycle !== null
        || afterResetOldWay.fullRunRequested;
    assert.equal(wouldResumeOld, false, "nothing was asking for the work");

    // The new order keeps the request set until the cycle record exists, so the
    // same crash leaves something that still asks.
    const afterResetNewWay = { phase: "open-issues", cursor: null, cycle: null, fullRunRequested: true };
    const wouldResumeNew = afterResetNewWay.cursor !== null
        || afterResetNewWay.cycle !== null
        || afterResetNewWay.fullRunRequested;
    assert.equal(wouldResumeNew, true, "the request survives, so the next slot picks it up");
});

// ═══ 4. Completion is a tuple, and the cards read the CURRENT cycle ════════

test("a completion from a previous cycle cannot release the cards", () => {
    const today = "2026-09-03";
    const done = {
        phase: "done" as const,
        chaserCompletedAt: `${today}T13:20:00-07:00`,
        blockedReason: null,
        completedCycleId: "cycle-1",
    };
    assert.equal(chaserCompletedFor(done, today, "America/Los_Angeles", "cycle-1"), true);

    // A NEW cycle is running. The stamp is still today and still true about
    // cycle-1 — it just says nothing about cycle-2.
    assert.equal(chaserCompletedFor(done, today, "America/Los_Angeles", "cycle-2"), false,
        "a stale completion must not release cards for a cycle still in flight");

    // Mid-flight and blocked are both refusals, whatever the date says.
    assert.equal(chaserCompletedFor({ ...done, phase: "lines" }, today, "America/Los_Angeles", "cycle-1"), false);
    assert.equal(
        chaserCompletedFor({ ...done, blockedReason: "bank-pull-stale" }, today, "America/Los_Angeles", "cycle-1"),
        false,
    );

    // PRE-FIX CONTROL: the date-only question, which is what round 45 asked.
    assert.equal(chaserCompletedFor(done, today), true,
        "asking only about the date says yes to the stale-cycle case above");
});

test("starting a cycle clears the previous completion", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    // `cycleId === null` means "a cycle is starting", and that wipes the stamp,
    // so there is no window where the old answer applies to the new cycle.
    assert.match(sweep, /const startingNewCycle = cycleId === null;/);
    assert.match(sweep, /chaserCompletedAt: startingNewCycle \? null : \(completedAt \?\? previous\.chaserCompletedAt\),/);
    assert.match(sweep, /await writePhase\("open-issues", undefined, null, prisma, null\);/);
    // And a completion names the cycle it belongs to.
    assert.match(sweep, /writePhase\(phase, completedAt, blockedReason, tx, cycle\.id\)/);

    const cards = read("src/app/api/cron/receipt-request-cards/route.ts");
    assert.match(cards, /const selectionAllowed = chaserCompletedFor\(marker, date, "America\/Los_Angeles", currentCycleId\);/);
});

// ═══ The apply script is exercised end to end in CI ════════════════════════

test("CI runs the apply script against a real database, with seeded rows", () => {
    const ci = read(".github/workflows/ci.yml");
    assert.match(ci, /Apply script end-to-end against real Postgres/);
    assert.match(ci, /node scripts\/ci-apply-phase2-receipt-queue-e2e\.mjs/);

    const driver = read("scripts/ci-apply-phase2-receipt-queue-e2e.mjs");
    // The seeds are the point: an empty database exercises the CREATEs and
    // nothing else, and both the memo quarantine and the delivery backfill are
    // statements ABOUT EXISTING DATA that would report "ok" over an empty table.
    assert.match(driver, /INSERT INTO "ReviewIssue"/);
    // The resolution lives INSIDE displayDetails — there is no such column —
    // and the seed makes two issues claim the SAME pdfId, which is the shape
    // the quarantine repair exists for.
    assert.match(driver, /resolution: "memo-signed"/);
    assert.match(driver, /details\("ci-shared-pdf"\), details\("ci-shared-pdf"\)/);
    assert.match(driver, /the losing memo-signed claim was not quarantined/);
    assert.match(driver, /INSERT INTO "ReceiptRequestCard"/);
    assert.match(driver, /"deliveredOn"/);
    // Run twice, for idempotency — and the legacy CARDS are seeded BETWEEN the
    // two runs, because `ReceiptRequestCard` does not exist until the first one
    // creates it. That is also the truer story: production carries cards the
    // deployed app wrote after the first apply.
    assert.match(driver, /apply, again \(idempotency, and the backfill has work now\)/);
    const firstRunAt = driver.indexOf("=== apply ===");
    const cardSeedAt = driver.indexOf("INSERT INTO \"ReceiptRequestCard\"");
    const secondRunAt = driver.indexOf("=== apply, again");
    assert.ok(firstRunAt > 0 && cardSeedAt > firstRunAt && secondRunAt > cardSeedAt,
        "apply, then seed the legacy cards, then apply again");
    // A bound parameter arrives as text; timestamps need the cast.
    assert.match(driver, /\$1::timestamp/);
    // And the resulting shape is compared against a database built from the
    // committed migration — columns, indexes, RLS and policies.
    assert.match(driver, /pg_policies/);
    assert.match(driver, /relrowsecurity/);
    assert.match(driver, /the apply script and the migration produced DIFFERENT shapes/);
    // CI mode never reaches production.
    assert.match(driver, /"--target", "ci"/);
    assert.match(driver, /REFUSING: APPLY_E2E_SERVER_URL looks like production/);
});

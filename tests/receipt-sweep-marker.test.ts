import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    SWEEP_MARKER_KEY,
    chaserCompletedFor,
    formatSweepMarker,
    parseSweepMarker,
} from "../src/lib/receipt-sweep-marker";
import {
    componentVersionOf,
    componentVersionsMatch,
} from "../src/lib/receipt-requests";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── The cards cron waits for tonight's chase (round-16 item 3) ─────────────

test("a card is only selected after the chase COMPLETED today", () => {
    // Mid-cycle, the open set is a half-reconciled world: answered items are
    // not closed yet and items that should have opened have not. A card built
    // from it asks for receipts already sent AND misses the ones not sent, on
    // the same morning — and selection claims the owner's whole day.
    const today = "2026-09-02";
    const done = parseSweepMarker(formatSweepMarker({
        phase: "done",
        chaserCompletedAt: "2026-09-02T13:20:00Z", // 6:20am Pacific
    }));
    assert.equal(chaserCompletedFor(done, today), true);

    for (const [label, marker] of [
        ["never completed", { phase: "done" as const, chaserCompletedAt: null }],
        ["completed yesterday", { phase: "done" as const, chaserCompletedAt: "2026-09-01T13:20:00Z" }],
        ["still mid-cycle", { phase: "lines" as const, chaserCompletedAt: null }],
        ["a garbage timestamp", { phase: "done" as const, chaserCompletedAt: "whenever" }],
    ] as const) {
        assert.equal(chaserCompletedFor(marker, today), false, label);
    }

    // The crew's day, not UTC's: 11pm Pacific on the 2nd is the 3rd in UTC.
    const lateNight = { phase: "done" as const, chaserCompletedAt: "2026-09-03T06:00:00Z" };
    assert.equal(chaserCompletedFor(lateNight, "2026-09-02"), true, "still the 2nd in Pacific");
});

test("the marker row still reads correctly when an older build wrote it", () => {
    // It used to hold a bare phase string. That must parse as "no completion
    // recorded" — the reading that BLOCKS selection — rather than throwing or
    // being taken as done.
    // A bare phase carries no block either — absent must read as "nothing is
    // holding this back", never as an unknown that alarms.
    assert.deepEqual(parseSweepMarker("lines"), { phase: "lines", chaserCompletedAt: null, blockedReason: null });
    assert.deepEqual(parseSweepMarker("done"), { phase: "done", chaserCompletedAt: null, blockedReason: null });
    // And a JSON marker from the build BEFORE blockedReason existed.
    assert.deepEqual(
        parseSweepMarker(JSON.stringify({ phase: "done", chaserCompletedAt: "2026-09-02T13:20:00Z" })),
        { phase: "done", chaserCompletedAt: "2026-09-02T13:20:00Z", blockedReason: null },
    );
    assert.equal(chaserCompletedFor(parseSweepMarker("done"), "2026-09-02"), false);
    // Junk is not a licence to assume anything either.
    for (const junk of ["", "  ", "{not json", "[]", "null", undefined, null]) {
        assert.equal(chaserCompletedFor(parseSweepMarker(junk as string), "2026-09-02"), false, String(junk));
    }
    // Round-trips, block and all.
    const marker = { phase: "lines" as const, chaserCompletedAt: "2026-09-02T13:20:00Z", blockedReason: null };
    assert.deepEqual(parseSweepMarker(formatSweepMarker(marker)), marker);
    const blocked = { phase: "lines" as const, chaserCompletedAt: null, blockedReason: "bank-pull-stale" };
    assert.deepEqual(parseSweepMarker(formatSweepMarker(blocked)), blocked);
    // An empty string is not a reason.
    assert.equal(parseSweepMarker(JSON.stringify({ phase: "done", blockedReason: "" })).blockedReason, null);
    assert.equal(parseSweepMarker(JSON.stringify({ phase: "done", blockedReason: 7 })).blockedReason, null);
});

test("the sweep stamps only a clean cycle, and the cards cron refuses without one", () => {
    const sweep = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    // "done" stamps; anything else carries the previous stamp forward.
    assert.match(sweep, /await writePhase\(\s*phase,\s*decision\.complete \? new Date\(\)\.toISOString\(\) : undefined,\s*decision\.blockedReason,\s*\);/);
    assert.match(sweep, /chaserCompletedAt: completedAt \?\? previous\.chaserCompletedAt,/);
    // A STALE BANK PULL CANNOT REACH "done". The phase is forced back to
    // "lines" so `shouldResumeSweep` keeps saying yes and the every-15-minutes
    // resume stamps as soon as the pull recovers — leaving it "done" would make
    // the resume exit with "nothing-in-progress" and lose the day's cards to an
    // outage that had already been fixed (Codex PR #443 gate, finding 3).
    assert.match(sweep, /const decision = sweepCompletionDecision\(\{ computedPhase, bankPullStale \}\);/);
    // The block reason is RESTATED on every write, never carried forward, or
    // `chaser-blocked` would keep firing after the pull recovered.
    assert.match(sweep, /blockedReason,/);

    const cards = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    // The gate is now a named verdict, because the RETRY pass consults it too:
    // it may select when the chase finished after the morning run bailed.
    assert.match(cards, /const selectionAllowed = chaserCompletedFor\(marker, date\);/);
    assert.match(cards, /if \(!selectionAllowed\) \{/);
    assert.match(cards, /skipped: "chaser-incomplete"/);
    // ok:false so it is visible, 200 because retrying THIS invocation would not
    // help — and nothing is claimed, so the slot is still free later.
    assert.match(cards, /ok: false,\s*\n\s*skipped: "chaser-incomplete"/);
    assert.match(cards, /return NextResponse\.json\(summary, \{ status: 200 \}\);/);
    const gateAt = cards.indexOf("skipped: \"chaser-incomplete\"");
    const selectAt = cards.indexOf("const { items, overflow } = selectOwnerItems(");
    assert.ok(gateAt > 0 && selectAt > gateAt, "the gate comes BEFORE selection");
    // The retry pass is exempt: it never selects.
    assert.match(cards, /if \(!retryOnly\) \{[\s\S]{0,400}chaser-incomplete/);
    // ...and a retry pass that MAY select does so rather than losing the day.
    assert.match(cards, /if \(!selectionAllowed\) continue;/);
    assert.equal(SWEEP_MARKER_KEY, "receiptRequestsPhase", "one row, not a new table");
});

// ── A sibling moving mid-sweep replans the component (item 2) ──────────────

test("a memo signed mid-sweep changes the component version", () => {
    // Assignment is a property of the SET, so a memo signed on the charge NEXT
    // to this one changes this line's verdict without touching this line. A
    // per-row freshness check cannot see that.
    const planned = componentVersionOf({
        issues: [{ updatedAt: new Date("2026-09-02T10:00:00Z") }, { updatedAt: new Date("2026-09-02T09:00:00Z") }],
        intakes: [{ updatedAt: new Date("2026-09-02T08:00:00Z") }],
    });
    assert.equal(planned.newest, "2026-09-02T10:00:00.000Z");
    assert.equal(planned.issues, 2);
    assert.equal(planned.intakes, 1);
    assert.equal(componentVersionsMatch(planned, { ...planned }), true, "an untouched component replans nothing");

    // The SIBLING was answered while we were planning.
    const sibling = componentVersionOf({
        issues: [{ updatedAt: new Date("2026-09-02T10:00:00Z") }, { updatedAt: new Date("2026-09-02T10:05:00Z") }],
        intakes: [{ updatedAt: new Date("2026-09-02T08:00:00Z") }],
    });
    assert.equal(componentVersionsMatch(planned, sibling), false);

    // A new intake arriving, and an intake being DELETED — the second is why
    // the stamp carries counts and not just the newest timestamp.
    const added = componentVersionOf({
        issues: [{ updatedAt: new Date("2026-09-02T10:00:00Z") }, { updatedAt: new Date("2026-09-02T09:00:00Z") }],
        intakes: [{ updatedAt: new Date("2026-09-02T08:00:00Z") }, { updatedAt: new Date("2026-09-02T07:00:00Z") }],
    });
    assert.equal(componentVersionsMatch(planned, added), false, "an added row");
    const removed = componentVersionOf({
        issues: [{ updatedAt: new Date("2026-09-02T10:00:00Z") }, { updatedAt: new Date("2026-09-02T09:00:00Z") }],
        intakes: [],
    });
    assert.equal(componentVersionsMatch(planned, removed), false, "a deleted row is invisible to a max()");
});

test("a changed component is replanned, and never committed from a stale plan", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    // Plan, LOCK, verify against the locked rows, THEN write — all inside one
    // transaction per component, so nothing can move between the check and the
    // writes and no component commits half its verdicts.
    const planAt = source.indexOf("const fullPlan = planReceiptRequests({");
    const lockAt = source.indexOf("FOR UPDATE`;", planAt);
    const checkAt = source.indexOf("if (!componentVersionsMatch(planned, current)) throw new ComponentMovedError();");
    const applyAt = source.indexOf("const applied = await applyReceiptRequestPlan(");
    assert.ok(planAt > 0 && lockAt > planAt, "the locks come first");
    assert.ok(checkAt > lockAt, "the fingerprint is recomputed from the LOCKED rows");
    assert.ok(applyAt > checkAt, "and the writes come last");
    // Both lock statements, in id order.
    assert.match(source, /SELECT "id" FROM "ReviewIssue"[\s\S]{0,220}ORDER BY "id"\s*\n\s*FOR UPDATE/);
    assert.match(source, /SELECT "id" FROM "ReceiptIntake"[\s\S]{0,160}ORDER BY "id"\s*\n\s*FOR UPDATE/);
    // A mismatch aborts the transaction: nothing committed, and a replan.
    assert.match(source, /class ComponentMovedError extends Error/);
    assert.match(source, /undecided: componentOpen\.length \+ componentClose\.length,\s*\n\s*replan: true,/);
    // The lifecycle writes join THIS transaction rather than opening their own.
    assert.match(source, /client: flattened as unknown as ReviewIssueLifecycleClient,/);
    // Bounded, and the give-up is an OPEN chase, not a close.
    assert.match(source, /const MAX_COMPONENT_REPLANS = 3;/);
    assert.match(source, /for \(let attempt = 1; attempt <= MAX_COMPONENT_REPLANS; attempt\+\+\)/);
    // ...and it is reported as CONTENDED as well as undecided, which is what
    // stops the run stamping a completion over a component nobody reconciled.
    assert.match(source, /return \{ summary: emptySummary\(\), undecided: batch\.length, contended: batch\.length, replans \};/);
    // Both passes go through the replanning wrapper.
    const wrapped = source.match(/await processBatchWithReplan\(/g) ?? [];
    assert.equal(wrapped.length, 2, "the open-issue pass and the line pass");
    assert.match(source, /replans,\s*\n\s*bankLines: linesSeen,/, "and it is reported");
});


// -- The stamp covers EVERY planner input (round-17 item 3) ----------------

test("a receipt attached to an existing Expense mid-plan forces a replan", () => {
    // THE RACE: a bookkeeper attaches a receipt to an expense that already
    // existed. `hasReceipt` flips false to true, every line in the component
    // gets a new answer - and Expense HAS NO updatedAt column (only createdAt
    // and qbSyncedAt), so no timestamp anywhere on that row moves. Hashing the
    // flag is the only fingerprint that sees it.
    const issues = [{ updatedAt: new Date("2026-09-02T10:00:00Z") }];
    const intakes: Array<{ updatedAt: Date }> = [];
    const lines = [{ id: "bl-1", updatedAt: new Date("2026-09-02T09:00:00Z"), rawDescriptor: "LOWES #02516" }];

    const before = componentVersionOf({
        issues, intakes, lines,
        expenses: [{ id: "exp-1", hasReceipt: false }, { id: "exp-2", hasReceipt: true }],
    });
    const after = componentVersionOf({
        issues, intakes, lines,
        expenses: [{ id: "exp-1", hasReceipt: true }, { id: "exp-2", hasReceipt: true }],
    });
    assert.equal(before.expenses, after.expenses, "the COUNT is identical - that is the trap");
    assert.equal(before.newest, after.newest, "and so is every timestamp");
    assert.notEqual(before.expenseHash, after.expenseHash);
    assert.equal(componentVersionsMatch(before, after), false, "so the plan must be redone");
});

test("a BankLine inserted mid-plan forces a replan", () => {
    // The nightly pull minting a line, or a statement import landing, adds a
    // competitor for the same evidence. The plan was made without it.
    const issues = [{ updatedAt: new Date("2026-09-02T10:00:00Z") }];
    const intakes: Array<{ updatedAt: Date }> = [];
    const expenses = [{ id: "exp-1", hasReceipt: true }];

    const before = componentVersionOf({
        issues, intakes, expenses,
        lines: [{ id: "bl-1", updatedAt: new Date("2026-09-02T09:00:00Z"), rawDescriptor: "LOWES #02516" }],
    });
    const after = componentVersionOf({
        issues, intakes, expenses,
        lines: [
            { id: "bl-1", updatedAt: new Date("2026-09-02T09:00:00Z"), rawDescriptor: "LOWES #02516" },
            { id: "bl-2", updatedAt: new Date("2026-09-02T09:30:00Z"), rawDescriptor: "LOWES #02516" },
        ],
    });
    assert.equal(componentVersionsMatch(before, after), false);
    assert.equal(after.lines, 2);

    // And a REFRESHED descriptor on the same line, which changes the payee and
    // therefore what matches, even though the id set is unchanged.
    const refreshed = componentVersionOf({
        issues, intakes, expenses,
        lines: [{ id: "bl-1", updatedAt: new Date("2026-09-02T09:00:00Z"), rawDescriptor: "LOWES #02516 POS DEB C#8516" }],
    });
    assert.equal(refreshed.lines, before.lines);
    assert.notEqual(refreshed.lineHash, before.lineHash);
    assert.equal(componentVersionsMatch(before, refreshed), false);
});

test("the cron stamps all four inputs, at plan time and again under the lock", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    // Two stamps per component: what it was planned from, and what the locked
    // rows say now.
    const stamps = source.match(/componentVersionOf\(\{/g) ?? [];
    assert.equal(stamps.length, 2, "plan time and check time");
    for (const input of ["issues:", "intakes:", "lines:", "expenses:"]) {
        const matches = source.match(new RegExp(input, "g")) ?? [];
        assert.ok(matches.length >= 2, `both stamps must cover ${input}`);
    }
    // The re-read happens on the TRANSACTION, so it sees the locked rows.
    for (const model of ["tx.reviewIssue.findMany", "tx.receiptIntake.findMany", "tx.bankLine.findMany", "tx.expense.findMany"]) {
        assert.ok(source.includes(model), model);
    }
    // Lines are re-read BY AMOUNT AND SPAN, not by an id list drawn from the
    // plan — that list is exactly what cannot see a line that just arrived.
    // The span is the JOIN window (COMPETING_LINE_ADJACENCY_DAYS), not the
    // narrower evidence window — a line up to 4 days past an edge can still
    // join this component, and the re-read has to be wide enough to see it.
    assert.match(source, /where: \{ amountCents: \{ in: amounts \}, postedDate: joinRange\.calendar \}/);
});

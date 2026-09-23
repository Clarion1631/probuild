import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cycleMatchesPlannerDay, type SweepCycle } from "../src/lib/receipt-sweep-marker";

/**
 * cheap-sweep-restart-spec.md §14.5 (Codex round 2 blocker 3): one planner
 * day per cycle. `now` is captured once, as the FIRST statement of
 * `runSweep`, and a cycle whose `plannerDay` no longer matches the current
 * invocation's UTC day is stale and restarts — closing the interleaving
 * Codex described: `now` captured just before UTC midnight, the cycle record
 * written just after it.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

test("a pure case: a cycle created just before UTC midnight is stale one moment after it", () => {
    const createdAt = new Date("2026-09-22T23:59:59.900Z");
    const plannerDay = createdAt.toISOString().slice(0, 10);
    assert.equal(plannerDay, "2026-09-22");

    const cycle: SweepCycle = { id: "c1", epoch: "1", evidenceEpoch: "1", plannerDay };
    assert.equal(cycleMatchesPlannerDay(cycle, createdAt), true, "still valid at the instant it was created");

    const oneMomentLater = new Date("2026-09-23T00:00:00.100Z");
    assert.equal(cycleMatchesPlannerDay(cycle, oneMomentLater), false, "a new UTC day — stale 200ms later, even though almost no time passed");
});

test("source pin: plannerDay is captured as the first statement of runSweep", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    const runSweepAt = sweep.indexOf("async function runSweep(");
    const bodyOpenAt = sweep.indexOf(") {", runSweepAt);
    const plannerDayAt = sweep.indexOf("const plannerDay = now.toISOString().slice(0, 10);", runSweepAt);
    const windowStartAt = sweep.indexOf("const windowStart = registerWindowStartYmd(now, LOOKBACK_DAYS);", runSweepAt);
    assert.ok(runSweepAt > 0 && bodyOpenAt > runSweepAt && plannerDayAt > bodyOpenAt, "runSweep declares plannerDay");
    assert.ok(plannerDayAt < windowStartAt, "plannerDay is captured before windowStart");

    // Nothing but a comment may sit between the function's opening brace and
    // the plannerDay declaration — that is what makes it the FIRST statement,
    // using the same `now` every processBatch and planner call in this
    // invocation is judged against.
    const between = sweep.slice(bodyOpenAt + ") {".length, plannerDayAt);
    const stripped = between
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(/\r?\n/)
        .map(line => line.replace(/\/\/.*/, ""))
        .join("\n")
        .trim();
    assert.equal(stripped, "", `only a comment may precede plannerDay, found: ${JSON.stringify(stripped)}`);
});

test("source pin: the stale rule also restarts on a planner-day mismatch", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");

    // The first two disjuncts stay byte-identical — pinned separately at
    // tests/receipt-round43-fixes.test.ts:241-242.
    assert.match(sweep, /const stale = !cycleStillValid\(cycle, snapshotEpoch, snapshotEvidenceEpoch, RECOGNITION_POLICY\)\s*\n\s*\|\| storedCursors\.some\(cursor => !cursorUsableAt\(cursor, snapshotEpoch, snapshotEvidenceEpoch\)\)\s*\n\s*\|\| !cycleMatchesPlannerDay\(cycle, now\);/);

    // restarted: declared at FUNCTION scope (before the stale-check block, not
    // inside it), so it is still readable once that block ends — needed by
    // the cycle-start log (§14.7), which is written later in the same function.
    const cycleReadAt = sweep.indexOf("let cycle = await readCycle();");
    const restartedDeclAt = sweep.indexOf("let restarted = false;", cycleReadAt);
    const staleBlockAt = sweep.indexOf('if (startPhase === "lines" || cycle !== null) {', cycleReadAt);
    assert.ok(cycleReadAt > 0 && restartedDeclAt > cycleReadAt && staleBlockAt > restartedDeclAt,
        "restarted is declared before the stale-check block starts");
    assert.match(sweep, /if \(stale\) \{\s*\n\s*restarted = true;/, "restarted is set true in the stale branch");

    // The restart log now also carries plannerDay and the cycle's own, for
    // the case where the two disagree.
    assert.match(sweep, /cursors: storedCursors\.map\(cursor => \(\{ epoch: cursor\.epoch, evidenceEpoch: cursor\.evidenceEpoch \}\)\),\s*\n\s*plannerDay,\s*\n\s*cyclePlannerDay: cycle\?\.plannerDay \?\? null,/);
    // The message text itself is unchanged.
    assert.match(sweep, /"\[cron\/receipt-requests\] ledger or evidence moved under the cycle; restarting it"/);
});

test("source pin: a fresh cycle record carries plannerDay", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    assert.match(sweep, /cycle = \{ id: randomUUID\(\), epoch: snapshotEpoch, evidenceEpoch: snapshotEvidenceEpoch, recognitionPolicy: RECOGNITION_POLICY, plannerDay \};/);
});

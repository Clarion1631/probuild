import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * cheap-sweep-restart-spec.md §14.7: one progress line per leased invocation,
 * plus two per-cycle event lines ("cycle-start", "certified"). All three are
 * source-pinned here — ids and counts only, never a bank-line or issue id,
 * and "progress" must be the last thing `GET` does before the lease it held
 * is released.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

test("source pin: cycle-start logs right after writeCycle, in the creation branch only", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");

    const creationAt = sweep.indexOf("if (cycle === null) {");
    const writeCycleAt = sweep.indexOf("await writeCycle(cycle);", creationAt);
    const logAt = sweep.indexOf('console.log("[cron/receipt-requests] cycle-start"', creationAt);
    const closeAt = sweep.indexOf("\n    }", logAt);
    assert.ok(creationAt > 0 && writeCycleAt > creationAt && logAt > writeCycleAt,
        "cycle-start logs after writeCycle, inside the creation branch");

    const body = sweep.slice(logAt, closeAt);
    assert.match(body, /cycleId: cycle\.id,/);
    assert.match(body, /plannerDay,/);
    assert.match(body, /reason: clearFullRunRequestOnStart \? "full-run" : restarted \? "restart" : "none",/);
    assert.match(body, /epoch: snapshotEpoch,/);
    assert.match(body, /evidenceEpoch: snapshotEvidenceEpoch,/);

    // Not logged when an existing cycle is merely being continued — this is
    // the once-per-cycle line, not the once-per-invocation one. progress.cycleId
    // is filled right after, outside the creation branch, on every invocation.
    const ifProgressAt = sweep.indexOf("if (progress) {", closeAt);
    const cycleIdFillAt = sweep.indexOf("progress.cycleId = cycle.id;", ifProgressAt);
    assert.ok(ifProgressAt > closeAt && cycleIdFillAt > ifProgressAt && cycleIdFillAt < ifProgressAt + 60,
        "progress.cycleId is filled unconditionally, right after the creation branch");
});

test("source pin: certified logs cycleId, plannerDay and the fence's own completedAt, only when decision.complete", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");

    const fenceCallAt = sweep.indexOf("decision = await fenceAndWritePhase(");
    const completedAtDeclAt = sweep.lastIndexOf("const completedAt = new Date();", fenceCallAt);
    const nowArgAt = sweep.indexOf("now: completedAt }", fenceCallAt);
    assert.ok(completedAtDeclAt > 0 && completedAtDeclAt < fenceCallAt,
        "completedAt is captured in a const before the fenceAndWritePhase call");
    assert.ok(nowArgAt > fenceCallAt, "that same completedAt is passed as fenceAndWritePhase's now");

    const guardAt = sweep.indexOf("if (decision.complete) {", fenceCallAt);
    const logAt = sweep.indexOf('console.log("[cron/receipt-requests] certified"', guardAt);
    const closeAt = sweep.indexOf("));", logAt);
    assert.ok(guardAt > nowArgAt && logAt > guardAt && closeAt > logAt,
        "certified only logs when decision.complete, after the fence call");

    const body = sweep.slice(logAt, closeAt);
    assert.match(body, /cycleId: cycle!\.id,/);
    assert.match(body, /plannerDay,/);
    assert.match(body, /completedAt: completedAt\.toISOString\(\),/);
});

test("source pin: progress is declared before GET's try, and logged inside finally before releaseLease", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");

    const getAt = sweep.indexOf("export async function GET(request: Request) {");
    const leaseAt = sweep.indexOf("await takeLease(LEASE_KEY, RUN_LEASE_MS, now, leaseToken)", getAt);
    const progressDeclAt = sweep.indexOf("const progress: SweepProgress = {", getAt);
    const tryAt = sweep.indexOf("\n    try {", progressDeclAt);
    assert.ok(getAt > 0 && leaseAt > getAt && progressDeclAt > leaseAt && tryAt > progressDeclAt,
        "progress is declared after the lease is taken and before the try block");

    const runSweepCallAt = sweep.indexOf("return await runSweep(now", tryAt);
    assert.ok(runSweepCallAt > tryAt);
    assert.match(sweep.slice(runSweepCallAt, runSweepCallAt + 120), /startingFullRun \? "open-issues" : resumePhase, startingFullRun, budget, progress\);/,
        "progress is passed as runSweep's new last argument, the pinned prefix unchanged");

    const finallyAt = sweep.indexOf("} finally {", runSweepCallAt);
    const progressLogAt = sweep.indexOf('console.log("[cron/receipt-requests] progress"', finallyAt);
    const releaseAt = sweep.indexOf("await releaseLease(LEASE_KEY, leaseToken);", finallyAt);
    assert.ok(finallyAt > 0 && progressLogAt > finallyAt && releaseAt > progressLogAt,
        "progress is logged inside finally, before the lease is released");
    assert.match(sweep.slice(progressLogAt, releaseAt),
        /JSON\.stringify\(\{ \.\.\.progress, totalMs: Date\.now\(\) - now\.getTime\(\) \}\)/);
});

test("source pin: the catch sets outcome to deferred, cursor-write-failed or error", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    const getAt = sweep.indexOf("export async function GET(request: Request) {");
    const catchAt = sweep.indexOf("} catch (error) {", getAt);
    const finallyAt = sweep.indexOf("} finally {", catchAt);
    const body = sweep.slice(catchAt, finallyAt);

    const deferredAt = body.indexOf('progress.outcome = "deferred";');
    const deferredReturnAt = body.indexOf("deferred: true, moreToProcess: true");
    const cursorFailAt = body.indexOf('progress.outcome = "cursor-write-failed";');
    const cursorFailReturnAt = body.indexOf('error: "cursor-write-failed"');
    const errorAt = body.indexOf('progress.outcome = "error";');
    const rethrowAt = body.indexOf("throw error;");

    assert.ok(deferredAt > 0 && deferredAt < deferredReturnAt, "deferred set before its return");
    assert.ok(cursorFailAt > deferredReturnAt && cursorFailAt < cursorFailReturnAt, "cursor-write-failed set before its return");
    assert.ok(errorAt > cursorFailReturnAt && errorAt < rethrowAt, "error set before the rethrow");
});

test("source pin: runSweep fills in progress from result (ids and counts, never failedTargets or cursor)", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    const resultAt = sweep.indexOf("const result = {");
    const fillGuardAt = sweep.indexOf("if (progress) {", resultAt);
    const fillAt = sweep.indexOf("progress.phase = result.phase;", fillGuardAt);
    const returnAt = sweep.indexOf("return NextResponse.json(result,", fillAt);
    assert.ok(resultAt > 0 && fillGuardAt > resultAt && fillAt > fillGuardAt && fillAt < fillGuardAt + 60 && returnAt > fillAt,
        "progress is filled from result after it is built, before the final return");

    const body = sweep.slice(fillAt, returnAt);
    for (const field of [
        "phase", "openBatches", "batches", "bankLines", "opened", "closed", "touched",
        "errors", "contended", "undecided", "undecidedLines", "replans",
    ]) {
        assert.match(body, new RegExp(`progress\\.${field} = result\\.${field};`), `progress.${field} comes from result`);
    }
    assert.match(body, /progress\.setupMs = setupMs;/);
    assert.match(body, /progress\.openMs = openMs;/);
    assert.match(body, /progress\.lineMs = lineMs;/);
    assert.match(body, /progress\.fenceMs = fenceMs;/);
    assert.match(body, /progress\.certified = decision\.complete;/);
    assert.match(body, /progress\.reason = result\.reason \?\? null;/);
    assert.doesNotMatch(body, /result\.failedTargets/);
    assert.doesNotMatch(body, /result\.cursor\b/);
});

test("source pin: progress is also filled incrementally at each pass's own checkpoint, not only from the final result (Codex round 1, real issue: exceptional progress logs lose committed work)", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");

    // The open-issue pass: synced right after its own loop, from openPass's
    // real totals — reached even when the LINE pass below goes on to throw.
    const openMsAt = sweep.indexOf("const openMs = Date.now() - openStart;");
    const openSyncAt = sweep.indexOf("if (progress) {", openMsAt);
    const openSyncCloseAt = sweep.indexOf("\n    }", openSyncAt);
    assert.ok(openMsAt > 0 && openSyncAt > openMsAt,
        "the open pass syncs progress after openMs is computed");
    const openSyncBody = sweep.slice(openSyncAt, openSyncCloseAt);
    assert.match(openSyncBody, /progress\.opened = totals\.opened;/);
    assert.match(openSyncBody, /progress\.errors = totals\.errors;/);
    assert.match(openSyncBody, /progress\.openMs = openMs;/);

    // The line pass: synced inside its OWN per-page checkpoint callback, so a
    // throw on a LATER page still leaves this page's real, committed counts
    // behind instead of the zeros `progress` started with.
    const lineCheckpointAt = sweep.indexOf("cursor = page[page.length - 1].key;");
    const lineSyncAt = sweep.indexOf("if (progress) {", lineCheckpointAt);
    const lineCheckpointCloseAt = sweep.indexOf("\n        });", lineCheckpointAt);
    assert.ok(lineCheckpointAt > openSyncCloseAt, "the line-pass checkpoint comes after the open-pass sync");
    assert.ok(lineSyncAt > lineCheckpointAt && lineSyncAt < lineCheckpointCloseAt,
        "the line pass syncs progress inside its own checkpoint callback, before that callback closes");
    const lineSyncBody = sweep.slice(lineSyncAt, lineCheckpointCloseAt);
    assert.match(lineSyncBody, /progress\.opened = totals\.opened;/);
    assert.match(lineSyncBody, /progress\.errors = totals\.errors;/);
    assert.match(lineSyncBody, /progress\.lineMs = Date\.now\(\) - lineStart;/);
});

// ═══ Codex round 2: "exceptional progress logs lose committed work" was only
// PARTIALLY fixed in round 2 — the sync above lands inside each checkpoint
// callback, but it used to run AFTER the awaited cursor write, so a
// `CursorWriteError` thrown by that write (a real, tested outcome — see
// `progress.outcome = "cursor-write-failed"` below) skipped the copy and
// GET's `finally` logged the PREVIOUS page's counts, not this one's already-
// committed work. The fix moves the copy before the write. These two pin
// that ORDER specifically; the "presence" test above still passes on the
// unfixed code (Codex's own words: "its assertions are compatible with the
// remaining bug") because it never checks what comes AFTER the sync. ═══════

test("source pin: the line-pass checkpoint copies progress BEFORE the awaited cursor write, not after", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    const lineCheckpointAt = sweep.indexOf("cursor = page[page.length - 1].key;");
    const lineSyncAt = sweep.indexOf("if (progress) {", lineCheckpointAt);
    const writeCursorAt = sweep.indexOf("await writeCursor(formatSweepCursor(", lineCheckpointAt);
    const exhaustedAt = sweep.indexOf("if (pageIndex >= pages.length) exhausted = true;", lineCheckpointAt);
    assert.ok(lineCheckpointAt > 0 && lineSyncAt > lineCheckpointAt,
        "the checkpoint syncs progress from the cursor it is about to persist");
    assert.ok(writeCursorAt > lineSyncAt,
        "progress must be copied BEFORE the awaited cursor write — a CursorWriteError there must not discard this page's already-committed counts");
    // `exhausted` is a claim that the write itself succeeded, so it stays
    // gated on the write, unlike `progress` (which describes committed DB
    // work that happened before this checkpoint ran at all).
    assert.ok(exhaustedAt > writeCursorAt, "exhausted is still set only after the cursor write succeeds");
});

test("source pin: the open-issue-pass checkpoint copies progress BEFORE the awaited cursor write, same as the line pass", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    const openCheckpointAt = sweep.indexOf("openCursor = page[page.length - 1].id;");
    const openSyncAt = sweep.indexOf("if (progress) {", openCheckpointAt);
    const writeOpenCursorAt = sweep.indexOf("await writeOpenCursor(formatSweepCursor(", openCheckpointAt);
    assert.ok(openCheckpointAt > 0 && openSyncAt > openCheckpointAt,
        "the checkpoint syncs progress from the cursor it is about to persist");
    assert.ok(writeOpenCursorAt > openSyncAt,
        "progress must be copied BEFORE the awaited open-cursor write, not after");
});

test("source pin: the SweepProgress shape names every field the brief lists", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    const ifaceAt = sweep.indexOf("interface SweepProgress {");
    const closeAt = sweep.indexOf("\n}", ifaceAt);
    assert.ok(ifaceAt > 0 && closeAt > ifaceAt);
    const body = sweep.slice(ifaceAt, closeAt);
    for (const field of [
        "cycleId", "plannerDay", "phase", "outcome", "openBatches", "batches", "bankLines",
        "opened", "closed", "touched", "errors", "contended", "undecided", "undecidedLines",
        "replans", "setupMs", "openMs", "lineMs", "fenceMs", "certified", "reason",
    ]) {
        assert.match(body, new RegExp(`\\b${field}[?]?:`), `SweepProgress names ${field}`);
    }
    assert.match(body, /outcome: "ok" \| "deferred" \| "cursor-write-failed" \| "error";/);
});

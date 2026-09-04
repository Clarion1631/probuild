/**
 * The billing paths walk a LIST of milestones doing several serial QuickBooks
 * calls each.
 *
 * Codex gate (round 27, item 4): bounding the individual calls was not enough.
 * `billing-core.ts` fetched tokens with no shared budget, then caught failures
 * per milestone and carried on — so during the 2026-09-01 outage every row
 * burned a fresh 20s deadline against the same wall and the action was killed
 * at the platform ceiling with nothing reported. That is the original defect,
 * one level up.
 *
 * The fix is one RouteDeadline per entry, threaded through every call, plus a
 * stop rule: connection-level failures end the loop, business failures do not.
 * These tests cover the classification, the cumulative-budget arithmetic that
 * makes the stop rule necessary, and a source tripwire that every loop still
 * uses both.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    BILLING_QBO_BUDGET_MS,
    isSharedQboWall,
    outageNote,
} from "../src/lib/billing-core";
import {
    QBTimeoutError,
    QboRetryableError,
    QboHttpError,
    QBTokenStrandedError,
    QBBudgetExhaustedError,
    createRouteDeadline,
    isBudgetExhausted,
    remainingBudgetMs,
} from "../src/lib/quickbooks";
import { QBResolveRequiredError } from "../src/lib/qbo-create-markers";

test("the stop rule separates the shared wall from a per-row refusal", () => {
    // Stop: the NEXT row would fail identically, at full cost.
    const walls: unknown[] = [
        new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/invoice"),
        new QboRetryableError("QB invoice create failed (503)", 503),
        new QboRetryableError("QB invoice create failed (429)", 429),
        new QboHttpError("QB invoice create failed (401)", 401),
        new QboHttpError("QB invoice create failed (403)", 403),
        new QBTokenStrandedError("HTTP 500"),
        new QBBudgetExhaustedError("/v3/company/x/invoice"),
    ];
    for (const error of walls) {
        assert.equal(isSharedQboWall(error), true, (error as Error).message);
    }

    // Carry on: these are about THIS row and say nothing about the connection.
    const perRow: unknown[] = [
        new Error("Milestone is already paid"),
        new QboHttpError("QB invoice create failed (400): Duplicate Document Number", 400),
        new QBResolveRequiredError("Rough-in"),
    ];
    for (const error of perRow) {
        assert.equal(isSharedQboWall(error), false, (error as Error).message);
    }
});

test("a row we never attempted says so, and says why", () => {
    assert.match(outageNote(new QBTimeoutError("timed out")), /stopped responding/);
    assert.match(outageNote(new QboRetryableError("503", 503)), /unavailable/);
    for (const error of [new QBTimeoutError("t"), new QboRetryableError("503", 503)]) {
        assert.match(outageNote(error), /not attempted/, "never imply we tried and failed");
    }
});

test("N rows on ONE budget cannot outlive the action ceiling", () => {
    // The arithmetic the stop rule exists for. Six rows at a 20s per-call
    // deadline is 120s of wall time; the shared budget is what makes the run
    // stop at 45s instead, in time to return a result.
    const PER_CALL_MS = 20_000;
    const started = Date.now();
    const deadline = createRouteDeadline(BILLING_QBO_BUDGET_MS, started);

    let attempted = 0;
    let clock = started;
    for (let row = 0; row < 20; row++) {
        if (isBudgetExhausted(deadline, clock)) break;
        attempted++;
        clock += PER_CALL_MS; // every row times out against the same wall
    }

    assert.ok(attempted <= Math.ceil(BILLING_QBO_BUDGET_MS / PER_CALL_MS), `attempted ${attempted}`);
    assert.ok(clock - started <= 60_000, "the whole run stays under the 60s server-action ceiling");
    assert.ok(remainingBudgetMs(deadline, started) <= BILLING_QBO_BUDGET_MS);

    // And with the stop rule the run ends on the FIRST wall, not the third.
    let attemptedWithStopRule = 0;
    for (let row = 0; row < 20; row++) {
        attemptedWithStopRule++;
        if (isSharedQboWall(new QBTimeoutError("timed out"))) break;
    }
    assert.equal(attemptedWithStopRule, 1);
});

// --- Source tripwire: every looping QBO caller keeps both halves -----------

/**
 * A budget that is created but not consulted, or a catch that records and
 * carries on, reopens the exact defect. Each entry names a function and the
 * two things its loop must still do.
 */
const LOOPING_CALLERS: { file: string; fn: string }[] = [
    { file: "src/lib/billing-core.ts", fn: "export async function resendInvoiceCore" },
    { file: "src/lib/billing-core.ts", fn: "export async function sendMilestoneInvoicesCore" },
    { file: "src/lib/billing-core.ts", fn: "export async function updatePendingMilestoneAmountsCore" },
];

test("every looping QuickBooks caller shares one budget and stops on the wall", () => {
    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    for (const { fn } of LOOPING_CALLERS) {
        const start = source.indexOf(fn);
        assert.ok(start >= 0, `${fn} not found — rename it here too`);
        // Up to the next top-level export, or the end of the file.
        const nextExport = source.indexOf("\nexport ", start + fn.length);
        const body = source.slice(start, nextExport === -1 ? undefined : nextExport);
        assert.ok(
            /deadline\?: RouteDeadline|qbDeadline|sendDeadline/.test(body),
            `${fn} does not take or create a shared RouteDeadline`,
        );
        assert.ok(
            body.includes("isBudgetExhausted"),
            `${fn} never checks the budget between rows`,
        );
        assert.ok(
            body.includes("isSharedQboWall"),
            `${fn} keeps looping past a connection-level failure`,
        );
    }
});

test("the QuickBooks sync route runs its call chain on one budget", () => {
    const source = readFileSync("src/app/api/quickbooks/sync/route.ts", "utf8");
    assert.ok(source.includes("createRouteDeadline"), "no route budget");
    // Token refresh, customer ensure, service-item ensure, document sync: the
    // whole serial chain has to be on it, not just the first call.
    // Matched as an ARGUMENT rather than only in final position: since the
    // round-38 idempotency work the two document-sync calls take a trailing
    // QuickBooks requestid AFTER the deadline, so `deadline)` alone stopped
    // seeing them while they were still perfectly well budgeted.
    const deadlineArgs = source.match(/deadline[,)]/g) ?? [];
    assert.ok(deadlineArgs.length >= 5, `only ${deadlineArgs.length} calls carry the deadline`);
    // ...and specifically the create on each rail, which is the call that costs
    // money to get wrong.
    assert.match(source, /qb\.glMappings \|\| \{\}, deadline, syncRequestId\(/);
    assert.match(source, /\}, deadline, syncRequestId\(invoice\.id/);
    assert.ok(source.includes("isQboConnectionFailure"), "an outage still answers 500");
});

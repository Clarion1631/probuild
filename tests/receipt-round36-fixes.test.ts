import test, { before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { PULL_MAX_WINDOW_DAYS, type PullWindowState } from "../src/lib/bank-register-pull";
import { BANK_PULL_LAST_SUCCESS_KEY } from "../src/lib/pipeline-health";
import {
    MEMO_CONFLICT_RESOLUTION,
    MEMO_SIGNED_RESOLUTION,
    hasBackedResolution,
    hasResolution,
} from "../src/lib/receipt-requests";
import {
    BANK_PULL_STALE_REASON,
    PULL_MOVED_REASON,
    ledgerMovedDuringPass,
    sweepCompletionDecision,
} from "../src/app/api/cron/receipt-requests/route";

/**
 * Codex PR #443, adversarial gate round 36.
 *
 * Each test is the failure story it closes:
 *
 *  1. A pull that could not finish the picture said so in its response and
 *     NOWHERE ELSE. A window the planner capped ingests everything it asked
 *     for, so `continueAfter` is cleared as finished; a reconcile that stopped
 *     on its own cap wrote nothing at all. Both report `complete: false`, and
 *     both left `pullContinuationPending` answering no — so every 15-minute
 *     slot exited with `nothing-in-progress` and a backlog drained one NIGHT
 *     per window while the 13:00 chaser waited on a stamp that could not come.
 *  2. The chaser's line pass loads its window ONCE and reads the pull's
 *     freshness marker at the END. A pull landing in between satisfies both: a
 *     fresh marker over a stale snapshot, so the cycle stamped "complete" for a
 *     list that was short by exactly the charges the pull had just delivered,
 *     and the morning card said the list was finished.
 *  3. The memo backfill binds the oldest claimant of a duplicated pdfId and
 *     leaves the others with a `memo-signed` resolution and no artifact. Since
 *     `hasResolution` alone closed a chase, a memo spent on one charge kept a
 *     second charge closed forever.
 *  4. The freshness stamp failing was a log line: the run answered 200 with
 *     `ok: true` while the clock the chaser reads had not moved, and the first
 *     sign was `bank-pull-stale` thirty-six hours later.
 *  5. The window state validated its retry bounds and took every other date on
 *     trust. A corrupt `highWater` made the planned window `NaN..NaN` and threw
 *     on every run; a corrupt `lastFullSweep` was quieter and worse —
 *     `todayMs - NaN >= 7 days` is false, so the deep sweep read as "not due"
 *     forever.
 */

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

// ── The pull cron, driven for real over a fake KV table ─────────────────────

/** The AutomationSetting KV table, as a map. */
let settings: Map<string, string>;
/** Every [startDate, endDate] the route asked QuickBooks for. */
let fetchCalls: Array<[string, string]>;
/** Links the fake reconcile reports it could not get to this run. */
let reconcileRemaining: number;
/** When true, the freshness-stamp write — and only that one — throws. */
let failStampWrite: boolean;

const pullPrisma = {
    automationSetting: {
        findUnique: async ({ where }: { where: { key: string } }) =>
            (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
        upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
            // The one write this suite needs to be able to fail on its own: a
            // blanket failure would prove nothing about which write mattered.
            if (failStampWrite && where.key === BANK_PULL_LAST_SUCCESS_KEY) {
                throw new Error("automation setting write failed");
            }
            settings.set(where.key, settings.has(where.key) ? update.value : create.value);
            return { key: where.key };
        },
    },
    bankLineObservation: { count: async () => 0 },
};

let pullGET: (request: Request) => Promise<Response>;

const pull = (query = "") => pullGET(new Request(`https://probuild.test/api/cron/bank-register-pull${query}`));

interface PullBody {
    ok: boolean;
    complete?: boolean;
    startDate?: string;
    endDate?: string;
    fullSweep?: boolean;
    reason?: string;
    error?: string;
    resumedAfter?: unknown;
    skipped?: string;
}

function parked(): (PullWindowState & { reconcileRemaining?: number | null; stampPending?: boolean }) | null {
    const raw = settings.get("bankRegisterPullWindow");
    return raw ? JSON.parse(raw) as PullWindowState : null;
}

function resetPull() {
    settings = new Map();
    fetchCalls = [];
    reconcileRemaining = 0;
    failStampWrite = false;
}

const ymd = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") return { prisma: pullPrisma };
        if (id === "@/lib/cron-auth") return { isCronAuthorized: () => true };
        if (id === "@/lib/cron-lease") return { takeLease: async () => true, releaseLease: async () => undefined };
        if (id === "@/lib/quickbooks-payments") return { getFreshQBTokens: async () => ({ accessToken: "t", realmId: "r" }) };
        if (id === "@/lib/qbo-bank-register") {
            return {
                fetchBankRegister: async (_get: unknown, startDate: string, endDate: string) => {
                    fetchCalls.push([startDate, endDate]);
                    return { rows: [], stale: false, clearedProbeOk: true, fetchedAt: new Date().toISOString(), accountId: "1", startDate, endDate };
                },
            };
        }
        if (id === "@/app/api/integrations/bank-ledger/ingest/route") {
            return {
                bankLedgerIngestHandlers: {
                    handleQboRegister: async () =>
                        new Response(JSON.stringify({ ok: true, inserted: 0, existing: 0 }), { status: 200 }),
                },
            };
        }
        if (id === "@/app/api/integrations/bank-ledger/reconcile/route") {
            return {
                ambiguousGroupKey: (group: { key?: string }) => group.key ?? "k",
                bankLedgerReconcileHandlers: {
                    runReconcile: async () => ({
                        linked: 0, proposed: 0, exceptions: [],
                        ambiguous: [], ambiguousStale: [], pairedByOrder: [], chunkErrors: [],
                        remaining: reconcileRemaining,
                    }),
                },
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let pullMod: { GET?: unknown };
    try {
        pullMod = await import("../src/app/api/cron/bank-register-pull/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof pullMod.GET !== "function") throw new Error("the bank-register-pull cron did not load");
    pullGET = pullMod.GET as typeof pullGET;
});

// ── 1. A run that could not finish the picture leaves work a slot can see ────

test("a CAPPED window is a continuation, not a finished night", async () => {
    /**
     * The planner takes the OLDEST 60 days of a wider backlog so the mark drains
     * forward — which is right, and is exactly why nothing was parked: the
     * window it asked for WAS fully ingested, so `continueAfter` cleared and the
     * mark advanced. `complete: false` said the picture was partial and only the
     * response body knew it.
     */
    resetPull();
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: ymd(150), lastFullSweep: ymd(1), continueAfter: null,
    }));

    const first = await pull();
    const firstBody = await first.json() as PullBody;
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.complete, false, "history remains behind the window it was able to ask for");
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false, "and a partial picture may not certify the register");
    assert.equal(parked()?.continueAfter ?? null, null, "nothing is parked — the window it asked for finished");

    // Every slot from here has to find work, and the backlog has to converge.
    let runs = 1;
    while (!settings.has(BANK_PULL_LAST_SUCCESS_KEY) && runs < 8) {
        const body = await (await pull("?continue=1")).json() as PullBody;
        assert.notEqual(
            body.skipped, "nothing-in-progress",
            `slot ${runs} exited with nothing to do while ${String(parked()?.highWater)} still trailed today`,
        );
        runs++;
    }
    assert.ok(settings.get(BANK_PULL_LAST_SUCCESS_KEY), "the backlog drains within the day and the register is certified");
    assert.ok(runs > 1, "and it genuinely needed more than the one nightly invocation");
    assert.ok(
        fetchCalls.every(([start, end]) => start <= end),
        "every window it asked for is a real window",
    );
});

test("a reconcile backlog is written down, drains over several slots, and only then stamps", async () => {
    /**
     * >400 links waiting, which is a normal night after a statement import. The
     * linker caps itself and reports `remaining`; the run correctly refuses to
     * call the picture complete — and then saved a state that said "finished".
     */
    resetPull();
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: ymd(1), lastFullSweep: ymd(1), continueAfter: null,
    }));
    reconcileRemaining = 420;

    const first = await pull();
    const firstBody = await first.json() as PullBody;
    assert.equal(firstBody.ok, true, "a backlog is the linker working as designed, not a failure");
    assert.equal(firstBody.complete, false);
    assert.equal(firstBody.error, "reconcile-incomplete");
    assert.equal(parked()?.reconcileRemaining, 420, "the backlog outlives the response that reported it");
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false);

    reconcileRemaining = 180;
    const second = await (await pull("?continue=1")).json() as PullBody;
    assert.notEqual(second.skipped, "nothing-in-progress", "the slot has real work while links are outstanding");
    assert.equal(parked()?.reconcileRemaining, 180);
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false);

    reconcileRemaining = 0;
    const third = await (await pull("?continue=1")).json() as PullBody;
    assert.notEqual(third.skipped, "nothing-in-progress");
    assert.equal(third.complete, true);
    assert.equal(parked()?.reconcileRemaining ?? null, null, "a drained backlog stops waking the resume pass");
    assert.ok(settings.get(BANK_PULL_LAST_SUCCESS_KEY), "and the run that finished it certifies the register");

    const idle = await (await pull("?continue=1")).json() as PullBody;
    assert.equal(idle.skipped, "nothing-in-progress", "with nothing outstanding a slot must cost nothing");
});

// ── 4. The stamp is the run's output, not a log line ────────────────────────

test("a freshness stamp that cannot be written is a 503, and a continuation comes back for it", async () => {
    resetPull();
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: ymd(1), lastFullSweep: ymd(1), continueAfter: null,
    }));
    failStampWrite = true;

    const failed = await pull();
    const body = await failed.json() as PullBody;
    assert.equal(failed.status, 503, "the work landed, the record of it did not — retrying is the fix");
    assert.equal(body.ok, false, "a run whose output never landed did not succeed");
    assert.equal(body.reason, "freshness-stamp-failed");
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false);
    assert.equal(parked()?.stampPending, true, "the obligation is parked where a slot can see it");

    // Every other marker a fully-successful run leaves is clear, so this flag is
    // the only thing standing between the stamp and tomorrow night.
    assert.equal(parked()?.continueAfter ?? null, null);
    assert.equal(parked()?.retryPending ?? null, null);
    assert.equal(parked()?.reconcileRemaining ?? null, null);

    failStampWrite = false;
    const recovered = await pull("?continue=1");
    const recoveredBody = await recovered.json() as PullBody;
    assert.notEqual(recoveredBody.skipped, "nothing-in-progress", "the slot must pick the owed stamp up");
    assert.equal(recovered.status, 200);
    assert.ok(settings.get(BANK_PULL_LAST_SUCCESS_KEY), "and the clock finally moves");
    assert.equal(parked()?.stampPending ?? false, false, "the obligation is released, not latched");
});

// ── 5. Corrupt stored dates fail SAFE — wide, never NaN and never silent ────

test("a corrupt highWater plans the widest safe window instead of throwing on every run", async () => {
    resetPull();
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: "not-a-date", lastFullSweep: ymd(1), continueAfter: null,
    }));

    const res = await pull();
    const body = await res.json() as PullBody;
    assert.equal(res.status, 200, "an unusable mark is not a reason to fail every invocation forever");
    assert.equal(body.ok, true);
    assert.match(String(body.startDate), /^\d{4}-\d{2}-\d{2}$/, "a real date, not NaN");
    assert.equal(body.startDate, ymd(PULL_MAX_WINDOW_DAYS - 1), "unknown means WIDE: the full lookback");
    assert.equal(parked()?.highWater, body.endDate, "and the repaired state carries a usable mark forward");
});

test("a corrupt lastFullSweep makes the deep sweep DUE — the quiet failure was suppressing it", async () => {
    // `todayMs - Date.parse("whenever") >= 7 days` is false, so a bad value read
    // as "swept recently" and the 60-day sweep never ran again.
    resetPull();
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: ymd(1), lastFullSweep: "whenever", continueAfter: null,
    }));

    const body = await (await pull()).json() as PullBody;
    assert.equal(body.ok, true);
    assert.equal(body.fullSweep, true, "no usable sweep date means the deep sweep is due, not skipped");
});

test("a corrupt continueAfter discards the CONTINUATION, never the run", async () => {
    resetPull();
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: ymd(1), lastFullSweep: ymd(1),
        continueAfter: { postedDate: "nope", qbTxnId: "9" },
    }));

    const body = await (await pull()).json() as PullBody;
    assert.equal(body.ok, true);
    assert.equal(body.resumedAfter ?? null, null, "an unplaceable resume point is dropped; the window is re-read from the top");
    assert.equal(parked()?.continueAfter ?? null, null);
});

test("a corrupt uncertifiedSince is dropped without taking the outstanding DAYS with it", async () => {
    // The bounds are the obligation; the timestamp only says how old it is. One
    // being unreadable must not clear the other.
    resetPull();
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: ymd(1), lastFullSweep: ymd(1),
        uncertifiedBounds: { startDate: ymd(20), endDate: ymd(15) },
        uncertifiedSince: "some time ago",
    }));

    const body = await (await pull()).json() as PullBody;
    assert.equal(body.ok, true);
    assert.equal(body.startDate, ymd(20), "the window still reaches back over the uncertified span");
});

// ── 2. The chaser may not certify a list the ledger changed under ───────────

test("ledgerMovedDuringPass: lines that arrived mid-pass are movement, and an unanswerable count is too", async () => {
    assert.equal(await ledgerMovedDuringPass(async () => 0), false, "an empty count is the only proof nothing arrived");
    assert.equal(await ledgerMovedDuringPass(async () => 1), true);
    assert.equal(
        await ledgerMovedDuringPass(async () => { throw new Error("db down"); }), true,
        "'we could not check' is not evidence that nothing arrived",
    );
});

test("a pull landing mid-pass holds the cycle open; the same pull landing before it does not", async () => {
    /**
     * The interleave, in the two units the route composes: the snapshot instant
     * is taken when the line pass loads its window, and the count afterwards
     * asks whether the ledger moved since. A fresh freshness marker cannot
     * answer that question — it says the pull succeeded, not WHEN.
     */
    const ledger: Array<{ createdAt: number }> = [{ createdAt: Date.parse("2026-09-03T12:00:00Z") }];
    const countSince = (since: number) => async () => ledger.filter(row => row.createdAt >= since).length;

    // (a) The pull lands BEFORE the pass loads its snapshot: the line is in the
    // list this cycle judged, so the cycle is finished and stamps.
    const before = Date.parse("2026-09-03T13:00:00Z");
    const quiet = await ledgerMovedDuringPass(countSince(before));
    const settled = sweepCompletionDecision({ computedPhase: "done", bankPullStale: false, ledgerMoved: quiet });
    assert.equal(settled.phase, "done");
    assert.equal(settled.complete, true);
    assert.equal(settled.blockedReason, null);

    // (b) The same pull lands WHILE the pass is working: the marker is fresh and
    // the snapshot is short by exactly that line.
    const during = Date.parse("2026-09-03T11:00:00Z");
    const moved = await ledgerMovedDuringPass(countSince(during));
    assert.equal(moved, true);
    const held = sweepCompletionDecision({ computedPhase: "done", bankPullStale: false, ledgerMoved: moved });
    assert.equal(held.phase, "lines", "held open so the next 15-minute continuation re-reads the fuller ledger");
    assert.equal(held.complete, false, "and the cards cron never sees a completion stamp for a short list");
    assert.equal(held.blockedReason, PULL_MOVED_REASON);
});

test("sweepCompletionDecision: a register that never arrived outranks one that arrived late", () => {
    const both = sweepCompletionDecision({ computedPhase: "done", bankPullStale: true, ledgerMoved: true });
    assert.equal(both.blockedReason, BANK_PULL_STALE_REASON, "one reason fits in the marker, and stale is the bigger claim");
    assert.equal(both.complete, false);
    // A pass that had not finished anyway keeps its own phase — movement can
    // only ever hold a cycle open, never move it forward.
    const unfinished = sweepCompletionDecision({ computedPhase: "open-issues", bankPullStale: false, ledgerMoved: true });
    assert.equal(unfinished.phase, "open-issues");
    assert.equal(unfinished.complete, false);
    // And the field is optional: callers written before it exists behave exactly
    // as they did.
    const legacy = sweepCompletionDecision({ computedPhase: "done", bankPullStale: false });
    assert.equal(legacy.complete, true);
    assert.equal(legacy.blockedReason, null);
});

// ── 3. A memo answer is only an answer the artifact table can vouch for ─────

test("a memo resolution needs its own binding; every other answer speaks for itself", () => {
    const memo = { resolution: MEMO_SIGNED_RESOLUTION, pdfId: "pdf-1" };
    assert.equal(hasBackedResolution(memo, "pdf-1"), true, "the artifact bound to THIS charge names this memo");
    assert.equal(hasBackedResolution(memo, null), false, "the losing side of a duplicated pdfId has no binding at all");
    assert.equal(hasBackedResolution(memo, "pdf-2"), false, "a binding for a different memo cannot vouch for this one");
    assert.equal(
        hasBackedResolution({ resolution: MEMO_SIGNED_RESOLUTION }, "pdf-1"), false,
        "a memo claim with no pdfId names no evidence to check",
    );
    // Everything else is self-evidencing: a found receipt is an Expense row.
    assert.equal(hasBackedResolution({ resolution: "receipt-found" }, null), true);
    assert.equal(hasBackedResolution({}, "pdf-1"), false, "no resolution is not an answer, artifact or not");
    assert.equal(hasBackedResolution(null, null), false);
});

test("a quarantined memo is NOT an answer — that is what reopens the chase", () => {
    assert.equal(hasResolution({ resolution: MEMO_SIGNED_RESOLUTION }), true);
    assert.equal(hasResolution({ resolution: "receipt-found" }), true);
    assert.equal(hasResolution({ resolution: "" }), false);
    assert.equal(hasResolution({}), false);
    assert.equal(
        hasResolution({ resolution: MEMO_CONFLICT_RESOLUTION, pdfId: "pdf-1" }), false,
        "the migration writes this over a memo spent on another charge; treating it as an answer would keep the chase closed forever",
    );
    assert.equal(
        hasBackedResolution({ resolution: MEMO_CONFLICT_RESOLUTION, pdfId: "pdf-1" }, "pdf-1"), false,
        "and no artifact can rehabilitate it — the binding it would need belongs to the other charge",
    );
});

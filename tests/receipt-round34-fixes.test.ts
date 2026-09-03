import test, { before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import {
    ComponentDeadlineExceededError,
    isComponentDeadlineExceeded,
    loadComponentToClosure,
} from "../src/lib/receipt-requests";
import { PROBE_RETRY_LIMIT, type PullWindowState } from "../src/lib/bank-register-pull";
import { rebuildCardItems, type CardItem, type CardItemTruth } from "../src/lib/receipt-request-cards";
import type { ReasonCode } from "../src/lib/review-alert-reasons";
import {
    BANK_PULL_LAST_SUCCESS_KEY,
    BANK_PULL_BLOCKED_REASON_KEY,
} from "../src/lib/pipeline-health";

/**
 * Codex PR #443, adversarial gate round 34.
 *
 * Each test below is the failure story it closes, not a restatement of the code:
 *
 *  1. (in receipt-answers-drive.test.ts) a signed memo's identity was MUTABLE:
 *     recording a second memo on a charge erased the first, which then passed
 *     the reuse check against a second charge and closed it too.
 *  2. A transient clearance-probe failure could not use the continuation
 *     schedule. The run was not TRUNCATED, so it parked no cursor — the window
 *     was cleared as finished, `pullContinuationPending()` answered
 *     "nothing-in-progress" for every one of the day's 44 resume slots, and the
 *     register stayed uncertified until the next night, hours after the 13:00
 *     chaser had already given up on it.
 *  3. The card cron's 45-second budget bounded only the DECISION to recompute,
 *     never the work: the component walk and the candidate scan each ran an
 *     unbounded number of real queries once started, so one slow component
 *     could carry the whole invocation past `maxDuration` and be killed —
 *     losing the claim bookkeeping along with the answer.
 */

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

// ── 2. A failed probe parks a RETRYABLE window ───────────────────────────────

/** The AutomationSetting KV table, as a map. */
let settings: Map<string, string>;
/** Every [startDate, endDate] the route asked QuickBooks for. */
let fetchCalls: Array<[string, string]>;
/** Leases taken this test. A continuation that no-ops must take NONE. */
let leases: string[];
/** Whether the patched register fetch answers the clearance question. */
let clearedProbeOk: boolean;

const pullPrisma = {
    automationSetting: {
        findUnique: async ({ where }: { where: { key: string } }) =>
            (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
        upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
            settings.set(where.key, settings.has(where.key) ? update.value : create.value);
            return { key: where.key };
        },
    },
    bankLineObservation: { count: async () => 0 },
};

let pullGET: (request: Request) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") return { prisma: pullPrisma };
        if (id === "@/lib/cron-auth") return { isCronAuthorized: () => true };
        if (id === "@/lib/cron-lease") {
            return {
                takeLease: async (key: string) => { leases.push(key); return true; },
                releaseLease: async () => undefined,
            };
        }
        if (id === "@/lib/quickbooks-payments") return { getFreshQBTokens: async () => ({ accessToken: "t", realmId: "r" }) };
        if (id === "@/lib/qbo-bank-register") {
            return {
                fetchBankRegister: async (_get: unknown, startDate: string, endDate: string) => {
                    fetchCalls.push([startDate, endDate]);
                    return { rows: [], stale: false, clearedProbeOk, fetchedAt: new Date().toISOString(), accountId: "1", startDate, endDate };
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
            // eslint-disable-next-line prefer-rest-params
            const real = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
            return {
                ...real,
                bankLedgerReconcileHandlers: {
                    runReconcile: async () => ({
                        linked: 0, proposed: 0, exceptions: [],
                        ambiguous: [], ambiguousStale: [], pairedByOrder: [], chunkErrors: [], remaining: 0,
                    }),
                },
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: { GET?: unknown };
    try {
        mod = await import("../src/app/api/cron/bank-register-pull/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.GET !== "function") throw new Error("the bank-register-pull cron did not load");
    pullGET = mod.GET as typeof pullGET;
});

function resetPull() {
    settings = new Map();
    fetchCalls = [];
    leases = [];
    clearedProbeOk = true;
}

const pull = (query = "") => pullGET(new Request(`https://probuild.test/api/cron/bank-register-pull${query}`));

/** The parked window state, as the route actually persisted it. */
function parked(): PullWindowState | null {
    const raw = settings.get("bankRegisterPullWindow");
    return raw ? JSON.parse(raw) as PullWindowState : null;
}

test("a failed probe at 02:00 is picked up by the 02:15 continuation and reaches a stamped pull", async () => {
    /**
     * THE WHOLE STORY (finding 2).
     *
     * QuickBooks serves the register and errors on the clearance report. The
     * rows land, `ok` stays true, `complete` goes false — all correct, and all
     * of it invisible to the resume schedule. `continueAfter` is only ever
     * written by a BUDGET-TRUNCATED ingest, and this run was not truncated, so
     * the window was saved as finished. Every 15-minute continuation slot then
     * answered `nothing-in-progress`, and the register sat uncertified until
     * 02:00 the next night — long past the 13:00 chaser, which held every
     * owner's cards for a failure that had cleared itself by 02:15.
     */
    resetPull();
    clearedProbeOk = false;

    const failed = await pull();
    const failedBody = await failed.json() as { ok: boolean; complete: boolean; reason?: string; startDate: string; endDate: string };
    assert.equal(failedBody.ok, true, "the pull did not FAIL — the rows are real");
    assert.equal(failedBody.complete, false);
    assert.equal(failedBody.reason, "cleared-probe-failed");
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false, "and nothing certified the register");

    const marker = parked()?.retryPending;
    assert.ok(marker, "the window is PARKED — this is the whole of the fix");
    assert.equal(marker.startDate, failedBody.startDate, "with its own bounds, not the planner's next guess");
    assert.equal(marker.endDate, failedBody.endDate);
    assert.equal(marker.attempts, 1);
    assert.equal(marker.reason, "cleared-probe-failed");

    // 02:15 — the continuation slot. It used to exit before taking the lease.
    clearedProbeOk = true;
    const resumed = await pull("?continue=1");
    assert.deepEqual(leases, ["bank-register-pull", "bank-register-pull"], "the resume pass really ran");
    const resumedBody = await resumed.json() as { ok: boolean; complete: boolean; startDate: string; endDate: string };
    assert.equal(resumedBody.ok, true);
    assert.equal(resumedBody.complete, true, "and reaches a complete pull — hours before the 13:00 chaser");
    assert.deepEqual(
        [resumedBody.startDate, resumedBody.endDate],
        [failedBody.startDate, failedBody.endDate],
        "over exactly the window whose clearance was unknown, not a narrower one re-planned from the advanced high-water mark",
    );
    assert.ok(settings.get(BANK_PULL_LAST_SUCCESS_KEY), "the freshness clock is stamped");
    assert.equal(settings.get(BANK_PULL_BLOCKED_REASON_KEY), "", "and nothing is holding the chaser back");
    assert.equal(parked()?.retryPending ?? null, null, "the marker is cleared — it latches nothing");
});

test("without a parked window a continuation still costs nothing", async () => {
    // The guard that makes the 15-minute schedule affordable: a resume pass with
    // no work must not even take the lease.
    resetPull();
    await pull();
    assert.ok(settings.get(BANK_PULL_LAST_SUCCESS_KEY), "a clean nightly run");

    leases = [];
    fetchCalls = [];
    const res = await pull("?continue=1");
    assert.deepEqual(await res.json(), { ok: true, skipped: "nothing-in-progress" });
    assert.deepEqual(leases, []);
    assert.deepEqual(fetchCalls, []);
});

test("a permanently dead clearance report stops retrying, and says so", async () => {
    // The other half of the schedule: without a cap, a report endpoint that
    // never comes back would burn all 44 continuation slots every day forever,
    // re-asking QuickBooks for a window it will never answer about.
    resetPull();
    clearedProbeOk = false;

    for (let attempt = 1; attempt <= PROBE_RETRY_LIMIT; attempt++) {
        const res = await pull(attempt === 1 ? "" : "?continue=1");
        const body = await res.json() as { reason?: string };
        assert.equal(body.reason, "cleared-probe-failed", `attempt ${attempt} is still trying`);
        assert.equal(parked()?.retryPending?.attempts, attempt, "and the count is on the window, not on the run");
    }

    const giveUp = await pull("?continue=1");
    const giveUpBody = await giveUp.json() as { ok: boolean; complete: boolean; reason?: string };
    assert.equal(giveUpBody.reason, "probe-retries-exhausted");
    assert.equal(giveUpBody.complete, false, "giving up does NOT certify the window");
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false, "and never stamps the freshness clock");
    assert.equal(
        settings.get(BANK_PULL_BLOCKED_REASON_KEY), "probe-retries-exhausted",
        "the health check must be able to tell 'retrying' from 'nobody is coming back for this'",
    );
    assert.equal(parked()?.retryPending ?? null, null);

    // And the schedule really does go quiet.
    leases = [];
    fetchCalls = [];
    const after = await pull("?continue=1");
    assert.deepEqual(await after.json(), { ok: true, skipped: "nothing-in-progress" });
    assert.deepEqual(fetchCalls, [], "a dead report endpoint is not re-asked 44 times a day");
});

test("a NEW window's probe failure starts its own count, it does not inherit one", async () => {
    // `attempts` is a property of the window being retried. Carrying it across
    // different bounds would make an unrelated later failure give up early.
    resetPull();
    clearedProbeOk = false;
    await pull();
    const first = parked()!.retryPending!;
    assert.equal(first.attempts, 1);

    // Hand the route a marker for some OTHER window, then fail again.
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: null,
        lastFullSweep: null,
        continueAfter: null,
        retryPending: { startDate: "2020-01-01", endDate: "2020-01-07", reason: "cleared-probe-failed", attempts: 5 },
    }));
    await pull("?continue=1");
    const next = parked()!.retryPending!;
    assert.deepEqual([next.startDate, next.endDate], ["2020-01-01", "2020-01-07"], "the parked bounds are what gets re-run");
    assert.equal(next.attempts, 6, "the SAME window's count carries; a different one's would not");
});

test("a corrupt retry marker is dropped whole, never half-read", async () => {
    // A marker with unusable bounds would re-plan the pull over something that
    // is not a window; one with an unreadable `attempts` would make the retry
    // unbounded. Both are worse than having no marker.
    resetPull();
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: null,
        lastFullSweep: null,
        retryPending: { startDate: "not-a-date", endDate: "2026-08-12", reason: "cleared-probe-failed", attempts: 1 },
    }));
    const res = await pull("?continue=1");
    assert.deepEqual(await res.json(), { ok: true, skipped: "nothing-in-progress" });
});

// ── 3. The deadline bounds the WORK, not just the decision to start it ───────

test("a slow multi-pass component stops at the deadline instead of running the invocation out of time", async () => {
    /**
     * THE STORY (finding 3). `MAX_COMPONENT_LINES` caps how MANY queries a
     * pathological component costs and says nothing about how LONG they take.
     * A chain of same-amount charges widens the window one pass at a time, each
     * pass a real round trip — so a component that needs eight passes at 300ms
     * each spends 2.4 seconds no matter what budget the caller thought it had.
     * The card cron checked its 45-second budget only BEFORE calling in, so a
     * backlog of these ran past `maxDuration` and the function was killed.
     */
    let queries = 0;
    const PER_QUERY_MS = 25;
    let now = 0;
    // A component that never closes inside the deadline: every pass finds one
    // more line a day further out, so the extent keeps growing.
    const load = async (fromYmd: string, _toYmd: string) => {
        queries++;
        now += PER_QUERY_MS;
        const start = Date.parse(`${fromYmd}T00:00:00Z`);
        return Array.from({ length: queries + 1 }, (_, i) => ({
            id: `bl-${i}`,
            postedDate: new Date(start - i * 86_400_000).toISOString().slice(0, 10),
        }));
    };

    const budgetMs = 100;
    await assert.rejects(
        () => loadComponentToClosure("2026-08-16", load, {
            maxNodes: 200,
            deadlineExceeded: () => now >= budgetMs,
        }),
        (error: unknown) => {
            assert.ok(isComponentDeadlineExceeded(error), "a DEADLINE abort, not a too-large one — the data is fine, we simply stopped asking");
            assert.ok(error instanceof ComponentDeadlineExceededError);
            return true;
        },
    );
    assert.equal(queries, budgetMs / PER_QUERY_MS, "it stopped ON the budget, not after it");
    assert.ok(queries < 200, "and nowhere near the node cap, which is the point — the cap never bounded time");
});

test("the walk with budget to spare still runs to closure", async () => {
    // The control. An abort that fired regardless would be a different bug
    // wearing this fix's clothes: every item would drop, every card would be
    // empty, and nobody would be asked for a receipt again.
    let queries = 0;
    const rows = [{ id: "bl-1", postedDate: "2026-08-16" }];
    const loaded = await loadComponentToClosure("2026-08-16", async () => { queries++; return rows; }, {
        maxNodes: 200,
        deadlineExceeded: () => false,
    });
    assert.deepEqual(loaded, rows);
    // Two: the walk only knows it has closed when a pass adds nothing.
    assert.equal(queries, 2);
});

test("the card cron reads a deadline abort as NOT SENDABLE, never as a verdict", async () => {
    // The consequence at the surface. `[]` from a recompute means "evidence
    // found, stop chasing"; an abort must never be confused with it, or a
    // slow run would silently close chases nobody answered.
    const truth = new Map<string, CardItemTruth>([
        ["ri-1", { clearedAt: null, acknowledged: false, resolved: false, evidenceSatisfied: false, owner: "CJ", revalidationSkipped: true }],
    ]);
    const items: CardItem[] = [
        { issueId: "ri-1", n: 1, fingerprint: "pb-bl-1", cents: 12_345, amount: "123.45", date: "2026-08-16", vendor: "LOWES", cardTail: null, targetKey: "bl-1" },
    ];
    const rebuilt = rebuildCardItems(items, truth, "CJ");
    assert.deepEqual(rebuilt.items, [], "nothing is sent");
    assert.deepEqual(rebuilt.dropped, [{ issueId: "ri-1", reason: "revalidation-deadline" }], "and the reason says which run ran out, not which charge was answered");
});

test("isComponentDeadlineExceeded is name-based, so a second module copy cannot make it fail open", () => {
    // tsx's require chain can hand a test (or a route) a SECOND copy of the
    // module, and `instanceof` across those two is false — which would send the
    // abort down the `throw` branch and kill the run it exists to protect.
    const foreign = Object.assign(new Error("from another copy of the module"), { name: "ComponentDeadlineExceededError" });
    assert.equal(isComponentDeadlineExceeded(foreign), true);
    assert.equal(isComponentDeadlineExceeded(new Error("something else")), false);
    assert.equal(isComponentDeadlineExceeded(null), false);
    assert.equal(isComponentDeadlineExceeded({ name: "ComponentTooLargeError" }), false,
        "and it must not swallow the too-large abort, which is a different answer entirely");
});

// ── 3b. The candidate scan is bounded in time as well as in pages ────────────

/** One page of ReviewIssue rows, shaped as the scan selects them. */
function issuePage(from: number, size: number) {
    return Array.from({ length: size }, (_, i) => ({
        id: `ri-${from + i}`,
        targetKey: `bl-${from + i}`,
        reasonCodes: JSON.stringify(["MISSING_RECEIPT"]),
        acknowledgedCodes: "[]",
        displayDetails: JSON.stringify({ amountCents: -100, owner: "CJ", postedDate: "2026-08-16", payee: "LOWES" }),
    }));
}

let scanPages: number;
const scanPrisma = {
    reviewIssue: {
        findMany: async () => {
            scanPages++;
            // Always a FULL page, so the scan never exhausts on its own: only
            // the page cap or the clock can stop it.
            return issuePage(scanPages * 500, 500);
        },
    },
};

test("the candidate scan stops on the clock, and says the count is not a total", async () => {
    // SCAN_MAX_PAGES = 200 pages of 500 rows is 100,000 indexed reads. The cap
    // bounds the query count; nothing bounded the time, and this runs BEFORE
    // the revalidation and the webhook posts that also have to fit in 60s.
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") return { prisma: scanPrisma };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: { scanCandidates?: unknown };
    try {
        mod = await import("../src/app/api/cron/receipt-request-cards/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    const scanCandidates = mod.scanCandidates as (
        deadlineExceeded?: () => boolean,
    ) => Promise<{ candidates: unknown[]; pages: number; exhausted: boolean; deadlineHit: boolean }>;

    scanPages = 0;
    const scan = await scanCandidates(() => scanPages >= 3);
    assert.equal(scan.pages, 3, "it stopped on the clock");
    assert.ok(scan.pages < 200, "long before the page cap, which is what the cap could never do");
    assert.equal(scan.deadlineHit, true);
    assert.equal(
        scan.exhausted, false,
        "so `overflowExact` is false and the card prints no 'and N more' it cannot stand behind",
    );

    // The control: with budget, the SAME scan runs to the page cap rather than
    // stopping early for its own reasons.
    scanPages = 0;
    const full = await scanCandidates(() => false);
    assert.equal(full.pages, 200);
    assert.equal(full.deadlineHit, false);
    assert.equal(full.exhausted, false, "capped by pages, which is the pre-existing honest answer");
});

// A type-only use, so the import above is not decoration.
void (null as ReasonCode[] | null);

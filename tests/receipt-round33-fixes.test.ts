import test, { before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
    runBankRegisterPull,
    type BankRegisterIngestLine,
    type BankRegisterRowLike,
    type PullWindowState,
} from "../src/lib/bank-register-pull";
import {
    RECONCILE_LOOKBACK_DAYS,
    reconcileScanSince,
    type ReconcileAmbiguousGroup,
} from "../src/lib/bank-ledger";
import {
    evaluatePipelineHealth,
    staleAmbiguousReason,
    BANK_PULL_LAST_SUCCESS_KEY,
    BANK_PULL_AMBIGUOUS_KEY,
    BANK_PULL_AMBIGUOUS_STALE_KEY,
    BANK_PULL_BLOCKED_REASON_KEY,
} from "../src/lib/pipeline-health";
import { createBankLedgerReconcileHandlers } from "../src/app/api/integrations/bank-ledger/reconcile/route";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Codex PR #443, adversarial gate round 33.
 *
 * Each test below is the failure story it closes, not a restatement of the code:
 *
 *  1. A failed clearance probe was still certified as a complete pull.
 *     `clearedProbeOk` was computed in `fetchBankRegister` and dropped at the
 *     cron's `fetchRows` boundary, so a night QuickBooks never answered the
 *     clearance question still stamped the freshness clock the chaser trusts.
 *  2. ONE duplicate transaction group could disable receipt cards globally: the
 *     reconcile scan was unbounded and ANY ambiguity blocked the stamp, so two
 *     legitimate identical purchases arriving statement-first suppressed every
 *     owner's cards for good.
 *  3. (in receipt-answers-drive.test.ts) signed affidavits were not bound to the
 *     card that asked for them.
 *  4. The resumable pull had no continuation schedule, so a truncated pull sat
 *     parked until long after the chaser had already given up on it.
 */

// ── The cron route, driven for real ──────────────────────────────────────────

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

/** The AutomationSetting KV table, as a map. */
let settings: Map<string, string>;
/** Every [startDate, endDate] the route asked QuickBooks for. */
let fetchCalls: Array<[string, string]>;
/** Leases taken this test. A continuation that no-ops must take NONE. */
let leases: string[];
/** What the patched register fetch answers. */
let registerAnswer: { rows: BankRegisterRowLike[]; stale: boolean; clearedProbeOk: boolean };
/** What the patched reconcile answers. */
let reconcileAnswer: {
    linked: number;
    proposed: number;
    exceptions: unknown[];
    ambiguous: ReconcileAmbiguousGroup[];
    ambiguousStale: ReconcileAmbiguousGroup[];
    pairedByOrder: unknown[];
    chunkErrors: unknown[];
    remaining: number;
};
/** The scope the route handed reconcile, so the bounded scan is provable. */
let reconcileScopes: unknown[];

const group = (postedDate: string, over: Partial<ReconcileAmbiguousGroup> = {}): ReconcileAmbiguousGroup => ({
    account: "WTB-0723",
    postedDate,
    amountCents: -7400,
    normalizedPayee: "US MARKET",
    checkNumber: null,
    observationIds: ["obs1", "obs2"],
    bankLineIds: ["bl1", "bl2", "bl3"],
    ...over,
});

const fakePrisma = {
    automationSetting: {
        findUnique: async ({ where }: { where: { key: string } }) =>
            (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
        upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
            settings.set(where.key, settings.has(where.key) ? update.value : create.value);
            return { key: where.key };
        },
        update: async ({ where, data }: { where: { key: string }; data: { value: string } }) => {
            if (!settings.has(where.key)) throw new Error("record not found");
            settings.set(where.key, data.value);
            return { key: where.key };
        },
    },
    bankLineObservation: { count: async () => 0 },
    // The freshness stamp and the release of its obligation are ONE
    // transaction (round-37 gate, finding 2), so the fake runs one.
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakePrisma),
};

let GET: (request: Request) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") return { prisma: fakePrisma };
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
                    return { ...registerAnswer, fetchedAt: new Date().toISOString(), accountId: "1", startDate, endDate };
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
            // The REAL module, with only the handlers swapped: `ambiguousGroupKey`
            // has to be the one production uses, or the recorded keys are a fake.
            // eslint-disable-next-line prefer-rest-params
            const real = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
            return {
                ...real,
                bankLedgerReconcileHandlers: {
                    runReconcile: async (_account: string, _deadlineAt?: number, scope?: unknown) => {
                        reconcileScopes.push(scope);
                        return reconcileAnswer;
                    },
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
    GET = mod.GET as typeof GET;
});

function reset() {
    settings = new Map();
    fetchCalls = [];
    leases = [];
    reconcileScopes = [];
    registerAnswer = { rows: [], stale: false, clearedProbeOk: true };
    reconcileAnswer = {
        linked: 0, proposed: 0, exceptions: [],
        ambiguous: [], ambiguousStale: [], pairedByOrder: [], chunkErrors: [], remaining: 0,
    };
}

const pull = (query = "") => GET(new Request(`https://probuild.test/api/cron/bank-register-pull${query}`));

// ── 1. A failed clearance probe is not a complete pull ───────────────────────

test("a clean run stamps the freshness clock and clears the blocked reason", async () => {
    reset();
    const res = await pull();
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; complete: boolean; clearedProbeOk: boolean; reason?: string };
    assert.equal(body.ok, true);
    assert.equal(body.complete, true);
    assert.equal(body.clearedProbeOk, true);
    assert.equal(body.reason, undefined);
    assert.ok(settings.get(BANK_PULL_LAST_SUCCESS_KEY), "the marker the chaser reads is written");
    assert.equal(settings.get(BANK_PULL_BLOCKED_REASON_KEY), "", "and nothing is holding it back");
});

test("a FAILED clearance probe is not stamped, and says why — the whole of finding 1", async () => {
    // THE STORY. QuickBooks serves the GL but the TransactionList clearance
    // report errors. `fetchBankRegister` deliberately survives that: the
    // register is still the register. But every row now reads "Unknown", so
    // minting can do nothing and the uncleared count means nothing — and this
    // route used to drop the flag at the `fetchRows` boundary, report a
    // complete pull, and stamp `bankRegisterPullLastSuccess`. The health check
    // read the register as current and the chaser released the cards over a
    // night when the one question the register exists to answer went unasked.
    reset();
    registerAnswer = { rows: [], stale: false, clearedProbeOk: false };

    const res = await pull();
    const body = await res.json() as { ok: boolean; complete: boolean; clearedProbeOk: boolean; reason?: string };
    assert.equal(body.ok, true, "the pull did not FAIL — the rows are real");
    assert.equal(body.complete, false, "but it is not proof the register is current");
    assert.equal(body.clearedProbeOk, false);
    assert.equal(body.reason, "cleared-probe-failed");
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false, "the freshness clock is NOT stamped");
    assert.equal(settings.get(BANK_PULL_BLOCKED_REASON_KEY), "cleared-probe-failed",
        "and the reason is recorded, not left to be inferred from bank-pull-stale 36h later");
});

test("the blocked reason is cleared by the next good run — it latches nothing", async () => {
    reset();
    registerAnswer = { rows: [], stale: false, clearedProbeOk: false };
    await pull();
    assert.equal(settings.get(BANK_PULL_BLOCKED_REASON_KEY), "cleared-probe-failed");

    registerAnswer = { rows: [], stale: false, clearedProbeOk: true };
    await pull();
    assert.equal(settings.get(BANK_PULL_BLOCKED_REASON_KEY), "");
    assert.ok(settings.get(BANK_PULL_LAST_SUCCESS_KEY));
});

// ── 2. One duplicate group must not disable the world ────────────────────────

test("ambiguity INSIDE this run's window still blocks the stamp", async () => {
    reset();
    const endDate = new Date().toISOString().slice(0, 10);
    reconcileAnswer = { ...reconcileAnswer, ambiguous: [group(endDate)] };
    await pull();
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false, "the register really is unsettled today");
    assert.equal(settings.get(BANK_PULL_AMBIGUOUS_KEY), "1");
});

test("ambiguity from BEFORE the window is recorded with its keys and does NOT block the stamp", async () => {
    // THE STORY. Two legitimate identical purchases arrive statement-first in
    // June and form a group nobody resolves. Every run afterwards found it (the
    // scan was unbounded), reported it as this run's ambiguity, and withheld
    // the stamp — so the chaser's freshness gate held every owner's cards,
    // every day, indefinitely, over one duplicate from months ago.
    reset();
    reconcileAnswer = {
        ...reconcileAnswer,
        ambiguousStale: [group("2026-06-01"), group("2026-06-02", { amountCents: -500, normalizedPayee: "CHEVRON" })],
    };

    await pull();
    assert.ok(settings.get(BANK_PULL_LAST_SUCCESS_KEY), "today's cards are not hostage to June");
    assert.equal(settings.get(BANK_PULL_AMBIGUOUS_KEY), "0");
    const recorded = JSON.parse(settings.get(BANK_PULL_AMBIGUOUS_STALE_KEY)!) as { count: number; keys: string[] };
    assert.equal(recorded.count, 2, "it is still counted — it is a real backlog");
    assert.deepEqual(recorded.keys, [
        "WTB-0723|2026-06-01|-7400|US MARKET|-",
        "WTB-0723|2026-06-02|-500|CHEVRON|-",
    ], "and named, so somebody can find them");
});

test("the route hands reconcile a BOUNDED scan and this run's own window", async () => {
    reset();
    const res = await pull();
    const body = await res.json() as { startDate: string; endDate: string };
    assert.equal(reconcileScopes.length, 1);
    const scope = reconcileScopes[0] as { since: string; window: { startDate: string; endDate: string } };
    assert.deepEqual(scope.window, { startDate: body.startDate, endDate: body.endDate });
    assert.equal(scope.since, reconcileScanSince(body.startDate, new Date()));
    assert.ok(scope.since <= body.startDate, "the scan never reads less than the run just ingested");
});

test("reconcileScanSince: the fixed lookback, or the window's own start when it reaches further", () => {
    const now = new Date("2026-09-02T04:00:00Z");
    assert.equal(RECONCILE_LOOKBACK_DAYS, 60);
    assert.equal(reconcileScanSince(null, now), "2026-07-04", "60 days before 2026-09-02");
    // A recent window does not NARROW the scan.
    assert.equal(reconcileScanSince("2026-08-30", now), "2026-07-04");
    // A deep sweep reaching further back widens it.
    assert.equal(reconcileScanSince("2026-05-01", now), "2026-05-01");
});

test("the reconcile handler splits ambiguity by window and pairs equal cardinality", async () => {
    // Straight through the shared handler, so the split the cron depends on is
    // proved where it happens rather than only in the fake above.
    const seen: string[] = [];
    const handlers = createBankLedgerReconcileHandlers({
        getIngestSecret: () => "s",
        findUnlinkedQboObservations: async (_account, since) => {
            seen.push(since);
            return [
                // In-window 2x3: unequal cardinality, stays ambiguous.
                { id: "o1", account: "A", postedDate: "2026-09-01", amountCents: -100, normalizedPayee: "P", checkNumber: null, bankLineId: null, qbTxnId: "1" },
                { id: "o2", account: "A", postedDate: "2026-09-01", amountCents: -100, normalizedPayee: "P", checkNumber: null, bankLineId: null, qbTxnId: "2" },
                // Older 2x2: equal cardinality, paired by order.
                { id: "o3", account: "A", postedDate: "2026-07-10", amountCents: -900, normalizedPayee: "Q", checkNumber: null, bankLineId: null, qbTxnId: "3" },
                { id: "o4", account: "A", postedDate: "2026-07-10", amountCents: -900, normalizedPayee: "Q", checkNumber: null, bankLineId: null, qbTxnId: "4" },
                // Older 1x2: unequal and outside the window — the stale case.
                { id: "o5", account: "A", postedDate: "2026-07-11", amountCents: -700, normalizedPayee: "R", checkNumber: null, bankLineId: null, qbTxnId: "5" },
            ];
        },
        findCandidateBankLines: async () => [
            { id: "b1", account: "A", postedDate: "2026-09-01", amountCents: -100, normalizedPayee: "P", checkNumber: null },
            { id: "b2", account: "A", postedDate: "2026-09-01", amountCents: -100, normalizedPayee: "P", checkNumber: null },
            { id: "b3", account: "A", postedDate: "2026-09-01", amountCents: -100, normalizedPayee: "P", checkNumber: null },
            { id: "b4", account: "A", postedDate: "2026-07-10", amountCents: -900, normalizedPayee: "Q", checkNumber: null },
            { id: "b5", account: "A", postedDate: "2026-07-10", amountCents: -900, normalizedPayee: "Q", checkNumber: null },
            { id: "b6", account: "A", postedDate: "2026-07-11", amountCents: -700, normalizedPayee: "R", checkNumber: null },
            { id: "b7", account: "A", postedDate: "2026-07-11", amountCents: -700, normalizedPayee: "R", checkNumber: null },
        ],
        persistLinks: async links => ({ linked: links.map(l => l.observationId), exceptions: [], chunkErrors: [], remaining: 0 }),
    });

    const result = await handlers.runReconcile("A", undefined, {
        since: "2026-07-04",
        window: { startDate: "2026-08-25", endDate: "2026-09-02" },
    });
    assert.deepEqual(seen, ["2026-07-04"], "the scan bound reaches the finder");
    assert.equal(result.ambiguous.length, 1, "the 2x3 inside the window blocks");
    assert.equal(result.ambiguous[0].postedDate, "2026-09-01");
    assert.equal(result.ambiguousStale.length, 1, "the 1x2 from July is reported, not blocking");
    assert.equal(result.ambiguousStale[0].postedDate, "2026-07-11");
    assert.equal(result.pairedByOrder.length, 1, "and the July 2x2 is resolved rather than left to block anything");
    assert.deepEqual(result.pairedByOrder[0].pairs, [
        { observationId: "o3", bankLineId: "b4" },
        { observationId: "o4", bankLineId: "b5" },
    ]);
    assert.equal(result.linked, 2);
});

// The health verdict itself lives in tests/pipeline-health.test.ts, where the
// full snapshot fixture is: "stale ambiguity and a blocked pull are reported
// without inventing staleness".

test("staleAmbiguousReason names at most three groups and counts the rest", () => {
    assert.equal(staleAmbiguousReason(0, []), "bank-ambiguous-stale:0");
    assert.equal(staleAmbiguousReason(2, ["a", "b"]), "bank-ambiguous-stale:2:a,b");
    assert.equal(staleAmbiguousReason(5, ["a", "b", "c", "d", "e"]), "bank-ambiguous-stale:5:a,b,c,+2");
});

// ── 4. The continuation schedule ─────────────────────────────────────────────

test("?continue=1 with nothing parked exits before it can even take the lease", async () => {
    reset();
    const res = await pull("?continue=1");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, skipped: "nothing-in-progress" });
    assert.deepEqual(leases, [], "a no-op resume must never contend with the nightly run for the lease");
    assert.deepEqual(fetchCalls, [], "and never touches QuickBooks");
});

test("?continue=1 runs when a truncated ingest parked a resume point", async () => {
    reset();
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: "2026-08-30",
        lastFullSweep: null,
        continueAfter: { postedDate: "2026-08-31", qbTxnId: "7001" },
    }));
    const res = await pull("?continue=1");
    assert.equal(res.status, 200);
    assert.equal(fetchCalls.length, 1, "it does the real pull, from the parked point");
    assert.deepEqual(leases, ["bank-register-pull"]);
});

test("?continue=1 also runs when a truncated MINT parked a cursor", async () => {
    reset();
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: "2026-08-30",
        lastFullSweep: null,
        continueAfter: null,
        mintRemainingCursor: "obs-1234",
    }));
    await pull("?continue=1");
    assert.equal(fetchCalls.length, 1);
});

test("a truncated pull reaches a COMPLETE state through its continuation", async () => {
    // THE STORY (finding 4). The pull is resumable and reports `complete:false`
    // when it truncates, but only one invocation a night existed — so the
    // parked cursor sat until 02:00 the NEXT night, eleven hours after the
    // 13:00 chaser had already found an uncertified register and held its cycle
    // open. The cards were lost to a backlog that was draining fine.
    const stored = new Map<string, string>();
    let saved: PullWindowState = { highWater: "2026-08-11", lastFullSweep: "2026-08-11", continueAfter: null };
    // Over one BANK_REGISTER_CHUNK_SIZE (500), so the ingest really does take
    // more than one batch and the budget can bite between them. Ids are
    // zero-padded because the resume cursor's order is (postedDate, qbTxnId)
    // lexically — "t9" sorting after "t100" would make the resume meaningless.
    const rows: BankRegisterRowLike[] = Array.from({ length: 600 }, (_, i) => ({
        date: "2026-08-12",
        qbType: "Expense",
        qbTxnId: `t${String(i + 1).padStart(4, "0")}`,
        docNum: null,
        name: `VENDOR ${i + 1}`,
        memo: null,
        amountCents: -100 * (i + 1),
        clearedStatus: "Cleared" as const,
    }));

    const deps = (budgetMs: number) => {
        let calls = 0;
        return {
            now: () => Date.parse("2026-08-12T02:00:00Z"),
            windowState: saved,
            saveWindowState: async (next: PullWindowState) => { saved = next; },
            budgetMs,
            // Each ingest batch "costs" 20s, so a 15s budget posts the first
            // batch and stops before the second with the rest parked.
            elapsedMs: () => calls * 20_000,
            fetchRows: async () => ({ rows, stale: false, clearedProbeOk: true }),
            ingest: async (_account: string, lines: BankRegisterIngestLine[]) => {
                calls++;
                for (const line of lines) stored.set(line.qbTxnId, line.rawDescriptor);
                return { status: 200, body: { ok: true, inserted: lines.length, existing: 0 } };
            },
            reconcile: async () => ({ linked: 0, proposed: 0 }),
        };
    };

    // 02:00 — the nightly run, cut short by its own wall clock.
    const first = await runBankRegisterPull(deps(15_000));
    assert.equal(first.ok, true);
    assert.equal(first.complete, false, "a truncated run is honest about it");
    assert.equal(first.continues, true);
    assert.ok(saved.continueAfter, "and parks where to carry on");
    const parkedAt = saved.continueAfter!;

    // 02:15 — the continuation, with its full budget. Same code, same state.
    const second = await runBankRegisterPull(deps(Number.POSITIVE_INFINITY));
    assert.deepEqual(second.resumedAfter, parkedAt, "it resumes past what the first run posted");
    assert.equal(second.ok, true);
    assert.equal(second.complete, true, "and reaches a complete pull — hours before the 13:00 chaser");
    assert.equal(saved.continueAfter, null, "the resume point is cleared");
    assert.equal(stored.size, 600, "every row landed exactly once across the two invocations");
});

test("the continuation is scheduled, bounded, and stops before the chaser", () => {
    const vercel = JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf8")) as {
        crons: Array<{ path: string; schedule: string }>;
    };
    const at = (path: string) => vercel.crons.find(c => c.path === path)?.schedule;
    assert.equal(at("/api/cron/bank-register-pull"), "0 2 * * *");
    const resume = at("/api/cron/bank-register-pull?continue=1");
    assert.ok(resume, "the pull needs a continuation slot, exactly as the chaser has one");
    // OFFSET off the hour (round-45 gate, finding 2): `*/15` fired at 02:00,
    // the same minute as the full pull it was meant to continue.
    assert.equal(resume, "5-59/15 2-12 * * *");

    // The ordering the whole design rests on, asserted rather than assumed: the
    // last continuation lands before the 13:00 sweep, and there are enough of
    // them for a real backlog to drain.
    const [minutes, hours] = (resume as string).split(" ");
    assert.equal(minutes, "5-59/15");
    // Still four slots an hour — :05, :20, :35, :50 — just none of them on the
    // hour, where the full pull runs.
    assert.deepEqual(
        [5, 20, 35, 50].filter(m => m >= 5 && (m - 5) % 15 === 0),
        [5, 20, 35, 50],
        "four offset slots per hour",
    );
    const [firstHour, lastHour] = hours.split("-").map(Number);
    assert.equal(firstHour, 2, "it starts with the nightly pull");
    assert.ok(lastHour < 13, "and every slot lands before the 13:00 chaser");
    assert.equal((lastHour - firstHour + 1) * 4, 44, "44 chances to drain a backlog, where there used to be none");
});

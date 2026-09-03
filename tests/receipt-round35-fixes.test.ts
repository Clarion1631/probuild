import test, { before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import {
    PROBE_RETRY_LIMIT,
    PULL_MAX_WINDOW_DAYS,
    extendWindowForUncertified,
    mergeUncertifiedBounds,
    subtractCertifiedWindow,
    type PullWindowState,
} from "../src/lib/bank-register-pull";
import { CARD_POST_TIMEOUT_MS, postOwnerCard, type OwnerCard } from "../src/lib/receipt-request-cards";
import { BANK_PULL_LAST_SUCCESS_KEY, BANK_PULL_UNCERTIFIED_KEY } from "../src/lib/pipeline-health";

/**
 * Codex PR #443, adversarial gate round 35.
 *
 * Each test is the failure story it closes:
 *
 *  1. Probe-retry EXHAUSTION falsely completed an uncertified window. A failed
 *     clearance probe still ingested its whole window, so the high-water mark
 *     advanced over it and `lastFullSweep` could be stamped from it. Six
 *     retries later the marker was dropped — by design — and nothing else
 *     remembered. The next nightly run planned the ordinary 3-day overlap from
 *     the advanced mark, got a healthy probe, and stamped
 *     `bankRegisterPullLastSuccess` over a stretch of observations that had
 *     never been given a clearance answer and were never offered to the mint.
 *  2. The card cron's candidate scan restarted from the top of the queue every
 *     invocation and stopped on a time/page limit, so a long prefix of older
 *     `office`/`unassigned` issues — the ones nobody is ever asked about — was
 *     re-read forever and an owner behind it could be starved indefinitely.
 *  3. The 45-second budget bounded only the revalidation. The send phase then
 *     flipped a row to POSTING and called Chat, which opened a FRESH 10-second
 *     timeout, with the completion writes after that. A kill in between leaves
 *     the row in POSTING, which the next run converts to UNCERTAIN and never
 *     resends — so a card nobody sent became a card nobody would ever send.
 */

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.RECEIPT_REQUEST_CARDS_ENABLED = "true";
process.env.RECEIPTS_CHAT_WEBHOOK = "https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages?key=x";

// ── 1a. The bounds arithmetic, on its own ───────────────────────────────────

test("an uncertified span is a UNION — it never forgets a day to keep itself tidy", () => {
    assert.deepEqual(
        mergeUncertifiedBounds(null, { startDate: "2026-08-09", endDate: "2026-08-12" }),
        { startDate: "2026-08-09", endDate: "2026-08-12" },
    );
    // A second, LATER failure widens the far end and keeps the near one.
    assert.deepEqual(
        mergeUncertifiedBounds({ startDate: "2026-08-09", endDate: "2026-08-12" }, { startDate: "2026-08-10", endDate: "2026-08-15" }),
        { startDate: "2026-08-09", endDate: "2026-08-15" },
    );
    // A DISJOINT later failure swallows the gap between them. Deliberate: the
    // gap gets re-fetched through an idempotent ingest, which costs one query,
    // and the alternative is fragment bookkeeping that can drop a day.
    assert.deepEqual(
        mergeUncertifiedBounds({ startDate: "2026-08-09", endDate: "2026-08-10" }, { startDate: "2026-08-20", endDate: "2026-08-21" }),
        { startDate: "2026-08-09", endDate: "2026-08-21" },
    );
});

test("only a prefix or a suffix is subtracted — a hole is never pretended away", () => {
    const bounds = { startDate: "2026-08-09", endDate: "2026-08-20" };
    // Fully covered: cleared.
    assert.equal(subtractCertifiedWindow(bounds, { startDate: "2026-08-01", endDate: "2026-08-25" }), null);
    assert.equal(subtractCertifiedWindow(bounds, { startDate: "2026-08-09", endDate: "2026-08-20" }), null);
    // A prefix: the span starts the day after what was certified.
    assert.deepEqual(
        subtractCertifiedWindow(bounds, { startDate: "2026-08-01", endDate: "2026-08-12" }),
        { startDate: "2026-08-13", endDate: "2026-08-20" },
    );
    // A suffix.
    assert.deepEqual(
        subtractCertifiedWindow(bounds, { startDate: "2026-08-15", endDate: "2026-08-30" }),
        { startDate: "2026-08-09", endDate: "2026-08-14" },
    );
    // STRICTLY INSIDE would leave a hole this one-span shape cannot hold, so
    // nothing is subtracted. Over-reporting delays a stamp; under-reporting
    // certifies days nobody read, and only one of those is recoverable.
    assert.deepEqual(
        subtractCertifiedWindow(bounds, { startDate: "2026-08-12", endDate: "2026-08-14" }),
        bounds,
    );
    // Disjoint changes nothing either.
    assert.deepEqual(subtractCertifiedWindow(bounds, { startDate: "2026-07-01", endDate: "2026-07-05" }), bounds);
    assert.equal(subtractCertifiedWindow(null, { startDate: "2026-08-01", endDate: "2026-08-25" }), null);
});

test("the planned window is pulled back over the uncertified span, and capped rather than refused", () => {
    const planned = { startDate: "2026-08-18", endDate: "2026-08-20", fullSweep: false, continues: false };
    // Already covering it: untouched, so the ordinary night costs nothing.
    assert.deepEqual(
        extendWindowForUncertified(planned, { startDate: "2026-08-19", endDate: "2026-08-19" }),
        planned,
    );
    assert.deepEqual(extendWindowForUncertified(planned, null), planned);
    // Reaching back is the whole point: the mark no longer advances over an
    // uncertified window, but a deep sweep that failed starts 60 days back and
    // the NEXT sweep is one day newer at both ends — so the oldest day of the
    // span it is meant to re-read would fall outside it.
    assert.deepEqual(
        extendWindowForUncertified(planned, { startDate: "2026-08-09", endDate: "2026-08-12" }),
        { startDate: "2026-08-09", endDate: "2026-08-20", fullSweep: false, continues: false },
    );
    // Too wide for one ask: the OLDEST slice, and `continues` so `complete`
    // stays false and nothing is stamped while it drains forward.
    const wide = extendWindowForUncertified(planned, { startDate: "2026-01-01", endDate: "2026-08-20" });
    assert.equal(wide.startDate, "2026-01-01");
    assert.equal(wide.continues, true);
    assert.equal(wide.fullSweep, false, "and it is not recorded as a deep sweep it did not finish");
    const span = Math.floor(
        (Date.parse(`${wide.endDate}T00:00:00Z`) - Date.parse(`${wide.startDate}T00:00:00Z`)) / 86_400_000,
    ) + 1;
    assert.equal(span, PULL_MAX_WINDOW_DAYS);
});

// ── 1b. The whole story, through the real cron route ────────────────────────

/** The AutomationSetting KV table, as a map. Shared by both fake clients. */
let settings: Map<string, string>;
/** Every [startDate, endDate] the route asked QuickBooks for. */
let fetchCalls: Array<[string, string]>;
/** Whether the patched register fetch answers the clearance question. */
let clearedProbeOk: boolean;

const settingStore = {
    findUnique: async ({ where }: { where: { key: string } }) =>
        (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
    upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
        settings.set(where.key, settings.has(where.key) ? update.value : create.value);
        return { key: where.key };
    },
};

const pullPrisma = {
    automationSetting: settingStore,
    bankLineObservation: { count: async () => 0 },
};

let pullGET: (request: Request) => Promise<Response>;

const pull = (query = "") => pullGET(new Request(`https://probuild.test/api/cron/bank-register-pull${query}`));

function parked(): PullWindowState | null {
    const raw = settings.get("bankRegisterPullWindow");
    return raw ? JSON.parse(raw) as PullWindowState : null;
}

function resetPull() {
    settings = new Map();
    fetchCalls = [];
    clearedProbeOk = true;
}

const ymd = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

test("an exhausted probe retry leaves DURABLE bounds, and the mark never stepped over them", async () => {
    /**
     * THE FIRST HALF OF THE STORY (finding 1).
     *
     * The probe fails at 02:00 and keeps failing through every continuation
     * slot until the retry budget is spent. Dropping the marker there is
     * correct — a dead report endpoint must stop burning slots — but it used to
     * be the END of the system's memory, while the high-water mark had ALREADY
     * advanced over the window on the very first failed run (it ingested all of
     * it, so `windowFullyIngested` was true).
     */
    resetPull();
    // A mark from three days ago, so once the retry marker is gone the planner
    // has a narrow overlap window to fall back to. That fallback is what made
    // the bug reachable: without a mark every run plans the widest window.
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: ymd(3), lastFullSweep: ymd(1), continueAfter: null,
    }));
    clearedProbeOk = false;

    for (let attempt = 1; attempt <= PROBE_RETRY_LIMIT; attempt++) {
        await pull(attempt === 1 ? "" : "?continue=1");
        assert.equal(parked()?.retryPending?.attempts, attempt);
    }
    const failedWindow = fetchCalls[0];
    assert.equal(parked()?.highWater, ymd(3), "the mark did NOT step over a window nobody could certify");

    const giveUp = await pull("?continue=1");
    const giveUpBody = await giveUp.json() as { reason?: string };
    assert.equal(giveUpBody.reason, "probe-retries-exhausted");
    assert.equal(parked()?.retryPending ?? null, null, "the retry schedule gives up, as designed");
    assert.deepEqual(
        parked()?.uncertifiedBounds,
        { startDate: failedWindow[0], endDate: failedWindow[1] },
        "but the DAYS are remembered — this is the whole of the fix",
    );
    assert.ok(parked()?.uncertifiedSince, "with a clock, so an operator can see how long the hole has been open");
    assert.equal(
        settings.get(BANK_PULL_UNCERTIFIED_KEY), `${failedWindow[0]}..${failedWindow[1]}`,
        "and pipeline-health can name them while they persist",
    );
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false);
});

test("the night after exhaustion re-reads the uncertified days before it may certify anything", async () => {
    // THE SECOND HALF. This is the run that used to stamp: healthy probe,
    // complete window, no ambiguity — over a THREE-DAY overlap that said
    // nothing about the days behind it.
    resetPull();
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: ymd(3), lastFullSweep: ymd(1), continueAfter: null,
    }));
    clearedProbeOk = false;
    for (let attempt = 1; attempt <= PROBE_RETRY_LIMIT + 1; attempt++) {
        await pull(attempt === 1 ? "" : "?continue=1");
    }
    const uncertified = parked()!.uncertifiedBounds!;
    fetchCalls = [];

    clearedProbeOk = true;
    const good = await pull();
    const body = await good.json() as { ok: boolean; startDate: string; endDate: string; uncertified?: unknown };
    assert.equal(body.ok, true);
    assert.ok(
        body.startDate <= uncertified.startDate && body.endDate >= uncertified.endDate,
        `the window (${body.startDate}..${body.endDate}) must cover the uncertified span (${uncertified.startDate}..${uncertified.endDate})`,
    );
    assert.equal(body.uncertified ?? null, null, "and only then is the span cleared");
    assert.equal(parked()?.uncertifiedBounds ?? null, null);
    assert.ok(settings.get(BANK_PULL_LAST_SUCCESS_KEY), "the freshness clock may finally move");
    assert.equal(settings.get(BANK_PULL_UNCERTIFIED_KEY), "", "and the health reason clears with it");
});

test("a healthy run that CANNOT cover the outstanding span does not stamp; the one that finishes it does", async () => {
    /**
     * The exact sequence the fix promises, forced into existence with a span
     * too wide for one ask (a long QuickBooks report outage, or a backlog).
     * The first run is complete, clean and clearance-answered over its OWN
     * window — every condition the old stamp checked — and must still refuse.
     */
    resetPull();
    const spanStart = ymd(PULL_MAX_WINDOW_DAYS + 20);
    const spanEnd = ymd(1);
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: ymd(3),
        lastFullSweep: ymd(1),
        continueAfter: null,
        uncertifiedBounds: { startDate: spanStart, endDate: spanEnd },
        uncertifiedSince: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    }));

    const first = await pull();
    const firstBody = await first.json() as { ok: boolean; startDate: string; uncertified?: { startDate: string; endDate: string } | null };
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.startDate, spanStart, "it starts at the oldest uncertified day, not at the planner's overlap");
    assert.ok(firstBody.uncertified, "part of the span is still unread");
    assert.ok(
        firstBody.uncertified!.startDate > spanStart,
        "and the part it DID read is subtracted, so this is monotonic rather than a loop",
    );
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false, "a run that could not cover the span must not certify the register");

    const second = await pull();
    const secondBody = await second.json() as { ok: boolean; uncertified?: unknown };
    assert.equal(secondBody.ok, true);
    assert.equal(secondBody.uncertified ?? null, null);
    assert.ok(settings.get(BANK_PULL_LAST_SUCCESS_KEY), "the run that finishes the span stamps and clears the marker");
    assert.equal(settings.get(BANK_PULL_UNCERTIFIED_KEY), "");
});

test("corrupt uncertified bounds are dropped whole, never half-read", async () => {
    // Half-reading these is worse than not having them: bad bounds either hold
    // the stamp down forever over dates that are not a window, or read as
    // "nothing outstanding" and certify days nobody pulled.
    resetPull();
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: null, lastFullSweep: null,
        uncertifiedBounds: { startDate: "2026-08-20", endDate: "not-a-date" },
    }));
    const res = await pull();
    const body = await res.json() as { ok: boolean; uncertified?: unknown };
    assert.equal(body.ok, true);
    assert.equal(body.uncertified ?? null, null);
    assert.ok(settings.get(BANK_PULL_LAST_SUCCESS_KEY));
});

// ── 2. The candidate scan resumes instead of restarting ─────────────────────

interface ScanRow {
    id: string;
    targetKey: string;
    reasonCodes: string;
    acknowledgedCodes: string;
    displayDetails: string | null;
}

/** The whole ReviewIssue queue, in the scan's own (firstObservedAt, id) order. */
let queue: ScanRow[];
/** Rows the fake card table holds, keyed by `${owner}|${date}`. */
let cards: Map<string, Record<string, unknown>>;
/** Every postOwnerCard call the route made this test. */
let postCalls: Array<{ owner: string; timeoutMs?: number }>;

function scanRow(id: string, owner: string): ScanRow {
    return {
        id,
        targetKey: `bl-${id}`,
        reasonCodes: JSON.stringify(["MISSING_RECEIPT"]),
        acknowledgedCodes: "[]",
        displayDetails: JSON.stringify({ amountCents: -100, owner, postedDate: "2026-08-16", payee: "LOWES", fingerprint: `pb-${id}` }),
    };
}

/** The `where` shapes the cards route actually uses against ReceiptRequestCard. */
function cardMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    if (typeof where.id === "string" && row.id !== where.id) return false;
    if (typeof where.claimToken === "string" && row.claimToken !== where.claimToken) return false;
    if ("postedAt" in where && where.postedAt === null && row.postedAt !== null) return false;
    if (typeof where.status === "string" && row.status !== where.status) return false;
    const status = where.status as { in?: string[] } | undefined;
    if (status && typeof status === "object" && Array.isArray(status.in) && !status.in.includes(row.status as string)) return false;
    const or = where.OR as Array<Record<string, unknown>> | undefined;
    if (or) {
        const free = row.claimedAt === null
            || or.some(clause => {
                const claimed = clause.claimedAt as { lt?: Date } | null | undefined;
                return claimed?.lt instanceof Date
                    && row.claimedAt instanceof Date
                    && row.claimedAt.getTime() < claimed.lt.getTime();
            });
        if (!free) return false;
    }
    return true;
}

const cardsPrisma: Record<string, unknown> = {
    $queryRaw: async () => [{ locked: true }],
    $transaction: async (arg: unknown) =>
        (typeof arg === "function" ? await (arg as (tx: unknown) => Promise<unknown>)(cardsPrisma) : arg),
    automationSetting: settingStore,
    reviewIssue: {
        findMany: async (args: {
            where: { id?: { in: string[] } };
            take?: number;
            cursor?: { id: string };
            skip?: number;
        }) => {
            // `loadCardItemTruth` asks by id; the scan pages the whole queue.
            if (args.where.id?.in) {
                const wanted = new Set(args.where.id.in);
                return queue.filter(row => wanted.has(row.id)).map(row => ({ ...row, clearedAt: null }));
            }
            const at = args.cursor ? queue.findIndex(row => row.id === args.cursor!.id) : -1;
            const from = args.cursor ? at + (args.skip ?? 0) : 0;
            if (args.cursor && at < 0) return [];
            return queue.slice(Math.max(from, 0), Math.max(from, 0) + (args.take ?? queue.length));
        },
    },
    receiptRequestCard: {
        findUnique: async ({ where }: { where: { owner_pacificDate: { owner: string; pacificDate: string } } }) =>
            cards.get(`${where.owner_pacificDate.owner}|${where.owner_pacificDate.pacificDate}`) ?? null,
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => {
            const key = `${data.owner as string}|${data.pacificDate as string}`;
            const row = { id: `card-${cards.size + 1}`, status: "PENDING", postedAt: null, ...data };
            cards.set(key, row);
            return row;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            let count = 0;
            for (const row of cards.values()) {
                if (!cardMatches(row, where)) continue;
                for (const [key, value] of Object.entries(data)) {
                    if (value && typeof value === "object" && "increment" in (value as object)) {
                        row[key] = ((row[key] as number) ?? 0) + (value as { increment: number }).increment;
                    } else {
                        row[key] = value;
                    }
                }
                count++;
            }
            return { count };
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
            let count = 0;
            for (const [key, row] of [...cards.entries()]) {
                if (!cardMatches(row, where)) continue;
                cards.delete(key);
                count++;
            }
            return { count };
        },
    },
};

let scanCandidates: (
    deadlineExceeded?: () => boolean,
    startCursor?: string | null,
) => Promise<{
    candidates: Array<{ id: string; owner: string }>;
    pages: number;
    exhausted: boolean;
    deadlineHit: boolean;
    nextCursor: string | null;
    wrapped: boolean;
}>;
let cardsGET: (request: Request) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    const patch = (resolve: (id: string) => unknown) => {
        (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
            this: NodeModule,
            id: string,
        ) {
            const hit = resolve(id);
            if (hit !== undefined) return hit;
            // eslint-disable-next-line prefer-rest-params
            return originalRequire.apply(this, arguments as unknown as [string]);
        } as typeof Module.prototype.require;
    };

    patch(id => {
        if (id === "@/lib/prisma") return { prisma: pullPrisma };
        if (id === "@/lib/cron-auth") return { isCronAuthorized: () => true };
        if (id === "@/lib/cron-lease") return { takeLease: async () => true, releaseLease: async () => undefined };
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
            return {
                ambiguousGroupKey: (group: { key?: string }) => group.key ?? "k",
                bankLedgerReconcileHandlers: {
                    runReconcile: async () => ({
                        linked: 0, proposed: 0, exceptions: [],
                        ambiguous: [], ambiguousStale: [], pairedByOrder: [], chunkErrors: [], remaining: 0,
                    }),
                },
            };
        }
        return undefined;
    });
    let pullMod: { GET?: unknown };
    try {
        pullMod = await import("../src/app/api/cron/bank-register-pull/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof pullMod.GET !== "function") throw new Error("the bank-register-pull cron did not load");
    pullGET = pullMod.GET as typeof pullGET;

    // The real module, loaded BEFORE the patch that shadows it, so the spread
    // below is the genuine implementation rather than a second stub.
    const realCards = await import("../src/lib/receipt-request-cards");
    patch(id => {
        if (id === "@/lib/prisma") return { prisma: cardsPrisma };
        if (id === "@/lib/cron-auth") return { isCronAuthorized: () => true };
        if (id === "@/lib/receipt-card-history") {
            return { recordCardOnIssues: async () => undefined, itemsMissingCardRecord: async () => [] };
        }
        // The real recompute walks competing components against a database.
        // "still missing" keeps the item on the card, which is the state the
        // send-phase tests below are about.
        if (id === "@/app/api/cron/receipt-requests/route") return { recomputeCodesFor: async () => ["MISSING_RECEIPT"] };
        if (id === "@/lib/receipt-request-cards") {
            return {
                ...realCards,
                // The cron refuses to run at the weekend and CI runs whenever it
                // runs. Nothing under test here is about the calendar.
                isPacificWeekday: () => true,
                postOwnerCard: async (_url: string, card: OwnerCard, options: { timeoutMs?: number } = {}) => {
                    postCalls.push({ owner: card.owner, timeoutMs: options.timeoutMs });
                    return { kind: "delivered", owner: card.owner, threadName: "spaces/s/threads/t", messageName: "spaces/s/messages/m" };
                },
            };
        }
        return undefined;
    });
    let cardsMod: { scanCandidates?: unknown; GET?: unknown };
    try {
        cardsMod = await import("../src/app/api/cron/receipt-request-cards/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof cardsMod.scanCandidates !== "function" || typeof cardsMod.GET !== "function") {
        throw new Error("the receipt-request-cards cron did not load");
    }
    scanCandidates = cardsMod.scanCandidates as typeof scanCandidates;
    cardsGET = cardsMod.GET as typeof cardsGET;
});

test("repeated deadline-limited scans make monotonic progress and reach the last owner", async () => {
    /**
     * THE STARVATION (finding 2). `office` and `unassigned` items are the
     * majority of the queue and also the oldest, and the scan reads oldest
     * first. It cannot filter by owner in SQL — `owner` lives inside a TEXT
     * column holding JSON — so the prefix has to be READ to be skipped. A run
     * that stops on the clock and starts again from the top next time reads
     * that same prefix forever, and CJ's items, which sit behind it, are never
     * seen at all.
     */
    queue = [
        ...Array.from({ length: 2_400 }, (_, i) => scanRow(`ri-office-${String(i).padStart(4, "0")}`, "office")),
        scanRow("ri-cj-last", "CJ"),
    ];

    let cursor: string | null = null;
    const startedAt: Array<string | null> = [];
    let found = false;
    for (let run = 0; run < 6 && !found; run++) {
        startedAt.push(cursor);
        // Two pages per run: real progress, nowhere near the whole queue.
        let pagesThisRun = 0;
        const scan = await scanCandidates(() => pagesThisRun++ >= 2, cursor);
        found = scan.candidates.some(candidate => candidate.id === "ri-cj-last");
        cursor = scan.nextCursor;
    }
    assert.equal(found, true, "CJ is reached — with a scan that restarts every run this loop never ends");
    assert.equal(new Set(startedAt).size, startedAt.length, "and every run started somewhere new: the cursor really advances");
});

test("a scan that runs off the end WRAPS, and only a complete pass claims an exact total", async () => {
    // `exhausted` drives `overflowExact`, which decides whether the card may
    // print "and N more". A resumed pass has not seen the prefix, so it must
    // not claim a total — and a pass that wrapped back to its own start has.
    queue = Array.from({ length: 900 }, (_, i) => scanRow(`ri-${String(i).padStart(4, "0")}`, "CJ"));

    const first = await scanCandidates(() => false, null);
    assert.equal(first.exhausted, true, "top to end in one go is a complete pass");
    assert.equal(first.nextCursor, null, "so the next run starts fresh");
    assert.equal(first.wrapped, false);
    assert.equal(first.candidates.length, 900);

    // Resume from the middle: it reads the tail, wraps, and comes back round.
    const resumed = await scanCandidates(() => false, "ri-0499");
    assert.equal(resumed.wrapped, true);
    assert.equal(resumed.exhausted, true, "it met its own start again, so the whole queue was read");
    assert.equal(resumed.nextCursor, null);
    assert.equal(resumed.candidates.length, 900, "and each row is counted once, not twice");

    // Stopped by the clock mid-queue: NOT a total.
    let pages = 0;
    const cut = await scanCandidates(() => pages++ >= 1, null);
    assert.equal(cut.exhausted, false);
    assert.ok(cut.nextCursor, "and it leaves a position for the next run rather than nothing");
});

// ── 3. The deadline bounds the SEND, not just the revalidation ──────────────

/**
 * Drive the real cron. `?retry=1` with no sweep marker means selection is not
 * allowed, so nothing scans: the run's only job is the claimed row already on
 * the books, which is exactly the send phase under test.
 */
async function runCards(): Promise<Record<string, unknown>> {
    const res = await cardsGET(new Request("https://probuild.test/api/cron/receipt-request-cards?retry=1"));
    return await res.json() as Record<string, unknown>;
}

function seedClaimedCard(): Record<string, unknown> {
    const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const row: Record<string, unknown> = {
        id: "card-1",
        owner: "CJ",
        pacificDate: date,
        itemsJson: JSON.stringify([{ issueId: "ri-1", n: 1, fingerprint: "pb-ri-1", cents: 12_345, amount: "123.45", date: "2026-08-16", vendor: "LOWES", cardTail: null, targetKey: "bl-ri-1" }]),
        overflow: 0,
        overflowExact: true,
        status: "PENDING",
        postedAt: null,
        claimedAt: null,
        claimToken: null,
        attempts: 0,
    };
    cards = new Map([[`CJ|${date}`, row]]);
    queue = [scanRow("ri-1", "CJ")];
    settings = new Map();
    postCalls = [];
    return row;
}

test("with less than the send headroom left, no row is flipped to POSTING and Chat is never called", async () => {
    /**
     * THE STORY (finding 3). Entering POSTING commits the run to three more
     * steps — the status write, a webhook call that opens its OWN 10-second
     * timeout, and the completion transaction. A kill anywhere in there strands
     * the row in POSTING, and the next run reads that as `uncertain-delivery`
     * and never resends. So the failure is not a late card, it is a card that
     * silently ceases to exist.
     */
    const row = seedClaimedCard();
    const realNow = Date.now;
    // The run reads its own start first; every read after that is 50 seconds
    // later, which leaves 5s against the 55s wall — under the headroom.
    let reads = 0;
    Date.now = () => (reads++ === 0 ? realNow() : realNow() + 50_000);
    let summary: Record<string, unknown>;
    try {
        summary = await runCards();
    } finally {
        Date.now = realNow;
    }

    assert.deepEqual(summary.sendDeferredOwners, ["CJ"]);
    assert.equal(summary.deferredReason, "send-deferred");
    assert.deepEqual(postCalls, [], "Chat was never called");
    assert.equal(row.status, "PENDING", "and the row never entered POSTING, so nothing can convert it to UNCERTAIN");
    assert.equal(row.postedAt, null);
    assert.equal(row.claimedAt, null, "the claim is RELEASED, so the next invocation may take it");
    assert.equal(row.claimToken, null);
    assert.equal(summary.ok, true, "deferring is not a failure — nothing went wrong, there was simply no time");
    assert.deepEqual(summary.uncertainTransitions, []);
});

test("with the budget intact the same row sends normally, and the call inherits the run's deadline", async () => {
    // The control. A gate that fired regardless would be a worse bug wearing
    // this fix's clothes: every morning card would silently defer forever.
    const row = seedClaimedCard();
    const summary = await runCards();

    assert.deepEqual(summary.sendDeferredOwners, []);
    assert.equal(summary.deferredReason, undefined);
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].owner, "CJ");
    assert.ok(
        postCalls[0].timeoutMs !== undefined && postCalls[0].timeoutMs > 0 && postCalls[0].timeoutMs <= CARD_POST_TIMEOUT_MS,
        "the webhook gets what is ACTUALLY left, never a fresh flat ten seconds",
    );
    assert.equal(row.status, "POSTED");
    assert.ok(row.postedAt);
    assert.deepEqual((summary.posted as Array<{ owner: string }>).map(entry => entry.owner), ["CJ"]);
});

test("postOwnerCard honours a shortened deadline, and a caller can never lengthen it", async () => {
    // The threading is only worth anything if the callee applies it. A hung
    // Chat is the case: on the flat ceiling this blocks for ten seconds, which
    // is most of the budget the gate above exists to protect.
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_url: unknown, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        // A real hung POST holds an open socket, and THAT handle is what keeps
        // the event loop alive long enough for the deadline to land:
        // `AbortSignal.timeout()` unrefs its own timer by design. A fake that
        // holds nothing lets the loop drain first, so the abort never fires and
        // this await never settles — CI (Node 20) cancelled the test with
        // "Promise resolution is still pending but the event loop has already
        // resolved", while Node 24 passed only on a handle its loader happened
        // to keep. Stand in for the socket, and release it on abort.
        const socketStandIn = setTimeout(() => {}, CARD_POST_TIMEOUT_MS);
        init.signal.addEventListener("abort", () => {
            clearTimeout(socketStandIn);
            reject(new Error("aborted"));
        });
    })) as unknown as typeof fetch;
    const card = {
        owner: "CJ", requestId: "receipt-req-CJ-2026-08-20", date: "2026-08-20",
        items: [], overflow: 0, overflowExact: true, text: "x",
    } as unknown as OwnerCard;
    try {
        const startedAt = Date.now();
        const outcome = await postOwnerCard("https://chat.googleapis.com/v1/spaces/AAQAKhvMYtg/messages?key=x", card, { timeoutMs: 60 });
        const elapsed = Date.now() - startedAt;
        assert.equal(outcome.kind, "unknown", "a timeout says nothing about whether Chat processed it — never resent");
        assert.ok(elapsed < CARD_POST_TIMEOUT_MS / 2, `it aborted on the caller's deadline (${elapsed}ms), not the flat ceiling`);
    } finally {
        globalThis.fetch = realFetch;
    }
});

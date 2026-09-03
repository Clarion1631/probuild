import test, { before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runBankRegisterPull, type BankRegisterIngestLine, type PullWindowState } from "../src/lib/bank-register-pull";
import { BANK_PULL_LAST_SUCCESS_KEY, newestStatementPostedDate } from "../src/lib/pipeline-health";
import type { ReasonCode } from "../src/lib/review-alert-reasons";
import {
    LEDGER_FENCE_FAILED_REASON,
    PULL_MOVED_REASON,
    fenceAndWritePhase,
} from "../src/app/api/cron/receipt-requests/route";

/**
 * Codex PR #443, adversarial gate round 37.
 *
 *  1. THE CLAIM WAS WIDER THAN THE SOURCE. "The QBO bank feed is bank truth"
 *     appeared in the mint header, the cron header, the spec and the PR body —
 *     but the pull reads the QuickBooks GENERAL LEDGER report, and QBO exposes
 *     no API for bank-feed items at all. A charge the bank cleared that
 *     QuickBooks has not posted cannot be ingested, cannot be minted, and is
 *     chased only after the statement import brings it in. Worse, the health
 *     probe took `max(postedDate)` across EVERY bank line, so one night of
 *     QBO-minted lines carried the "statement ledger through" date forward over
 *     an import nobody had run since July.
 *  2. A TRANSIENT CONTINUATION FAILURE ERASED AN OWED STAMP. `stampPending` was
 *     cleared by any run that did not owe a stamp — including a continuation
 *     that failed for an unrelated reason, which is not evidence the stamp
 *     landed. And a failed run persists no state at all, so nothing recorded
 *     that the register still needed reading.
 *  3. THE LEDGER CHECK WAS STILL TOCTOU. The count ran, then the phase marker
 *     was written in a separate statement: a BankLine committed in between was
 *     certified by a cycle that never saw it. And `createdAt` sees inserts only
 *     — a rewritten descriptor changes who owns the charge, and no count of new
 *     rows can see that.
 *  4. ONE COMPONENT CACHE FOR THE WHOLE RUN reused a verdict computed before
 *     owner A's card was posted, so evidence arriving during that post never
 *     reached owner B, who shares the component: B was chased for a charge that
 *     had just been answered.
 */

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. The pull reads the POSTED register, and says so ──────────────────────

test("a cleared bank-feed debit QuickBooks has not posted is invisible to the pull — nothing ingests or mints it", async () => {
    /**
     * The charge exists at the bank and in the "For Review" queue; QuickBooks
     * has not posted it, so it is absent from the General Ledger report the
     * pull reads. There is no code path that could pick it up, and this test is
     * here to say that in the suite rather than only in a comment.
     */
    const posted = {
        date: "2026-09-01",
        qbType: "Expense",
        qbTxnId: "posted-1",
        docNum: null,
        name: "LOWES",
        amountCents: -4_211,
        memo: "LOWES #02516 POS DEB C#8516",
        clearedStatus: "Cleared" as const,
    };
    const ingested: BankRegisterIngestLine[] = [];
    let mintCalls = 0;

    const summary = await runBankRegisterPull({
        account: "WTB",
        days: 3,
        // The GL report. The feed charge is NOT in it — that is the whole point.
        fetchRows: async () => ({ rows: [posted], stale: false, clearedProbeOk: true }),
        ingest: async (_account, lines) => {
            ingested.push(...lines);
            return { status: 200, body: { ok: true, inserted: lines.length, existing: 0 } };
        },
        reconcile: async () => ({ linked: 0, proposed: 0, exceptions: [], remaining: 0 }),
        mintFromQbo: async () => {
            mintCalls++;
            // Mints from OBSERVATIONS, which only ever come from the rows above.
            return { minted: ingested.length, skipped: {}, complete: true, remainingCursor: null };
        },
    });

    assert.equal(summary.ok, true);
    assert.equal(ingested.length, 1, "only the posted row reaches the ingest");
    assert.equal(ingested[0].qbTxnId, "posted-1");
    assert.equal(
        ingested.some(line => line.rawDescriptor.includes("FEED-ONLY")), false,
        "there is no path by which an unposted feed charge could arrive",
    );
    assert.equal(mintCalls, 1, "the mint ran, and could only ever see what the register returned");
    assert.equal(summary.observations, 1, "the register is the entire universe of this cron");
});

test("a fresh pull cannot make a stale statement import look current", async () => {
    // The health probe's date is what the digest prints and what a human reads
    // as "are we still importing statements". Scoped to STATEMENT lines, so a
    // night of QBO-minted rows cannot answer a question about a different source.
    const statement = new Date("2026-07-31T00:00:00Z");
    const qboMinted = new Date("2026-09-02T00:00:00Z");
    const asked: unknown[] = [];
    const client = {
        bankLine: {
            aggregate: async (args: { where?: { sourceOfRecord?: string } }) => {
                asked.push(args);
                return {
                    _max: {
                        postedDate: args?.where?.sourceOfRecord === "STATEMENT" ? statement : qboMinted,
                    },
                };
            },
        },
    };

    const newest = await newestStatementPostedDate(client as never);
    assert.deepEqual(asked, [{ where: { sourceOfRecord: "STATEMENT" }, _max: { postedDate: true } }]);
    assert.equal(
        newest?.toISOString(), statement.toISOString(),
        "the statement import is five weeks stale and the probe must keep saying so",
    );
});

test("the honesty claim is stated where it is easiest to get wrong", () => {
    // Comments are the only defence against the next person widening the claim
    // back out; this asserts the narrow words exist in each of the three places
    // Codex found the wide ones.
    const mint = readFileSync(join(repoRoot, "src/lib/bank-line-mint.ts"), "utf8");
    const register = readFileSync(join(repoRoot, "src/lib/qbo-bank-register.ts"), "utf8");
    const cron = readFileSync(join(repoRoot, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    const spec = readFileSync(join(repoRoot, "docs/plans/PHASE-2-QUEUE-AND-MEMOS-SPEC.md"), "utf8");

    for (const [name, source] of [["mint", mint], ["register", register], ["cron", cron]] as const) {
        assert.match(source, /POSTED/i, `${name} must name the source as the posted register`);
        assert.match(
            source, /statement import/i,
            `${name} must say statement import remains the source of record for unposted feed lines`,
        );
    }
    assert.doesNotMatch(mint, /the QBO bank feed is bank\s*\n?\s*\*?\s*truth/i, "the wide claim must not come back");
    assert.match(spec, /4b-i\. What the pull CANNOT see/);
    assert.match(spec, /statement import\*{0,2} remains the source of record|statement import stays the source of record/i);
});

// ── 2. An owed stamp survives everything except the write that discharges it ─

/** The AutomationSetting KV table, as a map. */
let settings: Map<string, string>;
/** Whether the freshness-stamp write throws this run. */
let failStampWrite: boolean;
/** Whether the ingest reports a failure (a run that is `ok: false` but throws nothing). */
let failIngest: boolean;

const pullPrisma = {
    automationSetting: {
        findUnique: async ({ where }: { where: { key: string } }) =>
            (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
        upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
            if (failStampWrite && where.key === BANK_PULL_LAST_SUCCESS_KEY) throw new Error("stamp write failed");
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
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(pullPrisma),
};

let pullGET: (request: Request) => Promise<Response>;
const pull = (query = "") => pullGET(new Request(`https://probuild.test/api/cron/bank-register-pull${query}`));

/** ReviewIssue rows the cards cron's revalidation reads. */
let cardIssues: Array<{
    id: string;
    targetKey: string;
    clearedAt: Date | null;
    reasonCodes: string;
    acknowledgedCodes: string;
    displayDetails: string | null;
}> = [];

const cardsPrisma = {
    // The memo bindings the cards cron loads per card (round-40 gate,
    // finding 3). None here: this test is about the per-card cache.
    receiptMemoArtifact: { findMany: async () => [] },
    reviewIssue: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
            cardIssues.filter(row => where.id.in.includes(row.id)),
    },
};

let loadCardItemTruth: (
    issueIds: string[],
    deps: {
        cache?: Map<string, ReasonCode[]>;
        recompute?: (targetKey: string, cache?: Map<string, ReasonCode[]>) => Promise<ReasonCode[]>;
    },
) => Promise<Map<string, { evidenceSatisfied: boolean }>>;

function parked(): (PullWindowState & { stampPending?: boolean; continuationPending?: boolean }) | null {
    const raw = settings.get("bankRegisterPullWindow");
    return raw ? JSON.parse(raw) as PullWindowState : null;
}

const ymd = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/prisma") return { prisma: pullPrisma };
        if (id === "@/lib/cron-auth") return { isCronAuthorized: () => true };
        if (id === "@/lib/cron-lease") return { takeLease: async () => true, releaseLease: async () => undefined };
        if (id === "@/lib/quickbooks-payments") return { getFreshQBTokens: async () => ({ accessToken: "t", realmId: "r" }) };
        if (id === "@/lib/qbo-bank-register") {
            return {
                fetchBankRegister: async (_get: unknown, startDate: string, endDate: string) => ({
                    // One POSTED row, so the ingest actually runs and can fail:
                    // a register that returns nothing never reaches it.
                    rows: [{
                        date: endDate,
                        qbType: "Expense",
                        qbTxnId: "gl-1",
                        docNum: null,
                        name: "LOWES",
                        amountCents: -1_000,
                        memo: "LOWES #02516 POS DEB C#8516",
                        clearedStatus: "Cleared",
                    }],
                    stale: false, clearedProbeOk: true, fetchedAt: new Date().toISOString(),
                    accountId: "1", startDate, endDate,
                }),
            };
        }
        if (id === "@/app/api/integrations/bank-ledger/ingest/route") {
            return {
                bankLedgerIngestHandlers: {
                    handleQboRegister: async () => new Response(
                        JSON.stringify(failIngest ? { ok: false, reason: "qbo-conflict" } : { ok: true, inserted: 0, existing: 0 }),
                        { status: failIngest ? 409 : 200 },
                    ),
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

    // The cards cron, over its own fake: `loadCardItemTruth` reads ReviewIssue
    // directly, so the prisma it closes over has to be the fake one.
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/prisma") return { prisma: cardsPrisma };
        if (id === "@/lib/cron-auth") return { isCronAuthorized: () => true };
        // The real recompute walks components against a database; every test
        // below supplies its own through `deps.recompute`.
        if (id === "@/app/api/cron/receipt-requests/route") return { recomputeCodesFor: async () => ["MISSING_RECEIPT"] };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;
    let cardsMod: { loadCardItemTruth?: unknown };
    try {
        cardsMod = await import("../src/app/api/cron/receipt-request-cards/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof cardsMod.loadCardItemTruth !== "function") throw new Error("the receipt-request-cards cron did not load");
    loadCardItemTruth = cardsMod.loadCardItemTruth as typeof loadCardItemTruth;
});

test("an owed stamp survives a transient continuation failure, and the next slot commits it", async () => {
    /**
     * The exact chain from the finding: the work lands, the stamp write fails,
     * a later continuation fails for an unrelated reason WITHOUT throwing, and
     * the slot after that must still know a stamp is owed.
     */
    settings = new Map();
    failStampWrite = true;
    failIngest = false;
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: ymd(1), lastFullSweep: ymd(1), continueAfter: null,
    }));

    // 1. Complete work, stamp write fails.
    const first = await pull();
    assert.equal(first.status, 503);
    assert.equal(parked()?.stampPending, true, "the obligation is parked");
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false);
    const markAfterWork = parked()?.highWater;

    // 2. A continuation that FAILS for an unrelated reason. It stamps nothing —
    //    and that is not evidence the stamp landed.
    failStampWrite = false;
    failIngest = true;
    const transient = await pull("?continue=1");
    assert.equal(transient.status, 500, "a failed ingest is a failed run");
    assert.equal(
        parked()?.stampPending, true,
        "and it must NOT erase the obligation — that is the bug this test exists for",
    );
    assert.equal(
        parked()?.continuationPending, true,
        "a failed run also records that the register still needs reading, or later slots see nothing in progress",
    );
    assert.equal(
        parked()?.highWater, markAfterWork,
        "while its high-water mark stays put — a failed run stored nothing new and must not step over anything",
    );

    // 3. The next slot finds work, succeeds, and commits the stamp.
    failIngest = false;
    const recovered = await pull("?continue=1");
    const body = await recovered.json() as { skipped?: string };
    assert.notEqual(body.skipped, "nothing-in-progress", "the parked obligation is what brings this slot back");
    assert.equal(recovered.status, 200);
    assert.ok(settings.get(BANK_PULL_LAST_SUCCESS_KEY), "the clock finally moves");
    assert.equal(parked()?.stampPending ?? false, false, "released by the write that discharged it, and only by that write");
});

test("a run that is held back for another reason carries the obligation forward rather than dropping it", async () => {
    // A stamp is owed; the next run cannot stamp (its own window is not
    // complete). It must leave the flag alone: only the successful marker write
    // may clear it.
    settings = new Map();
    failStampWrite = false;
    failIngest = false;
    settings.set("bankRegisterPullWindow", JSON.stringify({
        highWater: ymd(150), lastFullSweep: ymd(1), continueAfter: null, stampPending: true,
    }));

    const capped = await pull("?continue=1");
    const body = await capped.json() as { complete?: boolean };
    assert.equal(body.complete, false, "a capped window cannot certify anything");
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false);
    assert.equal(parked()?.stampPending, true, "and the earlier obligation is still on the books");
});

// ── 3. The ledger fence: check and commit are one transaction ───────────────

/**
 * An in-memory ledger with the two things the real fence relies on: a counter
 * every writer bumps, and a lock that makes the bump and the validation take
 * turns. Writers queue on the lock exactly as they would on the row.
 */
function makeLedger() {
    const lines: Array<{ id: string; createdAt: number; descriptor: string }> = [];
    let epoch = 0;
    let held: Promise<void> = Promise.resolve();
    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
        const previous = held;
        let release!: () => void;
        held = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
            return await fn();
        } finally {
            release();
        }
    };
    return {
        get epoch() { return String(epoch); },
        lines,
        /** A writer: bumps FIRST, under the lock, then writes its rows. */
        write: (mutate: () => void) => withLock(async () => {
            epoch++;
            mutate();
        }),
        /** The chaser's transaction: everything inside runs under the same lock. */
        transaction: <T>(fn: (ops: {
            lockEpoch: () => Promise<string>;
            /** The evidence side of the fence (round-43 gate, finding 4). */
            lockEvidenceEpoch: () => Promise<string>;
            countNewLines: () => Promise<number>;
            writePhase: (phase: string, completedAt: string | undefined, blockedReason: string | null) => Promise<void>;
        }) => Promise<T>): Promise<T> => withLock(() => fn({
            lockEpoch: async () => String(epoch),
            lockEvidenceEpoch: async () => "e0",
            countNewLines: async () => lines.filter(line => line.createdAt >= snapshotAt).length,
            writePhase: async (phase, completedAt, blockedReason) => {
                written.push({ phase, completedAt, blockedReason, linesAtCommit: lines.length });
            },
        })),
    };
    // eslint-disable-next-line no-unreachable
}

let snapshotAt = 0;
let written: Array<{ phase: string; completedAt: string | undefined; blockedReason: string | null; linesAtCommit: number }>;

test("a line inserted after the count cannot slip in before the marker: check and commit are one transaction", async () => {
    const ledger = makeLedger();
    ledger.lines.push({ id: "bl-1", createdAt: 1, descriptor: "LOWES" });
    snapshotAt = 10;
    written = [];
    const snapshotEpoch = ledger.epoch;

    // The writer starts DURING the fence: it queues on the same lock the fence
    // holds, exactly as it would on the epoch row.
    const fenced = fenceAndWritePhase(
        { snapshotEpoch, snapshotEvidenceEpoch: "e0", computedPhase: "done", bankPullStale: false, now: new Date("2026-09-03T14:00:00Z") },
        ledger.transaction as never,
    );
    const writer = ledger.write(() => ledger.lines.push({ id: "bl-2", createdAt: 20, descriptor: "HD" }));
    const decision = await fenced;
    await writer;

    assert.equal(decision.complete, true, "the cycle certified the ledger as it stood when it committed");
    assert.equal(written.length, 1);
    assert.equal(
        written[0].linesAtCommit, 1,
        "the new line was NOT committed before the marker — the fence serialized it after",
    );
    assert.equal(ledger.epoch, "1", "and the writer's bump landed afterwards, so the NEXT cycle sees it");

    // PRE-FIX CONTROL: count, then write, with no fence between them. The line
    // lands in the gap and the cycle stamps a list it never saw.
    const loose = makeLedger();
    loose.lines.push({ id: "bl-1", createdAt: 1, descriptor: "LOWES" });
    const beforeCount = loose.lines.filter(l => l.createdAt >= 10).length;
    await loose.write(() => loose.lines.push({ id: "bl-2", createdAt: 20, descriptor: "HD" }));
    const staleStamp = beforeCount === 0;
    assert.equal(staleStamp, true, "the old shape would have stamped");
    assert.equal(loose.lines.length, 2, "over a ledger that had already grown");
});

test("a DESCRIPTOR rewritten under the pass is movement too — a createdAt count can never see it", async () => {
    /**
     * The owner is derived from the descriptor, so rewriting it changes who is
     * asked for the receipt. No row was created, so the round-36 count is blind
     * to it; the epoch is not.
     */
    const ledger = makeLedger();
    ledger.lines.push({ id: "bl-1", createdAt: 1, descriptor: "LOWES #02516 POS DEB" });
    snapshotAt = 10;
    written = [];
    const snapshotEpoch = ledger.epoch;

    await ledger.write(() => { ledger.lines[0].descriptor = "LOWES #02516 POS DEB C#8516"; });

    const decision = await fenceAndWritePhase(
        { snapshotEpoch, snapshotEvidenceEpoch: "e0", computedPhase: "done", bankPullStale: false, now: new Date("2026-09-03T14:00:00Z") },
        ledger.transaction as never,
    );

    assert.equal(decision.ledgerMoved, true, "the epoch moved even though no row was created");
    assert.equal(decision.complete, false);
    assert.equal(decision.blockedReason, PULL_MOVED_REASON);
    assert.equal(written[0].completedAt, undefined, "and no completion stamp reached the marker");

    // PRE-FIX CONTROL: the createdAt count sees nothing at all.
    const appeared = ledger.lines.filter(line => line.createdAt >= snapshotAt).length;
    assert.equal(appeared, 0, "which is exactly why counting new rows was not enough");
});

test("a fence that cannot be taken refuses to certify, under its own reason", async () => {
    // The ledger may not have moved; what is missing is the proof. A completion
    // stamp is a claim of proof, so it is withheld and the cycle is held open.
    const failing = <T>(_fn: (ops: unknown) => Promise<T>): Promise<T> => Promise.reject(new Error("lock timeout"));
    await assert.rejects(
        () => fenceAndWritePhase(
            { snapshotEvidenceEpoch: "e0", snapshotEpoch: "3", computedPhase: "done", bankPullStale: false, now: new Date() },
            failing as never,
        ),
        /lock timeout/,
        "the failure propagates so the caller can hold the cycle open deliberately",
    );

    const route = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    assert.match(
        route,
        /catch \(error\) \{[\s\S]{0,900}blockedReason: LEDGER_FENCE_FAILED_REASON[\s\S]{0,200}await writePhase\(decision\.phase, undefined, decision\.blockedReason\)/,
        "and the caller writes the held phase without a completion stamp",
    );
    assert.equal(LEDGER_FENCE_FAILED_REASON, "ledger-fence-failed");
});

test("every BankLine writer bumps the epoch, and bumps it BEFORE its writes", () => {
    /**
     * A fence only fences what takes it. This is the guard that a new writer
     * cannot be added without one — checked as an ORDER, because a bump after
     * the writes leaves exactly the window the fence exists to close.
     */
    const writers = [
        "src/app/api/cron/bank-register-pull/route.ts",
        "src/app/api/integrations/bank-ledger/ingest/route.ts",
    ];
    for (const file of writers) {
        const source = readFileSync(join(repoRoot, file), "utf8");
        const bumpAt = source.indexOf("await bumpBankLedgerEpoch(tx)");
        assert.ok(bumpAt > 0, `${file} writes BankLine rows and must bump the ledger epoch`);
        const firstWrite = [...source.matchAll(/tx\.bankLine\.(create|createMany|update|updateMany|upsert)\(/g)]
            .map(match => match.index ?? -1)
            .filter(index => index >= 0);
        assert.ok(firstWrite.length > 0, `${file} was expected to write BankLine rows`);
        assert.ok(
            bumpAt < Math.min(...firstWrite),
            `${file} must bump the epoch before its first BankLine write, not after`,
        );
    }
    // And no OTHER module writes BankLine rows without one.
    const routeDir = join(repoRoot, "src");
    const suspects = listFiles(routeDir).filter(file => /\.ts$/.test(file));
    for (const file of suspects) {
        const source = readFileSync(file, "utf8");
        if (!/\bbankLine\.(create|createMany|update|updateMany|upsert)\(/.test(source)) continue;
        assert.match(
            source, /bumpBankLedgerEpoch/,
            `${file.slice(repoRoot.length)} writes BankLine rows and must bump the ledger epoch`,
        );
    }
});

function listFiles(dir: string): string[] {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...listFiles(full));
        else out.push(full);
    }
    return out;
}

// ── 4. One card's verdict is that card's own ────────────────────────────────

test("evidence arriving while owner A's card posts is seen by owner B in the same component", async () => {
    /**
     * A and B hold two charges from ONE competing component. A's card is
     * revalidated, posted (seconds), and in that window the receipt for B's
     * charge is booked. With a run-wide cache B was chased from the verdict
     * computed before A even posted; with a per-card cache B is re-resolved.
     */
    let receiptForB = false;
    cardIssues = [
        { id: "ri-a", targetKey: "bl-a", clearedAt: null, reasonCodes: JSON.stringify(["MISSING_RECEIPT"]), acknowledgedCodes: "[]", displayDetails: null },
        { id: "ri-b", targetKey: "bl-b", clearedAt: null, reasonCodes: JSON.stringify(["MISSING_RECEIPT"]), acknowledgedCodes: "[]", displayDetails: null },
    ];

    // The real recompute walks the whole component and caches every member.
    let walks = 0;
    const recompute = async (targetKey: string, cache?: Map<string, ReasonCode[]>): Promise<ReasonCode[]> => {
        if (cache?.has(targetKey)) return cache.get(targetKey)!;
        walks++;
        const verdict: ReasonCode[] = receiptForB ? [] : ["MISSING_RECEIPT"];
        cache?.set("bl-a", ["MISSING_RECEIPT"]);
        cache?.set("bl-b", verdict);
        return cache?.get(targetKey) ?? [];
    };

    // Owner A's card: one cache, created for this send.
    const aTruth = await loadCardItemTruth(["ri-a"], { cache: new Map(), recompute });
    assert.equal(aTruth.get("ri-a")?.evidenceSatisfied, false, "A is genuinely still missing its receipt");

    // ...A posts, and the receipt for B lands during the post.
    receiptForB = true;

    // Owner B's card: its OWN cache, so the component is re-resolved.
    const bTruth = await loadCardItemTruth(["ri-b"], { cache: new Map(), recompute });
    assert.equal(
        bTruth.get("ri-b")?.evidenceSatisfied, true,
        "B must not be chased for a charge answered while A's card was posting",
    );
    assert.equal(walks, 2, "one component walk per card is the price, and it is the point");

    // PRE-FIX CONTROL: the same two sends sharing one cache.
    receiptForB = false;
    walks = 0;
    const shared = new Map<string, ReasonCode[]>();
    await loadCardItemTruth(["ri-a"], { cache: shared, recompute });
    receiptForB = true;
    const stale = await loadCardItemTruth(["ri-b"], { cache: shared, recompute });
    assert.equal(walks, 1, "the shared cache skipped the second walk");
    assert.equal(
        stale.get("ri-b")?.evidenceSatisfied, false,
        "and handed owner B a verdict from before the receipt arrived — the bug",
    );
});

test("the card cron creates its revalidation cache INSIDE the send loop", () => {
    // The scoping is the fix; a cache hoisted back out of the loop reintroduces
    // it silently, and nothing else in the file would fail.
    const source = readFileSync(join(repoRoot, "src/app/api/cron/receipt-request-cards/route.ts"), "utf8");
    const loopAt = source.indexOf("for (const { card: claimedCard, rowId, token, resumed } of toPost.slice(0, CARD_RATE_CEILING))");
    const cacheAt = source.indexOf("const revalidationCache = new Map<string, ReasonCode[]>();");
    assert.ok(loopAt > 0 && cacheAt > 0);
    assert.ok(cacheAt > loopAt, "the cache must be created per card, not once for the run");
    assert.equal(
        source.split("const revalidationCache = new Map<string, ReasonCode[]>();").length - 1, 1,
        "exactly one cache, and it lives inside the loop",
    );
});

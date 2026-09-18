import test, { before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    BANK_PULL_CONFLICT_KEY,
    BANK_PULL_LAST_SUCCESS_KEY,
    BANK_PULL_BLOCKED_REASON_KEY,
    evaluatePipelineHealth,
    formatPipelineDigest,
    parseBankPullConflicts,
    type BankPullConflictEntry,
    type PipelineHealth,
} from "../src/lib/pipeline-health";
import type { QboRestatementConflict } from "../src/lib/bank-register-pull";

/**
 * QuickBooks transaction 6696 was edited after ProBuild stored it. The ingest
 * answered 409 and rolled the whole batch back, so the nightly pull failed 89
 * times over eleven days, `bankRegisterPullLastSuccess` never advanced,
 * `bank-pull-stale` fired, and the receipt chaser blocked on
 * `chaser-blocked:bank-pull-stale`. One human edit froze the whole receipt
 * pipeline.
 *
 * Quarantine-and-continue excludes the restated line and commits the rest. The
 * stored observation is never rewritten and — the one thing that must not be
 * got wrong — never minted, because minting copies observation content into a
 * canonical `BankLine` whose `amountCents` is immutable by trigger.
 */

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** EOL-normalised: this repo is checked out CRLF on Windows and LF in CI. */
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");

const NOW = Date.parse("2026-09-18T14:00:00.000Z");

// ═══ AC14 — the snapshot carries what the probe read ═══════════════════════

/**
 * The snapshot's `bankPull` object, as source text.
 *
 * A structural read rather than a regex per field: what is being asserted is
 * that the probe's values REACH `evaluatePipelineHealth`, and the only thing
 * standing between them is this literal.
 */
function snapshotBankPullBlock(): string {
    const health = read("src/lib/pipeline-health.ts");
    const at = health.indexOf("        bankPull: {\n            status: bankPull.status,");
    assert.ok(at > 0, "the snapshot assembly must still build a bankPull object");
    const end = health.indexOf("\n        },", at);
    assert.ok(end > at);
    return health.slice(at, end);
}

test("the quarantine count the probe reads reaches the verdict", () => {
    /**
     * PRE-EXISTING, AND SILENT. `readBankPullState` has computed
     * `quarantinedCount` since round 48 — including the `-1` unreadable
     * sentinel — but the snapshot never copied it, so `evaluatePipelineHealth`
     * read `undefined` every time and neither `bank-quarantine:<n>` nor
     * `bank-quarantine-unreadable` could ever fire. The reason existed; the
     * wire did not.
     */
    assert.match(snapshotBankPullBlock(), /quarantinedCount: bankPull\.value\.quarantinedCount/);
});

test("AC14: the restatement counts reach the verdict too", () => {
    const block = snapshotBankPullBlock();
    assert.match(block, /conflictCount: bankPull\.value\.conflictCount/);
    assert.match(block, /conflictLinkedCount: bankPull\.value\.conflictLinkedCount/);
    assert.match(block, /conflicts: bankPull\.value\.conflicts/, "the digest names ids, so it needs the entries");
});

// ═══ AC11 / AC12 — the health reason, and what it does and does not block ══

function snapshot(bankPull: Record<string, unknown>) {
    return {
        intuit: { status: "ok" as const, indicator: "none" },
        lastPurchaseSync: { status: "ok" as const, at: new Date(NOW - 3_600_000).toISOString() },
        purchaseSyncRun: { status: "ok" as const, at: new Date(NOW - 3_600_000).toISOString(), runStatus: "ok" as string | null },
        lastReceiptPush: { status: "ok" as const, at: new Date(NOW - 3_600_000).toISOString() },
        lastPaymentsSync: { status: "ok" as const, at: new Date(NOW - 3_600_000).toISOString() },
        receipts24h: { status: "ok" as const, counts: { created: 4 } },
        bank: { status: "ok" as const, at: new Date(NOW - 3_600_000).toISOString() },
        stuck: { status: "ok" as const, count: 0 },
        intakeStuck: { status: "ok" as const, count: 0 },
        intakeNeedsReview: { status: "ok" as const, count: 0 },
        intakeUnassigned: { status: "ok" as const, count: 0 },
        uncertainCards: { status: "ok" as const, count: 0 },
        driveCredentials: { status: "ok" as const, configured: true, source: "company-settings" },
        chaser: { status: "ok" as const, phase: "done", completedAt: new Date(NOW - 3_600_000).toISOString() },
        bankPull: {
            status: "ok" as const,
            enabled: true,
            // Stamped an hour ago: the pull is CURRENT, which is the whole
            // point — a restatement must not take that away.
            lastSuccessAt: new Date(NOW - 3_600_000).toISOString(),
            ambiguousCount: 0,
            quarantinedCount: 0,
            ...bankPull,
        },
        intakeQuarantined: { status: "ok" as const, count: 0 },
        payLinksPending: { status: "ok" as const, count: 0 },
        now: NOW,
    };
}

test("AC11: outstanding restatements are reported, and do NOT make the register stale", () => {
    const verdict = evaluatePipelineHealth(snapshot({ conflictCount: 2, conflictLinkedCount: 1 }));
    assert.ok(verdict.reasons.includes("bank-pull-conflict:2:1-linked"));
    /**
     * The asymmetry with `bank-quarantine:<n>` is deliberate. A quarantine
     * means rows are MISSING from the register; a restatement means one stored
     * row is stale, and it is equally stale whether the pipeline moves or not.
     * Blocking buys no correctness and costs every other line's receipts.
     */
    assert.equal(verdict.reasons.includes("bank-pull-stale"), false,
        "the freshness stamp is not withheld for a restatement — that is the freeze being fixed");
});

test("the -linked suffix appears only for the serious subset", () => {
    const verdict = evaluatePipelineHealth(snapshot({ conflictCount: 1, conflictLinkedCount: 0 }));
    assert.ok(verdict.reasons.includes("bank-pull-conflict:1"));
    assert.equal(verdict.reasons.some(reason => reason.includes("-linked")), false);
});

test("no conflicts means no reason at all", () => {
    const verdict = evaluatePipelineHealth(snapshot({ conflictCount: 0, conflictLinkedCount: 0 }));
    assert.equal(verdict.reasons.some(reason => reason.startsWith("bank-pull-conflict")), false);
    assert.equal(verdict.reasons.includes("bank-conflict-unreadable"), false);
});

test("AC12: an unreadable record is NEVER read as none", () => {
    // `null` is the unreadable signal, and `[]` is a real answer. A store that
    // will not parse is the state in which "never mint a conflicted
    // observation" cannot be enforced, so it must not read as silence.
    assert.equal(parseBankPullConflicts("{not json"), null);
    assert.equal(parseBankPullConflicts('{"a":1}'), null, "an object is not a list");
    assert.equal(parseBankPullConflicts('[{"qbTxnId":"6696"}]'), null, "a row missing fields/linked is malformed");
    assert.equal(parseBankPullConflicts('[{"qbTxnId":"6696","fields":["amountCents"],"linked":"yes"}]'), null);
    /**
     * F4: ONLY ABSENCE IS EMPTY. A row that exists and holds an empty or
     * whitespace-only string is a store somebody truncated — `!value` read it as
     * `[]`, i.e. "nothing restated", which is precisely the state in which the
     * mint exclusion cannot be enforced. The two sibling parsers keep the looser
     * rule on purpose; this is the one the mint reads.
     */
    assert.equal(parseBankPullConflicts(""), null, "an empty row is not an empty list");
    assert.equal(parseBankPullConflicts("   \n\t"), null, "and neither is a whitespace-only one");
    assert.deepEqual(parseBankPullConflicts(null), [], "absent is empty");
    assert.deepEqual(parseBankPullConflicts(undefined), [], "and so is a row that is not there at all");
    assert.deepEqual(parseBankPullConflicts("[]"), []);
    assert.deepEqual(
        parseBankPullConflicts('[{"qbTxnId":"6696","fields":["amountCents"],"linked":true,"firstSeenAt":"a","lastSeenAt":"b"}]'),
        [{ qbTxnId: "6696", fields: ["amountCents"], linked: true, firstSeenAt: "a", lastSeenAt: "b" }],
    );
});

test("AC12: the -1 sentinel becomes bank-conflict-unreadable, which IS a blocker's signal", () => {
    const verdict = evaluatePipelineHealth(snapshot({ conflictCount: -1, conflictLinkedCount: 0 }));
    assert.ok(verdict.reasons.includes("bank-conflict-unreadable"));
    assert.equal(verdict.reasons.some(reason => reason.startsWith("bank-pull-conflict:")), false,
        "unreadable is not a count nobody can act on");
});

// ═══ AC13 — the durable record merges, and self-clears ═════════════════════

/**
 * Bound in `before()`, from the SAME faked module the cron tests drive — the
 * route must never be imported for real here, or the module cache would hand
 * the harness a copy holding the production prisma.
 */
let mergeConflictRecord: (
    found: readonly QboRestatementConflict[],
    offered: readonly string[],
    prior: readonly BankPullConflictEntry[],
    now: string,
) => BankPullConflictEntry[];

const conflict = (qbTxnId: string, linked = false): QboRestatementConflict => ({
    qbTxnId,
    fields: ["amountCents"],
    stored: { postedDate: "2026-08-12", amountCents: -12_345, checkNumber: null },
    fresh: { postedDate: "2026-08-12", amountCents: -99_999, checkNumber: null },
    linked,
});

const entry = (qbTxnId: string, firstSeenAt: string): BankPullConflictEntry =>
    ({ qbTxnId, fields: ["amountCents"], linked: false, firstSeenAt, lastSeenAt: firstSeenAt });

test("AC13: a re-VERIFIED id that agrees again is deleted; the age of one still conflicting survives", () => {
    const merged = mergeConflictRecord(
        [conflict("A", true)],
        ["A", "B"],
        [entry("A", "T0"), entry("B", "T0")],
        "T1",
    );
    assert.deepEqual(merged.map(e => e.qbTxnId), ["A"], "B was committed and not reported back — the record clears itself");
    assert.equal(merged[0].firstSeenAt, "T0", "the age survives; a human needs to know how long this has been true");
    assert.equal(merged[0].lastSeenAt, "T1");
    assert.equal(merged[0].linked, true, "and the reading of the condition is replaced");
});

test("AC13: an entry outside this run's window is carried forward untouched", () => {
    const merged = mergeConflictRecord([], ["A"], [entry("A", "T0"), entry("C", "T0")], "T1");
    assert.deepEqual(merged.map(e => e.qbTxnId), ["C"],
        "A was offered and agreed, so it goes; C was never re-read, so a narrow window must not forget it");
    assert.equal(merged[0].firstSeenAt, "T0");
    assert.equal(merged[0].lastSeenAt, "T0", "untouched means untouched");
});

test("AC13: a brand-new conflict is stamped with this run's time", () => {
    const merged = mergeConflictRecord([conflict("6696")], ["6696"], [], "T1");
    assert.deepEqual(merged, [{ qbTxnId: "6696", fields: ["amountCents"], linked: false, firstSeenAt: "T1", lastSeenAt: "T1" }]);
});

// ═══ AC15 — the digest says it in plain English, every day ═════════════════

function sampleHealth(bankPull?: PipelineHealth["bankPull"]): PipelineHealth {
    return {
        ok: true,
        reasons: [],
        checkedAt: new Date(NOW).toISOString(),
        intuit: { status: "ok", indicator: "none", description: "All Systems Operational" },
        qbo: {
            lastPurchaseSync: { status: "ok", at: new Date(NOW - 3_600_000).toISOString() },
            purchaseSyncRun: { status: "ok", at: new Date(NOW - 3_600_000).toISOString() },
            lastReceiptPush: { status: "ok", at: new Date(NOW - 3_600_000).toISOString() },
            lastPaymentsSync: { status: "ok", at: new Date(NOW - 3_600_000).toISOString() },
        },
        receipts24h: { status: "ok", counts: { created: 4 } },
        bank: { status: "ok", at: new Date(NOW - 3_600_000).toISOString() },
        stuck: { status: "ok", count: 0 },
        intake: {
            stuck: { status: "ok", count: 0 },
            needsReview: { status: "ok", count: 0 },
            unassigned: { status: "ok", count: 0 },
            quarantined: { status: "ok", count: 0 },
        },
        payLinksPending: { status: "ok", count: 0 },
        ...(bankPull ? { bankPull } : {}),
    };
}

test("AC15: the digest carries the restatement line, and names the transactions", () => {
    const quiet = formatPipelineDigest(sampleHealth({
        status: "ok", enabled: true, lastSuccessAt: null, ambiguousCount: 0, conflictCount: 0, conflictLinkedCount: 0, conflicts: [],
    }));
    assert.match(quiet.text, /Bank register restatements \(QuickBooks changed a stored transaction\): 0/);
    assert.doesNotMatch(quiet.text, /Restated in QuickBooks/);

    const loud = formatPipelineDigest(sampleHealth({
        status: "ok",
        enabled: true,
        lastSuccessAt: null,
        ambiguousCount: 0,
        conflictCount: 2,
        conflictLinkedCount: 1,
        conflicts: [
            { qbTxnId: "6696", fields: ["amountCents"], linked: true, firstSeenAt: "T0", lastSeenAt: "T1" },
            { qbTxnId: "6700", fields: ["postedDate", "payee"], linked: false, firstSeenAt: "T1", lastSeenAt: "T1" },
        ],
    }));
    assert.match(loud.text, /Bank register restatements \(QuickBooks changed a stored transaction\): 2/);
    assert.match(loud.text, /- Restated in QuickBooks: txn 6696 \(amountCents\) \[already in ledger\]/);
    assert.match(loud.text, /- Restated in QuickBooks: txn 6700 \(postedDate, payee\)/);
    assert.doesNotMatch(loud.text, /txn 6700 .*already in ledger/);
});

test("AC15: an unreadable record is not printed as a reassuring zero", () => {
    const { text } = formatPipelineDigest(sampleHealth({
        status: "ok", enabled: true, lastSuccessAt: null, ambiguousCount: 0, conflictCount: -1, conflictLinkedCount: 0, conflicts: [],
    }));
    assert.match(text, /Bank register restatements .*: unavailable \(record unreadable\)/);
    assert.doesNotMatch(text, /Restated in QuickBooks/);
});

test("AC15: a failed probe says so rather than claiming none", () => {
    const { text } = formatPipelineDigest(sampleHealth({
        status: "error", enabled: true, lastSuccessAt: null, ambiguousCount: 0,
    }));
    assert.match(text, /Bank register restatements .*: unavailable \(probe failed\)/);
});

// ═══ The cron, over a fake KV: the store decides whether the mint runs ══════

/** The AutomationSetting KV table, as a map. */
let settings: Map<string, string>;
/** Every `where` the mint's observation read was given this run. */
let mintObservationWheres: Array<Record<string, unknown>>;
/** The qbTxnIds the fake ingest reports back as restated, per run. */
let conflictingIds: string[];
/** The `onConflict` mode the cron handed each batch. */
let ingestModes: Array<string | undefined>;
/** How many register rows the fake QuickBooks fetch returns. */
let registerRowCount: number;

/** `6696` first — the transaction this whole mechanism was built for. */
const registerTxnId = (index: number) => (index === 0 ? "6696" : `t${index}`);

const pullPrisma = {
    automationSetting: {
        findUnique: async ({ where }: { where: { key: string } }) =>
            (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
        upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
            settings.set(where.key, settings.has(where.key) ? update.value : create.value);
            return { key: where.key };
        },
        update: async ({ where, data }: { where: { key: string }; data: { value: string } }) => {
            settings.set(where.key, data.value);
            return { key: where.key };
        },
    },
    bankLineObservation: {
        count: async () => 0,
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
            mintObservationWheres.push(where);
            return [];
        },
    },
    bankLine: { findMany: async () => [] },
    $executeRaw: async () => 0,
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(pullPrisma),
};

let pullGET: (request: Request) => Promise<Response>;
const pull = () => pullGET(new Request("https://probuild.test/api/cron/bank-register-pull"));

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/prisma") return { prisma: pullPrisma };
        if (id === "@/lib/cron-auth") return { isCronAuthorized: () => true };
        if (id === "@/lib/cron-lease") return { takeLease: async () => true, releaseLease: async () => undefined };
        if (id === "@/lib/bank-ledger-epoch") return { bumpBankLedgerEpoch: async () => undefined };
        if (id === "@/lib/quickbooks-payments") return { getFreshQBTokens: async () => ({ accessToken: "t", realmId: "r" }) };
        if (id === "@/lib/qbo-bank-register") {
            return {
                fetchBankRegister: async (_get: unknown, startDate: string, endDate: string) => ({
                    rows: Array.from({ length: registerRowCount }, (_unused, index) => ({
                        date: endDate, qbType: "Expense", qbTxnId: registerTxnId(index), docNum: null,
                        name: "LOWES", amountCents: -(12_345 + index), memo: `LOWES #0251${index} POS DEB C#8516`,
                        clearedStatus: "Cleared",
                    })),
                    stale: false, clearedProbeOk: true, fetchedAt: new Date().toISOString(),
                    accountId: "1", startDate, endDate,
                }),
            };
        }
        if (id === "@/app/api/integrations/bank-ledger/ingest/route") {
            return {
                bankLedgerIngestHandlers: {
                    /**
                     * HONOURS THE MODE IT IS HANDED. A fake that quarantines
                     * whatever the caller asked for proves nothing about the
                     * caller: mode-forwarding could break and every test would
                     * still pass. In `abort` — the DEFAULT, and what the cron
                     * would silently fall back to — a restatement 409s the whole
                     * batch, which is the eleven-day freeze.
                     */
                    handleQboRegister: async (
                        _account: string,
                        lines: Array<{ qbTxnId: string }>,
                        options?: { onConflict?: string },
                    ) => {
                        ingestModes.push(options?.onConflict);
                        const conflicts = lines
                            .filter(line => conflictingIds.includes(line.qbTxnId))
                            .map(line => conflict(line.qbTxnId, line.qbTxnId === "6696"));
                        if (conflicts.length > 0 && (options?.onConflict ?? "abort") === "abort") {
                            return new Response(
                                JSON.stringify({ ok: false, reason: "qbo-txn-conflict", qbTxnId: conflicts[0].qbTxnId }),
                                { status: 409 },
                            );
                        }
                        return new Response(
                            JSON.stringify({
                                ok: true,
                                inserted: lines.length - conflicts.length,
                                existing: 0,
                                conflicted: conflicts.length,
                                conflictedLines: conflicts.length,
                                conflicts,
                            }),
                            { status: 200 },
                        );
                    },
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

    let mod: { GET?: unknown; mergeConflictRecord?: unknown };
    try {
        mod = await import("../src/app/api/cron/bank-register-pull/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.GET !== "function") throw new Error("the bank-register-pull cron did not load");
    if (typeof mod.mergeConflictRecord !== "function") throw new Error("mergeConflictRecord did not load");
    pullGET = mod.GET as typeof pullGET;
    mergeConflictRecord = mod.mergeConflictRecord as typeof mergeConflictRecord;
});

function reset() {
    settings = new Map();
    mintObservationWheres = [];
    conflictingIds = [];
    ingestModes = [];
    registerRowCount = 1;
    process.env.BANK_LINE_MINT_FROM_QBO = "true";
}

/** The `notIn` list the mint's observation read was narrowed by, if any. */
function mintExclusion(): string[] | null {
    const where = mintObservationWheres.find(w => "sourceLineId" in w);
    return where ? [...((where.sourceLineId as { notIn: string[] }).notIn)] : null;
}

test("AC9: a DURABLE prior conflict, from outside this run's window, is still excluded from the mint", async () => {
    reset();
    // 6696 is in this run's window and conflicts again; 6600 is a conflict from
    // a previous, wider run that this window never reaches. Both must be kept
    // away from the mint — `amountCents` is immutable by trigger, so a stale
    // mint is permanent.
    settings.set(BANK_PULL_CONFLICT_KEY, JSON.stringify([
        { qbTxnId: "6600", fields: ["postedDate"], linked: false, firstSeenAt: "T0", lastSeenAt: "T0" },
    ]));
    conflictingIds = ["6696"];

    const response = await pull();
    assert.equal(response.status, 200, "one edited transaction is not a failed run any more");
    /**
     * THE MODE ACTUALLY TRAVELS. `handleQboRegister` defaults to `abort`, which
     * is the 409 that froze the pipeline for eleven days, so a cron that stopped
     * passing `quarantine` would silently restore the freeze. The fake honours
     * whatever it is handed, so this assertion has teeth.
     */
    assert.deepEqual(ingestModes, ["quarantine"]);

    const excluded = mintExclusion();
    assert.ok(excluded, "the mint ran, and it ran narrowed");
    assert.ok(excluded.includes("6696"), "this run's restatement");
    assert.ok(excluded.includes("6600"), "AND the durable one this window never re-read");
});

test("AC9/AC12/F3: an unreadable conflict store supplies NO mint dependency, blocks the stamp, and does NOT answer 200", async () => {
    reset();
    settings.set(BANK_PULL_CONFLICT_KEY, "{not json");

    const response = await pull();
    /**
     * WITHHOLDING THE STAMP IS NOT ENOUGH ON ITS OWN. A 200 is what the platform
     * surfaces; nobody reads the body. "We cannot tell which observations may
     * never be minted" would have sat silent until `bank-pull-stale` fired a day
     * and a half later — the same shape of lie this whole file exists to stop.
     */
    assert.equal(response.status, 500);
    const summary = await response.json() as { ok: boolean; conflictStore?: string };
    assert.equal(summary.ok, false);
    assert.equal(summary.conflictStore, "unreadable");

    assert.equal(mintExclusion(), null, "the mint must not run at all — the exclusion cannot be enforced");
    assert.equal(mintObservationWheres.length, 0);
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false, "and the freshness stamp is withheld");
    assert.equal(settings.get(BANK_PULL_BLOCKED_REASON_KEY), "bank-conflict-unreadable",
        "the withholding is said out loud, not left to bank-pull-stale 36 hours later");
    assert.equal(settings.get(BANK_PULL_CONFLICT_KEY), "{not json",
        "and the record is never overwritten — that would destroy what we could not read");
});

test("F4: a TRUNCATED record is unreadable too, not an empty one", async () => {
    reset();
    // A row that exists and holds nothing. `!value` used to read this as "no
    // conflicts", which is the exact state in which a stale observation mints.
    settings.set(BANK_PULL_CONFLICT_KEY, "   ");

    const response = await pull();
    assert.equal(response.status, 500);
    assert.equal(mintObservationWheres.length, 0, "no mint dependency is supplied at all");
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false, "the stamp is withheld");
    assert.equal(settings.get(BANK_PULL_CONFLICT_KEY), "   ", "and nothing overwrites it");
});

test("AC8/AC12/F9: a restatement this run FOUND is recorded, and the stamp STILL lands", async () => {
    reset();
    conflictingIds = ["6696"];

    const response = await pull();
    assert.equal(response.status, 200);
    /**
     * THE LINE THAT ENDS THE ELEVEN-DAY FREEZE, asserted as the positive claim
     * rather than the absence of a blocker: with an outstanding conflict
     * (count > 0), a readable and writable store, and no flood, the cron
     * COMMITS the freshness stamp. `bank-pull-stale` clears within one run,
     * `chaser-blocked:bank-pull-stale` clears, and cards flow — while the
     * conflict stays visible in health and the digest until QuickBooks agrees.
     */
    const recorded = parseBankPullConflicts(settings.get(BANK_PULL_CONFLICT_KEY));
    assert.equal(recorded?.length, 1, "there IS an outstanding conflict");
    assert.equal(recorded?.[0].qbTxnId, "6696");
    assert.equal(recorded?.[0].linked, true);
    assert.ok(settings.has(BANK_PULL_LAST_SUCCESS_KEY), "and the stamp landed anyway — that is the non-blocking claim");
});

test("a prior conflict the run re-reads and no longer sees is deleted, with no code and no SQL", async () => {
    reset();
    settings.set(BANK_PULL_CONFLICT_KEY, JSON.stringify([
        { qbTxnId: "6696", fields: ["amountCents"], linked: false, firstSeenAt: "T0", lastSeenAt: "T0" },
    ]));
    // The fetch returns 6696 and the ingest commits it without reporting a
    // conflict: a human put the transaction back the way it was.
    conflictingIds = [];

    await pull();
    assert.deepEqual(parseBankPullConflicts(settings.get(BANK_PULL_CONFLICT_KEY)), []);
    assert.ok(settings.has(BANK_PULL_LAST_SUCCESS_KEY));
});

test("AC10b: a flood withholds the stamp and the mint, and names itself", async () => {
    reset();
    registerRowCount = 60;
    conflictingIds = Array.from({ length: 51 }, (_unused, index) => registerTxnId(index));

    const response = await pull();
    /**
     * NOT A FAILURE. `ok: false` here parked a continuation that re-fetched the
     * same window and flooded again, forever. The run finishes, the clean rows
     * land, the record is durable — and the two things that would ACT on a
     * picture we believe is wrong are held.
     */
    assert.equal(response.status, 200);
    assert.equal(settings.has(BANK_PULL_LAST_SUCCESS_KEY), false, "the freshness stamp is withheld");
    assert.equal(settings.get(BANK_PULL_BLOCKED_REASON_KEY), "conflict-flood",
        "and a human can see WHY immediately, not 36 hours later");
    assert.equal(mintObservationWheres.length, 0, "nothing mints over fifty transactions we already believe are stale");
    assert.equal(parseBankPullConflicts(settings.get(BANK_PULL_CONFLICT_KEY))?.length, 51,
        "the conflicts are still persisted — the point is to SEE all of them at once");
});

// ═══ The invariants, stated where they are easiest to "tidy" away ══════════

test("the cron's stamp gate names the asymmetry, and the mint gate names the trigger", () => {
    const route = read("src/app/api/cron/bank-register-pull/route.ts");
    // The stamp is decided by the STORE, never by the conflicts themselves —
    // except a flood, which is a systemic change rather than a human edit.
    assert.match(route, /&& conflictOutcome\.ok/);
    assert.match(route, /&& !summary\.conflictFlood/);
    assert.match(route, /THE STORE, NEVER THE CONFLICTS THEMSELVES/);
    /**
     * THE RECORD IS DURABLE BEFORE THE MINT. Persisting it out here, after
     * `runBankRegisterPull` had already minted and checkpointed, left a window
     * in which the exclusion was lost and the permanent line it was meant to
     * prevent already existed. It is a dependency now, so the ordering is the
     * pull's to enforce and the cron cannot reintroduce the gap by moving a
     * statement.
     */
    assert.match(route, /persistConflicts: \(found: readonly QboRestatementConflict\[\], verified: readonly string\[\]\) =>/);
    const pull = read("src/lib/bank-register-pull.ts");
    assert.ok(
        pull.indexOf("dependencies.persistConflicts(") < pull.indexOf("dependencies.mintFromQbo("),
        "the conflict record must be written before anything irreversible reads it",
    );
    // And the mint dependency is absent — not disabled — when the store is bad.
    assert.match(route, /BANK_LINE_MINT_FROM_QBO === "true" && conflictStore\.ok/);
    assert.match(route, /sourceLineId: \{ notIn: \[\.\.\.exclude\] \}/);
    assert.match(route, /immutable by trigger/);

    const health = read("src/lib/pipeline-health.ts");
    assert.match(health, /DELIBERATELY NOT A STAMP BLOCKER/);
    assert.match(health, /bank-conflict-unreadable/);
});

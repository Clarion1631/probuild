/**
 * The evidence-driven close: when a receipt books, the missing-receipt requests
 * it answers close inside that worker tick instead of waiting for a nightly
 * sweep that a stream of bookings keeps restarting.
 *
 * Injection over mocking, everywhere: no `mock.module` (CI is Node 20, where it
 * corrupts the require chain), no database, no network. The store module still
 * imports `@/lib/prisma`, whose client is a lazy proxy — so the fiction URL
 * below is only there to keep a stray `getPrismaClient()` from throwing a
 * config error, and every test injects the deps that would otherwise reach it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";

process.env.DATABASE_URL = "postgresql://fiction:fiction@127.0.0.1:9/test?pgbouncer=true";

import {
    candidateBankLineQuery,
    MAX_EVIDENCE_CLOSE_CANDIDATES,
    type BookedEvidence,
} from "../src/lib/receipt-intake/evidence-close";
import {
    closeRequestsSatisfiedBy,
    type ClearOneOutcome,
    type CourtesyTx,
    type EpochSnapshot,
    type EvidenceCloseDeps,
} from "../src/lib/receipt-intake/evidence-close-store";
import {
    type ReviewIssueRow,
} from "../src/lib/review-alert-lifecycle";
import { RECEIPT_EVIDENCE_EPOCH_KEY } from "../src/lib/receipt-evidence-lock";
import { BANK_LEDGER_EPOCH_KEY } from "../src/lib/bank-ledger-epoch";
import { ComponentDeadlineExceededError, RECEIPT_REQUEST_TARGET_TYPE } from "../src/lib/receipt-requests";
import { canonicalizeReasonCodes, hashReasonCodes, type ReasonCode } from "../src/lib/review-alert-reasons";
import {
    CLOSE_REQUESTS_MIN_BUDGET_MS,
    RUN_HARD_BUDGET_MS,
    runIntakeWorker,
    type WorkerDependencies,
    type WorkerRow,
} from "../src/lib/receipt-intake/worker";
import type { BookResult } from "../src/lib/receipt-intake/book";

/** The sweep's width today. Passed explicitly so these tests pin the shape, not the env. */
const LOOKBACK = 30;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function evidence(overrides: Partial<BookedEvidence> = {}): BookedEvidence {
    return { totalCents: 9_309, txnDate: "2026-09-16", bookedOn: "2026-09-21", ...overrides };
}

function mustQuery(input: BookedEvidence, lookbackDays: number) {
    const query = candidateBankLineQuery(input, lookbackDays);
    if (!query) throw new Error("expected a candidate query");
    return query;
}

// ---------------------------------------------------------------------------
// 1. candidateBankLineQuery is pure
// ---------------------------------------------------------------------------

test("candidate query negates the amount exactly once and inverts the sweep's window", () => {
    const query = mustQuery(evidence(), LOOKBACK);
    assert.equal(query.amountCents, -9_309, "spend lines are negative; the sign flips here and nowhere else");
    // The RECOGNITION window, not the ±2-day match slop: the judge narrows, the
    // proposal must not.
    assert.equal(query.fromYmd, "2026-08-17");
    assert.equal(query.toYmd, "2026-10-16");
    const span = (Date.parse(`${query.toYmd}T00:00:00Z`) - Date.parse(`${query.fromYmd}T00:00:00Z`)) / 86_400_000;
    assert.equal(span, 60, "±2 days would be a 4-day span — that is the matcher's job, not the proposal's");
});

test("a null txnDate falls back to the booking day", () => {
    const query = mustQuery(evidence({ txnDate: null }), LOOKBACK);
    assert.equal(query.fromYmd, "2026-08-22");
    assert.equal(query.toYmd, "2026-10-21");
});

test("the boundary days are inclusive of the anchor's own window", () => {
    // A zero lookback still reaches the anchor day itself at the top end.
    assert.equal(mustQuery(evidence({ txnDate: "2026-09-16" }), 0).toYmd, "2026-09-16");
});

test("unusable evidence proposes nothing at all", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
        assert.equal(candidateBankLineQuery(evidence({ totalCents: bad }), LOOKBACK), null, `total ${bad}`);
    }
    assert.equal(candidateBankLineQuery(evidence({ txnDate: "not-a-date" }), LOOKBACK), null);
    assert.equal(candidateBankLineQuery(evidence(), -1), null);
});

test("candidateBankLineQuery is pure: same input, same answer, no mutation", () => {
    const input = evidence();
    const snapshot = JSON.stringify(input);
    assert.deepEqual(candidateBankLineQuery(input, LOOKBACK), candidateBankLineQuery(input, LOOKBACK));
    assert.equal(JSON.stringify(input), snapshot);
});

// ---------------------------------------------------------------------------
// A tiny in-memory ledger: bank lines, review issues, and a recorder for EVERY
// write anything makes through it.
// ---------------------------------------------------------------------------

interface Store {
    lines: string[];
    issues: Map<string, ReviewIssueRow>;
    /** Every write, in order: model, operation, and the data it carried. */
    writes: Array<{ model: string; op: string; data: unknown }>;
    recomputes: string[];
    /**
     * The transaction-layer state `clearOneAtomically` (§14.10) locks and
     * reads — a mutable pair every fake transaction (below) shares with the
     * store's OWN `readEpochs` default, so a fresh store's setup snapshot and
     * its apply phase agree by construction. A test simulates drift by
     * mutating this directly, or via `fakeTransaction`'s `beforeEach` hook.
     */
    epoch: EpochSnapshot;
}

function store(
    lineIds: string[],
    openKeys: string[],
    clearedKeys: string[] = [],
    epoch: EpochSnapshot = { evidence: "1", ledger: "1" },
): Store {
    const issues = new Map<string, ReviewIssueRow>();
    const add = (targetKey: string, clearedAt: Date | null) => issues.set(targetKey, {
        id: `issue-${targetKey}`,
        targetType: RECEIPT_REQUEST_TARGET_TYPE,
        targetKey,
        version: 1,
        reasonCodes: JSON.stringify(["MISSING_RECEIPT"]),
        // THE REAL hash — not a placeholder, kept honest even though a
        // courtesy close (round 4) only ever reaches step 1 (clear/noop) and
        // never reads this field: other fixtures in this file reuse `store`
        // for the general-purpose lifecycle machinery, and a placeholder here
        // would silently mismatch `decideLifecycle`'s own computation.
        reasonHash: hashReasonCodes(canonicalizeReasonCodes(["MISSING_RECEIPT"])),
        displayDetails: JSON.stringify({ payee: "ARCO #82887", amountCents: -9_309 }),
        acknowledgedCodes: "[]",
        acknowledgedAt: null,
        firstObservedAt: new Date("2026-09-19T13:00:00.000Z"),
        clearedAt,
        currentGeneration: 1,
        updatedAt: new Date("2026-09-19T13:00:00.000Z"),
    });
    for (const key of openKeys) add(key, null);
    for (const key of clearedKeys) add(key, new Date("2026-09-20T13:00:00.000Z"));
    return { lines: lineIds, issues, writes: [], recomputes: [], epoch };
}

/**
 * THE RECORDING FAKE TRANSACTION (§14.10). It is `EvidenceCloseDeps.transaction`
 * — a fake Postgres transaction, backed by the SAME store as the rest of this
 * file, that answers both `SET LOCAL`s, the evidence lock, the evidence-epoch
 * read, the ledger-epoch lock, the evidence-epoch bump, and the lifecycle's
 * own `reviewIssue`/`reviewAlertEpisode` writes — all against `s.epoch`, so a
 * test can move it mid-run to simulate a foreign writer. Every test below
 * that does not override `transaction` or `clearOne` exercises the REAL
 * `clearOneAtomically` — including `courtesyClient`'s CAS wrapper and the
 * lock/epoch machinery — against this in-memory fake, not a reimplementation
 * of the apply step.
 *
 * `conflictOnceFor`/`conflictAlwaysFor`: the set of issue ids whose
 * `updateMany` should report a lost CAS — `{ count: 0 }` — once or forever,
 * exactly as a real concurrent writer committing between the lifecycle's own
 * read and its write would look from here (see the two CAS-conflict tests).
 *
 * `beforeEach`: fires before every recorded operation, with the calls log SO
 * FAR — the hook a test uses to land a "foreign" mutation to `s.epoch` at a
 * precise point in a multi-target run (e.g. once the first target's own two
 * evidence-reads have both happened, right as the second target's own
 * transaction is starting).
 */
function fakeTransaction(
    s: Store,
    opts: {
        conflictOnceFor?: Set<string>;
        conflictAlwaysFor?: Set<string>;
        beforeEach?: (calls: readonly string[]) => void;
    } = {},
) {
    const calls: string[] = [];
    const note = (tag: string) => { opts.beforeEach?.(calls); calls.push(tag); };
    const transaction = async <T>(fn: (tx: CourtesyTx) => Promise<T>): Promise<T> => {
        const tx = {
            $executeRaw: async (query: TemplateStringsArray, ..._values: unknown[]) => {
                const text = query.join("");
                if (text.includes("idle_in_transaction_session_timeout")) note("set-local-idle");
                else if (text.includes("SET LOCAL")) note("set-local-lock-timeout");
                else if (text.includes("pg_advisory_xact_lock")) note("lock");
                else note(`executeRaw:${text}`);
                return undefined;
            },
            $queryRaw: async (query: TemplateStringsArray, ...values: unknown[]) => {
                const text = query.join("");
                const key = values[0];
                if (key === RECEIPT_EVIDENCE_EPOCH_KEY && text.includes("SELECT")) {
                    note("evidence-read");
                    return [{ value: s.epoch.evidence }];
                }
                if (key === RECEIPT_EVIDENCE_EPOCH_KEY && text.includes("INSERT")) {
                    s.epoch = { ...s.epoch, evidence: String(Number(s.epoch.evidence) + 1) };
                    note("bump");
                    return [{ value: s.epoch.evidence }];
                }
                if (key === BANK_LEDGER_EPOCH_KEY && text.includes("INSERT")) {
                    note("ledger-lock");
                    return [{ value: s.epoch.ledger }];
                }
                throw new Error(`fakeTransaction: unexpected $queryRaw ${text} / ${String(key)}`);
            },
            reviewIssue: {
                findUnique: async (args: { where: { targetType_targetKey?: { targetKey: string }; id?: string } }) => {
                    note("reviewIssue.findUnique");
                    const key = args.where.targetType_targetKey?.targetKey;
                    if (key) return s.issues.get(key) ?? null;
                    return [...s.issues.values()].find(row => row.id === args.where.id) ?? null;
                },
                create: async (args: { data: Record<string, unknown> }) => {
                    s.writes.push({ model: "reviewIssue", op: "create", data: args.data });
                    throw new Error("evidence-close must never create an issue");
                },
                updateMany: async (args: { where: { id: string; version: number }; data: Record<string, unknown> }) => {
                    note("reviewIssue.updateMany");
                    s.writes.push({ model: "reviewIssue", op: "updateMany", data: args.data });
                    const row = [...s.issues.values()].find(r => r.id === args.where.id);
                    if (!row) return { count: 0 };
                    if (opts.conflictAlwaysFor?.has(row.id)) return { count: 0 };
                    if (opts.conflictOnceFor?.has(row.id)) {
                        opts.conflictOnceFor.delete(row.id);
                        return { count: 0 };
                    }
                    if (row.version !== args.where.version) return { count: 0 };
                    Object.assign(row, {
                        ...args.data,
                        version: row.version + 1,
                    });
                    return { count: 1 };
                },
            },
            reviewAlertEpisode: {
                create: async (args: { data: Record<string, unknown> }) => {
                    s.writes.push({ model: "reviewAlertEpisode", op: "create", data: args.data });
                    throw new Error("evidence-close must never open an episode");
                },
                updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
                    note("reviewAlertEpisode.updateMany");
                    s.writes.push({ model: "reviewAlertEpisode", op: "updateMany", data: args.data });
                    return { count: 0 };
                },
            },
        };
        return fn(tx as unknown as CourtesyTx);
    };
    return { transaction, calls };
}

function depsFor(s: Store, overrides: Partial<EvidenceCloseDeps> = {}): EvidenceCloseDeps {
    return {
        lookbackDays: LOOKBACK,
        findLines: async () => s.lines.map(id => ({ id })),
        openIssueKeys: async ids => new Map(
            ids
                .filter(id => {
                    const issue = s.issues.get(id);
                    return !!issue && issue.clearedAt === null;
                })
                .map(id => [id, s.issues.get(id)!.id]),
        ),
        recompute: async targetKey => { s.recomputes.push(targetKey); return []; },
        // Production's OWN `clearOneAtomically`, not a test reimplementation
        // of it — see `fakeTransaction` above.
        transaction: fakeTransaction(s).transaction,
        // The ONE setup read (§14.10 keeps the judge phase, including this,
        // exactly as merged) — snapshots whatever `s.epoch` holds right now.
        // Stable by default: no drift, no staleness. Tests that care about
        // the freshness fence mutate `s.epoch` (directly, via this override,
        // or via `fakeTransaction`'s `beforeEach`).
        readEpochs: async () => ({ ...s.epoch }),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// 2-8. The close itself
// ---------------------------------------------------------------------------

test("only OPEN issues are recomputed; a cleared one is examined, never cleared again", async () => {
    const s = store(["line-open", "line-cleared", "line-no-issue"], ["line-open"], ["line-cleared"]);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s));

    assert.equal(result.examined, 3, "every candidate is examined");
    assert.deepEqual(result.cleared, ["line-open"]);
    assert.deepEqual(s.recomputes, ["line-open"], "a cleared issue costs no component walk at all");
    assert.equal(s.issues.get("line-cleared")!.version, 1, "untouched");
});

test("running twice clears once: the second pass reaches the lifecycle and gets a noop", async () => {
    const s = store(["line-open"], ["line-open"]);
    const first = await closeRequestsSatisfiedBy(evidence(), depsFor(s));
    assert.deepEqual(first.cleared, ["line-open"]);
    const writesAfterFirst = s.writes.length;
    assert.equal(s.issues.get("line-open")!.clearedAt !== null, true);

    // A stale open-issue read — the sweep, or another courtesy close, cleared
    // it between this call's own lookup and its apply — still reaches
    // evaluateReviewIssue. It is decideLifecycle's OWN idempotency (step 1:
    // already cleared -> noop), not the open-issue filter, that keeps this
    // second pass from writing again.
    const second = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        openIssueKeys: async () => new Map([["line-open", "issue-line-open"]]),
    }));
    assert.deepEqual(second.cleared, [], "the lifecycle's own decision was noop, not clear — nothing to count");
    assert.equal(second.examined, 1);
    assert.deepEqual(s.recomputes, ["line-open", "line-open"], "the second pass actually judged it rather than being filtered out early");
    assert.equal(s.writes.length, writesAfterFirst, "no second write of any kind");
});

test("a non-empty verdict leaves the issue open — there is no force-close, and it is recorded in `judged`", async () => {
    const s = store(["line-open"], ["line-open"]);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        recompute: async targetKey => { s.recomputes.push(targetKey); return ["MISSING_RECEIPT"] as ReasonCode[]; },
    }));

    assert.deepEqual(result.cleared, []);
    assert.equal(result.examined, 1);
    assert.equal(result.errors, 0);
    // ids only — never a descriptor, amount or payee (Codex round-2 addendum).
    assert.deepEqual(result.judged, [{ lineId: "line-open", issueId: "issue-line-open", codes: ["MISSING_RECEIPT"] }]);
    assert.equal(s.issues.get("line-open")!.clearedAt, null);
    assert.deepEqual(s.writes, [], "a still-owed charge is not written to at all");
});

test("a throwing recompute is counted, swallowed, and leaves the issue untouched", async () => {
    const s = store(["line-a", "line-b"], ["line-a", "line-b"]);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        recompute: async targetKey => {
            s.recomputes.push(targetKey);
            if (targetKey === "line-a") throw new Error("pool timeout");
            return [];
        },
    }));

    assert.equal(result.errors, 1);
    assert.deepEqual(result.cleared, ["line-b"], "one bad candidate does not abandon the rest");
    assert.equal(s.issues.get("line-a")!.clearedAt, null);
});

test("a caught error's own name or message never reaches the log — only a small fixed category (Codex round 4, #3)", async () => {
    // `.name` is a plain mutable string property, not the "small, fixed set"
    // an earlier version of errorCategory's own comment claimed — nothing
    // stops a dependency from setting it to text that echoes a vendor or
    // account reference, exactly as this one does on both `.name` and
    // `.message`.
    const s = store(["line-a"], ["line-a"]);
    const vendorLikeError = new Error("Home Depot invoice 88213-4471 exceeded the lookback window");
    vendorLikeError.name = "ARCO #82887 lookup failure";

    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    let result;
    try {
        result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
            recompute: async () => { throw vendorLikeError; },
        }));
    } finally {
        console.warn = realWarn;
    }

    assert.equal(result.errors, 1);
    const output = warns.join("\n");
    assert.doesNotMatch(output, /Home Depot/);
    assert.doesNotMatch(output, /ARCO/);
    assert.doesNotMatch(output, /88213/);
    assert.doesNotMatch(output, /lookup failure/);
    assert.match(output, /\bother\b/, "an unrecognized error still logs a fixed category, not its own name");
});

test("a ComponentDeadlineExceededError is categorized as timeout, and a Prisma error as db — never by name (Codex round 4, #3)", async () => {
    const s1 = store(["line-a"], ["line-a"]);
    const warns1: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns1.push(args.map(String).join(" ")); };
    try {
        await closeRequestsSatisfiedBy(evidence(), depsFor(s1, {
            recompute: async () => { throw new ComponentDeadlineExceededError(3); },
        }));
    } finally {
        console.warn = realWarn;
    }
    assert.match(warns1.join("\n"), /\btimeout\b/);

    const s2 = store(["line-a"], ["line-a"]);
    const warns2: string[] = [];
    console.warn = (...args: unknown[]) => { warns2.push(args.map(String).join(" ")); };
    try {
        await closeRequestsSatisfiedBy(evidence(), depsFor(s2, {
            recompute: async () => {
                throw new Prisma.PrismaClientKnownRequestError("pool exhausted", { code: "P2024", clientVersion: "test" });
            },
        }));
    } finally {
        console.warn = realWarn;
    }
    assert.match(warns2.join("\n"), /\bdb\b/);
});

test("a deadline thrown from inside a component walk stops the pass without failing it", async () => {
    const s = store(["line-a", "line-b"], ["line-a", "line-b"]);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        recompute: async targetKey => { s.recomputes.push(targetKey); throw new ComponentDeadlineExceededError(2); },
    }));

    assert.equal(result.errors, 1);
    assert.deepEqual(result.cleared, []);
    assert.deepEqual(s.recomputes, ["line-a"], "the clock is not coming back; the next candidate is not attempted");
    assert.equal(s.issues.get("line-a")!.clearedAt, null);
});

test("an exhausted caller deadline skips the whole step", async () => {
    const s = store(["line-open"], ["line-open"]);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        deadlineExceeded: () => true,
        findLines: async () => { throw new Error("no query may be issued past the deadline"); },
    }));

    assert.deepEqual(result, { examined: 0, cleared: [], errors: 0, conflicts: 0, stale: 0, judged: [] });
});

test("THE FENCE: a close writes nothing to the cycle record, either cursor, or chaserCompletedAt", async () => {
    const s = store(["line-open"], ["line-open"]);
    const fake = fakeTransaction(s);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, { transaction: fake.transaction }));
    assert.deepEqual(result.cleared, ["line-open"]);

    // Every write this path made, through the client that also owns the
    // settings store. The close is subtractive: it may clear an issue and
    // cancel its open episodes, and nothing else.
    assert.deepEqual(
        s.writes.map(write => `${write.model}.${write.op}`),
        ["reviewIssue.updateMany", "reviewAlertEpisode.updateMany"],
    );
    assert.equal(s.writes.filter(write => write.model === "automationSetting").length, 0);

    // THE WRITE LOG for one cleared target, exactly (§14.10): both SET
    // LOCALs, the evidence lock, the freshness read, the ledger lock, the
    // lifecycle's own issue read and its two writes, the bump, then the
    // final read for `evidenceAfter`.
    assert.deepEqual(fake.calls, [
        "set-local-lock-timeout", "set-local-idle", "lock", "evidence-read", "ledger-lock",
        "reviewIssue.findUnique", "reviewIssue.updateMany", "reviewAlertEpisode.updateMany",
        "bump", "evidence-read",
    ]);

    const written = JSON.stringify(s.writes);
    for (const forbidden of ["receiptRequestsCursor", "receiptRequestsOpenIssueCursor", "receiptRequestsPhase", "chaserCompletedAt", "receiptEvidenceEpoch", "bankLedgerEpoch"]) {
        assert.equal(written.includes(forbidden), false, `wrote ${forbidden}`);
    }
    // And the same fence at the source, so a later edit cannot reintroduce one
    // through a path these fakes do not model. Comments are stripped first —
    // the module header NAMES these keys to say it never writes them, and a
    // check that could not tell the two apart would forbid saying so.
    for (const file of ["src/lib/receipt-intake/evidence-close.ts", "src/lib/receipt-intake/evidence-close-store.ts"]) {
        const code = readFileSync(join(REPO_ROOT, ...file.split("/")), "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:])\/\/.*$/gm, "$1");
        for (const forbidden of [
            // The judge-phase freshness fence (FENCED) is still READ-ONLY: it
            // may only ever OBSERVE the two epochs. The APPLY phase now
            // legitimately takes the evidence lock and bumps its epoch, in
            // its own atomic transaction (§14.10) — `lockReceiptEvidence`,
            // `readReceiptEvidenceEpoch`, `lockBankLedgerEpoch` and
            // `bumpReceiptEvidenceEpoch` are no longer forbidden. Still
            // forbidden: the LEDGER epoch is never bumped (this module never
            // creates bank activity), and this module never touches the
            // sweep's own phase, cycle or cursor state.
            "automationSetting", "chaserCompletedAt", "receiptRequestsPhase", "receiptRequestsCycle",
            "receiptRequestsCursor", "receiptRequestsOpenIssueCursor",
            "writeCycle", "writeCursor", "bumpBankLedgerEpoch",
        ]) {
            assert.equal(code.includes(forbidden), false, `${file} references ${forbidden}`);
        }
    }
});

test("bounded: forty same-amount lines examine exactly the cap", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `line-${String(i).padStart(2, "0")}`);
    const s = store(ids, ids);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s));

    assert.equal(result.examined, MAX_EVIDENCE_CLOSE_CANDIDATES);
    assert.equal(s.recomputes.length, MAX_EVIDENCE_CLOSE_CANDIDATES, "one component walk per candidate, no more");
    assert.equal(result.cleared.length, MAX_EVIDENCE_CLOSE_CANDIDATES);
});

test("the recompute cache is shared across candidates so siblings cost one walk", async () => {
    const s = store(["line-a", "line-b"], ["line-a", "line-b"]);
    // Captured on the FIRST recompute call and compared by IDENTITY on every
    // later one — "one cache reaches both" is a claim about the same Map
    // object, not just about a call count.
    let firstCache: Map<string, ReasonCode[]> | undefined;
    await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        recompute: async (targetKey, cache) => {
            if (!cache) throw new Error("a cache is always supplied");
            if (!firstCache) firstCache = cache;
            else assert.strictEqual(cache, firstCache, "the SAME Map instance reaches every candidate in one call");
            s.recomputes.push(targetKey);
            // A real recompute writes every member of the component it walked.
            cache.set("line-a", []);
            cache.set("line-b", []);
            return cache.get(targetKey)!;
        },
    }));
    assert.equal(s.recomputes.length, 2, "the fake ignores the cache; the point is that ONE cache reaches both");
    assert.ok(firstCache, "recompute ran at least once");
});

test("REGRESSION, ARCO $93.09 on 2026-09-16: the booked receipt closes the open request in one call", async () => {
    // The live shape on 2026-09-21: a native Expense for 9,309 cents dated the
    // same day as the charge, an open MISSING_RECEIPT issue on the bank line,
    // and a sweep that had not reached issue 81 of 109 all day.
    const BANK_LINE = "bankline-arco-9309";
    const s = store([BANK_LINE], [BANK_LINE]);
    const seen: Array<{ key: string; strict: unknown }> = [];

    const result = await closeRequestsSatisfiedBy(
        { totalCents: 9_309, txnDate: "2026-09-16", bookedOn: "2026-09-21" },
        depsFor(s, {
            findLines: async query => {
                // The charge is inside the proposed window, and the sign is right.
                assert.equal(query.amountCents, -9_309);
                assert.ok(query.fromYmd <= "2026-09-16" && "2026-09-16" <= query.toYmd);
                return [{ id: BANK_LINE }];
            },
            recompute: async (targetKey, _cache, _deadline, ...rest: unknown[]) => {
                seen.push({ key: targetKey, strict: rest[0] });
                return [];
            },
        }),
    );

    assert.deepEqual(result, { examined: 1, cleared: [BANK_LINE], errors: 0, conflicts: 0, stale: 0, judged: [] });
    assert.equal(s.issues.get(BANK_LINE)!.clearedAt !== null, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].strict, undefined, "LENIENT: strictCompleteness is never passed — strict is for card release");
});

test("a run of already-resolved candidates does not shadow a genuinely open one behind them", async () => {
    // MAX_EVIDENCE_CLOSE_CANDIDATES worth of ALREADY-CLEARED lines, then one
    // real open issue right behind them. Capping the raw candidate list
    // before the open-issue filter (the pre-round-2 bug) would stop at the
    // resolved ones and never reach it — this call runs once per booking, so
    // there is no next page to recover on.
    const resolved = Array.from({ length: MAX_EVIDENCE_CLOSE_CANDIDATES }, (_, i) => `resolved-${i}`);
    const s = store([...resolved, "line-open"], ["line-open"], resolved);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s));

    assert.deepEqual(result.cleared, ["line-open"]);
    assert.deepEqual(s.recomputes, ["line-open"], "no component walk was wasted on the already-resolved lines");
});

test("stale under the lock writes nothing and does not bump (§14.10)", async () => {
    const s = store(["line-open"], ["line-open"]);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        readEpochs: async () => {
            // The ONE setup read sees the store's starting snapshot; a
            // foreign writer then bumps the ledger before ANY apply's own
            // transaction ever takes its lock — `clearOneAtomically` sees the
            // move the instant it reads under that lock.
            const before = { ...s.epoch };
            s.epoch = { ...s.epoch, ledger: "2" };
            return before;
        },
    }));

    assert.deepEqual(result, { examined: 1, cleared: [], errors: 0, conflicts: 0, stale: 1, judged: [] });
    assert.equal(s.issues.get("line-open")!.clearedAt, null, "no lifecycle write happened");
    assert.deepEqual(s.writes, [], "the fence caught it before the CAS ever ran");
    assert.equal(s.epoch.evidence, "1", "not bumped — a stale read never reaches that step");
});

test("a stable epoch clears normally — the fence only withholds on an actual move", async () => {
    // A non-default pair, so this cannot pass by coincidentally matching a
    // hardcoded "1"/"1" somewhere — the fence compares VALUES, not literals.
    const s = store(["line-open"], ["line-open"], [], { evidence: "7", ledger: "3" });
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s));

    assert.deepEqual(result, { examined: 1, cleared: ["line-open"], errors: 0, conflicts: 0, stale: 0, judged: [] });
});

test("two targets clear in sorted order, and the second expects the first's post-bump epoch", async () => {
    // Seeded deliberately out of order — line-b before line-a.
    const s = store(["line-b", "line-a"], ["line-b", "line-a"]);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s));

    assert.deepEqual(result.cleared, ["line-a", "line-b"], "applied in SORTED order, not the store's own order");
    assert.equal(result.stale, 0, "the second target's own transaction reads line-a's bump as current, not a foreign move");
    assert.equal(s.epoch.evidence, "3", "bumped once per clear, from a starting value of 1");
});

test("a foreign bump between two targets makes the second stale, counting only the first as cleared", async () => {
    // The write log for a full run (THE FENCE, above) shows each target's own
    // two evidence-reads. Once the FIRST target's own pair has both
    // happened, its transaction is done — this is exactly the moment a
    // concurrent writer could land before the second target's own
    // transaction takes its lock.
    const s = store(["line-a", "line-b"], ["line-a", "line-b"]);
    const fake = fakeTransaction(s, {
        beforeEach: calls => {
            if (calls.filter(c => c === "evidence-read").length >= 2) {
                s.epoch = { ...s.epoch, ledger: "2" };
            }
        },
    });
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, { transaction: fake.transaction }));

    assert.deepEqual(result.cleared, ["line-a"], "the first apply already committed under still-current evidence");
    assert.equal(result.stale, 1, "the second apply — and everything still queued behind it — is withheld");
    assert.equal(s.issues.get("line-a")!.clearedAt !== null, true);
    assert.equal(s.issues.get("line-b")!.clearedAt, null, "never touched");
});

test("a CAS conflict that would never resolve is still terminal on the very first attempt — no re-judge, nothing applied, counted as a conflict, never cleared", async () => {
    const s = store(["line-open"], ["line-open"]);
    const conflictAlwaysFor = new Set([s.issues.get("line-open")!.id]);
    let recomputeCalls = 0;
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        transaction: fakeTransaction(s, { conflictAlwaysFor }).transaction,
        recompute: async targetKey => { recomputeCalls++; s.recomputes.push(targetKey); return []; },
    }));

    assert.equal(result.conflicts, 1, "contention on the row, not a bug — its own bucket");
    assert.deepEqual(result.cleared, [], "never counted as cleared");
    assert.equal(result.errors, 0, "a lost lifecycle CAS is not an `errors`-bucket failure");
    assert.equal(recomputeCalls, 1, "judged once, in the judge phase — no re-judge on the conflict (round 4, blocker 1: there is no recomputeCodes callback any more)");
    const updateManyAttempts = s.writes.filter(w => w.model === "reviewIssue" && w.op === "updateMany").length;
    assert.equal(updateManyAttempts, 1, "exactly one write attempt, even though this fake would keep losing the CAS forever — courtesyClient never gives evaluateReviewIssue's own retry loop the chance to try a second time");
    assert.deepEqual(s.writes.filter(w => w.model === "reviewAlertEpisode"), [], "nothing was ever actually applied");
    assert.equal(s.issues.get("line-open")!.version, 1, "the row's version never advanced — the one attempt lost the CAS");
    assert.equal(s.issues.get("line-open")!.clearedAt, null, "left exactly as it was, for the nightly sweep");
    assert.equal(s.epoch.evidence, "1", "a conflict never bumps — the transaction rolled back before that step");
});

test("a lost lifecycle CAS is terminal on the first attempt even when the conflicting writer would have gotten out of the way a moment later — counted as a conflict, never cleared, never retried (round 4, blocker 1)", async () => {
    const s = store(["line-open"], ["line-open"]);
    const conflictOnceFor = new Set([s.issues.get("line-open")!.id]);
    let recomputeCalls = 0;
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        transaction: fakeTransaction(s, { conflictOnceFor }).transaction,
        recompute: async targetKey => { recomputeCalls++; s.recomputes.push(targetKey); return []; },
    }));

    assert.equal(result.conflicts, 1, "a lost CAS is terminal on the first attempt, not retried until the conflicting writer clears");
    assert.deepEqual(result.cleared, [], "never counted as cleared");
    assert.equal(recomputeCalls, 1, "judged once, in the judge phase — no re-judge on the conflict");
    const updateManyAttempts = s.writes.filter(w => w.model === "reviewIssue" && w.op === "updateMany").length;
    assert.equal(updateManyAttempts, 1, "exactly one write attempt — courtesyClient stops evaluateReviewIssue's own retry loop from ever running a second one, so this transient conflict is never given the chance to resolve itself");
    assert.equal(s.issues.get("line-open")!.clearedAt, null, "left exactly as it was, for the nightly sweep");
});

test("a conflict on the first target still attempts the second", async () => {
    const s = store(["line-a", "line-b"], ["line-a", "line-b"]);
    const conflictAlwaysFor = new Set([s.issues.get("line-a")!.id]);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        transaction: fakeTransaction(s, { conflictAlwaysFor }).transaction,
    }));

    assert.equal(result.conflicts, 1);
    assert.deepEqual(result.cleared, ["line-b"], "the conflict on line-a did not stop line-b from being attempted and cleared");
});

test("a courtesy clear writes displayDetails exactly like the sweep's own clear: the column is not touched at all", async () => {
    const s = store(["line-open"], ["line-open"]);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s));

    assert.deepEqual(result.cleared, ["line-open"]);
    const clearWrite = s.writes.find(w => w.model === "reviewIssue" && w.op === "updateMany");
    assert.ok(clearWrite, "the clear happened");
    assert.equal(
        Object.prototype.hasOwnProperty.call(clearWrite!.data as object, "displayDetails"),
        false,
        "applyReceiptRequestPlan's own evaluate(targetKey, [], null) reaches the SAME lifecycle `clear` branch, which never writes displayDetails — a courtesy clear leaves the row identical to a sweep clear",
    );
});

test("a deadline that fires exactly when judging finishes stops before any apply starts", async () => {
    const s = store(["line-open"], ["line-open"]);
    let deadlineHit = false;
    let applyCalls = 0;
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        deadlineExceeded: () => deadlineHit,
        recompute: async targetKey => {
            s.recomputes.push(targetKey);
            const codes: ReasonCode[] = [];
            // The invocation's budget runs out the instant judging is done —
            // before the apply phase's own "after judging" check ever runs.
            deadlineHit = true;
            return codes;
        },
        clearOne: async () => { applyCalls++; return { kind: "noop" }; },
    }));

    assert.equal(applyCalls, 0, "the after-judging check stopped it before the apply phase began");
    assert.deepEqual(result.cleared, []);
    assert.equal(result.stale, 0, "a deadline stop, not a freshness one — nothing is counted stale");
});

test("a late-settling judge does not start an apply — the store's own deadline predicate stops it", async () => {
    const s = store(["line-open"], ["line-open"]);
    let deadlineHit = false;
    let applyCalls = 0;
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        deadlineExceeded: () => deadlineHit,
        recompute: async targetKey => {
            s.recomputes.push(targetKey);
            // The SAME predicate the worker's own outer race flips (see
            // worker.ts's closeDeadlineExceeded) is flipped WHILE this call
            // is still in flight, and only THEN does this call settle, on a
            // later tick — with a SATISFIED verdict that would otherwise
            // have gone on to clear. Deterministic: one controlled promise
            // tick, no timers.
            deadlineHit = true;
            await Promise.resolve();
            return [];
        },
        clearOne: async () => { applyCalls++; return { kind: "noop" }; },
    }));

    assert.equal(applyCalls, 0, "no apply was ever started once the deadline had fired, however late the judge settled");
    assert.deepEqual(result.cleared, []);
});

test("an error on the first target stops the loop before the second is even attempted", async () => {
    const s = store(["line-a", "line-b"], ["line-a", "line-b"]);
    const attempted: string[] = [];
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        clearOne: async targetKey => { attempted.push(targetKey); return { kind: "error" }; },
    }));

    assert.deepEqual(attempted, ["line-a"], "the second target is never attempted once the first errors");
    assert.equal(result.errors, 1);
    assert.deepEqual(result.cleared, []);
});

test("a deadline right before the second target stops the loop there", async () => {
    const s = store(["line-a", "line-b"], ["line-a", "line-b"]);
    let deadlineHit = false;
    const attempted: string[] = [];
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        deadlineExceeded: () => deadlineHit,
        clearOne: async targetKey => {
            attempted.push(targetKey);
            // Flips AFTER the first target's own attempt, so the loop's own
            // top-of-iteration check is what stops the second one — the
            // exact "checked again, nothing but a synchronous index between
            // the check and starting the apply" property round 4's blocker 3
            // established, now with the epoch re-read folded into the
            // atomic apply itself rather than a separate step to re-check
            // after.
            deadlineHit = true;
            return { kind: "cleared", evidenceAfter: "2" };
        },
    }));

    assert.deepEqual(attempted, ["line-a"], "only the first target's clearOne ran");
    assert.deepEqual(result.cleared, ["line-a"]);
});

test("the function never rejects, even when the transaction wrapper itself throws", async () => {
    const s = store(["line-open"], ["line-open"]);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        transaction: async () => { throw new Error("connection pool exhausted"); },
    }));

    assert.equal(result.errors, 1);
    assert.deepEqual(result.cleared, []);
});

test("a setup failure — the candidate query, the open-issue lookup, or the epoch read — is counted, never thrown", async () => {
    const s = store(["line-open"], ["line-open"]);

    const findLinesThrows = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        findLines: async () => { throw new Error("pool timeout"); },
    }));
    assert.deepEqual(findLinesThrows, { examined: 0, cleared: [], errors: 1, conflicts: 0, stale: 0, judged: [] });

    const openIssueKeysThrows = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        openIssueKeys: async () => { throw new Error("pool timeout"); },
    }));
    assert.deepEqual(openIssueKeysThrows, { examined: 0, cleared: [], errors: 1, conflicts: 0, stale: 0, judged: [] });

    const readEpochsThrows = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        readEpochs: async () => { throw new Error("pool timeout"); },
    }));
    assert.deepEqual(readEpochsThrows, { examined: 0, cleared: [], errors: 1, conflicts: 0, stale: 0, judged: [] });
});

// ---------------------------------------------------------------------------
// 9. The worker call site
// ---------------------------------------------------------------------------

const LIVE_TOKEN = "claim-1";

function bookingRow(overrides: Partial<WorkerRow> = {}): WorkerRow {
    return {
        id: "row-1",
        source: "drive",
        sourceRef: "drive:FILE1",
        state: "BOOKING",
        dryRun: false,
        projectId: "proj-1",
        costCodeId: null,
        costCodeSource: null,
        suggestedCostCodeId: null,
        suggestedConfidence: null,
        taxAtSource: false,
        installedAtCustomer: null,
        storagePath: "receipts/intake/row-1.jpg",
        fileName: "r.jpg",
        mimeType: "image/jpeg",
        fileSize: 100,
        vendor: "ARCO",
        txnDate: new Date("2026-09-16T07:00:00.000Z"),
        totalCents: 9_309,
        taxCents: null,
        docType: "receipt",
        refNumber: null,
        memo: null,
        attempts: 0,
        readAt: new Date("2026-09-21T19:00:00.000Z"),
        createdAt: new Date("2026-09-21T18:00:00.000Z"),
        dedupWeakKey: "arco|2026-09-16|93.09|amt",
        // Already owns its identity, so healStrongKey's fast path (#522)
        // returns immediately — these rows are about evidence-close, not
        // about strong-key recovery, and this keeps them out of that path.
        dedupStrongKey: "strong-row-1",
        readJson: null,
        duplicateOfId: null,
        busyPasses: 0,
        lastError: null,
        sendAttempted: false,
        claimToken: LIVE_TOKEN,
        fileSha256: "s".repeat(64),
        stateReason: null,
        ...overrides,
    };
}

interface WorkerHarness {
    deps: WorkerDependencies;
    closes: Array<{ expenseId: string; deadlineExceeded: () => boolean }>;
    clock: number;
}

function workerHarness(result: BookResult, overrides: Partial<WorkerDependencies> = {}): WorkerHarness {
    const h: WorkerHarness = { deps: null as unknown as WorkerDependencies, closes: [], clock: 0 };
    h.deps = {
        acquireLease: async () => ({ release: async () => {} }),
        claim: async () => ({ rows: [bookingRow()], shadowRetired: 0, requeued: 0, shadowQuarantined: 0, shadowSkippedMoved: 0 }),
        cutoverBoundary: async () => new Date("2026-08-25T00:00:00.000Z"),
        isDryRunEnabled: () => false,
        sweepStaleStaging: async () => 0,
        retryStorageCleanups: async () => 0,
        loadPhases: async () => [],
        refreshProjectId: async () => "proj-1",
        sendAttemptedNow: async () => false,
        downloadBytes: async () => ({ ok: true as const, bytes: Buffer.from("bytes") }),
        read: async () => { throw new Error("a BOOKING row is never read"); },
        applyRead: async () => ({ owned: true, strongOwner: null }),
        // Never actually invoked: bookingRow() already carries a dedupStrongKey,
        // so healStrongKey's (#522) fast path returns before calling this.
        claimStrongKey: async () => { throw new Error("bookingRow already owns a strong key"); },
        findWeakGroup: async () => [],
        applyState: async () => true,
        finishRouting: async () => {},
        companyTimeZone: async () => "America/Los_Angeles",
        promoteToBooking: async () => ({ promoted: true }),
        book: async () => result,
        applyBookResult: async () => {},
        closeRequestsSatisfiedBy: async (expenseId, deadlineExceeded) => {
            h.closes.push({ expenseId, deadlineExceeded });
        },
        deferRead: async () => true,
        releaseClaim: async () => true,
        releaseUnprocessed: async () => 0,
        retryRow: async () => true,
        now: () => new Date("2026-09-21T20:00:00.000Z"),
        monotonicMs: () => h.clock,
        ...overrides,
    };
    return h;
}

const BOOKED: BookResult = { outcome: "booked", qbPurchaseId: null, expenseId: "expense-arco-1", alreadyExisted: false };

test("the worker closes satisfied requests exactly once after a booked outcome", async () => {
    const h = workerHarness(BOOKED);
    const summary = await runIntakeWorker(h.deps);

    assert.equal(summary.byState.BOOKED, 1);
    assert.equal(h.closes.length, 1);
    assert.equal(h.closes[0].expenseId, "expense-arco-1", "the id of the Expense this booking just produced");
});

test("the close never runs for an outcome that booked nothing", async () => {
    const outcomes: Array<[string, BookResult]> = [
        ["deferred", { outcome: "deferred", reason: "push-disabled" }],
        ["aborted", { outcome: "aborted", reason: "voided mid-send" }],
        ["needs-review", { outcome: "needs-review", reason: "no-estimate", releaseStrongKey: true }],
        ["stale", { outcome: "stale" }],
        ["booked-after-void", { outcome: "booked-after-void", qbPurchaseId: "QB-9" }],
        ["retry", { outcome: "retry", attempts: 1, nextRetryAt: new Date("2026-09-21T20:05:00.000Z"), reason: "socket" }],
    ];
    for (const [name, result] of outcomes) {
        const h = workerHarness(result);
        await runIntakeWorker(h.deps);
        assert.equal(h.closes.length, 0, `${name} must not close anything`);
    }
});

test("a dry-run park books nothing, so it closes nothing", async () => {
    const h = workerHarness(BOOKED, { isDryRunEnabled: () => true });
    await runIntakeWorker(h.deps);
    assert.equal(h.closes.length, 0);
});

test("a throwing close does not fail the pass or the booking", async () => {
    const h = workerHarness(BOOKED, {
        closeRequestsSatisfiedBy: async () => { throw new Error("component too large"); },
    });
    const summary = await runIntakeWorker(h.deps);
    assert.equal(summary.processed, 1);
    assert.equal(summary.byState.BOOKED, 1, "the booking still reports BOOKED");
    assert.equal(summary.byState.RETRY, undefined, "and it is NOT routed through the row error path");
});

test("the worker's own courtesy catch never logs the close error's name or message either — only a fixed category (Codex round 4, #3)", async () => {
    const vendorLikeError = new Error("Lowe's PO#4471 receipt reconciliation failed");
    vendorLikeError.name = "HomeDepotSyncError";
    const h = workerHarness(BOOKED, {
        closeRequestsSatisfiedBy: async () => { throw vendorLikeError; },
    });

    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    let summary;
    try {
        summary = await runIntakeWorker(h.deps);
    } finally {
        console.warn = realWarn;
    }

    assert.equal(summary.byState.BOOKED, 1, "the booking is unaffected by the close's own failure");
    const output = warns.join("\n");
    assert.doesNotMatch(output, /Lowe's/);
    assert.doesNotMatch(output, /HomeDepotSyncError/);
    assert.doesNotMatch(output, /4471/);
    assert.match(output, /\bother\b/, "an unrecognized error still logs a fixed category, not its own name");
});

test("a SYNCHRONOUSLY throwing close does not fail an already-booked row — accounting still reports BOOKED, and the throw is logged as a category, never routed through handleRowError (Codex round 4, #4)", async () => {
    const h = workerHarness(BOOKED, {
        // Deliberately NOT `async`, and no `new Promise` either: this throws
        // the instant it is called, before ever returning anything a
        // `.then`/`.catch` chained onto the call's OWN return value could
        // attach to. Distinct from the async-rejection tests above, which a
        // plain `.then().catch()` already handled correctly before this fix.
        closeRequestsSatisfiedBy: () => { throw new Error("Ferguson invoice 90142 lookup exploded synchronously"); },
    });

    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    let summary;
    try {
        summary = await runIntakeWorker(h.deps);
    } finally {
        console.warn = realWarn;
    }

    assert.equal(summary.processed, 1);
    assert.equal(summary.byState.BOOKED, 1, "the booking still reports BOOKED — the sync throw never reached the outer per-row catch");
    assert.equal(summary.byState.RETRY, undefined, "not routed through handleRowError as a booking failure");
    assert.equal(summary.byState.NEEDS_REVIEW, undefined);
    const output = warns.join("\n");
    assert.doesNotMatch(output, /Ferguson/);
    assert.doesNotMatch(output, /90142/);
    assert.match(output, /\bother\b/, "the synchronous throw is still logged, as a fixed category");
});

test("the worker runs unchanged when the dependency is absent", async () => {
    const h = workerHarness(BOOKED);
    const deps = { ...h.deps };
    delete deps.closeRequestsSatisfiedBy;
    const summary = await runIntakeWorker(deps);
    assert.equal(summary.byState.BOOKED, 1);
});

test("the close is skipped with no runway left, and carries the invocation's own clock", async () => {
    const h = workerHarness(BOOKED);
    // THE BOOKING ITSELF is what spends the invocation: the pass starts at
    // zero and the QBO round trip lands with less than the minimum left.
    h.deps.book = async () => {
        h.clock = RUN_HARD_BUDGET_MS - CLOSE_REQUESTS_MIN_BUDGET_MS + 1;
        return BOOKED;
    };
    await runIntakeWorker(h.deps);
    assert.equal(h.closes.length, 0, "started with a second left it would only be killed mid-walk");

    const live = workerHarness(BOOKED);
    await runIntakeWorker(live.deps);
    assert.equal(live.closes.length, 1);
    assert.equal(live.closes[0].deadlineExceeded(), false, "budget remains at the start of the pass");
    live.clock = RUN_HARD_BUDGET_MS;
    assert.equal(live.closes[0].deadlineExceeded(), true, "the SAME predicate answers true once the invocation is spent");
});

test("applyBookResult commits before the evidence close ever starts", async () => {
    const order: string[] = [];
    const h = workerHarness(BOOKED, {
        applyBookResult: async () => { order.push("applyBookResult"); },
        closeRequestsSatisfiedBy: async () => { order.push("closeRequestsSatisfiedBy"); },
    });
    await runIntakeWorker(h.deps);
    assert.deepEqual(order, ["applyBookResult", "closeRequestsSatisfiedBy"]);
});

test("a never-resolving close times out; the pass still completes and accounts the booking", async () => {
    const h = workerHarness(BOOKED, {
        // NEVER settles — proves the worker cannot be blocked by it forever,
        // not merely that it eventually returns.
        closeRequestsSatisfiedBy: () => new Promise(() => {}),
    });
    // Pin the close's own budget to its floor (CLOSE_REQUESTS_MIN_BUDGET_MS -
    // CLOSE_REQUESTS_SAFETY_MARGIN_MS = 3s) rather than its 8s ceiling, so
    // this test's one real timer stays as short as the constants allow.
    h.deps.book = async () => {
        h.clock = RUN_HARD_BUDGET_MS - CLOSE_REQUESTS_MIN_BUDGET_MS;
        return BOOKED;
    };
    const summary = await runIntakeWorker(h.deps);
    assert.equal(summary.byState.BOOKED, 1, "accounting proceeded even though the close never settled");
});

test("once the timer wins the race, the deadline predicate latches true independent of the clock (round 4, blocker 3)", async () => {
    const h = workerHarness(BOOKED, {
        // NEVER settles, exactly like the timeout test above — the point
        // here is what `deadlineExceeded` reports afterward, not the timing.
        closeRequestsSatisfiedBy: async (expenseId, deadlineExceeded) => {
            h.closes.push({ expenseId, deadlineExceeded });
            return new Promise(() => {});
        },
    });
    // Pinned to the close's budget floor (3s), same as the timeout test, so
    // this test's one real timer stays short.
    h.deps.book = async () => {
        h.clock = RUN_HARD_BUDGET_MS - CLOSE_REQUESTS_MIN_BUDGET_MS;
        return BOOKED;
    };
    await runIntakeWorker(h.deps);

    assert.equal(h.closes.length, 1);
    // The injected clock is a plain variable, frozen at whatever `book()` set
    // it to — it never advances on its own. The only way the predicate can
    // now read `true` is the timer's own latch, not the elapsed-time
    // arithmetic: proof that "once cancelled, no new apply may start" does
    // not depend on real time having actually passed.
    assert.equal(h.closes[0].deadlineExceeded(), true, "the timer winning latches the flag");
});

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

process.env.DATABASE_URL = "postgresql://fiction:fiction@127.0.0.1:9/test?pgbouncer=true";

import {
    candidateBankLineQuery,
    MAX_EVIDENCE_CLOSE_CANDIDATES,
    type BookedEvidence,
} from "../src/lib/receipt-intake/evidence-close";
import {
    closeRequestsSatisfiedBy,
    type EvidenceCloseDeps,
} from "../src/lib/receipt-intake/evidence-close-store";
import {
    evaluateReviewIssue,
    type ReviewIssueLifecycleClient,
    type ReviewIssueRow,
} from "../src/lib/review-alert-lifecycle";
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
}

function store(lineIds: string[], openKeys: string[], clearedKeys: string[] = []): Store {
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
    return { lines: lineIds, issues, writes: [], recomputes: [] };
}

/**
 * THE RECORDING CLIENT. It is the lifecycle's client, and it is also the
 * settings store: `automationSetting` is wired so a write to the cycle key or
 * either cursor would be RECORDED rather than merely impossible, which is what
 * makes the fence test below an assertion instead of a hope.
 *
 * `conflictOnceFor`: the set of issue ids whose FIRST `updateMany` should
 * report a lost CAS — `{ count: 0 }` — regardless of whether the version
 * actually matches, exactly as a real concurrent writer committing between
 * the caller's read and its write would look from here. Consumed on the
 * first hit, so a retry's own write behaves normally (the transient-conflict
 * shape: contention clears and the SAME empty verdict lands a moment later).
 *
 * `conflictAlwaysFor`: the set of issue ids whose `updateMany` NEVER
 * succeeds — every one of `evaluateReviewIssue`'s own retry attempts loses
 * the CAS, so it exhausts its budget and throws (the sustained-contention
 * shape, round 4: counted as a `conflict`, never applied).
 */
function lifecycleClient(
    s: Store,
    opts: { conflictOnceFor?: Set<string>; conflictAlwaysFor?: Set<string> } = {},
): ReviewIssueLifecycleClient {
    const client = {
        reviewIssue: {
            findUnique: async (args: { where: { targetType_targetKey?: { targetKey: string }; id?: string } }) => {
                const key = args.where.targetType_targetKey?.targetKey;
                if (key) return s.issues.get(key) ?? null;
                return [...s.issues.values()].find(row => row.id === args.where.id) ?? null;
            },
            create: async (args: { data: Record<string, unknown> }) => {
                s.writes.push({ model: "reviewIssue", op: "create", data: args.data });
                throw new Error("evidence-close must never create an issue");
            },
            updateMany: async (args: { where: { id: string; version: number }; data: Record<string, unknown> }) => {
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
                s.writes.push({ model: "reviewAlertEpisode", op: "updateMany", data: args.data });
                return { count: 0 };
            },
        },
        automationSetting: {
            upsert: async (args: unknown) => { s.writes.push({ model: "automationSetting", op: "upsert", data: args }); },
            update: async (args: unknown) => { s.writes.push({ model: "automationSetting", op: "update", data: args }); },
            create: async (args: unknown) => { s.writes.push({ model: "automationSetting", op: "create", data: args }); },
            deleteMany: async (args: unknown) => { s.writes.push({ model: "automationSetting", op: "deleteMany", data: args }); },
        },
        $transaction: async <T>(fn: (tx: ReviewIssueLifecycleClient) => Promise<T>): Promise<T> =>
            fn(client as unknown as ReviewIssueLifecycleClient),
    };
    return client as unknown as ReviewIssueLifecycleClient;
}

/** The real lifecycle, driven against the in-memory ledger. Returns whether
 *  the decision was an actual CLEAR (false for a noop). No `recomputeCodes`
 *  is passed — the same wiring `defaultApplyCodes` does in production (round
 *  4) — so a version-conflict retry inside `evaluateReviewIssue` can only
 *  ever reapply the SAME empty `codes` it started with. */
function realApplyCodes(s: Store, opts: { conflictOnceFor?: Set<string>; conflictAlwaysFor?: Set<string> } = {}) {
    return async (targetKey: string, codes: ReasonCode[]) => {
        const { decision } = await evaluateReviewIssue(RECEIPT_REQUEST_TARGET_TYPE, targetKey, codes, null, {
            client: lifecycleClient(s, opts),
            episodeStatus: "SUPPRESSED",
            now: () => new Date("2026-09-21T20:00:00.000Z"),
        });
        return decision.action === "clear";
    };
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
        applyCodes: realApplyCodes(s),
        // Stable across both reads by default — no drift, no staleness. Tests
        // that care about the freshness fence override this explicitly.
        readEpochs: async () => ({ evidence: "1", ledger: "1" }),
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
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s));
    assert.deepEqual(result.cleared, ["line-open"]);

    // Every write this path made, through the client that also owns the
    // settings store. The close is subtractive: it may clear an issue and
    // cancel its open episodes, and nothing else.
    assert.deepEqual(
        s.writes.map(write => `${write.model}.${write.op}`),
        ["reviewIssue.updateMany", "reviewAlertEpisode.updateMany"],
    );
    assert.equal(s.writes.filter(write => write.model === "automationSetting").length, 0);

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
            "automationSetting", "chaserCompletedAt", "receiptRequestsCursor", "receiptRequestsOpenIssueCursor",
            "writeCycle", "writeCursor",
            // The freshness fence (FENCED) is READ-ONLY: it may only ever
            // OBSERVE the two epochs, never take the sweep's own advisory
            // lock for them or bump either counter — either would be the
            // fence perturbing the very thing it is comparing against.
            "bumpReceiptEvidenceEpoch", "bumpBankLedgerEpoch", "lockReceiptEvidence", "lockBankLedgerEpoch",
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

test("an epoch that moves between judging and applying withholds every clear, counted stale", async () => {
    const s = store(["line-open"], ["line-open"]);
    let reads = 0;
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        readEpochs: async () => {
            reads++;
            // The FIRST read (before judging) sees one snapshot; the SECOND
            // (right before applying) sees the ledger having moved under it —
            // a bank line committed or changed between the two reads.
            return reads === 1 ? { evidence: "1", ledger: "1" } : { evidence: "1", ledger: "2" };
        },
    }));

    assert.deepEqual(result, { examined: 1, cleared: [], errors: 0, conflicts: 0, stale: 1, judged: [] });
    assert.equal(s.issues.get("line-open")!.clearedAt, null, "no lifecycle write happened");
    assert.deepEqual(s.writes, [], "the fence caught it before the CAS ever ran");
});

test("a stable epoch clears normally — the fence only withholds on an actual move", async () => {
    const s = store(["line-open"], ["line-open"]);
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        readEpochs: async () => ({ evidence: "7", ledger: "3" }),
    }));

    assert.deepEqual(result, { examined: 1, cleared: ["line-open"], errors: 0, conflicts: 0, stale: 0, judged: [] });
});

test("an epoch that moves between two applies withholds the second one, counting only the first", async () => {
    // Codex round 3: the freshness read now happens IMMEDIATELY before EACH
    // apply, not once for the whole batch — this is the test that tells the
    // two designs apart, since the single-candidate version above cannot.
    const s = store(["line-a", "line-b"], ["line-a", "line-b"]);
    let reads = 0;
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        readEpochs: async () => {
            reads++;
            // #1 = setup (before judging); #2 = right before applying
            // line-a; #3 = right before applying line-b, where the ledger
            // has now moved under it.
            return reads <= 2 ? { evidence: "1", ledger: "1" } : { evidence: "1", ledger: "2" };
        },
    }));

    assert.deepEqual(result.cleared, ["line-a"], "the first apply already committed under still-current evidence");
    assert.equal(result.stale, 1, "the second apply — and everything still queued behind it — is withheld");
    assert.equal(s.issues.get("line-a")!.clearedAt !== null, true);
    assert.equal(s.issues.get("line-b")!.clearedAt, null, "never touched");
});

test("a CAS conflict that exhausts every retry does not re-judge, does not apply anything, and is counted as a conflict, never cleared", async () => {
    const s = store(["line-open"], ["line-open"]);
    const conflictAlwaysFor = new Set([s.issues.get("line-open")!.id]);
    let recomputeCalls = 0;
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        applyCodes: realApplyCodes(s, { conflictAlwaysFor }),
        recompute: async targetKey => { recomputeCalls++; s.recomputes.push(targetKey); return []; },
    }));

    assert.equal(result.conflicts, 1, "contention on the row, not a bug — its own bucket");
    assert.deepEqual(result.cleared, [], "never counted as cleared");
    assert.equal(result.errors, 0, "a lost lifecycle CAS is not an `errors`-bucket failure");
    assert.equal(recomputeCalls, 1, "judged once, in the judge phase — no re-judge on the conflict (round 4, blocker 1: there is no recomputeCodes callback any more)");
    assert.deepEqual(s.writes.filter(w => w.model === "reviewAlertEpisode"), [], "nothing was ever actually applied");
    assert.equal(s.issues.get("line-open")!.version, 1, "the row's version never advanced — every attempt lost the CAS");
    assert.equal(s.issues.get("line-open")!.clearedAt, null, "left exactly as it was, for the nightly sweep");
});

test("a transient CAS conflict retries the lifecycle's SAME clear-only verdict once contention clears — never a re-judge", async () => {
    const s = store(["line-open"], ["line-open"]);
    const conflictOnceFor = new Set([s.issues.get("line-open")!.id]);
    let recomputeCalls = 0;
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        applyCodes: realApplyCodes(s, { conflictOnceFor }),
        recompute: async targetKey => { recomputeCalls++; s.recomputes.push(targetKey); return []; },
    }));

    assert.deepEqual(result.cleared, ["line-open"], "the SAME empty verdict landed once the conflicting writer got out of the way");
    assert.equal(result.conflicts, 0, "the retry succeeded — no exhaustion to count");
    assert.equal(recomputeCalls, 1, "the lifecycle's own internal retry reapplied the fixed `[]` — it never asked to re-judge");
    assert.equal(s.issues.get("line-open")!.clearedAt !== null, true);
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
        applyCodes: async () => { applyCalls++; return false; },
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
        applyCodes: async () => { applyCalls++; return false; },
    }));

    assert.equal(applyCalls, 0, "no apply was ever started once the deadline had fired, however late the judge settled");
    assert.deepEqual(result.cleared, []);
});

test("a deadline that fires during the apply-phase epoch re-read stops that apply before it starts (round 4, blocker 3)", async () => {
    // The pre-existing top-of-loop check cannot catch this: the deadline
    // flips AFTER it has already passed, WHILE the epoch re-read itself is
    // in flight — proving the check right after that re-read, with no await
    // before the apply, is what actually stops it.
    const s = store(["line-open"], ["line-open"]);
    let deadlineHit = false;
    let applyCalls = 0;
    let reads = 0;
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        deadlineExceeded: () => deadlineHit,
        readEpochs: async () => {
            reads++;
            // #1 = setup (before judging), still fresh. #2 = the apply
            // phase's own re-read, right before the one candidate judging
            // produced — flips the deadline DURING it, evidence staying
            // fresh so this cannot be mistaken for a staleness stop.
            if (reads === 2) deadlineHit = true;
            return { evidence: "1", ledger: "1" };
        },
        applyCodes: async () => { applyCalls++; return true; },
    }));

    assert.equal(applyCalls, 0, "checked again right after the epoch re-read, before the apply started");
    assert.deepEqual(result.cleared, []);
    assert.equal(result.stale, 0, "evidence never moved — this is a deadline stop, not a freshness one");
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

test("the freshness re-check failing (not just drifting) is also counted, not thrown", async () => {
    const s = store(["line-open"], ["line-open"]);
    let reads = 0;
    const result = await closeRequestsSatisfiedBy(evidence(), depsFor(s, {
        readEpochs: async () => {
            reads++;
            if (reads === 1) return { evidence: "1", ledger: "1" };
            throw new Error("pool timeout");
        },
    }));

    assert.deepEqual(result, { examined: 1, cleared: [], errors: 1, conflicts: 0, stale: 0, judged: [] });
    assert.deepEqual(s.writes, [], "no clear was attempted without a confirmed-fresh read");
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

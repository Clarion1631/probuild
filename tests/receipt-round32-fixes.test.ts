import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isClearedForMint, isClearedStatusValue } from "../src/lib/register-types";
import {
    QBO_MINT_MIN_AGE_DAYS,
    planQboMint,
    type ExistingBankLine,
    type MintCandidateObservation,
} from "../src/lib/bank-line-mint";
import { recordCardOnIssues, itemsMissingCardRecord, type CardHistoryClient } from "../src/lib/receipt-card-history";
import { bankPullFresh, sweepCompletionDecision } from "../src/app/api/cron/receipt-requests/route";
import { BANK_PULL_CHASER_WINDOW_HOURS, BANK_PULL_UNCLEARED_KEY } from "../src/lib/pipeline-health";

/**
 * Codex PR #443 round-32 gate. Three ways this pipeline could ask a human for
 * something that was never owed, or lose the answer when they gave it.
 *
 *   1. A canonical bank line minted from a GL row nobody had cleared.
 *   2. Reply routing thrown away the moment an issue auto-closed.
 *   3. A chaser that stamped itself complete over a bank pull that had failed.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-08-20T09:00:00Z");
const ACCOUNT = "WTB-0723";

const obs = (over: Partial<MintCandidateObservation> = {}): MintCandidateObservation => ({
    id: "obs-1",
    account: ACCOUNT,
    postedDate: "2026-08-16",
    amountCents: -12_345,
    rawDescriptor: "PACIFIC PLUMBING",
    normalizedPayee: "PACIFIC PLUMBING",
    checkNumber: null,
    clearedStatus: "Reconciled",
    bankLineId: null,
    ...over,
});

const line = (over: Partial<ExistingBankLine> = {}): ExistingBankLine => ({
    id: "bl-1",
    account: ACCOUNT,
    postedDate: "2026-08-16",
    amountCents: -12_345,
    normalizedPayee: "PACIFIC PLUMBING",
    checkNumber: null,
    sourceOfRecord: "STATEMENT",
    ...over,
});

// ── 1. Only a CLEARED row becomes bank truth ────────────────────────────────

test("an uncleared row is not minted, and does not become a chase", () => {
    // The reviewer's case, exactly: a manually entered or uncleared check sits
    // in the General Ledger, ages past the grace period, and used to mint a
    // canonical BankLine — which is a claim that money left the account. The
    // chaser then asked somebody for the receipt for a transaction the bank had
    // never seen.
    for (const status of ["Uncleared", "Unknown", null] as const) {
        const plan = planQboMint([obs({ clearedStatus: status })], [], NOW);
        assert.equal(plan.mint.length, 0, `clearedStatus=${String(status)} must not mint`);
        assert.equal(plan.skipped.notCleared, 1, String(status));
        // And it is not silently re-labelled as some other kind of skip.
        assert.equal(plan.skipped.tooRecent, 0);
        assert.equal(plan.skipped.statementLineExists, 0);
    }
});

test("a cleared row mints exactly as it always did", () => {
    for (const status of ["Reconciled", "Cleared"] as const) {
        const plan = planQboMint([obs({ clearedStatus: status })], [], NOW);
        assert.equal(plan.mint.length, 1, status);
        assert.equal(plan.skipped.notCleared, 0, status);
    }
});

test("a row that clears LATER mints on the next run, and only once", () => {
    // Night one: QuickBooks has not cleared it.
    const uncleared = obs({ clearedStatus: "Uncleared" });
    assert.equal(planQboMint([uncleared], [], NOW).mint.length, 0);

    // Night two: the same observation, now cleared. It mints.
    const cleared = obs({ clearedStatus: "Cleared" });
    const second = planQboMint([cleared], [], NOW);
    assert.deepEqual(second.mint.map(o => o.id), ["obs-1"]);

    // Night three: the mint of night two exists and the observation is linked.
    // Re-running changes nothing — the idempotency promise survives the gate.
    const third = planQboMint(
        [obs({ clearedStatus: "Cleared", bankLineId: "bl-minted" })],
        [line({ id: "bl-minted", sourceOfRecord: "QBO" })],
        NOW,
    );
    assert.equal(third.mint.length, 0);
    assert.equal(third.skipped.alreadyLinked, 1);
});

test("an uncleared observation does not consume a canonical line it has no claim on", () => {
    // Two same-identity observations — one cleared, one not — and no existing
    // line. If the uncleared one were counted before the identity accounting it
    // would either mint or make the cleared one look already covered. Exactly
    // one canonical line is right.
    const plan = planQboMint(
        [obs({ id: "a", clearedStatus: "Uncleared" }), obs({ id: "b", clearedStatus: "Reconciled" })],
        [],
        NOW,
    );
    assert.deepEqual(plan.mint.map(o => o.id), ["b"]);
    assert.equal(plan.skipped.notCleared, 1);

    // And with a free statement line present, the cleared one adopts it rather
    // than minting a twin — the uncleared one still contributes nothing.
    const withLine = planQboMint(
        [obs({ id: "a", clearedStatus: "Uncleared" }), obs({ id: "b", clearedStatus: "Reconciled" })],
        [line()],
        NOW,
    );
    assert.equal(withLine.mint.length, 0);
    assert.equal(withLine.skipped.statementLineExists, 1);
    assert.equal(withLine.skipped.notCleared, 1);
});

test("age and clearance are BOTH required — neither substitutes for the other", () => {
    const tooRecent = obs({ postedDate: "2026-08-20", clearedStatus: "Reconciled" });
    assert.equal(planQboMint([tooRecent], [], NOW).mint.length, 0, "cleared but not yet settled");
    assert.equal(QBO_MINT_MIN_AGE_DAYS, 2, "the grace period is unchanged; clearance is ADDITIONAL");

    const oldButUncleared = obs({ postedDate: "2026-06-01", clearedStatus: "Uncleared" });
    assert.equal(planQboMint([oldButUncleared], [], NOW).mint.length, 0, "old is not evidence");
});

test("the clearance predicate is POSITIVE, so every unknown lands on the safe side", () => {
    assert.equal(isClearedForMint("Reconciled"), true);
    assert.equal(isClearedForMint("Cleared"), true);
    for (const value of ["Uncleared", "Unknown", null, undefined, "", "reconciled", "CLEARED", "true"]) {
        assert.equal(isClearedForMint(value as string | null), false, String(value));
    }
    // The validator is a closed set, so a typo can never read as a clearance.
    assert.equal(isClearedStatusValue("Reconciled"), true);
    assert.equal(isClearedStatusValue("reconciled"), false);
    assert.equal(isClearedStatusValue(undefined), false);
});

test("clearance is fetched the only way QuickBooks offers it, and the evidence is written down", () => {
    // `cleared` is a FILTER on TransactionList; it is not available as a column
    // on any report, so it cannot ride the GeneralLedger call the register
    // already makes. Verified against the live realm 2026-09-02 — the numbers
    // are in the file's honesty contract so a future reader does not have to
    // re-derive them.
    const source = readFileSync(join(repoRoot, "src/lib/qbo-bank-register.ts"), "utf8");
    assert.match(source, /reports\/TransactionList\?/, "the cleared answer comes from TransactionList");
    assert.match(source, /cleared: bucket/, "and `cleared` is passed as a filter");
    assert.match(source, /2026-09-02/, "the live verification is dated");
    // All THREE buckets, so a row QuickBooks classifies as neither (a manually
    // entered journal) stays Unknown instead of being called Uncleared.
    assert.match(source, /\["Uncleared", "Cleared", "Reconciled"\]/);
    // A probe failure is reported, never absorbed into a cleared-looking answer.
    assert.match(source, /clearedProbeOk = false/);
    assert.match(source, /clearedStatus: "Unknown"/);
});

test("clearance is mutable state, so it refreshes instead of conflicting", () => {
    // Hashing it would turn the ordinary uncleared-then-cleared transition into
    // a 409 restatement and stall the nightly pull on rows that never changed.
    const ledger = readFileSync(join(repoRoot, "src/lib/bank-ledger.ts"), "utf8");
    const hash = ledger.slice(ledger.indexOf("export function computeQboLineContentHash"));
    assert.doesNotMatch(hash.slice(0, 1500), /clearedStatus/, "clearance is not part of identity");

    const pull = readFileSync(join(repoRoot, "src/lib/bank-register-pull.ts"), "utf8");
    const content = pull.slice(pull.indexOf("function lineContent("));
    assert.doesNotMatch(content.slice(0, 400), /clearedStatus/, "nor of the in-request dedup key");

    const ingest = readFileSync(join(repoRoot, "src/app/api/integrations/bank-ledger/ingest/route.ts"), "utf8");
    assert.match(ingest, /refreshQboClearedStatus/, "an existing row is UPDATED, not refused");
    // "Unknown" never overwrites a stored answer: a failed probe would
    // otherwise wipe every clearance on the first bad night and nothing could
    // mint until QuickBooks was asked again.
    assert.match(ingest, /if \(line\.clearedStatus === "Unknown"\) continue;/);
    // The nullable column needs an explicit OR — a bare `not` leaves NULL rows
    // (the never-asked ones) unmatched in SQL.
    assert.match(ingest, /\{ clearedStatus: null \},\s*\n\s*\{ clearedStatus: \{ not: row\.clearedStatus \} \},/);
});

test("uncleared rows stay visible instead of disappearing", () => {
    // They are not chased and they are not canonical, so the only thing left
    // that could betray a wrong gate is a count nobody can see. This is it.
    assert.equal(BANK_PULL_UNCLEARED_KEY, "bankRegisterPullUnclearedCount");
    const pull = readFileSync(join(repoRoot, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    assert.match(pull, /BANK_PULL_UNCLEARED_KEY/);
    // Counted directly rather than read off the mint pass, which only runs when
    // BANK_LINE_MINT_FROM_QBO is on — the number is true either way.
    assert.match(pull, /bankLineObservation\.count\(/);
    const health = readFileSync(join(repoRoot, "src/lib/pipeline-health.ts"), "utf8");
    assert.match(health, /unclearedCount: bankPull\.value\.unclearedCount/);
    assert.match(health, /bankPull: snapshot\.bankPull/, "and it reaches the response, not just a log");
});

// ── 2. Reply routing survives an auto-close ─────────────────────────────────

/** A fake ReviewIssue store, enough for the history writer's read-CAS-write. */
function historyClient(rows: Record<string, { version: number; displayDetails: string; clearedAt: Date | null }>) {
    const writes: Array<{ id: string; where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const client = {
        reviewIssue: {
            findUnique: async ({ where }: { where: { id: string } }) => {
                const row = rows[where.id];
                return row ? { id: where.id, ...row } : null;
            },
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.filter(id => rows[id]).map(id => ({ id, ...rows[id] })),
            updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                const id = where.id as string;
                const row = rows[id];
                if (!row) return { count: 0 };
                if (where.version !== undefined && where.version !== row.version) return { count: 0 };
                if (where.clearedAt === null && row.clearedAt !== null) return { count: 0 };
                writes.push({ id, where, data });
                row.displayDetails = data.displayDetails as string;
                row.version += 1;
                return { count: 1 };
            },
        },
    } as unknown as CardHistoryClient;
    return { client, writes };
}

test("card history is recorded on an issue that cleared while the card was posting", () => {
    // THE RACE: the webhook confirms the post, the matcher clears the issue,
    // and then this write runs. It used to skip — leaving the item with no
    // thread record, so `hasRecordedMemoRequest` was false and the memo signed
    // in that thread came back 422 not-requested.
    const rows = {
        "answered": { version: 3, displayDetails: JSON.stringify({ resolution: "receipt-found", amountCents: 12_345 }), clearedAt: new Date() },
    };
    const { client, writes } = historyClient(rows);
    return recordCardOnIssues(
        { items: [{ issueId: "answered", n: 1, fingerprint: "pb-bl-1", cents: 12_345, amount: "123.45", date: "2026-08-16", vendor: "LOWES", cardTail: null, targetKey: "bl-1" }], date: "2026-08-20", requestId: "req-1" },
        "spaces/X/threads/t", "spaces/X/messages/m", NOW, client, "report",
    ).then(result => {
        assert.equal(result.recorded, 1, "the record is written");
        assert.equal(result.skipped, 0);
        assert.equal(result.lostRaces, 0);

        // THE RESOLUTION SURVIVES. That was the whole reason for the old skip,
        // and it is what the narrow write is for.
        const details = JSON.parse(rows.answered.displayDetails) as Record<string, unknown>;
        assert.equal(details.resolution, "receipt-found", "the answer is untouched");
        assert.equal(details.amountCents, 12_345);
        assert.equal((details.cards as unknown[]).length, 1, "and the thread record is there");

        // Nothing in the write can reopen or re-clear anything.
        assert.deepEqual(Object.keys(writes[0].where).sort(), ["id", "version"]);
        assert.deepEqual(Object.keys(writes[0].data).sort(), ["displayDetails", "version"]);
    });
});

test("a stale read still loses the CAS — the version is doing the work", () => {
    const rows = { "moved": { version: 9, displayDetails: "{}", clearedAt: null } };
    const { client } = historyClient(rows);
    // Bump the row out from under the read the writer is about to do.
    const findUnique = (client as unknown as { reviewIssue: { findUnique: unknown } }).reviewIssue.findUnique;
    (client as unknown as { reviewIssue: { findUnique: unknown } }).reviewIssue.findUnique = async (args: { where: { id: string } }) => {
        const row = await (findUnique as (a: unknown) => Promise<Record<string, unknown> | null>)(args);
        rows.moved.version = 10; // a concurrent writer commits between read and write
        return row;
    };
    return recordCardOnIssues(
        { items: [{ issueId: "moved", n: 1, fingerprint: "pb-bl-1", cents: 1, amount: "0.01", date: "2026-08-16", vendor: "X", cardTail: null, targetKey: "bl-2" }], date: "2026-08-20", requestId: "req-1" },
        "t", "m", NOW, client, "report",
    ).then(result => {
        assert.equal(result.recorded, 0);
        assert.equal(result.lostRaces, 1, "dropping clearedAt did not weaken the guard");
    });
});

test("the repair path can now repair a cleared item", () => {
    const rows = {
        "answered-no-record": { version: 1, displayDetails: "{}", clearedAt: new Date() },
        "answered-with-record": { version: 1, displayDetails: JSON.stringify({ cards: [{ requestId: "req-1", date: "2026-08-20", n: 1 }] }), clearedAt: new Date() },
        "open-no-record": { version: 1, displayDetails: "{}", clearedAt: null },
    };
    const { client } = historyClient(rows);
    return itemsMissingCardRecord(Object.keys(rows), "req-1", client).then(missing => {
        assert.deepEqual(missing, ["answered-no-record", "open-no-record"]);
    });
});

test("the thread export covers the whole retention window, cleared or not", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/automation/receipt-requests/threads/route.ts"), "utf8");
    // The issue join no longer filters on clearedAt — `itemsJson` is the
    // immutable record of what was posted, and "sign N" resolves against THAT.
    assert.doesNotMatch(source, /targetType: RECEIPT_REQUEST_TARGET_TYPE, clearedAt: null/);
    assert.match(source, /cleared: joined\.cleared/, "answered items ship marked, not dropped");
    // A cleared issue legitimately has NO reason codes — clearing is the
    // empty-codes lifecycle step — so the codes filter must not re-drop it.
    assert.match(source, /issue\.clearedAt !== null \|\| decodeReasonCodes\(issue\.reasonCodes\)\.length > 0/);
});

test("a valid memo on an already-answered chase is an idempotent 200", () => {
    const source = readFileSync(join(repoRoot, "src/app/api/automation/receipt-requests/answers/route.ts"), "utf8");
    // SUPERSEDED IN PART by the round-33 gate (finding 3). Round 32 let a
    // cleared issue with no card record through as the card-history race. That
    // race was real and is now fixed where it happened — recordCardOnIssues
    // writes on cleared issues too — so the exemption here only meant that any
    // already-closed charge accepted a memo nobody had asked for. What survives
    // is the idempotency it was protecting: a row that ALREADY carries a
    // resolution answers 200 with `alreadyResolved`, so the forwarder can retry
    // and get the same answer.
    assert.match(source, /const alreadyAnswered = hasResolution\(details\);/);
    assert.match(source, /alreadyResolved: alreadyAnswered,/);
    assert.match(source, /alreadyResolved: true/);
    assert.match(source, /reason: "not-requested"/, "the 422 still exists for the real case");
    assert.match(source, /reason: "wrong-thread"/, "and a memo from a thread this charge was never asked in is its own 422");
});

// ── 3. A chaser cycle is only complete over a fresh register ────────────────

test("the freshness window is the one the cron schedule implies", () => {
    assert.equal(BANK_PULL_CHASER_WINDOW_HOURS, 24);
    const crons = JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf8")) as {
        crons: Array<{ path: string; schedule: string }>;
    };
    const at = (path: string) => crons.crons.find(c => c.path === path)?.schedule;
    // The whole rule depends on these four staying in this order. A schedule
    // change that breaks the ordering should break this test, loudly.
    assert.equal(at("/api/cron/bank-register-pull"), "0 2 * * *");
    assert.equal(at("/api/cron/receipt-requests"), "0 13 * * *");
    assert.equal(at("/api/cron/receipt-request-cards"), "30 14 * * 1-5");
    // A CONTINUATION SLOT must exist between the sweep and the cards, or a
    // cycle held open for a stale pull could never finish before delivery.
    const resume = at("/api/cron/receipt-requests?continue=1");
    assert.ok(resume, "the ?continue=1 resume pass must be scheduled");
    assert.match(resume as string, /^\*\/15 /, "every 15 minutes, so it runs many times before 14:30");
});

test("bankPullFresh: a healthy pull is fresh at chaser time, last night's is not", () => {
    const chaserTime = new Date("2026-09-02T13:00:00Z");
    // Tonight's 02:00 pull — 11 hours old.
    assert.equal(bankPullFresh("2026-09-02T02:05:00Z", chaserTime), true);
    // Last night's, meaning tonight's failed — 35 hours old.
    assert.equal(bankPullFresh("2026-09-01T02:05:00Z", chaserTime), false);
    // Never succeeded, unreadable, and a clock from the future are all stale.
    assert.equal(bankPullFresh(null, chaserTime), false);
    assert.equal(bankPullFresh("", chaserTime), false);
    assert.equal(bankPullFresh("whenever", chaserTime), false);
    assert.equal(bankPullFresh("2026-09-03T00:00:00Z", chaserTime), false, "a future mark is not evidence");
    // The boundary itself is inclusive.
    assert.equal(bankPullFresh("2026-09-01T13:00:00Z", chaserTime), true, "exactly 24h");
    assert.equal(bankPullFresh("2026-09-01T12:59:59Z", chaserTime), false, "one second past");
});

test("a stale pull cannot stamp the cycle complete, and cannot close it either", () => {
    // STALE + otherwise finished: no stamp, so the cards cron keeps refusing —
    // and the phase is held at "lines" so the 15-minute resume keeps coming
    // back. Leaving it "done" would make shouldResumeSweep answer false and
    // lose the day to an outage that may already be over.
    const stale = sweepCompletionDecision({ computedPhase: "done", bankPullStale: true });
    assert.deepEqual(stale, { phase: "lines", complete: false, blockedReason: "bank-pull-stale" });

    // FRESH + finished: exactly what it always did.
    const fresh = sweepCompletionDecision({ computedPhase: "done", bankPullStale: false });
    assert.deepEqual(fresh, { phase: "done", complete: true, blockedReason: null });

    // A cycle that was unfinished anyway is unchanged — the pull check adds a
    // reason, it never overrides a phase that already says more work remains.
    for (const computedPhase of ["open-issues", "lines"] as const) {
        assert.deepEqual(
            sweepCompletionDecision({ computedPhase, bankPullStale: true }),
            { phase: computedPhase, complete: false, blockedReason: "bank-pull-stale" },
        );
        assert.deepEqual(
            sweepCompletionDecision({ computedPhase, bankPullStale: false }),
            { phase: computedPhase, complete: false, blockedReason: null },
        );
    }
});

test("the block is reported where a human will see it, not only in the summary", () => {
    const sweep = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    // In the response…
    assert.match(sweep, /\.\.\.\(bankPullStale \? \{ reason: BANK_PULL_STALE_REASON \} : \{\}\)/);
    assert.match(sweep, /bankPull: \{ fresh: bankPull\.fresh, lastSuccessAt: bankPull\.lastSuccessAt \}/);
    // …and on the marker the health check already reads, so it does not need a
    // probe of its own.
    const health = readFileSync(join(repoRoot, "src/lib/pipeline-health.ts"), "utf8");
    assert.match(health, /chaser-blocked:\$\{input\.chaser\.blockedReason\}/);
    // Distinct from chaser-stale on purpose: without it, a chaser refusing on
    // purpose looks merely slow for the two hours before chaser-stale fires —
    // and the 14:30 cards are gone by then.
    assert.match(health, /chaser-stale:\$\{hours\}/);
});

test("the sweep reads the pull marker the pull actually writes", () => {
    // Two spellings of one key is the same as not checking (the bank-line
    // identity lock learned this the hard way) — so both sides import it.
    const sweep = readFileSync(join(repoRoot, "src/app/api/cron/receipt-requests/route.ts"), "utf8");
    const pull = readFileSync(join(repoRoot, "src/app/api/cron/bank-register-pull/route.ts"), "utf8");
    assert.match(sweep, /BANK_PULL_LAST_SUCCESS_KEY[\s\S]*from "@\/lib\/pipeline-health"/);
    assert.match(pull, /BANK_PULL_LAST_SUCCESS_KEY[\s\S]*from "@\/lib\/pipeline-health"/);
    // And the pull still only stamps a COMPLETE, unambiguous success.
    assert.match(pull, /if \(summary\.ok && summary\.complete && summary\.clearedProbeOk && ambiguousCount === 0\) \{/);
    // A read failure is NOT fresh: "we could not check" is not evidence.
    assert.match(sweep, /return \{ fresh: false, lastSuccessAt: null \};/);
});

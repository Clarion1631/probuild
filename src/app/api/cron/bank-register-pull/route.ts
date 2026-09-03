import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { releaseLease, takeLease } from "@/lib/cron-lease";
import {
    BANK_PULL_LAST_SUCCESS_KEY,
    BANK_PULL_AMBIGUOUS_KEY,
    BANK_PULL_AMBIGUOUS_STALE_KEY,
    BANK_PULL_BLOCKED_REASON_KEY,
    BANK_PULL_UNCERTIFIED_KEY,
    BANK_PULL_UNCLEARED_KEY,
    uncertifiedWindowValue,
} from "@/lib/pipeline-health";
import { getFreshQBTokens } from "@/lib/quickbooks-payments";
import { fetchBankRegister } from "@/lib/qbo-bank-register";
import {
    BANK_REGISTER_ACCOUNT,
    type PullWindowState,
    BANK_REGISTER_PULL_DAYS,
    isYmd,
    REGISTER_WINDOW_DAYS,
    registerWindowStart,
    runBankRegisterPull,
    type BankRegisterIngestLine,
    type BankRegisterIngestResult,
} from "@/lib/bank-register-pull";
import { BANK_LINE_IDENTITY_LOCK, bankLineIdentityPayee, planQboMint } from "@/lib/bank-line-mint";
import { bankLedgerIngestHandlers } from "@/app/api/integrations/bank-ledger/ingest/route";
import { ambiguousGroupKey, bankLedgerReconcileHandlers } from "@/app/api/integrations/bank-ledger/reconcile/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Nightly QBO bank register pull (Phase 2 prerequisite / risk 1).
 *
 * Until this existed, `BankLine` only ever filled from a monthly statement
 * import and QBO register rows only arrived when a human ran
 * `scripts/post-qbo-register.mjs` from a laptop. The missing-receipt matcher's
 * whole input is bank truth, so a chase request could be weeks late. This runs
 * at 02:00 UTC — BEFORE `/api/cron/receipt-requests` (13:00 UTC) — so the
 * matcher always sees last night's register.
 *
 * It goes through the SAME ingest and reconcile code the script used
 * (`bankLedgerIngestHandlers.handleQboRegister` /
 * `bankLedgerReconcileHandlers.runReconcile`), not a copy: the identity rule,
 * the in-request duplicate check, the 409-on-restatement contract, and the
 * chunked savepoint writes are all one implementation. Re-running over an
 * overlapping window creates zero rows.
 *
 * OVERLAP SAFETY: `pg_try_advisory_xact_lock` in one short claim transaction
 * (pgbouncer forbids session-scoped advisory locks — see
 * review-alert-rollout.ts). A run that can't take the lock returns
 * `{skipped:"locked"}` rather than racing.
 */

const CLAIM_LOCK_KEY = "bank-register-pull";

/**
 * How long one pull owns the job. Comfortably longer than a maxDuration=60 run
 * plus its QBO round trips, short enough that a crashed run does not block
 * tomorrow night.
 */
const RUN_LEASE_MS = 20 * 60_000;

/**
 * Outer wall-clock budget across fetch + ingest + reconcile + mint.
 * `maxDuration` is 60s; stopping at 50 leaves room to persist the window state
 * and return a real answer instead of being killed with nothing recorded.
 */
const PULL_BUDGET_MS = 50_000;

/** Where the pull window's high-water mark and last deep sweep live. */
const WINDOW_STATE_KEY = "bankRegisterPullWindow";

async function readWindowState(): Promise<PullWindowState> {
    try {
        const row = await prisma.automationSetting.findUnique({ where: { key: WINDOW_STATE_KEY } });
        if (!row?.value) return { highWater: null, lastFullSweep: null, continueAfter: null, uncertifiedBounds: null };
        const parsed = JSON.parse(row.value) as Partial<PullWindowState>;
        const resume = parsed.continueAfter;
        const retry = parsed.retryPending;
        const uncertified = parsed.uncertifiedBounds;
        return {
            highWater: typeof parsed.highWater === "string" ? parsed.highWater : null,
            lastFullSweep: typeof parsed.lastFullSweep === "string" ? parsed.lastFullSweep : null,
            continueAfter: resume && typeof resume.postedDate === "string" && typeof resume.qbTxnId === "string"
                ? { postedDate: resume.postedDate, qbTxnId: resume.qbTxnId }
                : null,
            mintRemainingCursor: typeof parsed.mintRemainingCursor === "string" ? parsed.mintRemainingCursor : null,
            // VALIDATED FIELD BY FIELD, and dropped whole if any part is
            // unusable. A half-read marker would re-plan the pull over bounds
            // that are not a window, and an unreadable `attempts` would make the
            // retry unbounded — both worse than having no marker at all.
            retryPending: retry
                && isYmd(retry.startDate) && isYmd(retry.endDate)
                && typeof retry.reason === "string"
                && Number.isInteger(retry.attempts) && retry.attempts > 0
                ? { startDate: retry.startDate, endDate: retry.endDate, reason: retry.reason, attempts: retry.attempts }
                : null,
            // SAME ALL-OR-NOTHING RULE as the retry marker, and for a sharper
            // reason: this one WITHHOLDS the freshness stamp and widens every
            // future window. A half-read pair of bounds would either hold the
            // stamp down forever over dates that are not a window, or — worse —
            // read as "nothing outstanding" and certify days nobody pulled.
            uncertifiedBounds: uncertified
                && isYmd(uncertified.startDate) && isYmd(uncertified.endDate)
                && uncertified.startDate <= uncertified.endDate
                ? { startDate: uncertified.startDate, endDate: uncertified.endDate }
                : null,
            uncertifiedSince: typeof parsed.uncertifiedSince === "string" ? parsed.uncertifiedSince : null,
        };
    } catch {
        // A corrupt or unreadable state is "we know nothing", which plans the
        // widest safe window — never a narrow one built on a bad mark.
        return { highWater: null, lastFullSweep: null, continueAfter: null, uncertifiedBounds: null };
    }
}

async function saveWindowState(next: PullWindowState): Promise<void> {
    const value = JSON.stringify(next);
    await prisma.automationSetting.upsert({
        where: { key: WINDOW_STATE_KEY },
        update: { value },
        create: { key: WINDOW_STATE_KEY, value },
    });
}

/**
 * Is there parked work a continuation pass should pick up?
 *
 * `continueAfter` is the intra-window resume point a budget-truncated ingest
 * writes; `mintRemainingCursor` is where a truncated mint stopped;
 * `retryPending` is a window that ingested cleanly but could not be CERTIFIED —
 * today, one whose clearance probe failed. Any one of them means the last run
 * left the register in a state it already reported as incomplete, so a
 * continuation has real work. All null means the last run finished, and a resume
 * pass must cost nothing.
 *
 * The third was the gap (Codex PR #443 gate round 34, finding 2): a failed probe
 * is not a TRUNCATION, so it wrote neither of the first two — the window was
 * cleared as finished and every 15-minute resume slot answered
 * `nothing-in-progress` while the register stayed uncertified until the next
 * night, long after the 13:00 chaser had given up on it.
 */
export function pullContinuationPending(state: PullWindowState): boolean {
    return (state.continueAfter ?? null) !== null
        || (state.mintRemainingCursor ?? null) !== null
        || (state.retryPending ?? null) !== null;
}

export async function GET(request: Request) {
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    /**
     * THE CONTINUATION PASS (Codex PR #443 gate round 33, finding 4).
     *
     * The pull is resumable — a run that hits its wall clock parks
     * `continueAfter` and reports `complete: false` — but it was invoked exactly
     * once a night, at 02:00. So a truncated pull sat parked for eleven hours
     * and the 13:00 chaser found a register that had never been certified
     * current, held its cycle open, and the 14:30 cards did not go out. The
     * backlog needed another invocation and nothing was scheduled to give it
     * one.
     *
     * Checked BEFORE the lease, exactly as the chaser's own `?continue=1` does:
     * a resume pass with nothing to do must not even briefly contend with the
     * nightly run for the lease.
     */
    if (new URL(request.url).searchParams.get("continue") === "1") {
        const parked = await readWindowState();
        if (!pullContinuationPending(parked)) {
            return NextResponse.json({ ok: true, skipped: "nothing-in-progress" });
        }
    }

    // A DURABLE lease, held for the WHOLE pull including the token refresh.
    // The advisory claim it replaces committed — and so released — before the
    // first QBO call, so two invocations could both fetch, both ingest and both
    // mint against the same gap.
    const now = new Date();
    const token = randomUUID();
    if (!(await takeLease(CLAIM_LOCK_KEY, RUN_LEASE_MS, now, token))) {
        return NextResponse.json({ ok: true, skipped: "already-running" });
    }
    try {
        return await runPull();
    } finally {
        await releaseLease(CLAIM_LOCK_KEY, token);
    }
}

/**
 * How far back a mint pass looks for still-unlinked QBO observations: THE SAME
 * 60-calendar-day boundary as the deep sweep and the missing-receipt chaser.
 *
 * It was 45, and shorter is the dangerous direction: the chaser opens a chase
 * for a 50-day-old charge, minting cannot see the observation that would give
 * it a canonical line, and that chase can never close by itself.
 */
const MINT_LOOKBACK_DAYS = REGISTER_WINDOW_DAYS;

/** Rows per mint transaction. Small enough to commit well inside the timeout. */
const MINT_BATCH_SIZE = 200;
/** Explicit, because Prisma's interactive-transaction default is 5s. */
const MINT_TX_TIMEOUT_MS = 20_000;
/** Bounds one invocation; the nightly cron picks up whatever is left. */
const MINT_MAX_BATCHES = 10;

/**
 * Mint canonical BankLines from QBO observations that reconcile could not link
 * (Justin, decision 3). Gated by `BANK_LINE_MINT_FROM_QBO` at the call site.
 *
 * The planning is pure (`planQboMint`); this is the I/O around it. Each mint is
 * ONE transaction that creates the line and links the observation to it, so a
 * crash can never leave a canonical line nobody points at, or an observation
 * pointing at a line that was rolled back. The link is guarded on
 * `bankLineId: null`, so a concurrent reconcile that just claimed the same
 * observation wins and this mint rolls back rather than forking the identity.
 */
async function mintFromQbo(
    account: string,
    deadlineAt?: number,
): Promise<{ minted: number; skipped: Record<string, number>; complete: boolean; remainingCursor: string | null }> {
    // The START of the oldest allowed day, not an instant 60 days ago:
    // `postedDate` is a `@db.Date` at UTC midnight, so an instant boundary
    // silently drops the whole of its own oldest day and moves every run.
    const since = registerWindowStart(new Date(), MINT_LOOKBACK_DAYS);
    let minted = 0;
    let remainingCursor: string | null = null;
    const skipped: Record<string, number> = {};

    // BOUNDED BATCHES, each its own transaction. One transaction for the whole
    // run held the identity lock for as long as the mint took and kept an
    // interactive transaction open across hundreds of writes — on a pgbouncer
    // pool that is exactly the shape that hits Prisma's default 5s timeout and
    // rolls the entire night back. Now each batch takes the lock, plans inside
    // it, writes at most MINT_BATCH_SIZE rows, and commits; the next batch
    // re-reads the world, so nothing is planned against stale state.
    for (let batch = 0; batch < MINT_MAX_BATCHES; batch++) {
        // THE RUN'S ABSOLUTE DEADLINE, CHECKED PER BATCH. Minting creates
        // permanent rows; being killed by the platform half way through leaves
        // the pull with no checkpoint written, so it re-fetches the same window
        // and mints against a picture it has already half-acted on. The
        // deadline handed in already holds back CHECKPOINT_RESERVE_MS.
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
            skipped["deadline"] = (skipped["deadline"] ?? 0) + 1;
            // TRUNCATED, and it says so. See the return below.
            return { minted, skipped, complete: false, remainingCursor: "deadline" };
        }
        const result = await prisma.$transaction(async tx => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BANK_LINE_IDENTITY_LOCK}))`;

            const [observations, existingLines] = await Promise.all([
                tx.bankLineObservation.findMany({
                    where: { source: "QBO_REGISTER", account, postedDate: { gte: since } },
                    select: { id: true, account: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, clearedStatus: true, bankLineId: true },
                }),
                tx.bankLine.findMany({
                    where: { account, postedDate: { gte: since } },
                    select: { id: true, account: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, sourceOfRecord: true, qbTxnId: true },
                }),
            ]);

            const plan = planQboMint(
                observations.map(row => ({
                    id: row.id,
                    account: row.account,
                    postedDate: row.postedDate.toISOString().slice(0, 10),
                    amountCents: row.amountCents,
                    rawDescriptor: row.rawDescriptor,
                    normalizedPayee: bankLineIdentityPayee({ memo: row.rawDescriptor }),
                    checkNumber: row.checkNumber,
                    clearedStatus: row.clearedStatus,
                    bankLineId: row.bankLineId,
                })),
                existingLines.map(row => ({
                    id: row.id,
                    qbTxnId: row.qbTxnId,
                    account: row.account,
                    postedDate: row.postedDate.toISOString().slice(0, 10),
                    amountCents: row.amountCents,
                    normalizedPayee: bankLineIdentityPayee({ memo: row.rawDescriptor }),
                    checkNumber: row.checkNumber,
                    sourceOfRecord: row.sourceOfRecord,
                })),
                new Date(),
            );

            const slice = plan.mint.slice(0, MINT_BATCH_SIZE);
            let mintedHere = 0;
            for (const observation of slice) {
                const line = await tx.bankLine.create({
                    data: {
                        account: observation.account,
                        postedDate: new Date(`${observation.postedDate}T00:00:00Z`),
                        amountCents: observation.amountCents,
                        rawDescriptor: observation.rawDescriptor,
                        normalizedPayee: observation.normalizedPayee,
                        checkNumber: observation.checkNumber,
                        state: "POSTED",
                        sourceOfRecord: "QBO",
                    },
                });
                // Guarded even under the lock: reconcile does not take this lock
                // (it only links, never mints), so it can still claim the
                // observation. Losing that race must roll the new line back with
                // it rather than leave an orphan.
                const linked = await tx.bankLineObservation.updateMany({
                    where: { id: observation.id, bankLineId: null },
                    data: { bankLineId: line.id },
                });
                if (linked.count === 0) throw new ObservationClaimedError();
                mintedHere++;
            }
            return {
                mintedHere,
                skipped: plan.skipped,
                more: plan.mint.length > slice.length,
                // The oldest observation still waiting, so a truncated run can
                // say WHERE it stopped rather than merely that it did.
                nextId: plan.mint[slice.length]?.id ?? null,
            };
        }, { timeout: MINT_TX_TIMEOUT_MS });

        minted += result.mintedHere;
        for (const [key, value] of Object.entries(result.skipped)) skipped[key] = value;
        if (!result.more) return { minted, skipped, complete: true, remainingCursor: null };
        remainingCursor = result.nextId;
    }

    /**
     * THE BATCH CAP BIT, and it is not a detail.
     *
     * Falling out of this loop means there is more to mint and this invocation
     * chose to stop. Reporting that as a finished mint let the caller stamp the
     * freshness clock, which tells the health check the register is current
     * while a backlog of unminted observations sits behind it — and every
     * following run re-derives the same first ten batches, so the backlog never
     * drains and nothing ever says so.
     */
    return { minted, skipped, complete: false, remainingCursor };
}

class ObservationClaimedError extends Error {}

async function runPull() {
    const startedAt = Date.now();
    const windowState = await readWindowState();
    const summary = await runBankRegisterPull({
        account: BANK_REGISTER_ACCOUNT,
        days: BANK_REGISTER_PULL_DAYS,
        windowState,
        saveWindowState,
        budgetMs: PULL_BUDGET_MS,
        elapsedMs: () => Date.now() - startedAt,

        fetchRows: async (startDate, endDate) => {
            // Tokens are fetched lazily INSIDE fetchBankRegister (only on a
            // cache miss), and the call rides qbFetch's timeout budget.
            const register = await fetchBankRegister(getFreshQBTokens, startDate, endDate);
            // `clearedProbeOk` travels WITH the rows. It used to be dropped
            // here, so a register fetched without any clearance answer was
            // indistinguishable from a fully-answered one and the run stamped
            // the freshness clock over it (Codex PR #443 gate round 33,
            // finding 1).
            return { rows: register.rows, stale: register.stale, clearedProbeOk: register.clearedProbeOk };
        },

        ingest: async (account: string, lines: BankRegisterIngestLine[]) => {
            const response = await bankLedgerIngestHandlers.handleQboRegister(account, lines);
            let body: BankRegisterIngestResult["body"] = null;
            try { body = (await response.json()) as BankRegisterIngestResult["body"]; } catch { /* non-JSON error body */ }
            return { status: response.status, body };
        },

        reconcile: async (account: string, deadlineAt?: number, scope?: { since: string; window: { startDate: string; endDate: string } }) => {
            // The run's absolute deadline goes THROUGH to the linker's own
            // batch loop: links it cannot start come back in `remaining`
            // instead of the platform killing this run mid-chunk. The scope
            // goes through for the same reason — one implementation, told what
            // it may read and which part of it this run answers for.
            const result = await bankLedgerReconcileHandlers.runReconcile(account, deadlineAt, scope);
            return {
                linked: result.linked,
                proposed: result.proposed,
                // Surfaced, not swallowed: a rolled-back chunk and un-attempted
                // links both leave observations unlinked.
                chunkErrors: result.chunkErrors.length,
                remaining: result.remaining,
                // Surfaced, not discarded (Codex round-31 gate, finding 2): a
                // group reconcile could not resolve is a human call, not
                // something it can guess at. This used to be dropped here, so
                // those groups never showed up anywhere the pull reported.
                ambiguous: result.ambiguous,
                ambiguousStale: result.ambiguousStale,
                pairedByOrder: result.pairedByOrder,
            };
        },

        // Justin, decision 3: the QBO bank feed is bank truth. OFF by default —
        // the dependency is simply absent unless the flag is on, so there is no
        // "enabled" branch inside the pull to get wrong.
        ...(process.env.BANK_LINE_MINT_FROM_QBO === "true" ? { mintFromQbo } : {}),
    });

    // HOW MANY OBSERVATIONS QUICKBOOKS HAS NOT CLEARED.
    //
    // Counted directly, not read off the mint pass, because the mint pass only
    // runs when BANK_LINE_MINT_FROM_QBO is on and this number is true either
    // way. These rows are the honest residue of the clearance gate: real
    // QuickBooks postings that stay observations — visible on the Bank page,
    // absent from the canonical ledger, and therefore never chased — until
    // QuickBooks says they cleared. A read failure leaves the previous count
    // alone rather than writing a reassuring zero.
    try {
        const uncleared = await prisma.bankLineObservation.count({
            where: {
                source: "QBO_REGISTER",
                account: BANK_REGISTER_ACCOUNT,
                postedDate: { gte: registerWindowStart(new Date(), MINT_LOOKBACK_DAYS) },
                bankLineId: null,
                OR: [
                    { clearedStatus: null },
                    { clearedStatus: { notIn: ["Reconciled", "Cleared"] } },
                ],
            },
        });
        await prisma.automationSetting.upsert({
            where: { key: BANK_PULL_UNCLEARED_KEY },
            update: { value: String(uncleared) },
            create: { key: BANK_PULL_UNCLEARED_KEY, value: String(uncleared) },
        });
    } catch (error) {
        console.error("[cron/bank-register-pull] uncleared-count write failed", error instanceof Error ? error.message : "UnknownError");
    }

    // Same-identity groups reconcile refused to guess a pairing for — a human
    // call, never auto-resolved. `summary.reconciled` is only absent when
    // reconcile itself never completed (it threw, see runBankRegisterPull),
    // in which case there is nothing new to report and the LAST recorded
    // count must stand rather than reading as "resolved".
    const ambiguousCount = summary.reconciled?.ambiguous?.length ?? 0;
    const staleAmbiguous = summary.reconciled?.ambiguousStale ?? [];
    const pairedByOrder = summary.reconciled?.pairedByOrder ?? [];
    if (ambiguousCount > 0) {
        console.warn("[cron/bank-register-pull] ambiguous reconcile groups need a human", ambiguousCount);
    }
    if (pairedByOrder.length > 0) {
        // An INFERENCE, logged as one. Equal-cardinality groups are paired by
        // sorted order rather than left to block the world (see
        // reconcileObservations); that decision has to be findable afterwards.
        console.log("[cron/bank-register-pull] groups paired by order", JSON.stringify(pairedByOrder.map(ambiguousGroupKey)));
    }
    if (summary.reconciled) {
        try {
            await prisma.automationSetting.upsert({
                where: { key: BANK_PULL_AMBIGUOUS_KEY },
                update: { value: String(ambiguousCount) },
                create: { key: BANK_PULL_AMBIGUOUS_KEY, value: String(ambiguousCount) },
            });
        } catch (error) {
            console.error("[cron/bank-register-pull] ambiguous-count write failed", error instanceof Error ? error.message : "UnknownError");
        }
        // RESIDUAL AMBIGUITY FROM BEFORE THIS WINDOW is recorded separately and
        // never gates the stamp (Codex round-33 gate, finding 2). It is real and
        // somebody has to resolve it, but a duplicate pair from two months ago
        // is not evidence that TONIGHT'S register is unsettled — and treating it
        // as such switched every owner's chase cards off indefinitely. The keys
        // ride along so the health reason says WHICH groups, not just how many.
        try {
            const value = JSON.stringify({ count: staleAmbiguous.length, keys: staleAmbiguous.map(ambiguousGroupKey) });
            await prisma.automationSetting.upsert({
                where: { key: BANK_PULL_AMBIGUOUS_STALE_KEY },
                update: { value },
                create: { key: BANK_PULL_AMBIGUOUS_STALE_KEY, value },
            });
        } catch (error) {
            console.error("[cron/bank-register-pull] stale-ambiguous write failed", error instanceof Error ? error.message : "UnknownError");
        }
    }

    // WHY THE STAMP IS BEING WITHHELD, when it is and the cause is not a
    // failure. `bank-pull-stale` eventually fires on its own, 36 hours later —
    // this says which of the silent causes it was, immediately, the same way
    // `chaser-blocked:<reason>` does for the sweep. Written on EVERY run so a
    // recovered probe clears the alarm rather than leaving it latched.
    try {
        // EXHAUSTION IS ITS OWN REASON. `cleared-probe-failed` says a retry is
        // scheduled; `probe-retries-exhausted` says the retries are over and
        // nobody is coming back for this window — a human has to look at the
        // QuickBooks report endpoint. Reading them as the same string would hide
        // the moment the system stopped trying.
        const value = summary.clearedProbeOk === false
            ? (summary.reason === "probe-retries-exhausted" ? "probe-retries-exhausted" : "cleared-probe-failed")
            : "";
        await prisma.automationSetting.upsert({
            where: { key: BANK_PULL_BLOCKED_REASON_KEY },
            update: { value },
            create: { key: BANK_PULL_BLOCKED_REASON_KEY, value },
        });
    } catch (error) {
        console.error("[cron/bank-register-pull] blocked-reason write failed", error instanceof Error ? error.message : "UnknownError");
    }

    // WHICH DAYS ARE STILL UNCERTIFIED, if any (round-35 gate, finding 1).
    // Written on EVERY run, empty when the span is clear, so the health reason
    // appears the night the probe fails and disappears the run it is re-read —
    // never latched, and never inferred from a stamp that simply stopped moving.
    try {
        const value = uncertifiedWindowValue(summary.uncertified ?? null);
        await prisma.automationSetting.upsert({
            where: { key: BANK_PULL_UNCERTIFIED_KEY },
            update: { value },
            create: { key: BANK_PULL_UNCERTIFIED_KEY, value },
        });
    } catch (error) {
        console.error("[cron/bank-register-pull] uncertified-window write failed", error instanceof Error ? error.message : "UnknownError");
    }

    if (!summary.ok) {
        console.error("[cron/bank-register-pull]", JSON.stringify(summary));
    } else if (summary.inserted > 0 || summary.observations > 0) {
        console.log("[cron/bank-register-pull]", JSON.stringify(summary));
    }
    // ANY failure is a 500, not just a conflict. A QuickBooks restatement, a
    // failed ingest batch, a failed reconcile or a failed mint all leave the
    // matcher working from incomplete truth — and a 200 meant the platform
    // never surfaced it, so nobody looked. Whatever committed stays committed
    // and re-running is a no-op for it.
    // Record the last COMPLETE SUCCESS, not the last run: pipeline-health reads
    // this to decide whether the chaser is being fed, and a failed run that
    // stamped the clock would keep the health check green while the pull was
    // dead. A budget-truncated run is not a failure, but it is not proof the
    // register is current either — it read part of one window — so it does not
    // stamp the clock. If truncation persists, the mark goes stale and
    // `bank-pull-stale` fires, which is exactly the signal wanted.
    // UNRESOLVED AMBIGUITY is the same shape of lie: reconcile left a
    // same-identity group unmatched on purpose, and stamping the clock over it
    // told the health check the register was fully current while a manual
    // decision sat waiting. `bank-pull-ambiguous` is what surfaces that
    // instead (see evaluatePipelineHealth) — and only for ambiguity inside THIS
    // run's window, because older residue is a backlog somebody owes an answer
    // on, not a reason to hold back today's cards (round-33 gate, finding 2).
    // A FAILED CLEARANCE PROBE is the third shape of the same lie, and the one
    // this line used to be blind to: the register came back, the rows ingested,
    // and nothing clearance-gated could run over any of them — every row reads
    // "Unknown", so minting can do nothing and the uncleared count means
    // nothing. `clearedProbeOk` is already folded into `complete`; it is named
    // here too because THIS is the line the invariant is about, and a future
    // change to `complete` must not quietly reopen it (round-33 gate, finding 1).
    // AND NO OUTSTANDING UNCERTIFIED DAYS. `complete` and `clearedProbeOk` are
    // both statements about THIS run's window; neither one can see the week
    // behind it whose clearance probe failed and whose retries were exhausted.
    // That was the fourth shape of the lie: a narrow, healthy, complete overlap
    // window stamped the clock over observations that had never been certified
    // and were never offered to the mint (round-35 gate, finding 1).
    if (summary.ok && summary.complete && summary.clearedProbeOk && ambiguousCount === 0
        && !summary.uncertified) {
        try {
            await prisma.automationSetting.upsert({
                where: { key: BANK_PULL_LAST_SUCCESS_KEY },
                update: { value: new Date().toISOString() },
                create: { key: BANK_PULL_LAST_SUCCESS_KEY, value: new Date().toISOString() },
            });
        } catch (error) {
            console.error("[cron/bank-register-pull] last-success write failed", error instanceof Error ? error.message : "UnknownError");
        }
    }

    const status = summary.ok ? 200 : 500;
    return NextResponse.json(summary, { status });
}

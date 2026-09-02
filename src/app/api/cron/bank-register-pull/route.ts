import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { releaseLease, takeLease } from "@/lib/cron-lease";
import { BANK_PULL_LAST_SUCCESS_KEY } from "@/lib/pipeline-health";
import { getFreshQBTokens } from "@/lib/quickbooks-payments";
import { fetchBankRegister } from "@/lib/qbo-bank-register";
import {
    BANK_REGISTER_ACCOUNT,
    type PullWindowState,
    BANK_REGISTER_PULL_DAYS,
    runBankRegisterPull,
    type BankRegisterIngestLine,
    type BankRegisterIngestResult,
} from "@/lib/bank-register-pull";
import { BANK_LINE_IDENTITY_LOCK, bankLineIdentityPayee, planQboMint } from "@/lib/bank-line-mint";
import { bankLedgerIngestHandlers } from "@/app/api/integrations/bank-ledger/ingest/route";
import { bankLedgerReconcileHandlers } from "@/app/api/integrations/bank-ledger/reconcile/route";

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
        if (!row?.value) return { highWater: null, lastFullSweep: null, continueAfter: null };
        const parsed = JSON.parse(row.value) as Partial<PullWindowState>;
        const resume = parsed.continueAfter;
        return {
            highWater: typeof parsed.highWater === "string" ? parsed.highWater : null,
            lastFullSweep: typeof parsed.lastFullSweep === "string" ? parsed.lastFullSweep : null,
            continueAfter: resume && typeof resume.postedDate === "string" && typeof resume.qbTxnId === "string"
                ? { postedDate: resume.postedDate, qbTxnId: resume.qbTxnId }
                : null,
        };
    } catch {
        // A corrupt or unreadable state is "we know nothing", which plans the
        // widest safe window — never a narrow one built on a bad mark.
        return { highWater: null, lastFullSweep: null, continueAfter: null };
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

export async function GET(request: Request) {
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

/** How far back a mint pass looks for still-unlinked QBO observations. */
const MINT_LOOKBACK_DAYS = 45;

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
async function mintFromQbo(account: string): Promise<{ minted: number; skipped: Record<string, number> }> {
    const since = new Date(Date.now() - MINT_LOOKBACK_DAYS * 86_400_000);
    let minted = 0;
    const skipped: Record<string, number> = {};

    // BOUNDED BATCHES, each its own transaction. One transaction for the whole
    // run held the identity lock for as long as the mint took and kept an
    // interactive transaction open across hundreds of writes — on a pgbouncer
    // pool that is exactly the shape that hits Prisma's default 5s timeout and
    // rolls the entire night back. Now each batch takes the lock, plans inside
    // it, writes at most MINT_BATCH_SIZE rows, and commits; the next batch
    // re-reads the world, so nothing is planned against stale state.
    for (let batch = 0; batch < MINT_MAX_BATCHES; batch++) {
        const result = await prisma.$transaction(async tx => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BANK_LINE_IDENTITY_LOCK}))`;

            const [observations, existingLines] = await Promise.all([
                tx.bankLineObservation.findMany({
                    where: { source: "QBO_REGISTER", account, postedDate: { gte: since } },
                    select: { id: true, account: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, bankLineId: true },
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
            return { mintedHere, skipped: plan.skipped, more: plan.mint.length > slice.length };
        }, { timeout: MINT_TX_TIMEOUT_MS });

        minted += result.mintedHere;
        for (const [key, value] of Object.entries(result.skipped)) skipped[key] = value;
        if (!result.more) break;
    }

    return { minted, skipped };
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
            return { rows: register.rows, stale: register.stale };
        },

        ingest: async (account: string, lines: BankRegisterIngestLine[]) => {
            const response = await bankLedgerIngestHandlers.handleQboRegister(account, lines);
            let body: BankRegisterIngestResult["body"] = null;
            try { body = (await response.json()) as BankRegisterIngestResult["body"]; } catch { /* non-JSON error body */ }
            return { status: response.status, body };
        },

        reconcile: async (account: string) => {
            const result = await bankLedgerReconcileHandlers.runReconcile(account);
            return {
                linked: result.linked,
                proposed: result.proposed,
                // Surfaced, not swallowed: a rolled-back chunk and un-attempted
                // links both leave observations unlinked.
                chunkErrors: result.chunkErrors.length,
                remaining: result.remaining,
            };
        },

        // Justin, decision 3: the QBO bank feed is bank truth. OFF by default —
        // the dependency is simply absent unless the flag is on, so there is no
        // "enabled" branch inside the pull to get wrong.
        ...(process.env.BANK_LINE_MINT_FROM_QBO === "true" ? { mintFromQbo } : {}),
    });

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
    // Record the last SUCCESS, not the last run: pipeline-health reads this to
    // decide whether the chaser is being fed, and a failed run that stamped the
    // clock would keep the health check green while the pull was dead.
    if (summary.ok) {
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

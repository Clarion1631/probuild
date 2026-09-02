import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isCronAuthorized } from "@/lib/cron-auth";
import { getFreshQBTokens } from "@/lib/quickbooks-payments";
import { fetchBankRegister } from "@/lib/qbo-bank-register";
import {
    BANK_REGISTER_ACCOUNT,
    BANK_REGISTER_PULL_DAYS,
    runBankRegisterPull,
    type BankRegisterIngestLine,
    type BankRegisterIngestResult,
} from "@/lib/bank-register-pull";
import { normalizePayee } from "@/lib/bank-ledger";
import { planQboMint } from "@/lib/bank-line-mint";
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

/** How far back a mint pass looks for still-unlinked QBO observations. */
const MINT_LOOKBACK_DAYS = 45;

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

    const [observations, existingLines] = await Promise.all([
        prisma.bankLineObservation.findMany({
            where: { source: "QBO_REGISTER", account, bankLineId: null, postedDate: { gte: since } },
            select: { id: true, account: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, bankLineId: true },
        }),
        prisma.bankLine.findMany({
            where: { account, postedDate: { gte: since } },
            select: { id: true, account: true, postedDate: true, amountCents: true, normalizedPayee: true, checkNumber: true, sourceOfRecord: true },
        }),
    ]);

    const plan = planQboMint(
        observations.map(row => ({
            id: row.id,
            account: row.account,
            postedDate: row.postedDate.toISOString().slice(0, 10),
            amountCents: row.amountCents,
            rawDescriptor: row.rawDescriptor,
            normalizedPayee: normalizePayee(row.rawDescriptor),
            checkNumber: row.checkNumber,
            bankLineId: row.bankLineId,
        })),
        existingLines.map(row => ({
            id: row.id,
            account: row.account,
            postedDate: row.postedDate.toISOString().slice(0, 10),
            amountCents: row.amountCents,
            normalizedPayee: row.normalizedPayee,
            checkNumber: row.checkNumber,
            sourceOfRecord: row.sourceOfRecord,
        })),
        new Date(),
    );

    let minted = 0;
    for (const observation of plan.mint) {
        try {
            await prisma.$transaction(async tx => {
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
                // Guarded: a reconcile run that claimed this observation between
                // the read above and here must win. Throwing rolls the new line
                // back with it — no orphan.
                const linked = await tx.bankLineObservation.updateMany({
                    where: { id: observation.id, bankLineId: null },
                    data: { bankLineId: line.id },
                });
                if (linked.count === 0) throw new ObservationClaimedError();
            });
            minted++;
        } catch (error) {
            if (error instanceof ObservationClaimedError) continue;
            throw error;
        }
    }

    return { minted, skipped: { ...plan.skipped } };
}

class ObservationClaimedError extends Error {}

async function claim(): Promise<boolean> {
    return prisma.$transaction(async tx => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${CLAIM_LOCK_KEY}, 0)) AS locked`,
        );
        return lock?.locked === true;
    });
}

export async function GET(request: Request) {
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!(await claim())) {
        return NextResponse.json({ ok: true, skipped: "locked" });
    }

    const summary = await runBankRegisterPull({
        account: BANK_REGISTER_ACCOUNT,
        days: BANK_REGISTER_PULL_DAYS,

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
            return { linked: result.linked, proposed: result.proposed };
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
    // A conflict is a QuickBooks RESTATEMENT of a transaction already recorded,
    // and no code here may resolve it. 500 so the platform surfaces the run as
    // failed and a human looks; the ids are in the body. Whatever committed
    // before the conflict stays committed and re-running is a no-op for it.
    const status = summary.conflictQbTxnIds?.length ? 500 : 200;
    return NextResponse.json(summary, { status });
}

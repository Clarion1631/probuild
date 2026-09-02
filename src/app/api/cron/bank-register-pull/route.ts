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
    });

    if (!summary.ok) {
        console.error("[cron/bank-register-pull]", JSON.stringify(summary));
    } else if (summary.inserted > 0 || summary.observations > 0) {
        console.log("[cron/bank-register-pull]", JSON.stringify(summary));
    }
    return NextResponse.json(summary);
}

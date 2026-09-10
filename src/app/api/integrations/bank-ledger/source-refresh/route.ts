import { hasCronSecret } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { createRouteDeadline, qbFetch } from "@/lib/quickbooks";
import { getFreshQBTokens } from "@/lib/quickbooks-payments";
import { fetchBankRegister } from "@/lib/qbo-bank-register";
import { createPurchaseReader, rollingWindow } from "@/app/api/integrations/bank-ledger/conflict-diagnostic/route";
import { createBankSourceRefreshHandlers, createRefreshApplier, readRefreshEvidence } from "@/lib/bank-source-refresh";

/**
 * POST /api/integrations/bank-ledger/source-refresh
 *
 * Body: { "mode": "dry-run" | "apply", "items": [{ "qbTxnId": "6456", "expectedDigest": "<from dry-run>" }] }
 * (1..3 distinct ids; digest required in apply mode; no other fields, no query
 * overrides, no force). Strict cron bearer, 8KB body cap, no-store responses.
 * Stale Expense evidence stays held until the ordinary importer reflects the
 * same QBO version; this route never invokes that importer.
 * See src/lib/bank-source-refresh.ts for the policy. Never writes to QBO,
 * never stamps freshness, never runs a job or sends anything.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const handlers = createBankSourceRefreshHandlers({
    authorize: hasCronSecret,
    readRegister: () => {
        const { startDate, endDate } = rollingWindow();
        return fetchBankRegister(getFreshQBTokens, startDate, endDate, { fresh: true });
    },
    readPurchase: qbTxnId => createPurchaseReader({ fetch: qbFetch, tokens: getFreshQBTokens, deadline: createRouteDeadline })(qbTxnId),
    readEvidence: qbTxnId => readRefreshEvidence(prisma, qbTxnId),
    apply: createRefreshApplier(prisma),
});

export async function POST(request: Request) {
    return handlers.POST(request);
}

import { hasCronSecret } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getFreshQBTokens } from "@/lib/quickbooks-payments";
import { fetchBankRegister } from "@/lib/qbo-bank-register";
import { rollingWindow } from "@/app/api/integrations/bank-ledger/conflict-diagnostic/route";
import {
    createConflictInventoryHandlers,
    createStoredInventoryReader,
    type StoredInventoryClient,
} from "@/lib/bank-register-conflict-inventory";

/**
 * GET /api/integrations/bank-ledger/conflict-inventory
 *
 * Strict cron bearer, no query parameters, no writes, no QBO entity reads.
 * Fresh GL fetch over the rolling 60-day window, bounded stored read, pure
 * comparison. See `@/lib/bank-register-conflict-inventory` for the contract.
 * Every response is `Cache-Control: no-store`.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handlers = createConflictInventoryHandlers({
    authorize: hasCronSecret,
    window: rollingWindow,
    readRegister: ({ startDate, endDate }) => fetchBankRegister(getFreshQBTokens, startDate, endDate, { fresh: true }),
    // Built lazily so the Prisma proxy is touched only by an authorized request.
    readStored: (window, ids) => createStoredInventoryReader(prisma as unknown as StoredInventoryClient)(window, ids),
});

export const GET = handlers.GET;

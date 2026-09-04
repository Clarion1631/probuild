import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { validTimeZone, DEFAULT_COMPANY_TIME_ZONE } from "./tz-date";

// Pure date/time-zone primitives live in tz-date.ts (no prisma import, so
// they stay importable from anything that must be unit-testable without a
// database or browser-safe). This module adds the one thing that genuinely
// needs prisma — resolving the company's configured time zone — and
// re-exports the primitives so existing callers of dateOnlyInTimeZone /
// startOfDateInTimeZone / endOfDateInTimeZone / dateInputInTimeZone don't
// need to change their import path.
export {
    DEFAULT_COMPANY_TIME_ZONE,
    dateOnlyInTimeZone,
    startOfDateInTimeZone,
    endOfDateInTimeZone,
    dateInputInTimeZone,
} from "./tz-date";

/**
 * Either the base client or a transaction client. The payroll lock resolves the
 * zone INSIDE its own transaction, while it holds FOR SHARE on the
 * CompanySettings row — a read on the global client would be a second
 * connection, outside that transaction, free to see a zone the lock is
 * specifically holding still.
 */
export type CompanyTimeZoneClient = typeof prisma | Prisma.TransactionClient;

export async function resolveCompanyTimeZone(client: CompanyTimeZoneClient = prisma): Promise<string> {
    const settings = await client.companySettings.findUnique({
        where: { id: "singleton" },
        select: { timeZone: true },
    });
    if (validTimeZone(settings?.timeZone)) return settings.timeZone;
    if (validTimeZone(process.env.COMPANY_TIMEZONE)) return process.env.COMPANY_TIMEZONE;
    return DEFAULT_COMPANY_TIME_ZONE;
}

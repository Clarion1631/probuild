import { prisma } from "./prisma";
import { validTimeZone, DEFAULT_COMPANY_TIME_ZONE } from "./tz-date";
export type { CalendarDateVerdict } from "./tz-date";

// Pure date/time-zone primitives live in tz-date.ts (no prisma import, so
// they stay importable from anything that must be unit-testable without a
// database or browser-safe). This module adds the one thing that genuinely
// needs prisma — resolving the company's configured time zone — and
// re-exports the primitives so existing callers of dateOnlyInTimeZone /
// startOfDateInTimeZone / endOfDateInTimeZone / dateInputInTimeZone don't
// need to change their import path.
export {
    CALENDAR_DATE_BAD_SHAPE,
    CALENDAR_DATE_NOT_REAL,
    DEFAULT_COMPANY_TIME_ZONE,
    classifyCalendarDate,
    dateOnlyInTimeZone,
    startOfDateInTimeZone,
    endOfDateInTimeZone,
    dateInputInTimeZone,
} from "./tz-date";

export async function resolveCompanyTimeZone(): Promise<string> {
    const settings = await prisma.companySettings.findUnique({
        where: { id: "singleton" },
        select: { timeZone: true },
    });
    if (validTimeZone(settings?.timeZone)) return settings.timeZone;
    if (validTimeZone(process.env.COMPANY_TIMEZONE)) return process.env.COMPANY_TIMEZONE;
    return DEFAULT_COMPANY_TIME_ZONE;
}

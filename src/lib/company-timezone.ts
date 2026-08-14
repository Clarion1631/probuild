import { prisma } from "./prisma";

export const DEFAULT_COMPANY_TIME_ZONE = "America/Los_Angeles";

function validTimeZone(value: string | null | undefined): value is string {
    if (!value?.trim()) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

export async function resolveCompanyTimeZone(): Promise<string> {
    const settings = await prisma.companySettings.findUnique({
        where: { id: "singleton" },
        select: { timeZone: true },
    });
    if (validTimeZone(settings?.timeZone)) return settings.timeZone;
    if (validTimeZone(process.env.COMPANY_TIMEZONE)) return process.env.COMPANY_TIMEZONE;
    return DEFAULT_COMPANY_TIME_ZONE;
}

function offsetAt(instantMs: number, timeZone: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(new Date(instantMs));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const representedAsUtc = Date.UTC(
        Number(values.year),
        Number(values.month) - 1,
        Number(values.day),
        Number(values.hour),
        Number(values.minute),
        Number(values.second),
    );
    return representedAsUtc - Math.floor(instantMs / 1000) * 1000;
}

function dateParts(date: string, label: string) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) throw new Error(label + " must use YYYY-MM-DD");
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
        throw new Error(label + " is not a valid calendar date");
    }
    return { year, month, day };
}

function instantForWallClock(date: string, timeZone: string, hour: number, minute: number, second: number, millisecond: number, label: string): Date {
    if (!validTimeZone(timeZone)) throw new Error("Invalid company time zone: " + timeZone);
    const { year, month, day } = dateParts(date, label);
    const desiredWallClock = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    let instant = desiredWallClock;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        instant = desiredWallClock - offsetAt(instant, timeZone);
    }
    return new Date(instant);
}

/** Store date-only business values at local noon to preserve their company calendar date. */
export function dateOnlyInTimeZone(date: string, timeZone: string): Date {
    return instantForWallClock(date, timeZone, 12, 0, 0, 0, "date");
}

/** The instant of local midnight (00:00:00.000) for a calendar date in the given time zone. */
export function startOfDateInTimeZone(date: string, timeZone: string): Date {
    return instantForWallClock(date, timeZone, 0, 0, 0, 0, "date");
}

export function dateInputInTimeZone(value: string | Date | null | undefined, timeZone: string, label: string): Date | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return dateOnlyInTimeZone(value, timeZone);
    }
    const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is not a valid date.`);
    return parsed;
}

export function endOfDateInTimeZone(date: string, timeZone: string): Date {
    return instantForWallClock(date, timeZone, 23, 59, 59, 999, "throughDate");
}
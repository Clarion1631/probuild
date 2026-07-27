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

export function endOfDateInTimeZone(date: string, timeZone: string): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) throw new Error("throughDate must use YYYY-MM-DD");
    if (!validTimeZone(timeZone)) throw new Error(`Invalid company time zone: ${timeZone}`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const desiredWallClock = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
        throw new Error("throughDate is not a valid calendar date");
    }
    let instant = desiredWallClock;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        instant = desiredWallClock - offsetAt(instant, timeZone);
    }
    return new Date(instant);
}

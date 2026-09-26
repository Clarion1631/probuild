import type { PrismaClient } from "@prisma/client";

/**
 * The database server's own clock (`SELECT now()`), independent of this
 * process's wall clock. gmail-poll.ts sources every scan-start and watermark
 * timestamp from this, never from the caller's `now` — closing the
 * future-watermark class a wall-clock anomaly in THIS process used to be
 * able to cause (round-9, was round-6 finding 3: see gmail-poll.ts's own
 * module docstring). A separate module so tests can fake it the same way
 * they already fake `./gmail-inbox-client` (a `Module.prototype.require`
 * patch scoped to this literal specifier) without touching the real
 * database's clock.
 */
export async function dbNow(db: PrismaClient): Promise<Date> {
    const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return rows[0]?.now ?? new Date();
}

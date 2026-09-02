import { prisma } from "@/lib/prisma";

/**
 * A DURABLE run lease for a cron, on the AutomationSetting KV table.
 *
 * WHY NOT AN ADVISORY LOCK. `pg_try_advisory_xact_lock` is transaction-scoped,
 * and pgbouncer forbids the session-scoped kind — so the lock is released the
 * instant the claiming transaction commits, which is BEFORE any work starts. A
 * claim like that excludes nothing: two overlapping invocations both take it and
 * both run. Holding one transaction open across the whole run is not an option
 * either; these runs are minutes of query-heavy work and a pooled connection
 * cannot be parked that long.
 *
 * So the lease is a ROW: a token plus an expiry, claimed by CAS inside one short
 * transaction, held across the work, and released at the end. A run that cannot
 * claim it does nothing and says so.
 *
 * FAILS CLOSED. If the lease cannot be read or written, `takeLease` returns null
 * and the caller skips — a cron that cannot establish exclusivity must not run,
 * because the failure mode of two concurrent runs is contradictory writes.
 */

export interface LeaseState {
    token: string;
    expiresAt: string;
}

function parse(value: string): LeaseState | null {
    try {
        const parsed = JSON.parse(value) as Partial<LeaseState>;
        if (typeof parsed.token !== "string" || typeof parsed.expiresAt !== "string") return null;
        return { token: parsed.token, expiresAt: parsed.expiresAt };
    } catch {
        return null;
    }
}

/**
 * Claim `key` until `now + leaseMs`, or return null when someone else holds it.
 * A lease whose expiry has passed belongs to a run that died and is up for grabs.
 */
export async function takeLease(key: string, leaseMs: number, now: Date, token: string): Promise<string | null> {
    const payload = JSON.stringify({ token, expiresAt: new Date(now.getTime() + leaseMs).toISOString() });
    try {
        return await prisma.$transaction(async tx => {
            // The advisory lock is still worth taking, but only for what it can
            // honestly do: serialize the CLAIM itself. The row is what covers
            // the run.
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
            const existing = await tx.automationSetting.findUnique({ where: { key } });
            if (existing) {
                const held = parse(existing.value);
                // A corrupt lease is not a held lease.
                if (held && new Date(held.expiresAt) > now) return null;
                await tx.automationSetting.update({ where: { key }, data: { value: payload } });
                return token;
            }
            await tx.automationSetting.create({ data: { key, value: payload } });
            return token;
        });
    } catch (error) {
        console.error(`[cron-lease] could not claim ${key}`, error instanceof Error ? error.message : "UnknownError");
        return null;
    }
}

/**
 * Release, but only if we still hold it.
 *
 * A read-then-write release has a window: run A reads "I hold it", run B's
 * claim overwrites the row, then A's write clears B's lease and two runs are
 * live at once. This is ONE fenced statement — `updateMany` matching both the
 * key AND our token — so a release that lost the race updates zero rows and
 * says nothing, which is exactly right.
 */
export async function releaseLease(key: string, token: string): Promise<boolean> {
    try {
        const released = await prisma.automationSetting.updateMany({
            where: { key, value: { contains: `"token":"${token}"` } },
            data: { value: JSON.stringify({ token: "", expiresAt: new Date(0).toISOString() }) },
        });
        return released.count === 1;
    } catch {
        // The lease expires on its own; a failed release costs one skipped run.
        return false;
    }
}

/** True when `value` describes a lease that is still live at `now`. */
export function leaseIsHeld(value: string | null | undefined, now: Date): boolean {
    if (!value) return false;
    const held = parse(value);
    return held !== null && new Date(held.expiresAt) > now;
}

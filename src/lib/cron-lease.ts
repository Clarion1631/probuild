import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * A durable, whole-invocation lease for a cron that must not run twice at once.
 *
 * WHY NOT AN ADVISORY LOCK. `pg_try_advisory_xact_lock` is TRANSACTION scoped:
 * it is released the instant the transaction commits. A cron that takes it,
 * commits a claim, and then spends fifty seconds on Gemini and QuickBooks is
 * holding nothing for the part that matters — a second invocation walks
 * straight in behind it. (The session-scoped variant is not an option either:
 * pgbouncer pools connections, so "the same session" is not a thing we can
 * name across two statements.)
 *
 * WHY NOT A TRANSACTION HELD OPEN. Holding one across those network calls is
 * minutes of open transaction on a pooled connection, which is exactly what
 * the pooler cannot afford.
 *
 * So the lease is a ROW: one `AutomationSetting` holding an expiry and the
 * token of whoever holds it. Acquiring is a compare-and-swap; releasing is a
 * CAS on the same token, so a slow invocation whose lease has already expired
 * and been taken by someone else can never release the new holder's lease.
 *
 * WHAT IT GUARANTEES, precisely: at most one invocation processes a pass at a
 * time, UNLESS an invocation exceeds the lease TTL. The TTL is deliberately
 * set longer than the platform's own `maxDuration` ceiling (see
 * WORKER_LEASE_MS), so the platform kills a pass before its lease can lapse —
 * which is also why nothing here heartbeats. It is not a distributed lock and
 * does not pretend to be: the per-row claim token remains the second layer,
 * and it is what actually makes a double pass harmless.
 *
 * A DB failure anywhere here means NO lease. Failing closed (skip the run) is
 * right: the next cron is five minutes away, and running unprotected is the
 * thing this exists to prevent.
 */

export interface CronLease {
    /** Whoever holds it. Every write below is CAS'd on this. */
    readonly token: string;
    /**
     * Give the lease back. CAS'd on the exact value we last wrote, so an
     * invocation that lost its lease (expired, then taken) releases NOTHING
     * rather than freeing the current holder's. Never throws.
     */
    release(): Promise<void>;
}

/** The persisted shape: `<expiry ISO>|<token>`. Two fields, one string column. */
function encode(expiresAt: Date, token: string): string {
    return `${expiresAt.toISOString()}|${token}`;
}

function expiryOf(value: string): number {
    const iso = value.split("|", 1)[0];
    const at = Date.parse(iso);
    // An unparseable value is a corrupt lease, and a corrupt lease that read as
    // "live" would wedge the cron forever. Treat it as expired: the CAS below
    // still makes the takeover safe.
    return Number.isFinite(at) ? at : 0;
}

export interface CronLeaseStore {
    get(key: string): Promise<string | null>;
    /** Create only if absent. False when the row already exists. */
    insert(key: string, value: string): Promise<boolean>;
    /** Swap `from` for `to`. False when the stored value is no longer `from`. */
    swap(key: string, from: string, to: string): Promise<boolean>;
    /** Remove, only while the value is still `expected`. */
    remove(key: string, expected: string): Promise<void>;
}

/** AutomationSetting-backed. The `key` column is the primary key, so insert races resolve there. */
export const automationSettingLeaseStore: CronLeaseStore = {
    async get(key) {
        const row = await prisma.automationSetting.findUnique({ where: { key }, select: { value: true } });
        return row?.value ?? null;
    },
    async insert(key, value) {
        try {
            await prisma.automationSetting.create({ data: { key, value } });
            return true;
        } catch {
            // A unique violation is the LOSING side of a first-run race, which
            // is a normal outcome, not an error. Any other failure also means
            // we did not get the lease, which is the same answer.
            return false;
        }
    },
    async swap(key, from, to) {
        // The CAS. `value: from` in the WHERE is what makes this safe without a
        // transaction: two invocations reading the same expired lease both try
        // to swap the SAME old string, and exactly one update matches a row.
        const { count } = await prisma.automationSetting.updateMany({
            where: { key, value: from },
            data: { value: to },
        });
        return count > 0;
    },
    async remove(key, expected) {
        await prisma.automationSetting.deleteMany({ where: { key, value: expected } });
    },
};

/**
 * Take the lease, or return null if someone else holds a live one.
 *
 * `now` and `store` are injected so this is a unit test rather than a fact
 * about production that only a race in prod could ever exercise.
 */
export async function acquireCronLease(
    key: string,
    ttlMs: number,
    opts: { store?: CronLeaseStore; now?: () => Date; token?: string } = {},
): Promise<CronLease | null> {
    const store = opts.store ?? automationSettingLeaseStore;
    const now = opts.now ?? (() => new Date());
    const token = opts.token ?? randomUUID();

    let existing: string | null;
    try {
        existing = await store.get(key);
    } catch {
        // Fail closed: without knowing, we must not run.
        return null;
    }

    const at = now();
    const mine = encode(new Date(at.getTime() + ttlMs), token);

    let won = false;
    try {
        if (existing === null) {
            won = await store.insert(key, mine);
        } else if (expiryOf(existing) > at.getTime()) {
            // Somebody is holding it and has not run out of time.
            return null;
        } else {
            // Expired — a crashed invocation, or one the platform killed. Take
            // it over, but only if it is STILL the expired value we read: two
            // invocations racing here must not both believe they won.
            won = await store.swap(key, existing, mine);
        }
    } catch {
        return null;
    }
    if (!won) return null;

    return {
        token,
        async release() {
            try {
                // Fenced on OUR value. An invocation that overran, lost its
                // lease, and is only now finishing releases nothing — the row
                // it would delete belongs to whoever took over.
                // Deleting an already-deleted row matches nothing, so a
                // second call is a no-op rather than a mistake.
                await store.remove(key, mine);
            } catch {
                // A lease left behind expires on its own; the next run takes it
                // over. Never let a cleanup failure fail the run it protected.
            }
        },
    };
}

/**
 * THE OTHER LEASE ON THIS TABLE: the whole-RUN lease the Phase 2 crons
 * (bank-register-pull, receipt-requests) take. Same idea as
 * `acquireCronLease` above and the same AutomationSetting row shape, but a
 * different persisted encoding and its own key per cron, so the two never read
 * each other's values. Kept side by side rather than merged: unifying them is a
 * behaviour change to two shipping crons, not a merge resolution.
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
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
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

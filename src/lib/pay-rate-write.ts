// The ONE place a pay rate is written.
//
// Rates were being written from three unrelated routes (the team-member editor,
// /api/users, the mobile manager employee route), each with its own permission
// check, its own Number() conversion, and only one of them stamping
// lastRateSyncAt. That is three chances to put money through a float and three
// different answers to "who may change pay".
//
// Everything funnels through applyRateChange: one permission boundary (ADMIN or
// financialReports — the same gate the payroll export and the rates panel use),
// one exact-decimal parse, one lastRateSyncAt stamp (rate confirmations only),
// one payrollRevision bump (every payroll-affecting write), in one update.

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { hasPermission } from "./access-rules";
import { MAX_IMPORTABLE_HOURLY_RATE, parseRateValue } from "./rate-import";
import { isKnownPayType, lockOwnerRowForUpdate } from "./pay-rate-guard";
import { acquirePayrollWriteLock } from "./payroll-period";

export type RateActor = { role: string; permissions?: unknown } | null | undefined;

export type RateChange = {
    hourlyRate?: unknown;
    burdenRate?: unknown;
    payType?: unknown;
};

/** Thrown inside a transaction so a rate refusal rolls the whole write back, carrying its HTTP status. */
export class RateChangeError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.name = "RateChangeError";
        this.status = status;
    }
}

export type RateWriteResult = { ok: true; changed: boolean } | { ok: false; status: number; error: string };

/**
 * EXACTLY the gate the payroll export, the review page and requirePayrollAccess
 * use — deliberately the same expression, so the rates panel and the export can
 * never disagree about who may act.
 *
 * Note what hasPermission actually means: it returns true for ADMIN *and*
 * MANAGER unconditionally (src/lib/access-rules.ts — managers have full access
 * app-wide), so a MANAGER passes here. That is not a new grant invented by this
 * function; managers could already read and write rates before Phase 5. What
 * changed is that a FINANCE user now needs the financialReports permission, and
 * that every writer runs the same check instead of three different ones.
 *
 * If pay should ever be narrowed to ADMIN-only, that belongs in access-rules
 * (or a dedicated permission key) so every payroll surface moves together.
 */
export function canWriteRates(actor: RateActor): boolean {
    if (!actor) return false;
    return actor.role === "ADMIN" || hasPermission(actor as never, "financialReports");
}

/**
 * Validate and apply a rate change. Returns `changed: false` when the payload
 * carried no rate fields at all, so callers can keep updating other columns
 * without needing payroll permission.
 */
/**
 * The database handle. A transaction is REQUIRED: the rate write has to take the
 * exclusive row lock and write in one atomic step, or settlement's FOR SHARE
 * cannot serialize against it.
 */
export type RateWriteClient = {
    $transaction<T>(fn: (tx: RateWriteTx) => Promise<T>): Promise<T>;
};

/**
 * An INTERACTIVE transaction client. Note what is absent: `$transaction`. That
 * is deliberate — it is the thing a tx cannot do, and typing it out here is what
 * makes the mistake above impossible to repeat without a cast.
 */
export type RateWriteTx = {
    user: { update(args: unknown): Promise<unknown> };
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
    /** For the payroll advisory lock — tier 1 of the global lock order. */
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/** Does this payload touch payroll at all? Both entry points ask, so they cannot disagree. */
function touchesPayroll(change: RateChange): boolean {
    return change.hourlyRate !== undefined || change.burdenRate !== undefined || change.payType !== undefined;
}

export async function applyRateChangeInTx(
    tx: RateWriteTx,
    actor: RateActor,
    userId: string,
    change: RateChange
): Promise<RateWriteResult> {
    const touchesRates = change.hourlyRate !== undefined || change.burdenRate !== undefined;
    const touchesPayType = change.payType !== undefined;
    if (!touchesRates && !touchesPayType) return { ok: true, changed: false };

    if (!canWriteRates(actor)) {
        return { ok: false, status: 403, error: "Payroll access is required to change pay rates." };
    }

    const data: Record<string, unknown> = {};

    for (const field of ["hourlyRate", "burdenRate"] as const) {
        const raw = change[field];
        if (raw === undefined) continue;
        // Exact decimal TEXT -> Prisma.Decimal. Number() would put a pay rate
        // through a binary float on the way to the database.
        const text = parseRateValue(String(raw));
        if (text == null || text.startsWith("-") || Number(text) > MAX_IMPORTABLE_HOURLY_RATE) {
            return {
                ok: false,
                status: 400,
                error: `${field === "hourlyRate" ? "Hourly" : "Burden"} rate must be between 0 and ${MAX_IMPORTABLE_HOURLY_RATE}, with at most two decimal places.`,
            };
        }
        data[field] = new Prisma.Decimal(text);
    }

    if (touchesPayType) {
        const payType = change.payType;
        // Mirrors the DB CHECK User_payType_check — the constraint is the real
        // guarantee, this is the good error message.
        if (payType !== null && !isKnownPayType(payType)) {
            return { ok: false, status: 400, error: "Pay type must be hourly or salary." };
        }
        data.payType = payType;
    }

    // "Last confirmed" — ONLY when an actual rate is being confirmed. A
    // pay-type-only write must not move this: the Payroll rates panel reads it
    // as "somebody looked at and confirmed this rate", and stamping it for a
    // write that never touched hourlyRate/burdenRate made that claim false.
    if (touchesRates) data.lastRateSyncAt = new Date();

    // Replay protection lives here instead: a plain monotonic counter, bumped
    // on EVERY payroll-affecting write regardless of which fields it touches.
    // The rate-import preview/apply signature is keyed on this, not on
    // lastRateSyncAt — an A -> B -> A replay (rate OR pay type set back by
    // hand) still moves this counter forward, so an old approval's signature
    // stops verifying even though lastRateSyncAt cannot tell the difference.
    if (touchesRates || touchesPayType) data.payrollRevision = { increment: 1 };

    // TIER 1 OF THE GLOBAL LOCK ORDER (src/lib/payroll-period.ts), before any
    // row lock. hourlyRate, burdenRate and payType are all EXPORT INPUTS: pay
    // type decides who is on the Gusto roster and whether their hours are
    // summarised at all, and lockPayrollPeriod hashes the result and freezes it.
    // Without this, a pay-type change could commit between that lock's
    // "confirmed" recompute and its COMMIT, and the period would be frozen
    // around a roster that had already moved — the advisory lock is what makes
    // this writer wait for the lock creation instead.
    //
    // The SHARED half: rate writers do not conflict with each other (the row
    // lock below is what serialises those), only with a period being locked.
    // Taken BEFORE the row lock, which is also what keeps it deadlock-free: a
    // writer can never hold a User row while waiting for the payroll lock, so
    // the export's FOR SHARE on those rows cannot close a cycle.
    await acquirePayrollWriteLock(tx);

    // EXCLUSIVE row lock, then the write, on the CALLER's transaction.
    // Settlement reads the same row FOR SHARE while it reprices a day, so this
    // waits rather than moving the rate underneath a day that is mid-reprice —
    // which would leave one day's shifts priced at two different rates.
    await lockOwnerRowForUpdate(tx, userId);
    await tx.user.update({ where: { id: userId }, data });
    return { ok: true, changed: true };
}

/**
 * Open a transaction and apply the change in it.
 *
 * THE ONLY OPENER. Every route already runs its rate write inside its own
 * interactive transaction (the rate has to commit or roll back with the rest of
 * the profile edit), and an interactive Prisma client has no `$transaction`
 * method — so a version of this that opened one unconditionally crashed every
 * one of those routes at runtime. It type-checked because the call sites cast
 * their `tx` with `as never`.
 *
 * If you have a transaction, call applyRateChangeInTx with it. This is for the
 * caller that does not.
 */
export async function applyRateChange(
    actor: RateActor,
    userId: string,
    change: RateChange,
    // ONE cast, here, in the safe direction: Prisma's interactive tx is a
    // superset of RateWriteTx. It replaces the four `tx as never` casts at the
    // call sites, which were pointing the other way and hid a real crash.
    client: RateWriteClient = prisma as unknown as RateWriteClient
): Promise<RateWriteResult> {
    // Both cheap answers are decided BEFORE a connection is taken: a payload
    // with no rate fields does nothing, and a caller without payroll access is
    // refused. Neither needs a transaction.
    if (!touchesPayroll(change)) return { ok: true, changed: false };
    if (!canWriteRates(actor)) {
        return { ok: false, status: 403, error: "Payroll access is required to change pay rates." };
    }
    return client.$transaction((tx) => applyRateChangeInTx(tx, actor, userId, change));
}

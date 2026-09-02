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
// one exact-decimal parse, one lastRateSyncAt stamp, in one update.

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { hasPermission } from "./access-rules";
import { MAX_IMPORTABLE_HOURLY_RATE, parseRateValue } from "./rate-import";
import { isKnownPayType, lockOwnerRowForUpdate } from "./pay-rate-guard";

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

export type RateWriteTx = {
    user: { update(args: unknown): Promise<unknown> };
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
};

export async function applyRateChange(
    actor: RateActor,
    userId: string,
    change: RateChange,
    client: RateWriteClient = prisma as never
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

    // "Last confirmed", stamped by EVERY path that writes a rate — the whole
    // point of the staleness marker is that no rate write can skip it.
    if (touchesRates) data.lastRateSyncAt = new Date();

    // EXCLUSIVE row lock, then the write, in ONE transaction. Settlement reads
    // the same row FOR SHARE while it reprices a day, so this waits rather than
    // moving the rate underneath a day that is mid-reprice — which would leave
    // one day's shifts priced at two different rates.
    await client.$transaction(async (tx) => {
        await lockOwnerRowForUpdate(tx, userId);
        await tx.user.update({ where: { id: userId }, data });
    });
    return { ok: true, changed: true };
}

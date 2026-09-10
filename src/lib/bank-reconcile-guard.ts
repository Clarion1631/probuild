import type { Prisma } from "@prisma/client";
import { normalizePayee, type ReconcileLink } from "@/lib/bank-ledger";
import { BANK_LINE_IDENTITY_LOCK } from "@/lib/bank-line-mint";

/**
 * THE RECONCILE PERSISTENCE GUARD.
 *
 * `reconcileObservations` plans OUTSIDE any transaction from a read that may be
 * seconds old, and the old persistence wrote `bankLineId` guarded only on
 * `id + bankLineId IS NULL`. An observation whose date/descriptor/amount moved
 * after planning (a source refresh or a restatement) — or a candidate BankLine whose descriptor moved —
 * would still be linked on the strength of a match key that no longer holds.
 *
 * This module makes the write conditional on the plan's own inputs. The route
 * enriches every proposed link with the EXACT match-key snapshot of both rows
 * as originally read (`expectedObservation` / `expectedBankLine`); persistence
 * then, under the bank-line identity lock and with BOTH rows locked
 * `FOR UPDATE`, re-reads them and refuses unless (a) each row still equals its
 * snapshot, (b) the observation is still unlinked, (c) the pair still matches,
 * and (d) the candidate still has no QBO_REGISTER observation. A link that
 * arrives without snapshots FAILS CLOSED — that is not a planner this guard
 * knows how to trust.
 *
 * The pure planner and its outputs are untouched: the snapshot is an OPTIONAL
 * additional shape on the link, populated by the route from the same rows it
 * fed the planner.
 *
 * LOCK ORDER: receipt evidence (if held), Purchase, bank identity, Expense,
 * then row locks. Reconcile only takes bank identity and row locks.
 * The key is the one bank-line-mint's ingest/descriptor-refresh writers use,
 * so the two fences serialize against each other.
 */
export { BANK_LINE_IDENTITY_LOCK };
export const QBO_REGISTER_SOURCE = "QBO_REGISTER";
export const STALE_RECONCILE_PLAN = "stale-reconcile-plan";

export interface ExpectedMatchKey {
    account: string;
    postedDate: string;
    amountCents: number;
    normalizedPayee: string;
    checkNumber: string | null;
}

export type GuardedReconcileLink = ReconcileLink & {
    expectedObservation?: ExpectedMatchKey;
    expectedBankLine?: ExpectedMatchKey;
};

export type GuardTxClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw" | "bankLineObservation">;

export type GuardOutcome = { ok: true } | { ok: false; reason: string };

interface LockedObservationRow {
    id: string;
    account: string;
    source: string;
    bankLineId: string | null;
    amountCents: number;
    rawDescriptor: string | null;
    checkNumber: string | null;
    postedDate: string;
}

interface LockedBankLineRow {
    id: string;
    account: string;
    amountCents: number;
    normalizedPayee: string;
    checkNumber: string | null;
    postedDate: string;
}

/** Snapshot of the match key from the exact row the planner saw. */
export function toExpectedSnapshot(row: ExpectedMatchKey | undefined): ExpectedMatchKey | undefined {
    if (!row) return undefined;
    return {
        account: row.account,
        postedDate: row.postedDate,
        amountCents: row.amountCents,
        normalizedPayee: row.normalizedPayee,
        checkNumber: row.checkNumber ?? null,
    };
}

/** Transaction-scoped advisory lock shared with every bank-line identity writer. Take ONCE per transaction. */
export async function lockBankLineIdentity(tx: Pick<Prisma.TransactionClient, "$executeRaw">): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BANK_LINE_IDENTITY_LOCK}))`;
}

function sameKey(a: ExpectedMatchKey, b: ExpectedMatchKey): boolean {
    return a.account === b.account && a.postedDate === b.postedDate && a.amountCents === b.amountCents
        && a.normalizedPayee === b.normalizedPayee && (a.checkNumber ?? null) === (b.checkNumber ?? null);
}

/** The planner's rule, re-applied to the CURRENT rows: exact key, non-empty payee, check numbers agree exactly, including null. */
export function pairStillMatches(observation: ExpectedMatchKey, line: ExpectedMatchKey): boolean {
    if (observation.normalizedPayee === "" || line.normalizedPayee === "") return false;
    if (observation.account !== line.account || observation.postedDate !== line.postedDate) return false;
    if (observation.amountCents !== line.amountCents || observation.normalizedPayee !== line.normalizedPayee) return false;
    const observationCheck = observation.checkNumber ?? null;
    const lineCheck = line.checkNumber ?? null;
    if (observationCheck !== lineCheck) return false;
    return true;
}

/**
 * Lock both rows, verify the plan still holds, then CAS the link. Must run
 * inside the caller's transaction, after `lockBankLineIdentity`. Never throws
 * for a refused link; a unique-index violation on the CAS propagates so the
 * caller can apply its savepoint handling.
 */
export async function guardAndLinkObservation(tx: GuardTxClient, link: GuardedReconcileLink): Promise<GuardOutcome> {
    if (!link.expectedObservation || !link.expectedBankLine) return { ok: false, reason: STALE_RECONCILE_PLAN };

    const observations = await tx.$queryRaw<LockedObservationRow[]>`
        SELECT "id", "account", "source", "bankLineId", "amountCents", "rawDescriptor", "checkNumber",
               to_char("postedDate", 'YYYY-MM-DD') AS "postedDate"
        FROM "BankLineObservation" WHERE "id" = ${link.observationId} FOR UPDATE`;
    const lines = await tx.$queryRaw<LockedBankLineRow[]>`
        SELECT "id", "account", "amountCents", "normalizedPayee", "checkNumber",
               to_char("postedDate", 'YYYY-MM-DD') AS "postedDate"
        FROM "BankLine" WHERE "id" = ${link.bankLineId} FOR UPDATE`;

    const observation = observations[0];
    const line = lines[0];
    if (!observation || !line || observation.source !== QBO_REGISTER_SOURCE) return { ok: false, reason: STALE_RECONCILE_PLAN };
    if (observation.bankLineId !== null) return { ok: false, reason: "observation-already-linked" };

    const currentObservation: ExpectedMatchKey = {
        account: observation.account,
        postedDate: observation.postedDate,
        amountCents: observation.amountCents,
        normalizedPayee: normalizePayee(observation.rawDescriptor ?? ""),
        checkNumber: observation.checkNumber ?? null,
    };
    const currentLine: ExpectedMatchKey = {
        account: line.account,
        postedDate: line.postedDate,
        amountCents: line.amountCents,
        normalizedPayee: line.normalizedPayee,
        checkNumber: line.checkNumber ?? null,
    };
    if (!sameKey(currentObservation, link.expectedObservation) || !sameKey(currentLine, link.expectedBankLine)) {
        return { ok: false, reason: STALE_RECONCILE_PLAN };
    }
    if (!pairStillMatches(currentObservation, currentLine)) return { ok: false, reason: STALE_RECONCILE_PLAN };

    const claimed = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "BankLineObservation"
        WHERE "bankLineId" = ${link.bankLineId} AND "source" = ${QBO_REGISTER_SOURCE} LIMIT 1`;
    if (claimed.length > 0) return { ok: false, reason: "bank-line-already-claimed" };

    const result = await tx.bankLineObservation.updateMany({
        where: { id: link.observationId, bankLineId: null, source: QBO_REGISTER_SOURCE },
        data: { bankLineId: link.bankLineId },
    });
    if (result.count !== 1) return { ok: false, reason: "observation-already-linked" };
    return { ok: true };
}

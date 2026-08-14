import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizePayee, reconcileObservations, type ReconcileObservation, type ReconcileBankLine, type ReconcileLink } from "@/lib/bank-ledger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Bank ledger cross-source reconciliation (Receipt Automation Phase 1,
 * Codex peer-review round-2 amendments). Links not-yet-reconciled
 * QBO_REGISTER observations (BankLineObservation.bankLineId === null) to a
 * canonical BankLine — the explicit, separate step promised by the ingest
 * route's module comment; never an ingest-time side effect.
 *
 * Planning (reconcileObservations, src/lib/bank-ledger.ts) is pure and
 * requires an EXACT account+postedDate+amountCents+normalizedPayee match
 * (plus checkNumber agreement whenever either side carries one) — amount and
 * date alone are zero confidence (see the Chevron/Cash App wrong-match
 * lesson in docs/RECEIPT-AUTOMATION-PHASES.md). An observation or candidate
 * with an empty normalizedPayee (the EXCEPTION case) never matches anything.
 * A key with more observations than candidate BankLines leaves the excess
 * unmatched — never guessed.
 *
 * Persistence writes every proposed link inside ONE database transaction,
 * but wraps each link in its own SAVEPOINT: a unique-index violation on one
 * link (the partial unique index caps each canonical BankLine at one linked
 * observation per source — see prisma/schema.prisma) rolls back only that
 * link via ROLLBACK TO SAVEPOINT and is reported back as an exception,
 * rather than aborting every other valid link in the same run. This is the
 * standard Postgres pattern for "best-effort batch inside one transaction,
 * tolerate individual conflicts" — Prisma's interactive transactions don't
 * expose savepoints directly, so this issues them via $executeRawUnsafe on
 * the transaction client.
 *
 * Auth: x-ingest-key header must equal BANK_LEDGER_INGEST_SECRET, the same
 * shared-secret contract as the ingest route.
 */

const MAX_ACCOUNT_LEN = 64;

export interface ReconcileExceptionResult {
    observationId: string;
    bankLineId: string;
    reason: string;
}

export interface PersistedReconciliation {
    linked: string[];
    exceptions: ReconcileExceptionResult[];
}

export interface BankLedgerReconcileHandlerDependencies {
    getIngestSecret(): string | undefined;

    /** Not-yet-linked QBO_REGISTER observations, optionally scoped to one account. normalizedPayee is derived from rawDescriptor here (BankLineObservation has no stored normalizedPayee column). */
    findUnlinkedQboObservations(account: string | null): Promise<ReconcileObservation[]>;

    /** Candidate canonical BankLines with no QBO_REGISTER observation linked yet, optionally scoped to one account. */
    findCandidateBankLines(account: string | null): Promise<ReconcileBankLine[]>;

    /** Writes every link inside one transaction; a per-link unique-index conflict is caught and reported as an exception rather than failing the whole run (see the module comment). */
    persistLinks(links: ReconcileLink[]): Promise<PersistedReconciliation>;
}

export function createBankLedgerReconcileHandlers(dependencies: BankLedgerReconcileHandlerDependencies) {
    return {
        async POST(request: Request) {
            const secret = dependencies.getIngestSecret();
            if (!secret || request.headers.get("x-ingest-key") !== secret) {
                return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
            }

            let account: string | null = null;
            const rawBody = await request.text();
            if (rawBody.trim()) {
                let bodyUnknown: unknown;
                try {
                    bodyUnknown = JSON.parse(rawBody);
                } catch {
                    return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
                }
                if (bodyUnknown !== null && typeof bodyUnknown === "object" && !Array.isArray(bodyUnknown)) {
                    const body = bodyUnknown as { account?: unknown };
                    if (body.account !== undefined) {
                        if (typeof body.account !== "string" || !body.account.trim() || body.account.length > MAX_ACCOUNT_LEN) {
                            return NextResponse.json({ ok: false, reason: "invalid-account" }, { status: 400 });
                        }
                        account = body.account.trim();
                    }
                } else if (bodyUnknown !== null) {
                    return NextResponse.json({ ok: false, reason: "invalid-body" }, { status: 400 });
                }
            }

            const [observations, bankLines] = await Promise.all([
                dependencies.findUnlinkedQboObservations(account),
                dependencies.findCandidateBankLines(account),
            ]);

            const proposed = reconcileObservations(observations, bankLines);
            if (proposed.length === 0) {
                return NextResponse.json({ ok: true, proposed: 0, linked: 0, exceptions: [] });
            }

            const result = await dependencies.persistLinks(proposed);
            return NextResponse.json({
                ok: true,
                proposed: proposed.length,
                linked: result.linked.length,
                exceptions: result.exceptions,
            });
        },
    };
}

function isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const handlers = createBankLedgerReconcileHandlers({
    getIngestSecret: () => process.env.BANK_LEDGER_INGEST_SECRET,

    findUnlinkedQboObservations: async account => {
        const rows = await prisma.bankLineObservation.findMany({
            where: { source: "QBO_REGISTER", bankLineId: null, ...(account ? { account } : {}) },
            select: { id: true, account: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, bankLineId: true },
        });
        return rows.map(r => ({
            id: r.id,
            account: r.account,
            postedDate: r.postedDate.toISOString().slice(0, 10),
            amountCents: r.amountCents,
            normalizedPayee: normalizePayee(r.rawDescriptor),
            checkNumber: r.checkNumber,
            bankLineId: r.bankLineId,
        }));
    },

    findCandidateBankLines: async account => {
        const rows = await prisma.bankLine.findMany({
            where: {
                ...(account ? { account } : {}),
                observations: { none: { source: "QBO_REGISTER" } },
            },
            select: { id: true, account: true, postedDate: true, amountCents: true, normalizedPayee: true, checkNumber: true },
        });
        return rows.map(r => ({
            id: r.id,
            account: r.account,
            postedDate: r.postedDate.toISOString().slice(0, 10),
            amountCents: r.amountCents,
            normalizedPayee: r.normalizedPayee,
            checkNumber: r.checkNumber,
        }));
    },

    persistLinks: async links => {
        const linked: string[] = [];
        const exceptions: ReconcileExceptionResult[] = [];

        await prisma.$transaction(async tx => {
            for (let i = 0; i < links.length; i++) {
                const link = links[i];
                const savepoint = `bank_ledger_reconcile_${i}`;
                await tx.$executeRawUnsafe(`SAVEPOINT "${savepoint}"`);
                try {
                    // Guarded on bankLineId: null so a concurrent reconcile run
                    // can't double-claim the same observation between planning
                    // and this write.
                    const result = await tx.bankLineObservation.updateMany({
                        where: { id: link.observationId, bankLineId: null },
                        data: { bankLineId: link.bankLineId },
                    });
                    if (result.count === 0) {
                        await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT "${savepoint}"`);
                        exceptions.push({ observationId: link.observationId, bankLineId: link.bankLineId, reason: "observation-already-linked" });
                        continue;
                    }
                    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT "${savepoint}"`);
                    linked.push(link.observationId);
                } catch (error) {
                    if (isUniqueConstraintError(error)) {
                        // The partial unique index on (source, bankLineId) — this
                        // canonical BankLine already has a QBO observation linked
                        // (a concurrent run won the race). Roll back just this
                        // link and keep processing the rest of the batch.
                        await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT "${savepoint}"`);
                        exceptions.push({ observationId: link.observationId, bankLineId: link.bankLineId, reason: "bank-line-already-claimed" });
                        continue;
                    }
                    throw error;
                }
            }
        });

        return { linked, exceptions };
    },
});

export async function POST(request: Request) {
    return handlers.POST(request);
}

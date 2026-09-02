import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizePayee, reconcileObservations, type ReconcileObservation, type ReconcileBankLine, type ReconcileLink, type ReconcileAmbiguousGroup } from "@/lib/bank-ledger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Bank ledger cross-source reconciliation (Receipt Automation Phase 1,
 * Codex peer-review round-2 + round-3 amendments). Links not-yet-reconciled
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
 * A match key shared by more than one observation and/or more than one
 * candidate BankLine is AMBIGUOUS — reconcileObservations() leaves every
 * member of that group unmatched and reports it back in `ambiguous` rather
 * than guessing a pairing by input order (Codex round-3, defect 1).
 *
 * Persistence writes proposed links in bounded CHUNKS (Codex round-3, new
 * blocker) — the earlier implementation loaded every eligible row and ran up
 * to three statements per link inside ONE interactive transaction with no
 * explicit timeout, which Prisma defaults to 5s; a large backlog would time
 * out and roll back the entire run. Each chunk now gets its own transaction
 * with an explicit timeout, and a chunk that fails (timeout, connection
 * loss, anything not already handled per-link below) is reported as a
 * per-chunk error WITHOUT rolling back chunks that already committed.
 *
 * A single invocation only RUNS a bounded number of those chunks (Codex
 * round-4 fix 3) — sequential chunks at 20s each could otherwise still run
 * long enough for the platform to kill the request (maxDuration = 60) after
 * some chunks already committed, silently dropping chunkErrors and any
 * links past the kill point from the response entirely. Capping chunks per
 * invocation keeps worst case (RECONCILE_MAX_CHUNKS_PER_INVOCATION *
 * RECONCILE_TX_TIMEOUT_MS) comfortably inside the platform's budget, so a
 * response — success, exceptions, or chunkErrors — is always returned.
 * Links beyond the cap are reported back as `remaining` (never attempted
 * this invocation, not a failure) so the caller can re-invoke to resume;
 * chunks already committed in this or an earlier invocation stay committed
 * either way.
 *
 * Within a chunk, each link is wrapped in its own SAVEPOINT: a unique-index
 * violation on one link (the partial unique index caps each canonical
 * BankLine at one linked observation per source — see prisma/schema.prisma)
 * rolls back only that link via ROLLBACK TO SAVEPOINT (followed by RELEASE
 * SAVEPOINT, so the released resources don't linger for the rest of the
 * transaction — Codex round-3 should-fix) and is reported back as an
 * exception, rather than aborting every other valid link in the same chunk.
 * This is the standard Postgres pattern for "best-effort batch inside one
 * transaction, tolerate individual conflicts" — Prisma's interactive
 * transactions don't expose savepoints directly, so this issues them via
 * $executeRawUnsafe on the transaction client.
 *
 * Auth: x-ingest-key header must equal BANK_LEDGER_INGEST_SECRET, the same
 * shared-secret contract as the ingest route.
 */

const MAX_ACCOUNT_LEN = 64;

// Bounded so one interactive transaction never has to carry an unbounded
// number of statements against Prisma's 5s default transaction timeout
// (Codex round-3 new blocker) — 200 links is at most 600 statements
// (SAVEPOINT + updateMany + RELEASE/ROLLBACK) per chunk, comfortably inside
// RECONCILE_TX_TIMEOUT_MS below.
const RECONCILE_CHUNK_SIZE = 200;
const RECONCILE_TX_TIMEOUT_MS = 20_000;

// Codex round-4 fix 3: bounds how many chunks a SINGLE invocation runs, so
// worst case (2 * 20s = 40s) stays comfortably under maxDuration = 60 even
// with sequential chunks and no early platform kill. Links beyond the cap
// are reported as `remaining` for the caller to resume with another call —
// never silently dropped or half-processed without a returned response.
const RECONCILE_MAX_CHUNKS_PER_INVOCATION = 2;

export interface ReconcileExceptionResult {
    observationId: string;
    bankLineId: string;
    reason: string;
}

export interface ReconcileChunkError {
    chunkIndex: number;
    linkCount: number;
    error: string;
}

export interface PersistedReconciliation {
    linked: string[];
    exceptions: ReconcileExceptionResult[];
    chunkErrors: ReconcileChunkError[];
    /** Links not yet attempted this invocation because RECONCILE_MAX_CHUNKS_PER_INVOCATION was reached (Codex round-4 fix 3) — never a failure, just work the caller should re-invoke to resume. 0 when every proposed link was attempted. */
    remaining: number;
}

/**
 * Pure chunk orchestration (no I/O of its own — `runChunk` does the real
 * work) so it can be unit tested without a live database: splits `links`
 * into bounded chunks, runs each via `runChunk`, and merges results ONLY for
 * chunks that succeed. A chunk whose `runChunk` call throws is recorded in
 * `chunkErrors` and its links are left out of `linked`/`exceptions` entirely
 * — the real implementation runs each chunk in its own transaction, so a
 * thrown error there means that chunk's transaction rolled back and none of
 * its links actually persisted; reporting them as linked/excepted here would
 * lie about what's in the database. Chunks that already succeeded are
 * unaffected by a later chunk's failure.
 *
 * `maxChunks` (Codex round-4 fix 3) stops the loop after that many chunks
 * have been RUN (attempted — success or chunkError both count), regardless
 * of how many links remain; the un-run links are reported back via
 * `remaining` rather than attempted. Defaults to unbounded so any other
 * caller/test that doesn't pass it keeps running every chunk in one call.
 */
export async function persistLinksInChunks(
    links: ReconcileLink[],
    chunkSize: number,
    runChunk: (chunk: ReconcileLink[], chunkIndex: number) => Promise<{ linked: string[]; exceptions: ReconcileExceptionResult[] }>,
    maxChunks: number = Infinity,
): Promise<PersistedReconciliation> {
    const linked: string[] = [];
    const exceptions: ReconcileExceptionResult[] = [];
    const chunkErrors: ReconcileChunkError[] = [];

    let attempted = 0;
    let chunksRun = 0;
    for (let start = 0; start < links.length && chunksRun < maxChunks; start += chunkSize) {
        const chunk = links.slice(start, start + chunkSize);
        const chunkIndex = Math.floor(start / chunkSize);
        try {
            const result = await runChunk(chunk, chunkIndex);
            linked.push(...result.linked);
            exceptions.push(...result.exceptions);
        } catch (error) {
            chunkErrors.push({
                chunkIndex,
                linkCount: chunk.length,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        attempted += chunk.length;
        chunksRun++;
    }

    return { linked, exceptions, chunkErrors, remaining: links.length - attempted };
}

export interface BankLedgerReconcileHandlerDependencies {
    getIngestSecret(): string | undefined;

    /** Not-yet-linked QBO_REGISTER observations, optionally scoped to one account. normalizedPayee is derived from rawDescriptor here (BankLineObservation has no stored normalizedPayee column). */
    findUnlinkedQboObservations(account: string | null): Promise<ReconcileObservation[]>;

    /** Candidate canonical BankLines with no QBO_REGISTER observation linked yet, optionally scoped to one account. */
    findCandidateBankLines(account: string | null): Promise<ReconcileBankLine[]>;

    /** Writes links in bounded chunks, up to RECONCILE_MAX_CHUNKS_PER_INVOCATION per call (see the module comment); a per-link unique-index conflict is caught and reported as an exception, a whole-chunk failure is reported as a chunk error, and any links past the per-invocation cap are reported in `remaining` — none of these fail the whole run. */
    persistLinks(links: ReconcileLink[]): Promise<PersistedReconciliation>;
}

function ambiguousForResponse(ambiguous: ReconcileAmbiguousGroup[]) {
    return ambiguous.map(g => ({
        account: g.account,
        postedDate: g.postedDate,
        amountCents: g.amountCents,
        normalizedPayee: g.normalizedPayee,
        checkNumber: g.checkNumber,
        observationIds: g.observationIds,
        bankLineIds: g.bankLineIds,
    }));
}

export function createBankLedgerReconcileHandlers(dependencies: BankLedgerReconcileHandlerDependencies) {
    /**
     * Plan + persist for one scope. `account: null` means every account.
     * Split out of POST so an IN-PROCESS caller (the nightly
     * `/api/cron/bank-register-pull`) runs the SAME planning and the SAME
     * chunked writes rather than a second implementation. POST keeps every
     * one of its body/scope validations — this is reached only after them.
     */
    async function runReconcile(account: string | null) {
        const [observations, bankLines] = await Promise.all([
            dependencies.findUnlinkedQboObservations(account),
            dependencies.findCandidateBankLines(account),
        ]);

        const { links: proposed, ambiguous } = reconcileObservations(observations, bankLines);
        if (proposed.length === 0) {
            return { proposed: 0, linked: 0, exceptions: [] as ReconcileExceptionResult[], ambiguous, chunkErrors: [] as ReconcileChunkError[], remaining: 0 };
        }

        const result = await dependencies.persistLinks(proposed);
        return {
            proposed: proposed.length,
            linked: result.linked.length,
            exceptions: result.exceptions,
            ambiguous,
            chunkErrors: result.chunkErrors,
            remaining: result.remaining,
        };
    }

    return {
        runReconcile,

        async POST(request: Request) {
            const secret = dependencies.getIngestSecret();
            if (!secret || request.headers.get("x-ingest-key") !== secret) {
                return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
            }

            // Strict body contract (Codex round-3 should-fix): a reconcile run
            // must always be explicitly scoped, either to one account or,
            // deliberately, to all of them — there is no implicit default.
            // This rejects a missing body, a JSON `null`, any non-object body,
            // an unrecognized field (a typo'd "acount" silently falling
            // through to a global run), and a body carrying neither `account`
            // nor `all` (or both).
            const rawBody = await request.text();
            if (!rawBody.trim()) {
                return NextResponse.json({ ok: false, reason: "missing-body" }, { status: 400 });
            }

            let bodyUnknown: unknown;
            try {
                bodyUnknown = JSON.parse(rawBody);
            } catch {
                return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
            }
            if (bodyUnknown === null || typeof bodyUnknown !== "object" || Array.isArray(bodyUnknown)) {
                return NextResponse.json({ ok: false, reason: "invalid-body" }, { status: 400 });
            }

            const body = bodyUnknown as { account?: unknown; all?: unknown };
            const knownFields = new Set(["account", "all"]);
            const unknownField = Object.keys(body).find(field => !knownFields.has(field));
            if (unknownField) {
                return NextResponse.json({ ok: false, reason: "unknown-field", field: unknownField }, { status: 400 });
            }

            const hasAccount = body.account !== undefined;
            const hasAll = body.all !== undefined;
            if (hasAccount === hasAll) {
                // Neither present, or both present — the run must be scoped by
                // exactly one of the two, never implicitly and never both.
                return NextResponse.json({ ok: false, reason: "missing-scope" }, { status: 400 });
            }

            let account: string | null = null;
            if (hasAll) {
                if (body.all !== true) {
                    return NextResponse.json({ ok: false, reason: "invalid-all" }, { status: 400 });
                }
            } else {
                if (typeof body.account !== "string" || !body.account.trim() || body.account.length > MAX_ACCOUNT_LEN) {
                    return NextResponse.json({ ok: false, reason: "invalid-account" }, { status: 400 });
                }
                account = body.account.trim();
            }

            const result = await runReconcile(account);
            return NextResponse.json({
                ok: true,
                proposed: result.proposed,
                linked: result.linked,
                exceptions: result.exceptions,
                ambiguous: ambiguousForResponse(result.ambiguous),
                chunkErrors: result.chunkErrors,
                // Codex round-4 fix 3: links not attempted this invocation
                // because RECONCILE_MAX_CHUNKS_PER_INVOCATION was reached — the
                // caller should re-invoke (same scope) to resume; 0 means every
                // proposed link was attempted (linked, excepted, or chunk-errored).
                remaining: result.remaining,
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
        return persistLinksInChunks(links, RECONCILE_CHUNK_SIZE, async (chunk, chunkIndex) => {
            const chunkLinked: string[] = [];
            const chunkExceptions: ReconcileExceptionResult[] = [];

            await prisma.$transaction(async tx => {
                for (let i = 0; i < chunk.length; i++) {
                    const link = chunk[i];
                    const savepoint = `bank_ledger_reconcile_${chunkIndex}_${i}`;
                    await tx.$executeRawUnsafe(`SAVEPOINT "${savepoint}"`);
                    try {
                        // Guarded on bankLineId: null so a concurrent reconcile
                        // run can't double-claim the same observation between
                        // planning and this write.
                        const result = await tx.bankLineObservation.updateMany({
                            where: { id: link.observationId, bankLineId: null },
                            data: { bankLineId: link.bankLineId },
                        });
                        if (result.count === 0) {
                            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT "${savepoint}"`);
                            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT "${savepoint}"`);
                            chunkExceptions.push({ observationId: link.observationId, bankLineId: link.bankLineId, reason: "observation-already-linked" });
                            continue;
                        }
                        await tx.$executeRawUnsafe(`RELEASE SAVEPOINT "${savepoint}"`);
                        chunkLinked.push(link.observationId);
                    } catch (error) {
                        if (isUniqueConstraintError(error)) {
                            // The partial unique index on (source, bankLineId) —
                            // this canonical BankLine already has a QBO
                            // observation linked (a concurrent run won the
                            // race). Roll back just this link and keep
                            // processing the rest of the chunk.
                            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT "${savepoint}"`);
                            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT "${savepoint}"`);
                            chunkExceptions.push({ observationId: link.observationId, bankLineId: link.bankLineId, reason: "bank-line-already-claimed" });
                            continue;
                        }
                        throw error;
                    }
                }
            }, { timeout: RECONCILE_TX_TIMEOUT_MS });

            return { linked: chunkLinked, exceptions: chunkExceptions };
        }, RECONCILE_MAX_CHUNKS_PER_INVOCATION);
    },
});

/** Production-wired handlers, exported for the in-process cron caller. */
export const bankLedgerReconcileHandlers = handlers;

export async function POST(request: Request) {
    return handlers.POST(request);
}

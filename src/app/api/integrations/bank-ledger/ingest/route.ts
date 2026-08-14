import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
    normalizePayee,
    computeStatementContentHash,
    computeQboLineContentHash,
    validateStatementSemantics,
    isValidCalendarDate,
    isSafeCents,
} from "@/lib/bank-ledger";

export const dynamic = "force-dynamic";
// Statements now post as ONE complete request (see MAX_LINES_PER_REQUEST) and
// the insert+finalize happens inside a single DB transaction — bumped from
// 60s to give a large multi-hundred-line statement transaction headroom over
// the pooler, matching other multi-row-write routes in this repo (e.g.
// co-billing-sweep, qbo-maintenance).
export const maxDuration = 120;

/**
 * Bank ledger ingest (Receipt Automation Phase 1,
 * docs/RECEIPT-AUTOMATION-PHASES.md "Persistence decision" + Codex
 * peer-review round-1 amendments). Local parsers (scripts/parse-wtb-statement.mjs
 * today; a future QBO-register puller) POST raw lines here.
 *
 * Two distinct flows, because the two sources have fundamentally different
 * identity and trust models:
 *
 * - STATEMENT: the bank statement is true north. One request = one complete
 *   statement (periodStart/periodEnd/openingCents/closingCents + every
 *   line), content-addressed by computeStatementContentHash(). A retry with
 *   the identical content is a no-op; a different statement claiming the
 *   same account+period is a 409, never a silent overwrite. Every line in a
 *   fresh statement mints its own canonical BankLine (statement = true
 *   north) plus a BankLineObservation carrying its durable in-statement
 *   sequence locator — inserted and finalized in one transaction.
 * - QBO_REGISTER: corroborating evidence, not canonical. Lines carry their
 *   own durable identity (qbTxnId) and land as BankLineObservation rows only
 *   — no canonical BankLine is minted. Linking a QBO observation to a
 *   canonical BankLine is the separate, explicit reconcileObservations()
 *   step in src/lib/bank-ledger.ts, never an ingest-time side effect
 *   (see the sibling reconcile route). A qbTxnId retried with DIFFERENT
 *   content (date/amount/descriptor/check#) — whether against what's
 *   already stored or against another line earlier in the SAME request — is
 *   a 409 conflict, never a silent skip or overwrite: QuickBooks never
 *   legitimately reassigns a transaction id to different content, so a
 *   content mismatch under the same id means the puller re-sent an
 *   edited/corrected row, and that has to be looked at, not swallowed.
 *
 * A STATEMENT request is also rejected (400, before anything is written) if
 * it fails semantic validation: any line dated outside periodStart/periodEnd,
 * or openingCents + sum(signed lines) !== closingCents. Both are structural
 * guarantees the statement itself makes about its own lines — a request that
 * breaks either one is malformed regardless of whether every individual
 * field parsed.
 *
 * Auth: x-ingest-key header must equal BANK_LEDGER_INGEST_SECRET, the same
 * shared-secret contract as receipt-ingest and qbo-receipts/create.
 */

// One complete statement per request (chunking removed — see the module
// comment). The largest of the 7 real WTB statements parsed to date is 238
// lines; this cap leaves generous headroom over that while still being a
// realistic structural guard against a malformed/runaway payload rather than
// the earlier 20000 (which, at the old one-row-at-a-time write pattern,
// meant up to 40,000 serial inserts per request — see createStatementImport,
// now bulk-inserted).
const MAX_LINES_PER_REQUEST = 5000;
const VALID_SOURCES = new Set(["STATEMENT", "QBO_REGISTER"]);
const MAX_ACCOUNT_LEN = 64;
const MAX_DESCRIPTOR_LEN = 500;
const MAX_CHECK_NUMBER_LEN = 32;
const MAX_QB_TXN_ID_LEN = 128;

interface IngestLineInput {
    postedDate?: unknown; // YYYY-MM-DD
    amountCents?: unknown;
    rawDescriptor?: unknown;
    checkNumber?: unknown;
    qbTxnId?: unknown; // QBO_REGISTER only
}

interface IngestBody {
    source?: unknown;
    account?: unknown;
    lines?: unknown;
    // STATEMENT only:
    periodStart?: unknown;
    periodEnd?: unknown;
    openingCents?: unknown;
    closingCents?: unknown;
}

interface FieldError {
    index: number;
    field: string;
}

interface ValidatedLineBase {
    postedDate: string;
    amountCents: number;
    rawDescriptor: string;
    checkNumber: string | null;
}

interface ValidatedQboLine extends ValidatedLineBase {
    qbTxnId: string;
}

/** Never echoes the raw line back — only its index and the offending field. */
function validateCommonFields(raw: IngestLineInput, index: number): { ok: true; value: ValidatedLineBase } | { ok: false; error: FieldError } {
    if (!isValidCalendarDate(raw.postedDate)) return { ok: false, error: { index, field: "postedDate" } };
    if (!isSafeCents(raw.amountCents)) return { ok: false, error: { index, field: "amountCents" } };
    if (typeof raw.rawDescriptor !== "string" || !raw.rawDescriptor.trim() || raw.rawDescriptor.length > MAX_DESCRIPTOR_LEN) {
        return { ok: false, error: { index, field: "rawDescriptor" } };
    }
    if (raw.checkNumber !== undefined && raw.checkNumber !== null) {
        if (typeof raw.checkNumber !== "string" || raw.checkNumber.length > MAX_CHECK_NUMBER_LEN) {
            return { ok: false, error: { index, field: "checkNumber" } };
        }
    }
    return {
        ok: true,
        value: {
            postedDate: raw.postedDate,
            amountCents: raw.amountCents,
            rawDescriptor: raw.rawDescriptor,
            checkNumber: typeof raw.checkNumber === "string" ? raw.checkNumber : null,
        },
    };
}

function validateStatementLine(raw: IngestLineInput, index: number): { ok: true; value: ValidatedLineBase } | { ok: false; error: FieldError } {
    return validateCommonFields(raw, index);
}

function validateQboLine(raw: IngestLineInput, index: number): { ok: true; value: ValidatedQboLine } | { ok: false; error: FieldError } {
    const common = validateCommonFields(raw, index);
    if (!common.ok) return common;
    if (typeof raw.qbTxnId !== "string" || !raw.qbTxnId.trim() || raw.qbTxnId.length > MAX_QB_TXN_ID_LEN) {
        return { ok: false, error: { index, field: "qbTxnId" } };
    }
    return { ok: true, value: { ...common.value, qbTxnId: raw.qbTxnId } };
}

/** Thrown by createStatementImport when a concurrent request wins the (account, periodStart, periodEnd) unique constraint first. */
export class StatementImportRaceError extends Error {}

export interface ExistingQboObservation {
    postedDate: string;
    amountCents: number;
    rawDescriptor: string;
    checkNumber: string | null;
}

export interface StatementImportLineInput {
    sequence: number;
    postedDate: string;
    amountCents: number;
    rawDescriptor: string;
    normalizedPayee: string;
    checkNumber: string | null;
    /** normalizedPayee stripped to "" — insert in EXCEPTION state rather than silently persisting an empty identity. */
    exception: boolean;
}

export interface BankLedgerIngestHandlerDependencies {
    getIngestSecret(): string | undefined;

    findStatementImport(account: string, periodStart: string, periodEnd: string): Promise<{ id: string; contentHash: string } | null>;

    countStatementObservations(statementImportId: string): Promise<number>;

    /** Inserts StatementImport + one BankLine/BankLineObservation pair per line, and finalizes — all in one transaction. */
    createStatementImport(input: {
        account: string;
        periodStart: string;
        periodEnd: string;
        openingCents: number;
        closingCents: number;
        contentHash: string;
        lines: StatementImportLineInput[];
    }): Promise<{ statementImportId: string; inserted: number }>;

    /** Returns the currently-stored content for each already-seen qbTxnId (whatever is present in the input list), keyed by qbTxnId — used to detect a retried id with DIFFERENT content. */
    findExistingQboObservations(account: string, qbTxnIds: string[]): Promise<Map<string, ExistingQboObservation>>;

    createQboObservations(rows: Array<{
        account: string;
        postedDate: string;
        amountCents: number;
        rawDescriptor: string;
        checkNumber: string | null;
        qbTxnId: string;
    }>): Promise<number>;
}

export function createBankLedgerIngestHandlers(dependencies: BankLedgerIngestHandlerDependencies) {
    async function handleStatement(body: IngestBody, account: string, rawLines: IngestLineInput[]) {
        if (!isValidCalendarDate(body.periodStart)) return NextResponse.json({ ok: false, reason: "invalid-period-start" }, { status: 400 });
        if (!isValidCalendarDate(body.periodEnd)) return NextResponse.json({ ok: false, reason: "invalid-period-end" }, { status: 400 });
        if (body.periodStart > body.periodEnd) return NextResponse.json({ ok: false, reason: "invalid-period-range" }, { status: 400 });
        if (!isSafeCents(body.openingCents)) return NextResponse.json({ ok: false, reason: "invalid-opening-cents" }, { status: 400 });
        if (!isSafeCents(body.closingCents)) return NextResponse.json({ ok: false, reason: "invalid-closing-cents" }, { status: 400 });

        const periodStart = body.periodStart;
        const periodEnd = body.periodEnd;
        const openingCents = body.openingCents;
        const closingCents = body.closingCents;

        const validated: ValidatedLineBase[] = [];
        for (let i = 0; i < rawLines.length; i++) {
            const result = validateStatementLine(rawLines[i] ?? {}, i);
            if (!result.ok) return NextResponse.json({ ok: false, reason: "invalid-line", index: result.error.index, field: result.error.field }, { status: 400 });
            validated.push(result.value);
        }

        const semanticFailures = validateStatementSemantics({
            periodStart,
            periodEnd,
            openingCents,
            closingCents,
            lines: validated.map(l => ({ postedDate: l.postedDate, amountCents: l.amountCents })),
        });
        if (semanticFailures.length > 0) {
            return NextResponse.json({
                ok: false,
                reason: semanticFailures[0].reason,
                index: semanticFailures[0].index,
                failures: semanticFailures,
            }, { status: 400 });
        }

        const contentHash = computeStatementContentHash({
            account,
            periodStart,
            periodEnd,
            openingCents,
            closingCents,
            lines: validated.map(l => ({ postedDate: l.postedDate, amountCents: l.amountCents, rawDescriptor: l.rawDescriptor, checkNumber: l.checkNumber })),
        });

        const resolveExisting = async () => {
            const existing = await dependencies.findStatementImport(account, periodStart, periodEnd);
            if (!existing) return null;
            if (existing.contentHash === contentHash) {
                const existingCount = await dependencies.countStatementObservations(existing.id);
                return NextResponse.json({ ok: true, statementImportId: existing.id, inserted: 0, existing: existingCount, replay: true });
            }
            return NextResponse.json({ ok: false, reason: "statement-conflict", account, periodStart, periodEnd }, { status: 409 });
        };

        const preExisting = await resolveExisting();
        if (preExisting) return preExisting;

        const lines: StatementImportLineInput[] = validated.map((l, sequence) => {
            const normalizedPayee = normalizePayee(l.rawDescriptor);
            return {
                sequence,
                postedDate: l.postedDate,
                amountCents: l.amountCents,
                rawDescriptor: l.rawDescriptor,
                normalizedPayee,
                checkNumber: l.checkNumber,
                exception: normalizedPayee === "",
            };
        });

        try {
            const result = await dependencies.createStatementImport({ account, periodStart, periodEnd, openingCents, closingCents, contentHash, lines });
            return NextResponse.json({ ok: true, statementImportId: result.statementImportId, inserted: result.inserted, existing: 0 });
        } catch (error) {
            if (error instanceof StatementImportRaceError) {
                const raced = await resolveExisting();
                if (raced) return raced;
            }
            throw error;
        }
    }

    async function handleQboRegister(account: string, rawLines: IngestLineInput[]) {
        const validated: ValidatedQboLine[] = [];
        for (let i = 0; i < rawLines.length; i++) {
            const result = validateQboLine(rawLines[i] ?? {}, i);
            if (!result.ok) return NextResponse.json({ ok: false, reason: "invalid-line", index: result.error.index, field: result.error.field }, { status: 400 });
            validated.push(result.value);
        }

        // Reject a qbTxnId that appears twice in THIS request with different
        // content before ever touching the database — two lines claiming the
        // same durable identity with different dates/amounts/descriptors
        // can't both be right, and picking one silently would be a guess.
        const seenInRequest = new Map<string, string>(); // qbTxnId -> content hash of the first occurrence
        for (let i = 0; i < validated.length; i++) {
            const line = validated[i];
            const hash = computeQboLineContentHash(line);
            const priorHash = seenInRequest.get(line.qbTxnId);
            if (priorHash !== undefined && priorHash !== hash) {
                return NextResponse.json({ ok: false, reason: "qbo-duplicate-conflict", index: i, qbTxnId: line.qbTxnId }, { status: 409 });
            }
            seenInRequest.set(line.qbTxnId, hash);
        }

        const qbTxnIds = [...seenInRequest.keys()];
        const existing = await dependencies.findExistingQboObservations(account, qbTxnIds);

        for (const line of validated) {
            const priorContent = existing.get(line.qbTxnId);
            if (priorContent && computeQboLineContentHash(priorContent) !== computeQboLineContentHash(line)) {
                return NextResponse.json({ ok: false, reason: "qbo-txn-conflict", qbTxnId: line.qbTxnId }, { status: 409 });
            }
        }

        // Content-identical repeats (already stored, or duplicated within this
        // request) collapse to a single insert attempt per qbTxnId — sequence
        // has no meaning here (unlike STATEMENT lines): qbTxnId IS the identity.
        const insertedQbTxnIds = new Set<string>();
        const rows: Array<{ account: string; postedDate: string; amountCents: number; rawDescriptor: string; checkNumber: string | null; qbTxnId: string }> = [];
        for (const line of validated) {
            if (existing.has(line.qbTxnId)) continue;
            if (insertedQbTxnIds.has(line.qbTxnId)) continue;
            insertedQbTxnIds.add(line.qbTxnId);
            rows.push({
                account,
                postedDate: line.postedDate,
                amountCents: line.amountCents,
                rawDescriptor: line.rawDescriptor,
                checkNumber: line.checkNumber,
                qbTxnId: line.qbTxnId,
            });
        }

        const inserted = rows.length > 0 ? await dependencies.createQboObservations(rows) : 0;
        const existingCount = validated.length - inserted;

        if (rows.length > 0 && inserted < rows.length) {
            // Race (Codex round-3, defect 7a): between the pre-insert
            // findExistingQboObservations() check above and this createMany,
            // a concurrent request for the SAME qbTxnId could have been
            // inserted first — createMany(skipDuplicates: true) silently
            // drops our row in that case rather than erroring, and
            // `inserted` alone can't tell us whether the winner's content
            // matched ours. Re-read every id we attempted and compare
            // content: a stored hash that differs from what THIS request
            // tried to insert means the concurrent writer's content was
            // genuinely different, and that must 409 like any other
            // qbo-txn-conflict — never a silent 200.
            const attemptedIds = rows.map(row => row.qbTxnId);
            const postInsert = await dependencies.findExistingQboObservations(account, attemptedIds);
            for (const row of rows) {
                const stored = postInsert.get(row.qbTxnId);
                if (!stored) continue;
                if (computeQboLineContentHash(stored) !== computeQboLineContentHash(row)) {
                    return NextResponse.json({ ok: false, reason: "qbo-txn-conflict", qbTxnId: row.qbTxnId }, { status: 409 });
                }
            }
        }

        return NextResponse.json({ ok: true, inserted, existing: existingCount });
    }

    return {
        async POST(request: Request) {
            const secret = dependencies.getIngestSecret();
            if (!secret || request.headers.get("x-ingest-key") !== secret) {
                return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
            }

            let bodyUnknown: unknown;
            try {
                bodyUnknown = await request.json();
            } catch {
                return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
            }

            if (bodyUnknown === null || typeof bodyUnknown !== "object" || Array.isArray(bodyUnknown)) {
                return NextResponse.json({ ok: false, reason: "invalid-body" }, { status: 400 });
            }
            const body = bodyUnknown as IngestBody;

            if (typeof body.source !== "string" || !VALID_SOURCES.has(body.source)) {
                return NextResponse.json({ ok: false, reason: "invalid-source" }, { status: 400 });
            }
            if (typeof body.account !== "string" || !body.account.trim() || body.account.length > MAX_ACCOUNT_LEN) {
                return NextResponse.json({ ok: false, reason: "invalid-account" }, { status: 400 });
            }
            if (!Array.isArray(body.lines) || body.lines.length === 0) {
                return NextResponse.json({ ok: false, reason: "missing-lines" }, { status: 400 });
            }
            if (body.lines.length > MAX_LINES_PER_REQUEST) {
                return NextResponse.json({ ok: false, reason: "too-many-lines", max: MAX_LINES_PER_REQUEST }, { status: 400 });
            }

            const account = body.account.trim();
            const rawLines = body.lines as IngestLineInput[];

            if (body.source === "STATEMENT") return handleStatement(body, account, rawLines);
            return handleQboRegister(account, rawLines);
        },
    };
}

function isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const handlers = createBankLedgerIngestHandlers({
    getIngestSecret: () => process.env.BANK_LEDGER_INGEST_SECRET,

    findStatementImport: async (account, periodStart, periodEnd) => {
        const row = await prisma.statementImport.findUnique({
            where: { account_periodStart_periodEnd: { account, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd) } },
            select: { id: true, contentHash: true },
        });
        return row;
    },

    countStatementObservations: async statementImportId => {
        return prisma.bankLineObservation.count({ where: { statementImportId } });
    },

    createStatementImport: async input => {
        try {
            return await prisma.$transaction(async tx => {
                const statementImport = await tx.statementImport.create({
                    data: {
                        account: input.account,
                        periodStart: new Date(input.periodStart),
                        periodEnd: new Date(input.periodEnd),
                        openingCents: input.openingCents,
                        closingCents: input.closingCents,
                        contentHash: input.contentHash,
                        status: "FINALIZED",
                    },
                });

                // Pre-generate every id so both tables can be bulk-inserted with
                // createMany (2 statements total) instead of one create() per
                // line per table (2N serial round-trips) — see the module
                // comment / MAX_LINES_PER_REQUEST for why that mattered.
                const bankLineIds = input.lines.map(() => randomUUID());

                await tx.bankLine.createMany({
                    data: input.lines.map((line, i) => ({
                        id: bankLineIds[i],
                        account: input.account,
                        postedDate: new Date(line.postedDate),
                        amountCents: line.amountCents,
                        rawDescriptor: line.rawDescriptor,
                        normalizedPayee: line.normalizedPayee,
                        checkNumber: line.checkNumber,
                        state: line.exception ? "EXCEPTION" : "POSTED",
                        exceptionReason: line.exception ? "empty-normalized-payee" : null,
                    })),
                });

                await tx.bankLineObservation.createMany({
                    data: input.lines.map((line, i) => ({
                        id: randomUUID(),
                        source: "STATEMENT",
                        account: input.account,
                        sourceDocumentId: statementImport.id,
                        sourceLineId: String(line.sequence),
                        postedDate: new Date(line.postedDate),
                        amountCents: line.amountCents,
                        rawDescriptor: line.rawDescriptor,
                        checkNumber: line.checkNumber,
                        bankLineId: bankLineIds[i],
                        statementImportId: statementImport.id,
                    })),
                });

                return { statementImportId: statementImport.id, inserted: input.lines.length };
            });
        } catch (error) {
            if (isUniqueConstraintError(error)) throw new StatementImportRaceError();
            throw error;
        }
    },

    findExistingQboObservations: async (account, qbTxnIds) => {
        const rows = await prisma.bankLineObservation.findMany({
            where: { source: "QBO_REGISTER", account, sourceDocumentId: "QBO_REGISTER", sourceLineId: { in: qbTxnIds } },
            select: { sourceLineId: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
        });
        const result = new Map<string, ExistingQboObservation>();
        for (const row of rows) {
            result.set(row.sourceLineId, {
                postedDate: row.postedDate.toISOString().slice(0, 10),
                amountCents: row.amountCents,
                rawDescriptor: row.rawDescriptor,
                checkNumber: row.checkNumber,
            });
        }
        return result;
    },

    createQboObservations: async rows => {
        const result = await prisma.bankLineObservation.createMany({
            data: rows.map(row => ({
                source: "QBO_REGISTER",
                account: row.account,
                sourceDocumentId: "QBO_REGISTER",
                sourceLineId: row.qbTxnId,
                postedDate: new Date(row.postedDate),
                amountCents: row.amountCents,
                rawDescriptor: row.rawDescriptor,
                checkNumber: row.checkNumber,
            })),
            skipDuplicates: true,
        });
        return result.count;
    },
});

export async function POST(request: Request) {
    return handlers.POST(request);
}

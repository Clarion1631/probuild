import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
    isDescriptorOnlyChange,
    normalizePayee,
    computeStatementContentHash,
    computeQboLineContentHash,
    validateStatementSemantics,
    isValidCalendarDate,
    isSafeCents,
} from "@/lib/bank-ledger";
import { BANK_LINE_IDENTITY_LOCK, bankLineIdentityPayee, planStatementAdoption } from "@/lib/bank-line-mint";
import { bumpBankLedgerEpoch } from "@/lib/bank-ledger-epoch";
import { isClearedStatusValue, type ClearedStatus } from "@/lib/register-types";

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

/** One statement is one transaction; give it a budget the default 5s is not. */
const STATEMENT_TX_TIMEOUT_MS = 20_000;
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
    clearedStatus?: unknown; // QBO_REGISTER only — see ValidatedQboLine
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
    /**
     * QuickBooks' own bank-clearance answer for this row.
     *
     * MUTABLE STATE, NOT IDENTITY. It is deliberately absent from
     * `computeQboLineContentHash`: an uncleared row that later clears is the
     * SAME transaction, and hashing this would answer that ordinary transition
     * with a 409 restatement conflict and stall the nightly pull forever.
     * "Unknown" means the caller could not ask — it never overwrites a stored
     * answer (see the refresh below).
     */
    clearedStatus: ClearedStatus;
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
            checkNumber: typeof raw.checkNumber === "string" && raw.checkNumber.trim() !== "" ? raw.checkNumber : null,
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
    // Absent is legal and means "Unknown" — a caller that cannot ask must not
    // be forced to invent an answer. A PRESENT but unrecognised value is a
    // caller bug and is refused, so a typo can never read as a clearance.
    if (raw.clearedStatus !== undefined && raw.clearedStatus !== null && !isClearedStatusValue(raw.clearedStatus)) {
        return { ok: false, error: { index, field: "clearedStatus" } };
    }
    const clearedStatus: ClearedStatus = isClearedStatusValue(raw.clearedStatus) ? raw.clearedStatus : "Unknown";
    return { ok: true, value: { ...common.value, qbTxnId: raw.qbTxnId, clearedStatus } };
}

/** Thrown by createStatementImport when a concurrent request wins the (account, periodStart, periodEnd) unique constraint first. */
export class StatementImportRaceError extends Error {}

/**
 * Thrown by createQboObservations — from INSIDE its own create+recheck
 * transaction (Codex round-4 fix 2) — when the post-insert re-read finds a
 * concurrent writer's stored content for `qbTxnId` that differs from what
 * this request tried to insert. Throwing from inside that transaction rolls
 * back every row THIS call attempted to insert, not just the conflicting
 * one, so a 409 built from this error always means nothing from the request
 * was persisted.
 */
export class QboIngestConflictError extends Error {
    constructor(public readonly qbTxnId: string) {
        super(`qbo-txn-conflict: ${qbTxnId}`);
    }
}

export interface ExistingQboObservation {
    postedDate: string;
    amountCents: number;
    rawDescriptor: string;
    checkNumber: string | null;
    /**
     * The stored clearance answer, or null on rows written before the column
     * existed. Read only to decide whether a refresh is needed — it is not part
     * of `computeQboLineContentHash` and must never make a row a restatement.
     */
    clearedStatus?: string | null;
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
    }): Promise<{ statementImportId: string; inserted: number; adopted?: number }>;

    /** Returns the currently-stored content for each already-seen qbTxnId (whatever is present in the input list), keyed by qbTxnId — used to detect a retried id with DIFFERENT content. */
    findExistingQboObservations(account: string, qbTxnIds: string[]): Promise<Map<string, ExistingQboObservation>>;

    /**
     * Inserts `rows` via createMany(skipDuplicates), then — for any row that
     * createMany silently skipped because a concurrent request won the race
     * for the same qbTxnId — re-reads that qbTxnId's stored content and
     * compares. Codex round-4 fix 2: the insert, the re-read, and the
     * compare must all run inside ONE transaction, and a content mismatch
     * must throw QboIngestConflictError from INSIDE it (never return a
     * count and let the caller 409 afterward) — otherwise a mixed batch can
     * commit its non-conflicting rows before the conflict is discovered,
     * and a 409 response would be lying about what's in the database. The
     * caller (handleQboRegister below) treats any throw here as "nothing
     * from this call was persisted."
     */
    /**
     * Updates the stored descriptor for observations whose identity is
     * unchanged. Returns how many rows were touched.
     */
    refreshQboDescriptors(account: string, rows: Array<{ qbTxnId: string; rawDescriptor: string }>): Promise<number>;

    createQboObservations(rows: Array<{
        account: string;
        postedDate: string;
        amountCents: number;
        rawDescriptor: string;
        checkNumber: string | null;
        qbTxnId: string;
        clearedStatus: ClearedStatus;
    }>): Promise<number>;

    /**
     * Moves the stored clearance answer on observations that already exist.
     * Returns how many rows were touched.
     *
     * No identity lock: `clearedStatus` takes no part in the identity key that
     * minting, reconcile and statement adoption plan against, so unlike
     * `refreshQboDescriptors` this cannot fork a line. It also never touches
     * the canonical BankLine — a line that was minted was minted from a cleared
     * row, and a later status change does not un-mint it.
     */
    refreshQboClearedStatus(account: string, rows: Array<{ qbTxnId: string; clearedStatus: ClearedStatus }>): Promise<number>;
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
            // `adopted` says how many lines attached to a canonical row the QBO
            // pull had already minted, instead of minting a twin.
            return NextResponse.json({ ok: true, statementImportId: result.statementImportId, inserted: result.inserted, existing: 0, adopted: result.adopted ?? 0 });
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

        // A DESCRIPTOR-ONLY difference is not a restatement. Rows stored before
        // the pull stopped appending the transaction type carry the old text;
        // refusing them would stall the nightly pull forever on transactions
        // that never changed. Same identity, newer words: take the newer words.
        const refreshDescriptors: Array<{ qbTxnId: string; rawDescriptor: string }> = [];
        for (const line of validated) {
            const priorContent = existing.get(line.qbTxnId);
            if (!priorContent) continue;
            if (computeQboLineContentHash(priorContent) !== computeQboLineContentHash(line)) {
                return NextResponse.json({ ok: false, reason: "qbo-txn-conflict", qbTxnId: line.qbTxnId }, { status: 409 });
            }
            if (isDescriptorOnlyChange(priorContent, line)) {
                refreshDescriptors.push({ qbTxnId: line.qbTxnId, rawDescriptor: line.rawDescriptor });
            }
        }
        let descriptorsRefreshed = 0;
        if (refreshDescriptors.length > 0) {
            descriptorsRefreshed = await dependencies.refreshQboDescriptors(account, refreshDescriptors);
        }

        // CLEARANCE MOVES; IDENTITY DOES NOT. Every uncleared row is expected
        // to clear eventually, so this is an UPDATE on an existing observation,
        // never a restatement — which is why clearedStatus is outside the
        // content hash and why this runs for every existing row, not only the
        // ones whose descriptor changed.
        //
        // "Unknown" NEVER OVERWRITES. It is what a failed clearance probe
        // produces, and letting it land would wipe every stored answer on the
        // first bad night — after which nothing could mint until QuickBooks was
        // asked again. Absence of evidence does not erase evidence.
        const refreshCleared: Array<{ qbTxnId: string; clearedStatus: ClearedStatus }> = [];
        const clearedSeen = new Set<string>();
        for (const line of validated) {
            const prior = existing.get(line.qbTxnId);
            if (!prior) continue;
            if (line.clearedStatus === "Unknown") continue;
            if (prior.clearedStatus === line.clearedStatus) continue;
            if (clearedSeen.has(line.qbTxnId)) continue;
            clearedSeen.add(line.qbTxnId);
            refreshCleared.push({ qbTxnId: line.qbTxnId, clearedStatus: line.clearedStatus });
        }
        let clearedRefreshed = 0;
        if (refreshCleared.length > 0) {
            clearedRefreshed = await dependencies.refreshQboClearedStatus(account, refreshCleared);
        }

        // Content-identical repeats (already stored, or duplicated within this
        // request) collapse to a single insert attempt per qbTxnId — sequence
        // has no meaning here (unlike STATEMENT lines): qbTxnId IS the identity.
        const insertedQbTxnIds = new Set<string>();
        const rows: Array<{ account: string; postedDate: string; amountCents: number; rawDescriptor: string; checkNumber: string | null; qbTxnId: string; clearedStatus: ClearedStatus }> = [];
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
                clearedStatus: line.clearedStatus,
            });
        }

        let inserted = 0;
        if (rows.length > 0) {
            try {
                inserted = await dependencies.createQboObservations(rows);
            } catch (error) {
                if (error instanceof QboIngestConflictError) {
                    // Codex round-4 fix 2: createQboObservations threw from
                    // inside its own create+recheck transaction, so nothing
                    // this call attempted to insert was persisted — return a
                    // plain 409 with no partial inserted/existing counts.
                    return NextResponse.json({ ok: false, reason: "qbo-txn-conflict", qbTxnId: error.qbTxnId }, { status: 409 });
                }
                throw error;
            }
        }
        const existingCount = validated.length - inserted;

        return NextResponse.json({ ok: true, inserted, existing: existingCount, descriptorsRefreshed, clearedRefreshed });
    }

    return {
        /**
         * The QBO_REGISTER branch, exposed so an IN-PROCESS caller (the
         * nightly `/api/cron/bank-register-pull`) runs the SAME validation,
         * same content-conflict detection, and same writes the external
         * `post-qbo-register.mjs` runner did over HTTP — rather than a second
         * implementation that could drift. It deliberately skips only the
         * shared-secret check, which exists to authenticate a NETWORK caller;
         * the cron is already authorized by `isCronAuthorized`.
         */
        handleQboRegister,

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
                // The SAME identity lock the nightly mint takes, held across
                // the adoption read and every write below. Without it a mint
                // committing between this read and these inserts would leave a
                // QBO line the statement never adopted, plus the twin.
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BANK_LINE_IDENTITY_LOCK}))`;
                // AND THE LEDGER EPOCH, BEFORE ANY BankLine WRITE (round-37 gate,
                // finding 3). The chaser fences its completion stamp on this
                // counter; bumping it first is what makes that fence real —
                // this transaction holds the row until it commits, so a chaser
                // validating at the same moment waits and then sees movement
                // instead of certifying a list these rows are missing from.
                await bumpBankLedgerEpoch(tx);

                // ADOPTION (Justin, decision 3). The nightly QBO pull may have
                // already minted a canonical line for some of these
                // transactions. Minting a second one would be the dual-identity
                // failure that the "statements only" rule used to prevent, so a
                // statement line that matches a QBO-minted line EXACTLY
                // (account+date+amount+payee+check#) attaches to it and flips
                // sourceOfRecord to STATEMENT instead of creating a twin.
                //
                // Read inside the transaction, so a mint committing between a
                // pre-read and this write can't be missed.
                const adoptable = await tx.bankLine.findMany({
                    where: {
                        account: input.account,
                        sourceOfRecord: "QBO",
                        postedDate: { gte: new Date(input.periodStart), lte: new Date(input.periodEnd) },
                    },
                    select: { id: true, account: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, sourceOfRecord: true, qbTxnId: true },
                });
                const adoptionPlan = planStatementAdoption(
                    input.lines.map(line => ({
                        sequence: line.sequence,
                        postedDate: line.postedDate,
                        amountCents: line.amountCents,
                        normalizedPayee: bankLineIdentityPayee({ memo: line.rawDescriptor }),
                        checkNumber: line.checkNumber,
                    })),
                    adoptable.map(row => ({
                        id: row.id,
                        qbTxnId: row.qbTxnId,
                        account: row.account,
                        postedDate: row.postedDate.toISOString().slice(0, 10),
                        amountCents: row.amountCents,
                        // ONE identity function, both sides.
                        normalizedPayee: bankLineIdentityPayee({ memo: row.rawDescriptor }),
                        checkNumber: row.checkNumber,
                        sourceOfRecord: row.sourceOfRecord,
                    })),
                    input.account,
                );
                if (adoptionPlan.ambiguous.length > 0) {
                    // Reported, never guessed: those lines mint as they always
                    // did, and the stale QBO line stays visible for a human.
                    console.warn("[bank-ledger/ingest] ambiguous adoption groups", adoptionPlan.ambiguous.length);
                }

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
                // comment / MAX_LINES_PER_REQUEST for why that mattered. An
                // ADOPTED line reuses the QBO-minted line's id instead, so the
                // observation below attaches to the existing canonical row.
                const bankLineIds = input.lines.map(line => adoptionPlan.adopt.get(line.sequence) ?? randomUUID());
                const mintedIndexes = input.lines
                    .map((line, i) => (adoptionPlan.adopt.has(line.sequence) ? -1 : i))
                    .filter(i => i >= 0);

                await tx.bankLine.createMany({
                    data: mintedIndexes.map(i => {
                        const line = input.lines[i];
                        return {
                            id: bankLineIds[i],
                            account: input.account,
                            postedDate: new Date(line.postedDate),
                            amountCents: line.amountCents,
                            rawDescriptor: line.rawDescriptor,
                            normalizedPayee: line.normalizedPayee,
                            checkNumber: line.checkNumber,
                            state: line.exception ? "EXCEPTION" : "POSTED",
                            exceptionReason: line.exception ? "empty-normalized-payee" : null,
                        };
                    }),
                });

                // The statement now owns every line it adopted. `amountCents`
                // is immutable by trigger and identical by construction (it is
                // part of the match key), so this touches only the flag and the
                // descriptor the statement is authoritative for.
                const adoptedIds = [...adoptionPlan.adopt.values()];
                if (adoptedIds.length > 0) {
                    // THE STATEMENT'S DESCRIPTOR WINS, per line, not just the
                    // flag. The QBO descriptor is "LOWES #02516 Expense"; the
                    // statement's carries "C#8516" — the ONLY evidence of whose
                    // card it was. Flipping sourceOfRecord while leaving the
                    // QBO text behind left every adopted line owned by
                    // "office", so nobody was ever asked for the receipt.
                    // `amountCents` is untouched (immutable by trigger, and
                    // identical by construction — it is part of the match key).
                    for (const [sequence, bankLineId] of adoptionPlan.adopt) {
                        const line = input.lines.find(l => l.sequence === sequence);
                        if (!line) continue;
                        await tx.bankLine.updateMany({
                            where: { id: bankLineId, sourceOfRecord: "QBO" },
                            data: {
                                sourceOfRecord: "STATEMENT",
                                rawDescriptor: line.rawDescriptor,
                                normalizedPayee: line.normalizedPayee,
                                checkNumber: line.checkNumber,
                            },
                        });
                    }
                }

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

                return { statementImportId: statementImport.id, inserted: input.lines.length, adopted: adoptedIds.length };
            }, {
                // EXPLICIT, because Prisma's interactive-transaction default is
                // 5s and this one holds the identity lock across the adoption
                // read, two bulk inserts and a per-adopted-line update. A
                // statement is bounded (MAX_LINES_PER_REQUEST) so one
                // transaction is right here — but it needs a real budget, not
                // the default that silently rolls a good import back.
                timeout: STATEMENT_TX_TIMEOUT_MS,
            });
        } catch (error) {
            if (isUniqueConstraintError(error)) throw new StatementImportRaceError();
            throw error;
        }
    },

    findExistingQboObservations: async (account, qbTxnIds) => {
        const rows = await prisma.bankLineObservation.findMany({
            where: { source: "QBO_REGISTER", account, sourceDocumentId: "QBO_REGISTER", sourceLineId: { in: qbTxnIds } },
            select: { sourceLineId: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, clearedStatus: true },
        });
        const result = new Map<string, ExistingQboObservation>();
        for (const row of rows) {
            result.set(row.sourceLineId, {
                postedDate: row.postedDate.toISOString().slice(0, 10),
                amountCents: row.amountCents,
                rawDescriptor: row.rawDescriptor,
                checkNumber: row.checkNumber,
                clearedStatus: row.clearedStatus,
            });
        }
        return result;
    },

    refreshQboClearedStatus: async (account, rows) => {
        let touched = 0;
        for (const row of rows) {
            // A PLAIN UPDATE, no identity lock and no BankLine write. Clearance
            // is not part of the identity key minting and adoption plan
            // against, so there is nothing here for a concurrent planner to
            // disagree with — and a canonical line that was already minted
            // stays minted: it was minted from a cleared row, and QuickBooks
            // moving that row back to uncleared is a human's problem, not
            // grounds for this cron to unpick a canonical line.
            //
            // Guarded on the stored value so the count reports real movement.
            // The guard is spelled out as an explicit OR rather than a bare
            // `not`: the column is nullable, and in SQL a NULL row does not
            // satisfy `clearedStatus <> 'Cleared'` — which is precisely the
            // row that has never been asked about and most needs the update.
            const result = await prisma.bankLineObservation.updateMany({
                where: {
                    source: "QBO_REGISTER",
                    account,
                    sourceDocumentId: "QBO_REGISTER",
                    sourceLineId: row.qbTxnId,
                    OR: [
                        { clearedStatus: null },
                        { clearedStatus: { not: row.clearedStatus } },
                    ],
                },
                data: { clearedStatus: row.clearedStatus },
            });
            touched += result.count;
        }
        return touched;
    },

    refreshQboDescriptors: async (account, rows) => {
        let touched = 0;
        for (const row of rows) {
            // ONE TRANSACTION PER OBSERVATION, because the canonical line it
            // minted has to move with it. Half of this landing is the bug it
            // fixes, one layer down.
            touched += await prisma.$transaction(async tx => {
                /**
                 * THE IDENTITY LOCK, FIRST.
                 *
                 * `rawDescriptor` and `normalizedPayee` are what minting and
                 * statement adoption plan against, and both take this lock
                 * precisely so no two writers can be looking at different
                 * versions of an identity at once. This refresh rewrites those
                 * two columns, so without the lock it is a third writer working
                 * outside the agreement: an adoption planned from the OLD payee
                 * commits against the NEW one, sees no match, and mints a
                 * second canonical line for a transaction that already had one.
                 * `amountCents` is immutable by trigger, so only a human can
                 * unpick that.
                 *
                 * $executeRaw, not $queryRaw: pg_advisory_xact_lock returns
                 * void, and the query form trips the raw-SQL guard.
                 */
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BANK_LINE_IDENTITY_LOCK}))`;
                // AND THE LEDGER EPOCH, BEFORE ANY BankLine WRITE (round-37 gate,
                // finding 3). The chaser fences its completion stamp on this
                // counter; bumping it first is what makes that fence real —
                // this transaction holds the row until it commits, so a chaser
                // validating at the same moment waits and then sees movement
                // instead of certifying a list these rows are missing from.
                await bumpBankLedgerEpoch(tx);
                const result = await tx.bankLineObservation.updateMany({
                    where: {
                        source: "QBO_REGISTER",
                        account,
                        sourceDocumentId: "QBO_REGISTER",
                        sourceLineId: row.qbTxnId,
                    },
                    data: { rawDescriptor: row.rawDescriptor },
                });
                if (result.count === 0) return 0;

                /**
                 * AND THE LINE IT MINTED, if it minted one.
                 *
                 * A QBO-minted BankLine copies the observation's descriptor at
                 * mint time. When the pull stopped appending the transaction
                 * type, every stored observation refreshed to the real bank
                 * text — the one that carries `C#8516` — while the canonical
                 * line kept the old, tail-less copy. The missing-receipt chaser
                 * reads the LINE, so every one of those charges resolved to
                 * `office`, the crew was never asked, and the descriptors on
                 * screen disagreed with the descriptors in the ledger.
                 *
                 * Narrow on purpose:
                 *   - `sourceOfRecord: "QBO"` — a STATEMENT line is bank truth
                 *     and a QBO edit may never rewrite it.
                 *   - one observation only — a line carrying several QBO
                 *     observations has no single "its" descriptor.
                 *   - `state: "POSTED"` — an unmatched line. Once it is matched
                 *     or reconciled its text is part of a decision somebody has
                 *     already made against it.
                 */
                const observations = await tx.bankLineObservation.findMany({
                    where: {
                        source: "QBO_REGISTER",
                        account,
                        sourceDocumentId: "QBO_REGISTER",
                        sourceLineId: row.qbTxnId,
                        bankLineId: { not: null },
                    },
                    select: { bankLineId: true },
                });
                const lineIds = [...new Set(observations.map(o => o.bankLineId as string))];
                for (const lineId of lineIds) {
                    const observationCount = await tx.bankLineObservation.count({
                        where: { bankLineId: lineId, source: "QBO_REGISTER" },
                    });
                    if (observationCount !== 1) continue;
                    await tx.bankLine.updateMany({
                        where: { id: lineId, sourceOfRecord: "QBO", state: "POSTED" },
                        data: {
                            rawDescriptor: row.rawDescriptor,
                            // The payee is DERIVED, so it has to be re-derived
                            // — a refreshed descriptor with a stale normalized
                            // payee is the same disagreement in a second column.
                            normalizedPayee: bankLineIdentityPayee({ memo: row.rawDescriptor }),
                        },
                    });
                }
                return result.count;
            });
        }
        return touched;
    },

    createQboObservations: async rows => {
        // Codex round-4 fix 2: create, re-read, and compare all run inside
        // ONE transaction. If any attempted qbTxnId turns out to have been
        // won by a concurrent writer with DIFFERENT content, the thrown
        // QboIngestConflictError aborts this transaction — rolling back
        // every row THIS call inserted, not just the conflicting one — so a
        // 409 built from it always means nothing from this request persisted.
        return prisma.$transaction(async tx => {
            const result = await tx.bankLineObservation.createMany({
                data: rows.map(row => ({
                    source: "QBO_REGISTER",
                    account: row.account,
                    sourceDocumentId: "QBO_REGISTER",
                    sourceLineId: row.qbTxnId,
                    postedDate: new Date(row.postedDate),
                    amountCents: row.amountCents,
                    rawDescriptor: row.rawDescriptor,
                    checkNumber: row.checkNumber,
                    clearedStatus: row.clearedStatus,
                })),
                skipDuplicates: true,
            });

            if (result.count < rows.length) {
                // Race (Codex round-3, defect 7a): between the pre-insert
                // findExistingQboObservations() check and this createMany, a
                // concurrent request for the SAME qbTxnId could have been
                // inserted first — createMany(skipDuplicates: true) silently
                // drops our row in that case rather than erroring, and
                // `result.count` alone can't tell us whether the winner's
                // content matched ours. Re-read every id we attempted, in
                // the SAME transaction, and compare content.
                const account = rows[0]?.account;
                const attemptedIds = rows.map(row => row.qbTxnId);
                const postInsertRows = await tx.bankLineObservation.findMany({
                    where: { source: "QBO_REGISTER", account, sourceDocumentId: "QBO_REGISTER", sourceLineId: { in: attemptedIds } },
                    select: { sourceLineId: true, postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true },
                });
                // clearedStatus is deliberately NOT read here: the comparison
                // below is a CONTENT-IDENTITY check, and clearance is not part
                // of identity. A concurrent writer that stored a newer
                // clearance is not a conflict.
                const postInsert = new Map<string, ExistingQboObservation>();
                for (const row of postInsertRows) {
                    postInsert.set(row.sourceLineId, {
                        postedDate: row.postedDate.toISOString().slice(0, 10),
                        amountCents: row.amountCents,
                        rawDescriptor: row.rawDescriptor,
                        checkNumber: row.checkNumber,
                    });
                }
                for (const row of rows) {
                    const stored = postInsert.get(row.qbTxnId);
                    if (!stored) {
                        // An id we attempted is neither inserted by us nor
                        // readable now (concurrent delete or key-changing
                        // update). We can't prove the skip was benign, so
                        // abort the whole request — a 409 must mean nothing
                        // from this request was written (Codex round-5).
                        throw new QboIngestConflictError(row.qbTxnId);
                    }
                    if (computeQboLineContentHash(stored) !== computeQboLineContentHash(row)) {
                        throw new QboIngestConflictError(row.qbTxnId);
                    }
                }
            }

            return result.count;
        });
    },
});

/** Production-wired handlers, exported for the in-process cron caller. */
export const bankLedgerIngestHandlers = handlers;

export async function POST(request: Request) {
    return handlers.POST(request);
}

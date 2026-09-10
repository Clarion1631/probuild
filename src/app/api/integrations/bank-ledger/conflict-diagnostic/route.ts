import { NextResponse } from "next/server";
import { hasCronSecret } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { createRouteDeadline, qbFetch } from "@/lib/quickbooks";
import { getFreshQBTokens } from "@/lib/quickbooks-payments";
import { fetchBankRegister, type BankRegisterResult, type BankRegisterRow } from "@/lib/qbo-bank-register";

/**
 * GET /api/integrations/bank-ledger/conflict-diagnostic?qbTxnId=<digits>
 *
 * Narrow, READ-ONLY diagnostic for one QuickBooks transaction id on the fixed
 * WTB-0723 account. It returns, side by side and nothing else:
 *
 *   - what the nightly pull STORED for that id (BankLineObservation rows with
 *     source QBO_REGISTER, at most two so a duplicate is visible), including
 *     a bounded projection of the linked canonical BankLine and up to three
 *     STATEMENT observations (with their StatementImport controls/hash),
 *   - what the LIVE QuickBooks GL register says for the same id right now,
 *     over the same rolling 60-day UTC window the pull planner uses, and
 *   - optionally the LIVE Purchase entity, only when the register shows the
 *     id as an Expense or Check (never a blind entity guess for transfers).
 *
 * Everything is raw. The puller's descriptor/amount transformation is NOT
 * applied, so the response never claims the two sides match or differ.
 *
 * There is NO per-field revision history for QBO rows anywhere in probuild:
 * observations carry only createdAt. The response says so explicitly.
 *
 * No writes. Auth is the strict cron bearer with NO development bypass.
 * Upstream failures on the required reads collapse to a sanitized 503; the
 * optional Purchase read degrades to a status without hiding stored evidence.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const DIAGNOSTIC_ACCOUNT = "WTB-0723";
export const DIAGNOSTIC_SOURCE = "QBO_REGISTER";
export const STATEMENT_SOURCE = "STATEMENT";
export const ROLLING_WINDOW_DAYS = 60;
export const PURCHASE_READ_DEADLINE_MS = 10_000;
const STORED_LIMIT = 2;
const LINKED_STATEMENT_LIMIT = 3;
const QB_TXN_ID = /^\d{1,20}$/;
const PURCHASE_TYPES = new Set(["Expense", "Check"]);

export interface StatementImportProjection {
    id: string;
    account: string;
    periodStart: Date | string;
    periodEnd: Date | string;
    openingCents: number;
    closingCents: number;
    contentHash: string;
    status: string;
    createdAt: Date | string;
}

export interface LinkedStatementObservationRow {
    id: string;
    source: string;
    sourceDocumentId: string;
    sourceLineId: string;
    postedDate: Date | string;
    amountCents: number;
    rawDescriptor: string;
    checkNumber: string | null;
    createdAt: Date | string;
    statementImport: StatementImportProjection | null;
}

export interface LinkedBankLineRow {
    id: string;
    account: string;
    postedDate: Date | string;
    amountCents: number;
    rawDescriptor: string;
    normalizedPayee: string;
    checkNumber: string | null;
    state: string;
    sourceOfRecord: string;
    qbTxnId: string | null;
    qbBankMatched: boolean;
    probuildExpenseId: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
    observations: LinkedStatementObservationRow[];
}

export interface StoredObservationRow {
    id: string;
    createdAt: Date | string;
    bankLineId: string | null;
    postedDate: Date | string;
    amountCents: number;
    rawDescriptor: string | null;
    checkNumber: string | null;
    sourceLineId: string | null;
    bankLine: LinkedBankLineRow | null;
}

export const STORED_SELECT = {
    id: true,
    createdAt: true,
    bankLineId: true,
    postedDate: true,
    amountCents: true,
    rawDescriptor: true,
    checkNumber: true,
    sourceLineId: true,
    bankLine: {
        select: {
            id: true,
            account: true,
            postedDate: true,
            amountCents: true,
            rawDescriptor: true,
            normalizedPayee: true,
            checkNumber: true,
            state: true,
            sourceOfRecord: true,
            qbTxnId: true,
            qbBankMatched: true,
            probuildExpenseId: true,
            createdAt: true,
            updatedAt: true,
            observations: {
                where: { source: STATEMENT_SOURCE },
                orderBy: { id: "asc" },
                take: LINKED_STATEMENT_LIMIT,
                select: {
                    id: true,
                    source: true,
                    sourceDocumentId: true,
                    sourceLineId: true,
                    postedDate: true,
                    amountCents: true,
                    rawDescriptor: true,
                    checkNumber: true,
                    createdAt: true,
                    statementImport: {
                        select: {
                            id: true,
                            account: true,
                            periodStart: true,
                            periodEnd: true,
                            openingCents: true,
                            closingCents: true,
                            contentHash: true,
                            status: true,
                            createdAt: true,
                        },
                    },
                },
            },
        },
    },
} as const;

export interface StoredObservationClient {
    bankLineObservation: {
        findMany(input: {
            where: { source: string; account: string; sourceDocumentId: string; sourceLineId: string };
            select: typeof STORED_SELECT;
            take: number;
        }): Promise<StoredObservationRow[]>;
    };
}

export interface PurchaseProjection {
    Id: string;
    TxnDate: string | null;
    TotalAmt: number | null;
    EntityRef: { name: string | null; value: string | null } | null;
    AccountRef: { name: string | null; value: string | null } | null;
    PrivateNote: string | null;
    DocNumber: string | null;
    SyncToken: string | null;
    MetaData: { CreateTime: string | null; LastUpdatedTime: string | null } | null;
}

export type CurrentPurchaseResult =
    | { status: "ok"; purchase: PurchaseProjection }
    | { status: "mismatch" }
    | { status: "unavailable" }
    | { status: "not-applicable"; reason: string };

export interface ConflictDiagnosticDependencies {
    /** Strict bearer check. Must not consult anything but the request and the secret. */
    authorize(request: Request): boolean;
    /** Stored observations for exactly this id, already scoped by the adapter. */
    readStored(qbTxnId: string): Promise<StoredObservationRow[]>;
    /** Live register over the planner's rolling window. */
    readRegister(): Promise<BankRegisterResult>;
    /**
     * Live Purchase entity. Resolves to the raw QBO Purchase object, or null
     * when QBO reports 404. Throws on any other failure; the handler never
     * surfaces the exception. Called only for Expense/Check register rows.
     */
    readPurchase(qbTxnId: string, accountId: string): Promise<unknown>;
}

/**
 * Rolling 60 inclusive UTC calendar days ending today — the same window the
 * nightly pull planner requests.
 */
export function rollingWindow(now: Date = new Date()): { startDate: string; endDate: string } {
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const start = end - (ROLLING_WINDOW_DAYS - 1) * 86_400_000;
    return {
        startDate: new Date(start).toISOString().slice(0, 10),
        endDate: new Date(end).toISOString().slice(0, 10),
    };
}

/**
 * Prisma adapter. The scoping lives HERE, not in the handler, so no caller can
 * widen it: fixed source, fixed account, fixed source document, exact line id,
 * bounded projection (no receipt URLs, no person details), at most two rows,
 * at most three linked STATEMENT observations per line.
 */
export function createStoredReader(client: StoredObservationClient) {
    return async (qbTxnId: string): Promise<StoredObservationRow[]> =>
        client.bankLineObservation.findMany({
            where: {
                source: DIAGNOSTIC_SOURCE,
                account: DIAGNOSTIC_ACCOUNT,
                sourceDocumentId: DIAGNOSTIC_SOURCE,
                sourceLineId: qbTxnId,
            },
            select: STORED_SELECT,
            take: STORED_LIMIT,
        });
}

export interface PurchaseReaderDependencies {
    fetch: typeof qbFetch;
    tokens: typeof getFreshQBTokens;
    deadline: typeof createRouteDeadline;
}

/**
 * QBO adapter for GET /purchase/{id}. Null on 404, raw Purchase on 200,
 * throws otherwise. Nothing here writes.
 */
export function createPurchaseReader(deps: PurchaseReaderDependencies) {
    return async (qbTxnId: string): Promise<unknown> => {
        const deadline = deps.deadline(PURCHASE_READ_DEADLINE_MS);
        const tokens = await deps.tokens(deadline);
        const response = await deps.fetch(`/purchase/${encodeURIComponent(qbTxnId)}`, tokens, { qbDeadline: deadline });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`purchase read status ${response.status}`);
        const body = (await response.json()) as { Purchase?: unknown };
        return body && typeof body === "object" && "Purchase" in body ? body.Purchase : null;
    };
}

function parseQbTxnId(request: Request): string | null {
    const params = new URL(request.url).searchParams;
    const entries = Array.from(params.entries());
    // Exactly one parameter, and it must be qbTxnId: unknown, repeated and
    // missing keys are all rejected before any read happens.
    if (entries.length !== 1) return null;
    const [key, value] = entries[0];
    if (key !== "qbTxnId" || !QB_TXN_ID.test(value)) return null;
    return value;
}

function ymd(value: Date | string): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
}

function iso(value: Date | string): string {
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

function serializeStatementImport(row: StatementImportProjection | null) {
    if (!row) return null;
    return {
        id: row.id,
        account: row.account,
        periodStart: ymd(row.periodStart),
        periodEnd: ymd(row.periodEnd),
        openingCents: row.openingCents,
        closingCents: row.closingCents,
        contentHash: row.contentHash,
        status: row.status,
        createdAt: iso(row.createdAt),
    };
}

function serializeLinkedObservation(row: LinkedStatementObservationRow) {
    return {
        id: row.id,
        source: row.source,
        sourceDocumentId: row.sourceDocumentId,
        sourceLineId: row.sourceLineId,
        postedDate: ymd(row.postedDate),
        amountCents: row.amountCents,
        rawDescriptor: row.rawDescriptor,
        checkNumber: row.checkNumber ?? null,
        createdAt: iso(row.createdAt),
        statementImport: serializeStatementImport(row.statementImport),
    };
}

function serializeBankLine(row: LinkedBankLineRow | null) {
    if (!row) return null;
    return {
        id: row.id,
        account: row.account,
        postedDate: ymd(row.postedDate),
        amountCents: row.amountCents,
        rawDescriptor: row.rawDescriptor,
        normalizedPayee: row.normalizedPayee,
        checkNumber: row.checkNumber ?? null,
        state: row.state,
        sourceOfRecord: row.sourceOfRecord,
        qbTxnId: row.qbTxnId ?? null,
        qbBankMatched: row.qbBankMatched,
        probuildExpenseId: row.probuildExpenseId ?? null,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
        statementObservations: (row.observations ?? []).slice(0, LINKED_STATEMENT_LIMIT).map(serializeLinkedObservation),
    };
}

function serializeStored(row: StoredObservationRow) {
    return {
        id: row.id,
        createdAt: iso(row.createdAt),
        bankLineId: row.bankLineId ?? null,
        postedDate: ymd(row.postedDate),
        amountCents: row.amountCents,
        rawDescriptor: row.rawDescriptor ?? null,
        checkNumber: row.checkNumber ?? null,
        sourceLineId: row.sourceLineId ?? null,
        bankLine: serializeBankLine(row.bankLine ?? null),
    };
}

function serializeRegisterRow(row: BankRegisterRow) {
    return {
        date: row.date,
        qbType: row.qbType,
        qbTxnId: row.qbTxnId,
        docNum: row.docNum,
        name: row.name,
        memo: row.memo,
        amountCents: row.amountCents,
        clearedStatus: row.clearedStatus,
    };
}

function str(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ref(value: unknown): { name: string | null; value: string | null } | null {
    if (!value || typeof value !== "object") return null;
    const r = value as Record<string, unknown>;
    return { name: str(r.name), value: str(r.value) };
}

/**
 * Projects the raw Purchase to the allow-listed fields, and refuses to emit
 * ANY of it unless the entity id and the bank AccountRef match what was asked
 * for. A foreign entity yields a bare mismatch status with no data.
 */
export function projectPurchase(raw: unknown, qbTxnId: string, accountId: string): CurrentPurchaseResult {
    if (!raw || typeof raw !== "object") return { status: "unavailable" };
    const p = raw as Record<string, unknown>;
    const accountRef = ref(p.AccountRef);
    if (str(p.Id) !== qbTxnId || accountRef?.value !== accountId) return { status: "mismatch" };
    const meta = p.MetaData && typeof p.MetaData === "object" ? (p.MetaData as Record<string, unknown>) : null;
    return {
        status: "ok",
        purchase: {
            Id: qbTxnId,
            TxnDate: str(p.TxnDate),
            TotalAmt: num(p.TotalAmt),
            EntityRef: ref(p.EntityRef),
            AccountRef: accountRef,
            PrivateNote: str(p.PrivateNote),
            DocNumber: str(p.DocNumber),
            SyncToken: str(p.SyncToken),
            MetaData: meta ? { CreateTime: str(meta.CreateTime), LastUpdatedTime: str(meta.LastUpdatedTime) } : null,
        },
    };
}

export function createConflictDiagnosticHandlers(deps: ConflictDiagnosticDependencies) {
    async function GET(request: Request): Promise<Response> {
        if (!deps.authorize(request)) {
            return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
        }
        const qbTxnId = parseQbTxnId(request);
        if (!qbTxnId) {
            return NextResponse.json({ ok: false, reason: "invalid-query" }, { status: 400 });
        }

        let stored: StoredObservationRow[];
        let register: BankRegisterResult;
        try {
            stored = await deps.readStored(qbTxnId);
            register = await deps.readRegister();
        } catch (error) {
            // Log the class only; the response carries no exception text.
            console.error("conflict diagnostic upstream failed", error instanceof Error ? error.name : "UnknownError");
            return NextResponse.json({ ok: false, reason: "upstream-unavailable" }, { status: 503 });
        }

        const rows = register.rows.filter(row => row.qbTxnId === qbTxnId);
        const purchaseTyped = rows.some(row => PURCHASE_TYPES.has(row.qbType));
        let currentPurchase: CurrentPurchaseResult = {
            status: "not-applicable",
            reason: "no Expense or Check register row for this id; Purchase entity not guessed",
        };
        if (purchaseTyped) {
            try {
                const raw = await deps.readPurchase(qbTxnId, register.accountId);
                currentPurchase = raw === null ? { status: "unavailable" } : projectPurchase(raw, qbTxnId, register.accountId);
            } catch (error) {
                console.error("conflict diagnostic purchase read failed", error instanceof Error ? error.name : "UnknownError");
                currentPurchase = { status: "unavailable" };
            }
        }

        return NextResponse.json({
            ok: true,
            account: DIAGNOSTIC_ACCOUNT,
            source: DIAGNOSTIC_SOURCE,
            qbTxnId,
            historyStatus: "not-recorded",
            stored: stored.map(serializeStored),
            register: {
                stale: register.stale,
                fetchedAt: register.fetchedAt,
                clearedProbeOk: register.clearedProbeOk,
                startDate: register.startDate,
                endDate: register.endDate,
                rows: rows.map(serializeRegisterRow),
            },
            currentPurchase,
            note: "Raw rows from both sides. The puller transformation is not applied; no identity or mismatch claim is made.",
            limitations: [
                "QBO source history is not recorded: probuild keeps no immutable per-field revision history for QBO_REGISTER observations, only createdAt.",
                "Metadata timestamps (observation createdAt, BankLine createdAt/updatedAt, Purchase MetaData) show when a record was written or last touched; they do not prove which field changed or what its prior value was.",
                "Linked STATEMENT observations and StatementImport controls/contentHash are the bank-side evidence; QBO rows are not the source of truth.",
            ],
        });
    }
    return { GET };
}

const handlers = createConflictDiagnosticHandlers({
    authorize: hasCronSecret,
    // Built lazily so the Prisma proxy is touched only by an authorized,
    // validated request.
    readStored: qbTxnId => createStoredReader(prisma as unknown as StoredObservationClient)(qbTxnId),
    readRegister: () => {
        const { startDate, endDate } = rollingWindow();
        return fetchBankRegister(getFreshQBTokens, startDate, endDate);
    },
    readPurchase: qbTxnId =>
        createPurchaseReader({ fetch: qbFetch, tokens: getFreshQBTokens, deadline: createRouteDeadline })(qbTxnId),
});

export const GET = handlers.GET;

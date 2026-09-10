import { NextResponse } from "next/server";
import { hasCronSecret } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { getFreshQBTokens } from "@/lib/quickbooks-payments";
import { fetchBankRegister, type BankRegisterResult, type BankRegisterRow } from "@/lib/qbo-bank-register";

/**
 * GET /api/integrations/bank-ledger/conflict-diagnostic?qbTxnId=<digits>
 *
 * Narrow, READ-ONLY diagnostic for one QuickBooks transaction id on the fixed
 * WTB-0723 account. It returns two things side by side and nothing else:
 *
 *   - what the nightly pull STORED for that id (BankLineObservation rows with
 *     source QBO_REGISTER, at most two so a duplicate is visible), and
 *   - what the LIVE QuickBooks GL register says for the same id right now,
 *     over the same rolling 60-day UTC window the pull planner uses.
 *
 * Both are returned raw. The puller's descriptor/amount transformation is NOT
 * applied here, so the response never claims the two sides match or differ —
 * it only shows the operator the material to decide with.
 *
 * No writes. `fetchBankRegister` is read-only; the only side effect is that
 * the canonical token helper may refresh the OAuth pair, which is normal.
 *
 * Auth is the strict cron bearer with NO development bypass: a missing
 * CRON_SECRET rejects. Upstream failures (DB or QBO) are collapsed to a
 * sanitized 503 so error text never leaks.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const DIAGNOSTIC_ACCOUNT = "WTB-0723";
export const DIAGNOSTIC_SOURCE = "QBO_REGISTER";
export const ROLLING_WINDOW_DAYS = 60;
const STORED_LIMIT = 2;
const QB_TXN_ID = /^\d{1,20}$/;

export interface StoredObservationRow {
    postedDate: Date | string;
    amountCents: number;
    rawDescriptor: string | null;
    checkNumber: string | null;
    sourceLineId: string | null;
}

export interface StoredObservationClient {
    bankLineObservation: {
        findMany(input: {
            where: { source: string; account: string; sourceDocumentId: string; sourceLineId: string };
            select: { postedDate: true; amountCents: true; rawDescriptor: true; checkNumber: true; sourceLineId: true };
            take: number;
        }): Promise<StoredObservationRow[]>;
    };
}

export interface ConflictDiagnosticDependencies {
    /** Strict bearer check. Must not consult anything but the request and the secret. */
    authorize(request: Request): boolean;
    /** Stored observations for exactly this id, already scoped by the adapter. */
    readStored(qbTxnId: string): Promise<StoredObservationRow[]>;
    /** Live register over the planner's rolling window. */
    readRegister(): Promise<BankRegisterResult>;
}

/**
 * Rolling 60 inclusive UTC calendar days ending today — the same window the
 * nightly pull planner requests, so the live rows here are the rows the pull
 * would see, not a wider or narrower slice.
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
 * projection limited to the five diagnostic columns, at most two rows.
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
            select: { postedDate: true, amountCents: true, rawDescriptor: true, checkNumber: true, sourceLineId: true },
            take: STORED_LIMIT,
        });
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

function serializeStored(row: StoredObservationRow) {
    return {
        postedDate: ymd(row.postedDate),
        amountCents: row.amountCents,
        rawDescriptor: row.rawDescriptor ?? null,
        checkNumber: row.checkNumber ?? null,
        sourceLineId: row.sourceLineId ?? null,
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

        return NextResponse.json({
            ok: true,
            account: DIAGNOSTIC_ACCOUNT,
            source: DIAGNOSTIC_SOURCE,
            qbTxnId,
            stored: stored.map(serializeStored),
            register: {
                stale: register.stale,
                fetchedAt: register.fetchedAt,
                clearedProbeOk: register.clearedProbeOk,
                startDate: register.startDate,
                endDate: register.endDate,
                rows: register.rows.filter(row => row.qbTxnId === qbTxnId).map(serializeRegisterRow),
            },
            note: "Raw rows from both sides. The puller transformation is not applied; no identity or mismatch claim is made.",
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
});

export const GET = handlers.GET;

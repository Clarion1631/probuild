import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isValidCalendarDate } from "@/lib/bank-ledger";

export const dynamic = "force-dynamic";

const ACCOUNT = "WTB-0723";
const MAX_RANGE_DAYS = 14;
const REQUIRED_QUERY_KEYS = new Set(["account", "from", "to"]);

export interface BankLedgerStatusImport {
    periodStart: Date;
    periodEnd: Date;
    status: string;
    openingCents: number;
    closingCents: number;
    contentHash: string;
    lineCount: number;
}

export interface BankLedgerStatusHandlerDependencies {
    getStatusSecret(): string | undefined;
    // eslint-disable-next-line no-unused-vars
    listStatementImports(input: { account: string; from: Date; to: Date }): Promise<BankLedgerStatusImport[]>;
}

interface StatementImportStatusRow {
    periodStart: Date;
    periodEnd: Date;
    status: string;
    openingCents: number;
    closingCents: number;
    contentHash: string;
    _count: { observations: number };
}

export interface BankLedgerStatusStatementImportReader {
    // eslint-disable-next-line no-unused-vars
    findMany(_input: {
        where: {
            account: string;
            periodStart: { gte: Date };
            periodEnd: { lte: Date };
        };
        select: {
            periodStart: true;
            periodEnd: true;
            status: true;
            openingCents: true;
            closingCents: true;
            contentHash: true;
            _count: { select: { observations: true } };
        };
        orderBy: Array<{ periodStart: "asc" } | { periodEnd: "asc" }>;
    }): Promise<StatementImportStatusRow[]>;
}

function timingSafeCompare(provided: string | null, expected: string | undefined): boolean {
    if (!provided || !expected) return false;
    return timingSafeEqual(
        createHash("sha256").update(provided).digest(),
        createHash("sha256").update(expected).digest(),
    );
}

function utcDate(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
}

function calendarDaysInclusive(from: string, to: string): number {
    return (utcDate(to).getTime() - utcDate(from).getTime()) / 86_400_000 + 1;
}

function dateOnly(value: Date): string {
    return value.toISOString().slice(0, 10);
}

export function getBankLedgerStatusSecret(): string | undefined {
    return process.env.BANK_LEDGER_STATUS_SECRET;
}

export function createListStatementImports(reader: BankLedgerStatusStatementImportReader): BankLedgerStatusHandlerDependencies["listStatementImports"] {
    return async ({ account, from, to }) => {
        const imports = await reader.findMany({
            where: {
                account,
                periodStart: { gte: from },
                periodEnd: { lte: to },
            },
            select: {
                periodStart: true,
                periodEnd: true,
                status: true,
                openingCents: true,
                closingCents: true,
                contentHash: true,
                _count: { select: { observations: true } },
            },
            orderBy: [{ periodStart: "asc" }, { periodEnd: "asc" }],
        });
        return imports.map(({ _count, ...statementImport }) => ({
            ...statementImport,
            lineCount: _count.observations,
        }));
    };
}

/**
 * Read-only status contract for the WTB posting watchdog. It is deliberately
 * scoped to the single account the watchdog owns. Callers receive statement
 * facts only; they must treat a day as posted only when a returned import is
 * a one-day FINALIZED record with the expected balances and line count.
 */
export function createBankLedgerStatusHandlers(dependencies: BankLedgerStatusHandlerDependencies) {
    return {
        async GET(request: Request) {
            const providedSecret = request.headers.get("x-ledger-status-key");
            if (!timingSafeCompare(providedSecret, dependencies.getStatusSecret())) {
                return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
            }

            const url = new URL(request.url);
            const unknownKey = [...url.searchParams.keys()].find(key => !REQUIRED_QUERY_KEYS.has(key));
            const values = Object.fromEntries([...REQUIRED_QUERY_KEYS].map(key => [key, url.searchParams.getAll(key)])) as Record<string, string[]>;
            if (unknownKey || Object.values(values).some(value => value.length !== 1)) {
                return NextResponse.json({ ok: false, reason: "invalid-query" }, { status: 400 });
            }

            const account = values.account[0];
            const from = values.from[0];
            const to = values.to[0];
            if (account !== ACCOUNT) {
                return NextResponse.json({ ok: false, reason: "invalid-account" }, { status: 400 });
            }
            if (!isValidCalendarDate(from) || !isValidCalendarDate(to) || from > to) {
                return NextResponse.json({ ok: false, reason: "invalid-date-range" }, { status: 400 });
            }
            if (calendarDaysInclusive(from, to) > MAX_RANGE_DAYS) {
                return NextResponse.json({ ok: false, reason: "range-too-large", maxDays: MAX_RANGE_DAYS }, { status: 400 });
            }

            const imports = await dependencies.listStatementImports({ account: ACCOUNT, from: utcDate(from), to: utcDate(to) });
            return NextResponse.json({
                ok: true,
                account: ACCOUNT,
                imports: [...imports]
                    .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime() || a.periodEnd.getTime() - b.periodEnd.getTime())
                    .map(statementImport => ({
                        periodStart: dateOnly(statementImport.periodStart),
                        periodEnd: dateOnly(statementImport.periodEnd),
                        status: statementImport.status,
                        openingCents: statementImport.openingCents,
                        closingCents: statementImport.closingCents,
                        lineCount: statementImport.lineCount,
                        contentHash: statementImport.contentHash,
                    })),
            });
        },
    };
}

const handlers = createBankLedgerStatusHandlers({
    getStatusSecret: getBankLedgerStatusSecret,
    // Access the Prisma proxy only when an authorized request reaches the
    // adapter. Import-time access would make the hermetic route tests require
    // DATABASE_URL even when they inject their own dependency.
    listStatementImports: createListStatementImports({ findMany: input => prisma.statementImport.findMany(input) }),
});

export async function GET(request: Request) {
    return handlers.GET(request);
}

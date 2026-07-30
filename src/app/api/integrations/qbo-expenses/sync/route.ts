import { NextResponse } from "next/server";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import {
    syncQboExpenses,
    type QboExpenseSyncResult,
} from "@/lib/qbo-expense-sync";
import type { QBTokens } from "@/lib/quickbooks";

export const dynamic = "force-dynamic";
// 300s: the first historical backfill reads every QBO Purchase page since the
// requested date and exceeded 120s in production (FUNCTION_INVOCATION_TIMEOUT).
// Incremental CDC runs stay well under the old limit; this only buys headroom
// for backfills, which are manual and secret-gated.
export const maxDuration = 300;

type SyncMode = "incremental" | "backfill";

export interface QboExpenseSyncHandlerDependencies {
    getIngestSecret(): string | undefined;
    getCronSecret(): string | undefined;
    isCronEnabled(): boolean;
    getFreshTokens(): Promise<QBTokens>;
    syncExpenses(
        options: { since: Date; until?: Date; mode: SyncMode },
        runtime: { tokens: QBTokens },
    ): Promise<QboExpenseSyncResult>;
    now(): Date;
    incrementalLookbackDays: number;
}

const DEFAULT_INCREMENTAL_LOOKBACK_DAYS = 7;

function configuredLookbackDays(): number {
    const configured = Number(process.env.QBO_EXPENSE_SYNC_LOOKBACK_DAYS);
    if (!Number.isInteger(configured)) return DEFAULT_INCREMENTAL_LOOKBACK_DAYS;
    // QBO CDC accepts a maximum 30-day lookback.
    return Math.min(30, Math.max(1, configured));
}

function parseBackfillDate(value: unknown, now: Date): Date | null {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return null;
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        return null;
    }
    if (parsed.getTime() > now.getTime()) return null;
    return parsed;
}

function incrementalSince(now: Date, lookbackDays: number): Date {
    return new Date(now.getTime() - lookbackDays * 86_400_000);
}

export function createQboExpenseSyncHandlers(
    dependencies: QboExpenseSyncHandlerDependencies,
) {
    async function run(mode: SyncMode, since: Date, until?: Date) {
        try {
            const tokens = await dependencies.getFreshTokens();
            const result = await dependencies.syncExpenses({ since, until, mode }, { tokens });
            return NextResponse.json({
                ok: true,
                mode,
                since: since.toISOString().slice(0, 10),
                ...(until ? { until: until.toISOString().slice(0, 10) } : {}),
                ...result,
            });
        } catch (error) {
            if (error instanceof QBNotConnectedError) {
                return NextResponse.json(
                    { ok: false, reason: "quickbooks-not-connected" },
                    { status: 503 },
                );
            }
            console.error(
                "QBO expense sync failed",
                error instanceof Error ? error.name : "UnknownError",
            );
            return NextResponse.json(
                { ok: false, reason: "sync-failed" },
                { status: 500 },
            );
        }
    }

    return {
        async POST(request: Request) {
            const secret = dependencies.getIngestSecret();
            if (!secret || request.headers.get("x-ingest-key") !== secret) {
                return NextResponse.json(
                    { ok: false, reason: "unauthorized" },
                    { status: 401 },
                );
            }

            let body: { mode?: unknown; since?: unknown; until?: unknown };
            try {
                body = await request.json();
            } catch {
                return NextResponse.json(
                    { ok: false, reason: "invalid-json" },
                    { status: 400 },
                );
            }

            const now = dependencies.now();
            if (body.mode === "incremental") {
                return run(
                    "incremental",
                    incrementalSince(now, dependencies.incrementalLookbackDays),
                );
            }
            if (body.mode === "backfill") {
                const since = parseBackfillDate(body.since, now);
                if (!since) {
                    return NextResponse.json(
                        { ok: false, reason: "invalid-since" },
                        { status: 400 },
                    );
                }
                // Optional inclusive end date so a long historical backfill can
                // be chunked into windows that each finish within maxDuration.
                let until: Date | undefined;
                if (body.until !== undefined) {
                    const parsedUntil = parseBackfillDate(body.until, now);
                    if (!parsedUntil || parsedUntil.getTime() < since.getTime()) {
                        return NextResponse.json(
                            { ok: false, reason: "invalid-until" },
                            { status: 400 },
                        );
                    }
                    until = parsedUntil;
                }
                return run("backfill", since, until);
            }
            return NextResponse.json(
                { ok: false, reason: "invalid-mode" },
                { status: 400 },
            );
        },

        async GET(request: Request) {
            const cronSecret = dependencies.getCronSecret();
            if (
                !cronSecret ||
                request.headers.get("authorization") !== `Bearer ${cronSecret}`
            ) {
                return NextResponse.json(
                    { ok: false, reason: "unauthorized" },
                    { status: 401 },
                );
            }
            if (!dependencies.isCronEnabled()) {
                return NextResponse.json(
                    { ok: false, reason: "sync-disabled" },
                    { status: 503 },
                );
            }
            const since = incrementalSince(
                dependencies.now(),
                dependencies.incrementalLookbackDays,
            );
            return run("incremental", since);
        },
    };
}

const handlers = createQboExpenseSyncHandlers({
    getIngestSecret: () => process.env.RECEIPT_INGEST_SECRET,
    getCronSecret: () => process.env.CRON_SECRET,
    isCronEnabled: () => process.env.QBO_EXPENSE_SYNC_CRON_ENABLED !== "false",
    getFreshTokens: getFreshQBTokens,
    syncExpenses: (options, runtime) =>
        syncQboExpenses(options, undefined, runtime),
    now: () => new Date(),
    incrementalLookbackDays: configuredLookbackDays(),
});

/**
 * Secret-gated manual entry point. Backfill is always date bounded; incremental
 * mode uses the configured rolling window.
 */
export async function POST(request: Request) {
    return handlers.POST(request);
}

/**
 * Vercel cron sends GET with Authorization: Bearer CRON_SECRET. It can only run
 * incremental mode; historical backfill stays behind the manual POST contract.
 */
export async function GET(request: Request) {
    return handlers.GET(request);
}

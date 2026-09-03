import { NextResponse } from "next/server";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import {
    skippedAuditSummary,
    syncQboExpenses,
    type QboExpenseSyncResult,
} from "@/lib/qbo-expense-sync";
import type { QBTokens } from "@/lib/quickbooks";
import { logAutomationEvent } from "@/lib/automation-events";
import { isPaused, PAUSE_KEYS } from "@/lib/automation-settings";

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
    isSyncPaused?: () => Promise<boolean>;
    logEvent?: (event: import("@/lib/automation-events").AutomationEventInput) => void | Promise<void>;
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
    async function run(mode: SyncMode, since: Date, until?: Date, source: string = "manual") {
        const rawLog = dependencies.logEvent ?? logAutomationEvent;
        // An injected logger that REJECTS must never divert the money path into
        // its error branch — isolate it here, whatever the dependency does.
        const logEvent = async (event: Parameters<typeof logAutomationEvent>[0]) => {
            try { await rawLog(event); } catch (error) {
                console.error("sync audit log failed", error instanceof Error ? error.name : "UnknownError");
            }
        };
        try {
            const tokens = await dependencies.getFreshTokens();
            const result = await dependencies.syncExpenses({ since, until, mode }, { tokens });
            await logEvent({
                kind: "qbo-sync",
                status: "ok",
                source,
                detail: {
                    mode,
                    since: since.toISOString().slice(0, 10),
                    ...(until ? { until: until.toISOString().slice(0, 10) } : {}),
                    imported: result.imported,
                    updated: result.updated,
                    deactivated: result.removed,
                    // Rows a write-time attribution race left incomplete —
                    // a create that never happened (round 31, item 2) or a
                    // catch-up fill that was refused (round 33, item 3). A
                    // nonzero count means the backfill this run belongs to is
                    // NOT complete, however clean imported/updated/removed
                    // look.
                    attributionRaceSkipped: result.attributionRaceSkipped,
                    // Bounded summary + reason histogram so the dashboard can
                    // say WHY instead of a bare scary count (shared shape with
                    // the Command Center's sync-now route).
                    ...skippedAuditSummary(result.skipped),
                },
            });
            return NextResponse.json({
                ok: true,
                mode,
                since: since.toISOString().slice(0, 10),
                ...(until ? { until: until.toISOString().slice(0, 10) } : {}),
                ...result,
            });
        } catch (error) {
            if (error instanceof QBNotConnectedError) {
                await logEvent({ kind: "qbo-sync", status: "error", reason: "quickbooks-not-connected", source });
                return NextResponse.json(
                    { ok: false, reason: "quickbooks-not-connected" },
                    { status: 503 },
                );
            }
            console.error(
                "QBO expense sync failed",
                error instanceof Error ? error.name : "UnknownError",
            );
            await logEvent({ kind: "qbo-sync", status: "error", reason: error instanceof Error ? error.name : "UnknownError", source });
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
                return run("backfill", since, until, "backfill");
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
            // Command Center pause (cron only — the manual Run-sync-now button
            // deliberately overrides a pause; pressing it IS the override).
            const isSyncPausedFn = dependencies.isSyncPaused ?? (() => isPaused(PAUSE_KEYS.qboSync));
            if (await isSyncPausedFn()) {
                return NextResponse.json({ ok: false, reason: "sync-paused" }, { status: 503 });
            }
            const since = incrementalSince(
                dependencies.now(),
                dependencies.incrementalLookbackDays,
            );
            return run("incremental", since, undefined, "cron");
        },
    };
}

const handlers = createQboExpenseSyncHandlers({
    getIngestSecret: () => process.env.RECEIPT_INGEST_SECRET,
    getCronSecret: () => process.env.CRON_SECRET,
    isCronEnabled: () => process.env.QBO_EXPENSE_SYNC_CRON_ENABLED !== "false",
    getFreshTokens: getFreshQBTokens,
    syncExpenses: (options, runtime) =>
        syncQboExpenses(
            {
                ...options,
                // No-customer purchases triage into this in-progress project
                // (the Shop overhead bucket) instead of skipping invisibly.
                overheadProjectId: process.env.QBO_EXPENSE_OVERHEAD_PROJECT_ID || undefined,
            },
            undefined,
            runtime,
        ),
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

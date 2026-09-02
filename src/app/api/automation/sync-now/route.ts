import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, isAdminOrManager } from "@/lib/permissions";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import { skippedAuditSummary, syncQboExpenses, QBO_EXPENSE_SYNC_BUDGET_MS } from "@/lib/qbo-expense-sync";
import { createRouteDeadline } from "@/lib/quickbooks";
import { logAutomationEvent } from "@/lib/automation-events";
import { isPaused, PAUSE_KEYS } from "@/lib/automation-settings";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_LOOKBACK_DAYS = 7;

function lookbackDays(): number {
    const configured = Number(process.env.QBO_EXPENSE_SYNC_LOOKBACK_DAYS);
    if (!Number.isInteger(configured)) return DEFAULT_LOOKBACK_DAYS;
    return Math.min(30, Math.max(1, configured));
}

/**
 * Command Center "Run sync now": the same incremental QBO→ProBuild sync the
 * 4-hour cron runs, triggered on demand by an admin/manager session. Safe to
 * mash — the sync is idempotent (keyed by QBO transaction id) and serialized
 * by a pg advisory lock, so overlapping runs cannot double-import.
 */
export async function POST() {
    const user = await getCurrentUserWithPermissions();
    if (!user) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    if (!isAdminOrManager(user)) {
        return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }
    // Server-side pause enforcement — UI disablement is not an authority
    // boundary (stale tabs, direct calls). Resuming first IS the override.
    if (await isPaused(PAUSE_KEYS.qboSync)) {
        return NextResponse.json({ ok: false, reason: "sync-paused" }, { status: 503 });
    }

    const since = new Date(Date.now() - lookbackDays() * 86_400_000);
    const source = `manual:${user.id}`;
    try {
        // At entry, before the refresh: the refresh is itself a QBO round trip
        // on this route's ceiling.
        const deadline = createRouteDeadline(QBO_EXPENSE_SYNC_BUDGET_MS);
        const tokens = await getFreshQBTokens(deadline);
        const result = await syncQboExpenses(
            {
                since,
                mode: "incremental",
                overheadProjectId: process.env.QBO_EXPENSE_OVERHEAD_PROJECT_ID || undefined,
            },
            undefined,
            { tokens },
        );
        const counts = {
            imported: result.imported,
            updated: result.updated,
            deactivated: result.removed,
            skipped: result.skipped.length,
        };
        // A run that could not land every receipt did not finish cleanly.
        const incomplete = result.attachmentsIncomplete === true;
        await logAutomationEvent({
            kind: "qbo-sync",
            status: incomplete ? "partial" : "ok",
            reason: incomplete ? "attachments-incomplete" : undefined,
            source,
            detail: { mode: "incremental", since: since.toISOString().slice(0, 10), imported: result.imported, updated: result.updated, deactivated: result.removed, by: user.name || user.email || undefined, ...skippedAuditSummary(result.skipped) },
        });
        return NextResponse.json({ ok: true, ...counts });
    } catch (error) {
        if (error instanceof QBNotConnectedError) {
            await logAutomationEvent({ kind: "qbo-sync", status: "error", reason: "quickbooks-not-connected", source });
            return NextResponse.json({ ok: false, reason: "quickbooks-not-connected" }, { status: 503 });
        }
        console.error("manual sync-now failed", error instanceof Error ? error.name : "UnknownError");
        await logAutomationEvent({
            kind: "qbo-sync",
            status: "error",
            reason: error instanceof Error ? error.name : "UnknownError",
            source,
        });
        return NextResponse.json({ ok: false, reason: "sync-failed" }, { status: 500 });
    }
}

import { NextResponse } from "next/server";

import { isCronAuthorized } from "@/lib/cron-auth";
import { logAutomationEvent } from "@/lib/automation-events";
import { PAYMENTS_SYNC_EVENT_KIND, QBO_MAINTENANCE_SOURCE } from "@/lib/pipeline-health";
import { POST as runMaintenance } from "@/app/api/integrations/qbo-maintenance/route";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The automatic runner for the QuickBooks repair queues.
 *
 * Every repair this PR added — the pay-link sweep, the pending-deletion sweep,
 * the parked document-sync sweep — lived behind the `sync-payment-options`
 * action of a POST-only, secret-gated route that NOTHING called on a schedule.
 * `vercel.json` scheduled it nowhere, and Vercel cron issues GET, so the UI
 * copy promising "the maintenance sweep will finish this" was describing a job
 * that only ran when a human remembered to curl it.
 *
 * This is a GET, authorised the way every other cron in this app is
 * (`isCronAuthorized`: CRON_SECRET bearer, constant-time, fail-closed), and it
 * delegates to the SAME handler rather than reimplementing the sweeps — one
 * implementation, so the scheduled path and the manual one cannot drift.
 *
 * Scheduled hourly at :45 (vercel.json). That is the only free quarter-hour in
 * the existing schedule (:00 payments, :15 drain/review, :30 co-billing), so the
 * sweeps never contend with the payments cron for the same QuickBooks
 * connection. `pipeline-health` treats two missed runs as stale.
 */
export async function GET(request: Request) {
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    const secret = process.env.RECEIPT_INGEST_SECRET;
    if (!secret) {
        // The delegate is gated on this. Say so rather than reporting a clean
        // run that did nothing.
        return NextResponse.json(
            { ok: false, reason: "receipt-ingest-secret-missing" },
            { status: 503 },
        );
    }

    // Delegated in-process: no network hop, no second copy of the sweep logic.
    const delegated = new Request("https://internal/api/integrations/qbo-maintenance", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-key": secret },
        body: JSON.stringify({ action: "sync-payment-options" }),
    });

    let body: unknown;
    let status = 500;
    try {
        const res = await runMaintenance(delegated);
        status = res.status;
        body = await res.json().catch(() => null);
    } catch (error) {
        body = { ok: false, reason: error instanceof Error ? error.message.slice(0, 300) : "maintenance failed" };
    }

    const ok = status === 200 && !!(body as { ok?: boolean } | null)?.ok;
    // The heartbeat pipeline-health reads. Only a genuinely clean run stamps
    // `ok`, so a run that finished with work outstanding cannot make the
    // staleness check look healthy.
    await logAutomationEvent({
        kind: PAYMENTS_SYNC_EVENT_KIND,
        status: ok ? "ok" : "error",
        source: QBO_MAINTENANCE_SOURCE,
        reason: ok ? undefined : String((body as { reason?: string } | null)?.reason ?? "maintenance-incomplete"),
        detail: (body ?? {}) as Record<string, unknown>,
    });

    // 503 whenever the run was not genuinely clean, whatever the delegate
    // answered. Returning the delegate's 200 for an `ok:false` body recorded a
    // SUCCESSFUL cron invocation in Vercel while repair work had failed or was
    // still outstanding — so the one signal an operator sees without opening the
    // logs said everything was fine. The body is passed through unchanged; only
    // the status tells the truth about it.
    return NextResponse.json(
        body ?? { ok: false, reason: "no-response" },
        { status: ok ? status : (status >= 400 ? status : 503) },
    );
}

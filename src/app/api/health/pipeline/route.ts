import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { getPipelineHealth } from "@/lib/pipeline-health";
import { hasCronSecret } from "@/lib/cron-auth";
import { loadReceiptOutcomeAudit } from "@/lib/receipt-outcome-audit";
import { loadChaserCompletionDiagnostic } from "@/lib/receipt-chaser-completion";

export const dynamic = "force-dynamic";
// Auth runs before the health sweep; its bounded QBO probe may use 30s.
// Leave room for the probe to return "unavailable" before the platform stops us.
export const maxDuration = 60;

/**
 * On-demand pipeline health: Intuit's status, how current the QBO sync and
 * receipt bookings are, 24h receipt counts, the bank ledger's high-water mark,
 * and the error count. Same summariser the morning digest cron uses, so the
 * two can never disagree.
 *
 * Unlike the bare liveness probe at /api/health, this exposes internal
 * operating data, so it is gated: a staff session with the financialReports
 * permission (same gate as the other Command Center reads), or the cron
 * secret for headless/ops checks.
 */
export async function GET(request: Request) {
    // Bearer branch: constant-time, and a missing CRON_SECRET rejects (there is
    // no environment in which this endpoint is open). The staff-session branch
    // below is the normal human path.
    if (!hasCronSecret(request)) {
        const user = await getCurrentUserWithPermissions();
        if (!user) {
            return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
        }
        if (!hasPermission(user, "financialReports")) {
            return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
        }
    }

    const noStore = { "Cache-Control": "no-store, max-age=0" };

    const params = new URL(request.url).searchParams;
    // ?outcomes=only: just the receipt-outcome audit, skipping the health
    // sweep and its bounded QBO probe. Read-only, narrow, DB only.
    if (params.get("outcomes") === "only") {
        const receiptOutcomes = await loadReceiptOutcomeAudit();
        return NextResponse.json({ receiptOutcomes }, { headers: noStore });
    }

    // ?chaser=only: the missing-receipt chaser's CURRENT-CYCLE completion proof
    // alone — eight fixed AutomationSetting rows read twice, no QBO probe, no
    // outcome audit. Read-only and bounded; same gate as everything above.
    if (params.get("chaser") === "only") {
        const chaserCompletion = await loadChaserCompletionDiagnostic();
        return NextResponse.json({ chaserCompletion }, { headers: noStore });
    }

    const health = await getPipelineHealth();
    // Appended, not merged: health.ok keeps its operational meaning and an
    // unavailable audit reads as unavailable, never as a quiet zero.
    const receiptOutcomes = await loadReceiptOutcomeAudit();
    const chaserCompletion = await loadChaserCompletionDiagnostic();
    return NextResponse.json({ ...health, receiptOutcomes, chaserCompletion }, { headers: noStore });
}

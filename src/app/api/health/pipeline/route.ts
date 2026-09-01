import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { getPipelineHealth } from "@/lib/pipeline-health";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

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
    const authHeader = request.headers.get("authorization");
    const cronAuthed = Boolean(
        process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`,
    );
    if (!cronAuthed) {
        const user = await getCurrentUserWithPermissions();
        if (!user) {
            return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
        }
        if (!hasPermission(user, "financialReports")) {
            return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
        }
    }

    const health = await getPipelineHealth();
    return NextResponse.json(health, {
        headers: { "Cache-Control": "no-store, max-age=0" },
    });
}

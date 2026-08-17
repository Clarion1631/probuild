import { NextResponse } from "next/server";
import { drainChangeOrderAutomationUntilIdle } from "@/lib/change-order-automation";
import { seedLegacyApprovedChangeOrderAutomationJobs } from "@/lib/change-order-automation-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Permanent backstop for the durable change-order automation queue. It scans
 * all due PENDING jobs and stale PROCESSING leases, without an approval-age
 * window or milestone shortcut, so interrupted billing, schedule, review, and
 * notification work remains recoverable until terminally resolved.
 */
export async function GET(request: Request) {
    // Any deployed environment (production or preview) requires the cron secret,
    // and fails closed if CRON_SECRET is unset. Only local dev skips the check.
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV && (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Bridge approvals committed by the prior after()-only build around the
    // outbox cutover. This never backfills an email; it only creates safe,
    // durable billing/schedule recovery work (or an explicit attention row).
    const legacy = await seedLegacyApprovedChangeOrderAutomationJobs({ limit: 25 });
    const result = await drainChangeOrderAutomationUntilIdle({ limit: 25 }, {}, 4);
    if (Object.values(result).some(count => count > 0)) {
        console.log("[cron/co-billing-sweep]", JSON.stringify({ legacySeeded: legacy.seeded, ...result }));
    }
    return NextResponse.json({ legacySeeded: legacy.seeded, ...result });
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleChangeOrderApproved } from "@/lib/billing-core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Hourly backstop for the change-order approval automation: after() gives no
 * delivery guarantee (a cancelled function can drop both the billing and the
 * ACTION-NEEDED alert), so this sweep re-runs the idempotent handler for any
 * Approved CO that still has no invoice milestone.
 *
 * The 15min–2h approvedAt band means each CO is swept by at most two hourly
 * runs (bounded duplicate "needs a look" alerts) and never races the inline
 * after() automation, which fires within seconds of signing.
 */
export async function GET(request: Request) {
    // Any deployed environment (production or preview) requires the cron secret,
    // and fails closed if CRON_SECRET is unset. Only local dev skips the check.
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV && (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = Date.now();
    const candidates = await prisma.changeOrder.findMany({
        where: {
            status: "Approved",
            approvedAt: { lte: new Date(now - 15 * 60_000), gte: new Date(now - 2 * 60 * 60_000) },
        },
        select: { id: true, code: true, projectId: true },
        take: 10,
    });

    const results: Array<{ code: string; action: string }> = [];
    for (const co of candidates) {
        const billedAlready = await prisma.paymentSchedule.findFirst({
            where: {
                name: { startsWith: `${co.code} — ` },
                status: { not: "Canceled" },
                invoice: { projectId: co.projectId },
            },
            select: { id: true },
        });
        if (billedAlready) {
            results.push({ code: co.code, action: "skipped (already billed)" });
            continue;
        }
        const outcome = await handleChangeOrderApproved(co.id);
        const action = outcome.sent
            ? "billed + sent"
            : outcome.clientEmailSuppressed
                ? `billed; client email suppressed${outcome.issues.length ? `: ${outcome.issues.join("; ")}` : ""}`
                : `alerted: ${outcome.issues.join("; ")}`;
        results.push({ code: co.code, action });
    }

    if (results.some(r => !r.action.startsWith("skipped"))) {
        console.log("[cron/co-billing-sweep]", JSON.stringify(results));
    }
    return NextResponse.json({ checked: candidates.length, results });
}

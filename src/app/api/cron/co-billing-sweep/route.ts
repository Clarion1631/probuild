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
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV === "production" && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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
        results.push({ code: co.code, action: outcome.sent ? "billed + sent" : `alerted: ${outcome.issues.join("; ")}` });
    }

    if (results.some(r => !r.action.startsWith("skipped"))) {
        console.log("[cron/co-billing-sweep]", JSON.stringify(results));
    }
    return NextResponse.json({ checked: candidates.length, results });
}

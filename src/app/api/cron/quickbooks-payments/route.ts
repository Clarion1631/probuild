import { NextResponse } from "next/server";
import { syncQuickBooksPayments } from "@/lib/quickbooks-payments";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Hourly sweep: pull settled QuickBooks invoices (online payments AND manual
 * checks Vanessa applies in QBO off the Washington Trust bank feed) back into
 * ProBuild payment milestones, so ProBuild / QuickBooks / the bank stay in sync.
 */
export async function GET(request: Request) {
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV === "production" && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await syncQuickBooksPayments();
    if (result.settled > 0 || result.errors.length > 0) {
        console.log("[cron/quickbooks-payments]", JSON.stringify(result));
    }
    return NextResponse.json(result);
}

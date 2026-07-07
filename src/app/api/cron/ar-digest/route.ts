import { NextResponse } from "next/server";
import { sendArDigest } from "@/lib/billing-core";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Weekly accounts-receivable digest to the team (System Notification Email):
 * every invoice with a balance due, overdue ones flagged. Skips the email when
 * nothing is outstanding.
 */
export async function GET(request: Request) {
    // Any deployed environment (production or preview) requires the cron secret,
    // and fails closed if CRON_SECRET is unset. Only local dev skips the check.
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV && (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await sendArDigest();
    console.log("[cron/ar-digest]", JSON.stringify({ sent: result.sent, invoices: result.invoiceCount, outstanding: result.totalOutstanding }));
    return NextResponse.json(result);
}

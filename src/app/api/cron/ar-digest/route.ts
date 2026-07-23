import { NextResponse } from "next/server";
import { sendArDigest } from "@/lib/billing-core";
import { sendInvoiceLifecycleDigest } from "@/lib/invoice-alignment";

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
    const secret = process.env.CRON_SECRET;
    const authed = !!secret && authHeader === `Bearer ${secret}`;
    const isLocalDev = !process.env.VERCEL && process.env.NODE_ENV !== "production" && !secret;
    if (!authed && !isLocalDev) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [result, lifecycle] = await Promise.all([sendArDigest(), sendInvoiceLifecycleDigest()]);
    console.log("[cron/ar-digest]", JSON.stringify({ sent: result.sent, invoices: result.invoiceCount, outstanding: result.totalOutstanding }));
    return NextResponse.json({ ...result, lifecycle });
}

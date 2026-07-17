import { NextResponse } from "next/server";
import { sendPaymentReminders } from "@/lib/payment-reminders";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily client payment-reminder sweep: emails clients about payment-schedule
 * milestones due soon or recently overdue (see sendPaymentReminders for the
 * exact selection/throttle rules). Idempotent and safe on retries — each
 * milestone is sent+updated independently.
 */
export async function GET(request: Request) {
    // Any deployed environment (production or preview) requires the cron secret,
    // and fails closed if CRON_SECRET is unset. Only local dev skips the check.
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV && (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await sendPaymentReminders();
    console.log("[cron/payment-reminders]", JSON.stringify(result));
    return NextResponse.json(result);
}

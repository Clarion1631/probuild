import { NextResponse } from "next/server";
import { sendPaymentReminders } from "@/lib/payment-reminders";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily client payment-reminder sweep: emails clients about payment-schedule
 * milestones due soon or recently overdue (see sendPaymentReminders for the
 * exact selection/throttle rules). Idempotent and safe on retries — each
 * milestone is claimed before it's sent, so overlapping/retried runs can't
 * double-send.
 *
 * ?dryRun=1 runs the full selection and reports what would happen without sending any
 * email or writing lastReminderAt. PAYMENT_REMINDERS_DRY_RUN=1 is the operational kill
 * switch — it FORCES dry-run regardless of this query param (precedence is enforced in
 * sendPaymentReminders, not here): when that env var is set, ?dryRun=0 cannot turn
 * sending back on. Absent the env var, this query param can only turn dry-run on, never
 * off — omitting it defaults to a real (non-dry) run.
 */
export async function GET(request: Request) {
    // Any deployed environment (production or preview) requires the cron secret,
    // and fails closed if CRON_SECRET is unset. Only local dev skips the check.
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV && (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const dryRunParam = searchParams.get("dryRun");
    const dryRun = dryRunParam === null ? undefined : dryRunParam === "1" || dryRunParam === "true";

    const result = await sendPaymentReminders({ dryRun });
    console.log("[cron/payment-reminders]", JSON.stringify(result));
    return NextResponse.json(result);
}

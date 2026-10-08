import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Customer payment reminders are DISABLED (Justin, Oct 2026). This route sends
 * no email and writes nothing; it only answers { status: "disabled" }.
 *
 * To re-enable: restore this route's previous body from git history and add
 * the "/api/cron/payment-reminders" entry back to vercel.json's crons. The
 * reminder logic itself still lives in src/lib/payment-reminders.ts.
 */
export async function GET(request: Request) {
    // Any deployed environment (production or preview) requires the cron secret,
    // and fails closed if CRON_SECRET is unset. Only local dev skips the check.
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV && (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json({ status: "disabled" });
}

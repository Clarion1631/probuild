import { NextResponse } from "next/server";
import { sendMondayMarginCard } from "@/lib/margin-digest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Monday 14:00 UTC (7 AM PDT): one Google Chat message to the Main Office space
 * with a line per active job — auto %, the manual override and its date, earned
 * margin, and a link straight to the page where the number is adjusted.
 *
 * Fails soft when MAIN_OFFICE_CHAT_WEBHOOK is unset or is not a Google Chat
 * webhook URL: `{ sent: false, reason }` plus a console line, never a throw.
 */
export async function GET(request: Request) {
    // Any deployed environment (production or preview) requires the cron secret,
    // and fails closed if CRON_SECRET is unset. Only local dev skips the check.
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV && (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await sendMondayMarginCard();
    console.log("[cron/monday-margin-card]", JSON.stringify(result));
    return NextResponse.json(result);
}

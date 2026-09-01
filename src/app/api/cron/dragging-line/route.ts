import { NextResponse } from "next/server";
import { sendDraggingUsLine } from "@/lib/margin-digest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Monday 14:05 UTC, five minutes behind the margin card so the two do not race
 * for the same per-job financial queries.
 *
 * Emails PIPELINE_DIGEST_TO the two active jobs with the lowest earned margin,
 * each with its single biggest cost that landed on no phase. Jobs with no
 * percent complete are excluded from the ranking and counted in a footer line.
 *
 * Internal only: never posts to Chat, never notifies a client. Fails soft when
 * PIPELINE_DIGEST_TO is unset.
 */
export async function GET(request: Request) {
    // Any deployed environment (production or preview) requires the cron secret,
    // and fails closed if CRON_SECRET is unset. Only local dev skips the check.
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV && (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await sendDraggingUsLine();
    console.log("[cron/dragging-line]", JSON.stringify(result));
    return NextResponse.json(result);
}

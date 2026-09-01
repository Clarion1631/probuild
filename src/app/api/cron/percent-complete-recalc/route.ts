import { NextResponse } from "next/server";
import { recalcAllActivePercentComplete } from "@/lib/percent-complete-db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Nightly percent-complete recalculation (09:00 UTC ≈ 1-2 AM Pacific).
 *
 * The ONLY writer of Project.percentCompleteAuto. It always refreshes the auto
 * value — including on jobs carrying a manual override, because the drift flag
 * compares the current auto value against the snapshot taken at override time.
 * It never overwrites a MANUAL percentComplete.
 *
 * Returns per-job results so the cron log shows what moved.
 */
export async function GET(request: Request) {
    // Any deployed environment (production or preview) requires the cron secret,
    // and fails closed if CRON_SECRET is unset. Only local dev skips the check.
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV && (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const results = await recalcAllActivePercentComplete();
    console.log(
        "[cron/percent-complete-recalc]",
        JSON.stringify({
            jobs: results.length,
            measured: results.filter((r) => r.auto !== null).length,
            manualOverridesKept: results.filter((r) => r.manualOverrideKept).length,
        })
    );
    return NextResponse.json({ jobs: results.length, results });
}

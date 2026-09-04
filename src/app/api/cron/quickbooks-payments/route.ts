import { NextResponse } from "next/server";
import { syncQuickBooksPayments } from "@/lib/quickbooks-payments";
import { isCronAuthorized } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Hourly sweep: pull settled QuickBooks invoices (online payments AND manual
 * checks Vanessa applies in QBO off the Washington Trust bank feed) back into
 * ProBuild payment milestones, so ProBuild / QuickBooks / the bank stay in sync.
 */
export async function GET(request: Request) {
    // Was fail-OPEN: the check only ran when VERCEL_ENV === "production", so any
    // preview or non-Vercel runtime could trigger a money sync unauthenticated,
    // and a missing CRON_SECRET made `Bearer undefined` a valid credential.
    // Now it can also write a source:"cron" heartbeat, so an unauthorized caller
    // could make a dead cron look alive. Fail closed, constant-time.
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await syncQuickBooksPayments(undefined, { source: "cron" });
    if (result.settled > 0 || result.errors.length > 0) {
        console.log("[cron/quickbooks-payments]", JSON.stringify(result));
    }
    // A run that failed outright must not answer 200. Vercel's cron log, the
    // monitoring on top of it, and anyone re-running this by hand all read the
    // STATUS first — a 200 carrying runFailed:true in the body meant an outage
    // that skipped every row reported as a clean hourly sync. 503 because it is
    // retryable by definition (the next hourly run continues from the cursor);
    // the body is unchanged so nothing parsing it has to move.
    if (result.runFailed) {
        return NextResponse.json({ ...result, retry: true }, { status: 503 });
    }
    return NextResponse.json(result);
}

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Deployment identity probe for the stale-tab banner (VersionWatcher).
 * VERCEL_URL is unique per deployment, so a long-open tab can detect that
 * production has moved on and prompt a refresh. Exposes nothing sensitive.
 */
export async function GET() {
    return NextResponse.json(
        { v: process.env.VERCEL_URL || process.env.VERCEL_DEPLOYMENT_ID || "dev" },
        { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
}

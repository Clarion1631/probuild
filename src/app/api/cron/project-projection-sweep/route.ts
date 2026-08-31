import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { runProjectProjectionSweep } from "@/lib/project-projection-sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function timingSafeCompare(a: string, b: string): boolean {
    return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/**
 * Nightly backstop for the task-write projection recompute. This only updates
 * derived Project fields and is bounded to keep a Vercel cron invocation safe.
 */
export async function GET(request: Request) {
    const secret = process.env.CRON_SECRET;
    const authHeader = request.headers.get("authorization") ?? "";
    const authed = !!secret && timingSafeCompare(authHeader, `Bearer ${secret}`);
    const isLocalDev = !process.env.VERCEL && process.env.NODE_ENV !== "production" && !secret;
    if (!authed && !isLocalDev) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    try {
        const result = await runProjectProjectionSweep();
        console.log("[cron/project-projection-sweep]", JSON.stringify(result));
        return NextResponse.json({ ok: true, ...result });
    } catch (error) {
        console.error(
            "project projection sweep failed",
            error instanceof Error ? error.name : "UnknownError",
        );
        return NextResponse.json({ ok: false, reason: "projection-sweep-failed" }, { status: 500 });
    }
}

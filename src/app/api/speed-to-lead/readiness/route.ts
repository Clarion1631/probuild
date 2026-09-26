import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isApprover } from "@/lib/speed-to-lead/constants";
import { runReadinessCheck } from "@/lib/speed-to-lead/readiness";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Justin-only readiness runner (spec Release "Readiness runner"). A GET
 * exists only to display the latest ReadinessRecord (never mutates); the
 * mutating action is this POST. Server Actions can't drive a long-running
 * background HTTP call as cleanly as a route can, and this endpoint's own
 * body IS the audit-safe result — no extra CSRF token layer beyond the
 * session + origin check, since it can only ever write an append-only record
 * and never sends anything to a real customer (isTest leads / allowlisted
 * recipients only, enforced inside dispatchOutreach itself).
 */
export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    if (!isApprover(session?.user?.email)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const origin = request.headers.get("origin");
    const expected = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "";
    if (!origin || !expected || new URL(origin).origin !== new URL(expected).origin) {
        return NextResponse.json({ error: "Unauthorized: origin mismatch" }, { status: 401 });
    }

    const result = await runReadinessCheck({ deploySha: process.env.VERCEL_GIT_COMMIT_SHA ?? null });
    return NextResponse.json(result);
}

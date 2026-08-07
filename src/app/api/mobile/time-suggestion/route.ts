export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";
import { suggestTaskForClockIn } from "@/lib/time-suggestion";

// GET /api/mobile/time-suggestion?projectId=...
// Suggested clock-in task for the caller on this project, derived from the
// latest daily log (AI match, then keywords), today's schedule, then the
// caller's own recent entries. Deterministic — no AI call happens here.
// Hybrid auth: Bearer token (mobile) OR NextAuth session (web time clock).
export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");
    if (!projectId) {
        return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    const fail = await assertProjectAccess(user, projectId);
    if (fail) return fail;

    try {
        const suggestion = await suggestTaskForClockIn({ userId: user.id, projectId });
        return NextResponse.json({ suggestion });
    } catch (error) {
        // A suggestion fault must never break the clock-in screen.
        console.error("[time-suggestion] failed", { projectId, error });
        return NextResponse.json({ suggestion: null });
    }
}

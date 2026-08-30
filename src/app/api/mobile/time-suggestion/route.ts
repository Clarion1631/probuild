export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";
import { suggestTaskForClockIn } from "@/lib/time-suggestion";

// GET /api/mobile/time-suggestion?projectId=...
// Suggested clock-in task for the caller on this project, derived first from
// today's dispatch (what the office planned for the caller today), then the
// latest daily log (AI match, then keywords), today's schedule, then the
// caller's own recent entries. Deterministic — no AI call happens here.
// Response: { suggestion: TimeSuggestion | null, uncostedPlannedTask: { id, name, note } | null }.
// `uncostedPlannedTask` is set when the caller's top-ranked active dispatch
// today has no chargeable estimate item/cost code — never a `suggestion`, but
// still worth telling the crew ("Planned: drywall start (not costed)"). Ranking
// considers ALL of the caller's active dispatched assignments together
// (chargeable or not) before deciding which bucket the winner falls into.
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
        const result = await suggestTaskForClockIn({ userId: user.id, projectId });
        return NextResponse.json(result);
    } catch (error) {
        // A suggestion fault must never break the clock-in screen.
        console.error("[time-suggestion] failed", { projectId, error });
        return NextResponse.json({ suggestion: null, uncostedPlannedTask: null });
    }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { markReviewed } from "@/lib/review-alert-lifecycle";

export const dynamic = "force-dynamic";

/**
 * Command Center "Mark reviewed" (Unified Money Register plan §4/§5 step 8).
 *
 * Carries its OWN `financialReports` permission check — RLS is not
 * authorization here, Prisma connects as a role that bypasses it (see
 * scripts/apply-automation-events.mjs:49, same posture as every other
 * automation API route in this directory).
 *
 * Conditionally updates by `{id, version, reasonHash}` (plan §4 B) so a
 * stale request — built from a reason set the server has since cleared or
 * changed — cannot repopulate acknowledgement fields after the issue moved
 * on. A 409 means the client's copy of the issue is stale; it should refetch
 * before retrying.
 */
const BodySchema = z.object({
    id: z.string().min(1),
    version: z.number().int().nonnegative(),
    reasonHash: z.string().min(1),
});

export async function POST(request: Request) {
    const user = await getCurrentUserWithPermissions();
    if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    if (!hasPermission(user, "financialReports")) {
        return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }

    let parsed: unknown;
    try {
        parsed = await request.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    const result = BodySchema.safeParse(parsed);
    if (!result.success) {
        return NextResponse.json(
            { ok: false, reason: "invalid-body", details: result.error.flatten() },
            { status: 400 },
        );
    }

    try {
        const outcome = await markReviewed(result.data);
        if (!outcome.ok) {
            const status = outcome.reason === "not-found" ? 404 : 409;
            return NextResponse.json({ ok: false, reason: outcome.reason }, { status });
        }
        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error("mark-reviewed failed", error instanceof Error ? error.name : "UnknownError");
        return NextResponse.json({ ok: false, reason: "mark-reviewed-failed" }, { status: 500 });
    }
}

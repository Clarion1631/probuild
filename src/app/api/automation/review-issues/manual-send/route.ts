import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { drainReviewAlerts, unconfiguredSender } from "@/lib/review-alert-outbox";

export const dynamic = "force-dynamic";

/**
 * Command Center "Send now" (Unified Money Register plan §4/§5 step 8).
 *
 * Carries its OWN `financialReports` permission check — same posture as
 * every other automation API route in this directory (RLS is not
 * authorization here; Prisma connects as a bypassing role).
 *
 * Gated on `REVIEW_ALERTS_ENABLED` (ships `false`) BEFORE anything else: no
 * Google Chat integration exists yet (that's plan step 10 — service account
 * key generation and the Vercel env var are Justin's to do, never handled
 * here), so there is no real `ReviewAlertSender` to call. This route exists
 * now so step 10 only has to swap `unconfiguredSender()` for the real one —
 * the auth check, validation, and drain wiring are already in place.
 */
const BodySchema = z.object({
    issueId: z.string().min(1).optional(),
});

export async function POST(request: Request) {
    const user = await getCurrentUserWithPermissions();
    if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    if (!hasPermission(user, "financialReports")) {
        return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }

    if (process.env.REVIEW_ALERTS_ENABLED !== "true") {
        return NextResponse.json({ ok: false, reason: "review-alerts-disabled" }, { status: 503 });
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
        const outcome = await drainReviewAlerts({
            issueId: result.data.issueId,
            sender: unconfiguredSender(),
        });
        return NextResponse.json({ ok: true, ...outcome });
    } catch (error) {
        console.error("review-alert manual send failed", error instanceof Error ? error.name : "UnknownError");
        return NextResponse.json({ ok: false, reason: "send-failed" }, { status: 500 });
    }
}

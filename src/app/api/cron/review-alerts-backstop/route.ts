import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { evaluateReviewAlertsBackstop } from "@/lib/review-alert-evaluator";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Periodic backstop for the review-alert evaluator (Unified Money Register
 * plan §5 step 8, "periodic receipt-exception backstop"). The post-sync
 * evaluator hooked into `syncQboExpenses` (qbo-expense-sync.ts) is
 * best-effort and swallows its own failures so a review-alert bug can never
 * fail the money sync it rides alongside — which also means an ingest-path
 * failure there is silent. This cron re-runs the SAME full evaluation on a
 * timer regardless of whether the last sync's inline evaluation succeeded,
 * so a missed evaluation self-heals on the next run instead of permanently
 * skipping alert creation for that target.
 *
 * Same auth posture as drain-notifications: fail CLOSED whenever CRON_SECRET
 * is configured (exact Bearer match, required on every environment); the
 * only unauthenticated path is genuinely local dev with no secret set.
 *
 * Finding 12 (nit): compares via `timingSafeEqual` over fixed-length SHA-256
 * digests of both sides (mirrors /api/integrations/co-audit's `authorized()`
 * and /api/mcp's gate) rather than plain `===`, so neither the header's
 * content nor its length leaks through response timing.
 */
function timingSafeCompare(a: string, b: string): boolean {
    return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export async function GET(request: Request) {
    const secret = process.env.CRON_SECRET;
    const authHeader = request.headers.get("authorization") ?? "";
    const authed = !!secret && timingSafeCompare(authHeader, `Bearer ${secret}`);
    const isLocalDev = !process.env.VERCEL && process.env.NODE_ENV !== "production" && !secret;
    if (!authed && !isLocalDev) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    if (process.env.REVIEW_ALERTS_ENABLED !== "true") {
        return NextResponse.json({ ok: false, reason: "review-alerts-disabled" }, { status: 503 });
    }

    try {
        const result = await evaluateReviewAlertsBackstop();
        console.log("[cron/review-alerts-backstop]", JSON.stringify(result));
        return NextResponse.json({ ok: true, ...result });
    } catch (error) {
        console.error(
            "review-alerts backstop failed",
            error instanceof Error ? error.name : "UnknownError",
        );
        return NextResponse.json({ ok: false, reason: "backstop-failed" }, { status: 500 });
    }
}

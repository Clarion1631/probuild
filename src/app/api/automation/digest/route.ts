import { NextResponse } from "next/server";
import { runDigestTick, createDefaultDigestDeps, type DigestTickResult } from "@/lib/automation-digest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Maps a digest tick's outcome to the HTTP response — pulled out as its own
 * function so the "never a silent 200 on failure" rule is unit-testable
 * without exercising the real QBO/DB-backed deps. ok:true (sent, or a benign
 * skip like before-send-window/already-sent/in-flight) is 200; ok:false
 * (delivery genuinely failed this tick) is 500.
 */
export function digestResultResponse(result: DigestTickResult): Response {
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

/**
 * Hourly cron: sends Vanessa the "posted yesterday" QuickBooks expense digest
 * once per Pacific calendar day, first attempt at/after 06:00 Pacific
 * (Goal 1, docs/plans/vanessa-review-loop-plan.md). Every tick is safe to
 * re-run — see src/lib/automation-digest.ts for the claim/retry/fencing logic.
 */
export async function GET(request: Request) {
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV && (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Required recipients — provisioned in Vercel prod before deploy. Never a
    // silent 200: a misconfigured deploy must be loud, not quietly no-op.
    const vanessaEmail = process.env.VANESSA_EMAIL?.trim();
    const digestCcEmail = process.env.DIGEST_CC_EMAIL?.trim();
    if (!vanessaEmail || !digestCcEmail) {
        const missing = [!vanessaEmail && "VANESSA_EMAIL", !digestCcEmail && "DIGEST_CC_EMAIL"].filter(Boolean).join(", ");
        console.error(`[cron/automation-digest] missing required env var(s): ${missing}`);
        return NextResponse.json(
            { ok: false, error: `Automation digest is misconfigured: missing ${missing}` },
            { status: 500 },
        );
    }

    const result = await runDigestTick(createDefaultDigestDeps(), { vanessaEmail, digestCcEmail });
    if (!result.ok) {
        console.error("[cron/automation-digest]", JSON.stringify(result));
    } else if ("sent" in result) {
        console.log("[cron/automation-digest]", JSON.stringify(result));
    }
    return digestResultResponse(result);
}

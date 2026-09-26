import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { withCronHeartbeat, isRecord } from "@/lib/cron-heartbeat";
import { prisma } from "@/lib/prisma";
import { pollLeadInbox } from "@/lib/speed-to-lead/gmail-poll";
import { promoteDueFallbacks } from "@/lib/speed-to-lead/intake";
import { deliverDueAlerts } from "@/lib/speed-to-lead/alerts";
import { maybeSend0900Digest } from "@/lib/speed-to-lead/tracking";
import { speedToLeadMode } from "@/lib/speed-to-lead/constants";

export const dynamic = "force-dynamic";
export const maxDuration = 55;

/**
 * Runs every minute. OFF returns immediately with zero Gmail, ntfy or Chat
 * calls — v1a has no opt-out/reply/bounce safety processing to run
 * regardless of mode, so unlike v1 there is nothing left to justify running
 * in OFF at all.
 */
async function handleGET() {
    if (speedToLeadMode() === "OFF") {
        return NextResponse.json({ mode: "OFF" });
    }
    const now = new Date();
    const poll = await pollLeadInbox(prisma, now);
    const promoted = await promoteDueFallbacks(now);
    const delivered = await deliverDueAlerts(prisma, now);
    const digestSent = await maybeSend0900Digest(now, prisma);

    return NextResponse.json({ poll, promoted: promoted.length, delivered: delivered.attempted, digestSent });
}

export const GET = withCronHeartbeat("SPEED_TO_LEAD", async request => {
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return handleGET();
}, {
    isFailure: body => isRecord(body) && isRecord(body.poll) && body.poll.ran === false && body.poll.reason === "error",
});

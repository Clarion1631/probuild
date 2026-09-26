import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { withCronHeartbeat, isRecord } from "@/lib/cron-heartbeat";
import { prisma } from "@/lib/prisma";
import { pollLeadInbox } from "@/lib/speed-to-lead/gmail-poll";
import { promoteDueFallbacks } from "@/lib/speed-to-lead/intake";
import { reconcileUnknownDeliveries, dispatchReadyAndApproved } from "@/lib/speed-to-lead/dispatch";
import { runFollowupSweep, send0900Digest } from "@/lib/speed-to-lead/followups";
import { templateADeadlinePassed } from "@/lib/speed-to-lead/template";

export const dynamic = "force-dynamic";
export const maxDuration = 55;

/**
 * Runs every minute (spec Intake: "Inbox poll (gtrsupport@, every minute)"),
 * in every mode including OFF — the poll itself processes opt-outs regardless
 * of mode. Everything else here (fallback promotion, reconciliation,
 * follow-ups, the 09:00 digest, expiring stale A) is cheap/idempotent to run
 * every minute alongside it.
 */
async function expireStaleTemplateA(now: Date): Promise<number> {
    const ready = await prisma.outreachMessage.findMany({ where: { kind: "TEMPLATE_A", status: "READY" } });
    let expired = 0;
    for (const message of ready) {
        const version = await prisma.outreachVersion.findFirst({ where: { messageId: message.id, generation: message.generation } });
        const renderInputs = version?.renderInputs as unknown as { intakeReceivedAt?: string } | null;
        const intakeReceivedAt = renderInputs?.intakeReceivedAt ? new Date(renderInputs.intakeReceivedAt) : null;
        if (!intakeReceivedAt || templateADeadlinePassed(intakeReceivedAt, now)) {
            await prisma.outreachMessage.updateMany({ where: { id: message.id, status: "READY" }, data: { status: "EXPIRED" } });
            expired++;
        }
    }
    return expired;
}

async function maybeSend0900Digest(now: Date): Promise<boolean> {
    if (now.getUTCHours() !== 9) return false;
    const today = now.toISOString().slice(0, 10);
    const key = "speedToLeadDigestLastSentDate";
    const row = await prisma.automationSetting.findUnique({ where: { key } });
    if (row?.value === today) return false;
    const { count } = await prisma.automationSetting.updateMany({ where: { key, value: { not: today } }, data: { value: today } });
    if (count === 0 && row) return false; // lost the race to another invocation
    if (!row) await prisma.automationSetting.create({ data: { key, value: today } }).catch(() => undefined);
    await send0900Digest();
    return true;
}

async function handleGET() {
    const now = new Date();
    const poll = await pollLeadInbox(prisma, now);
    const promoted = await promoteDueFallbacks(now);
    await reconcileUnknownDeliveries(prisma, now);
    const expired = await expireStaleTemplateA(now);
    const dispatched = await dispatchReadyAndApproved(prisma);
    const followups = await runFollowupSweep(now);
    const digestSent = await maybeSend0900Digest(now);

    return NextResponse.json({
        poll, promoted: promoted.length, expired, dispatched: dispatched.attempted, followups, digestSent,
    });
}

export const GET = withCronHeartbeat("SPEED_TO_LEAD", async request => {
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return handleGET();
}, {
    isFailure: body => isRecord(body) && isRecord(body.poll) && body.poll.ran === false && body.poll.reason === "error",
});

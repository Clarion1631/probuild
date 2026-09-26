import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { withCronHeartbeat, isRecord } from "@/lib/cron-heartbeat";
import { prisma } from "@/lib/prisma";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { dayKeyInTimeZone } from "@/lib/tz-date";
import { pollLeadInbox } from "@/lib/speed-to-lead/gmail-poll";
import { promoteDueFallbacks } from "@/lib/speed-to-lead/intake";
import { reconcileUnknownDeliveries, dispatchReadyAndApproved } from "@/lib/speed-to-lead/dispatch";
import { runFollowupSweep, send0900Digest } from "@/lib/speed-to-lead/followups";
import { templateADeadlinePassed } from "@/lib/speed-to-lead/template";
import { pushToJustin } from "@/lib/speed-to-lead/push";

/** The hour-of-day (0-23) `date` falls on in `timeZone` — Intl can render midnight as "24", so it is normalized back to 0. */
function hourInTimeZone(date: Date, timeZone: string): number {
    const hourPart = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).formatToParts(date).find(p => p.type === "hour")?.value ?? "0";
    return Number(hourPart) % 24;
}

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
    // The business's own local morning (spec Goal 8), not 09:00 UTC — Golden
    // Touch Remodeling is in Vancouver, WA (America/Los_Angeles), where
    // 09:00 UTC lands at 1am or 2am local depending on DST.
    const timeZone = await resolveCompanyTimeZone(prisma);
    if (hourInTimeZone(now, timeZone) !== 9) return false;
    const today = dayKeyInTimeZone(now, timeZone);
    const key = "speedToLeadDigestLastSentDate";
    const row = await prisma.automationSetting.findUnique({ where: { key } });
    if (row?.value === today) return false;
    const { count } = await prisma.automationSetting.updateMany({ where: { key, value: { not: today } }, data: { value: today } });
    if (count === 0 && row) return false; // lost the race to another invocation
    if (!row) await prisma.automationSetting.create({ data: { key, value: today } }).catch(() => undefined);
    await send0900Digest();
    return true;
}

/**
 * Goal 3 ("push Justin within 5 minutes for every web lead AND every Voice
 * voicemail/missed call") also covers a WEB_EMAIL_FALLBACK lead promoted
 * here — the only production push call used to be the direct webhook path,
 * so a fallback-promoted lead never notified Justin at all.
 */
async function pushPromotedFallbacks(outcomes: Awaited<ReturnType<typeof promoteDueFallbacks>>): Promise<void> {
    for (const outcome of outcomes) {
        if (!outcome.won || !outcome.leadId) continue;
        const lead = await prisma.lead.findUnique({ where: { id: outcome.leadId }, select: { name: true, client: { select: { email: true } } } });
        await pushToJustin(
            "New web lead (email fallback)",
            `${lead?.name ?? "Website inquiry"}${lead?.client?.email ? ` (${lead.client.email})` : ""} — REVIEW`,
        );
    }
}

async function handleGET() {
    const now = new Date();
    const poll = await pollLeadInbox(prisma, now);
    const promoted = await promoteDueFallbacks(now);
    await pushPromotedFallbacks(promoted);
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

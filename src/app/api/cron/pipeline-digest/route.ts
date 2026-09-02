import { NextResponse } from "next/server";
import { getPipelineHealth, formatPipelineDigest } from "@/lib/pipeline-health";
import { sendNotification } from "@/lib/email";
import { postTextToChatWebhook } from "@/lib/chat-webhook";
import { isCronAuthorized } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_TO = "jadkins@goldentouchremodeling.com";

/**
 * Morning pipeline digest. The vercel.json schedule is `0 14 * * *`, which is
 * UTC — that is 7 AM PDT and 6 AM PST (Vercel cron has no timezone setting, so
 * the delivery hour shifts by one across the DST boundary; that is accepted,
 * not a bug). vercel.json is strict JSON and cannot carry this note itself.
 *
 * One plain-text summary of the
 * receipt/QBO pipeline's overnight health, so an Intuit outage or a stalled
 * bot is noticed over coffee instead of at month-end reconciliation.
 *
 * Uses the SAME summariser as GET /api/health/pipeline — the digest and the
 * on-demand check must never disagree about whether the pipeline is OK.
 * Sends every morning, healthy or not: a digest that only arrives on failure
 * is indistinguishable from a digest that stopped running.
 */
export async function GET(request: Request) {
    // Fail closed everywhere but an explicit local dev run — see cron-auth.ts.
    if (!isCronAuthorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const health = await getPipelineHealth();
    const { subject, text } = formatPipelineDigest(health);

    const to = process.env.PIPELINE_DIGEST_TO || DEFAULT_TO;
    // sendNotification takes HTML and derives its own plain-text part; <pre>
    // keeps the line-per-item layout intact in an HTML client.
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const emailResult = await sendNotification(
        to,
        subject,
        `<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.5;">${escaped}</pre>`,
        undefined,
        { fromName: "ProBuild" },
    );

    const chatWebhook = process.env.BOT_HEALTH_CHAT_WEBHOOK;
    const chatPosted = chatWebhook ? await postTextToChatWebhook(chatWebhook, text) : false;

    console.log("[cron/pipeline-digest]", JSON.stringify({
        ok: health.ok,
        stuck: health.stuck,
        intuit: health.intuit.indicator,
        emailed: emailResult.success,
        chatPosted,
    }));

    return NextResponse.json({
        ok: health.ok,
        emailed: emailResult.success,
        chatPosted,
        health,
    });
}

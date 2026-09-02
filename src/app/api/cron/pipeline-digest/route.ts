import { NextResponse } from "next/server";
import { getPipelineHealth, formatPipelineDigest, type PipelineHealth } from "@/lib/pipeline-health";
import { sendNotification } from "@/lib/email";
import { postTextToWebhook } from "@/lib/chat-webhook";
import { isCronAuthorized } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_TO = "jadkins@goldentouchremodeling.com";
/** Neither delivery channel may hang the cron; each gets its own deadline. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Morning pipeline digest. The vercel.json schedule is `0 14 * * *`, which is
 * UTC — that is 7 AM PDT and 6 AM PST (Vercel cron has no timezone setting, so
 * the delivery hour shifts by one across the DST boundary; that is accepted,
 * not a bug). vercel.json is strict JSON and cannot carry this note itself.
 *
 * One plain-text summary of the receipt/QBO pipeline's overnight health, so an
 * Intuit outage or a stalled bot is noticed over coffee instead of at
 * month-end reconciliation.
 *
 * Uses the SAME summariser as GET /api/health/pipeline — the digest and the
 * on-demand check must never disagree about whether the pipeline is OK.
 * Sends every morning, healthy or not: a digest that only arrives on failure
 * is indistinguishable from a digest that stopped running.
 *
 * Delivery is the whole point of this route, so it is not best-effort: the two
 * channels run INDEPENDENTLY (one failing must not cancel the other) and a
 * rejected email is a 500. A monitoring job that silently fails to deliver is
 * worse than no monitoring job, because it looks like good news.
 */

/**
 * In production, a missing RESEND_API_KEY is a DELIVERY FAILURE, not a no-op.
 *
 * src/lib/email.ts falls back to a dummy key and returns {success:true} without
 * sending anything, which is fine for local dev but poison here: the pulse that
 * exists to reveal a broken pipeline would report emailed:true and HTTP 200
 * while delivering nothing — the failure disguised as good news. Checked HERE
 * rather than in email.ts so no other caller's behaviour changes.
 */
export function isEmailDeliveryConfigured(): boolean {
    const productionish =
        process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
    if (!productionish) return true;
    return Boolean(process.env.RESEND_API_KEY?.trim());
}

/** Resolve to a sentinel rather than reject, so allSettled reports the timeout as a value. */
async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const deadline = new Promise<T>(resolve => {
            timer = setTimeout(() => resolve(onTimeout), ms);
        });
        return await Promise.race([work, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

export interface PipelineDigestDependencies {
    getHealth: () => Promise<PipelineHealth>;
    sendEmail: (to: string, subject: string, html: string, text: string) => Promise<{ success: boolean }>;
    postChat: (webhookUrl: string, text: string) => Promise<{ sent: boolean; reason?: string }>;
    getChatWebhook: () => string | undefined;
    getRecipient: () => string;
    /** False when email cannot actually be delivered (see isEmailDeliveryConfigured). */
    isEmailConfigured?: () => boolean;
    /** Overridable so tests need not wait out the real 10s deadline. */
    deliveryTimeoutMs?: number;
}

export function createPipelineDigestHandlers(dependencies: PipelineDigestDependencies) {
    return {
        async GET(request: Request) {
            // Fail closed everywhere but an explicit local dev run — see cron-auth.ts.
            if (!isCronAuthorized(request)) {
                return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
            }

            const health = await dependencies.getHealth();
            const { subject, text } = formatPipelineDigest(health);

            const to = dependencies.getRecipient();
            // <pre> keeps the line-per-item layout intact for HTML clients,
            // and the ORIGINAL text is passed as the explicit text part — the
            // derived one collapses every newline, flattening this report into
            // a single unreadable line for plain-text readers.
            const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const html = `<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.5;">${escaped}</pre>`;

            const chatWebhook = dependencies.getChatWebhook();

            // allSettled, not all: Chat is optional and a thrown webhook error
            // must never cost us the email (or vice versa).
            const deadlineMs = dependencies.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS;
            const emailConfigured = (dependencies.isEmailConfigured ?? isEmailDeliveryConfigured)();
            if (!emailConfigured) {
                console.error("[cron/pipeline-digest] RESEND_API_KEY is not set — the digest cannot be delivered");
            }
            const [emailOutcome, chatOutcome] = await Promise.allSettled([
                emailConfigured
                    ? withDeadline(dependencies.sendEmail(to, subject, html, text), deadlineMs, { success: false })
                    : Promise.resolve({ success: false }),
                chatWebhook
                    ? withDeadline(dependencies.postChat(chatWebhook, text), deadlineMs, { sent: false, reason: "timed out" })
                    : Promise.resolve({ sent: false, reason: "no webhook configured" }),
            ]);

            const emailed = emailOutcome.status === "fulfilled" && emailOutcome.value.success === true;
            const chatPosted = chatOutcome.status === "fulfilled" && chatOutcome.value.sent === true;

            console.log("[cron/pipeline-digest]", JSON.stringify({
                ok: health.ok,
                stuck: health.stuck,
                intuit: health.intuit.indicator,
                emailed,
                chatPosted,
            }));

            if (!emailed) {
                // Chat still ran above — an unconfigured mailer must not cost
                // the one channel that might still reach a human.
                // Non-2xx so the failure is visible in Vercel's cron history
                // instead of being swallowed by a 200 nobody reads.
                console.error("[cron/pipeline-digest] digest email was not accepted");
                return NextResponse.json(
                    { ok: false, reason: "email-not-accepted", chatPosted, health },
                    { status: 500 },
                );
            }

            return NextResponse.json({ ok: health.ok, emailed, chatPosted, health });
        },
    };
}

const handlers = createPipelineDigestHandlers({
    getHealth: getPipelineHealth,
    sendEmail: (to, subject, html, text) =>
        sendNotification(to, subject, html, undefined, { fromName: "ProBuild", text }),
    postChat: postTextToWebhook,
    getChatWebhook: () => process.env.BOT_HEALTH_CHAT_WEBHOOK,
    getRecipient: () => process.env.PIPELINE_DIGEST_TO || DEFAULT_TO,
});

export async function GET(request: Request) {
    return handlers.GET(request);
}

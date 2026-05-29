/**
 * Google Chat (Spaces) notifier via incoming webhooks.
 *
 * Two spaces: an INTERNAL space for crew/job-costing alerts (time edits, uncoded labor,
 * missing receipts, offsite, forgotten clock-outs) and a CUSTOMER-friendly space for
 * client-facing updates. Each space's incoming-webhook URL is supplied via env:
 *   GOOGLE_CHAT_INTERNAL_WEBHOOK_URL
 *   GOOGLE_CHAT_CUSTOMER_WEBHOOK_URL
 * If a space's webhook isn't configured the call is a logged no-op (never throws), so the
 * surrounding request path is unaffected.
 */
export type ChatSpace = "internal" | "customer";

function webhookFor(space: ChatSpace): string | undefined {
    return space === "customer"
        ? process.env.GOOGLE_CHAT_CUSTOMER_WEBHOOK_URL
        : process.env.GOOGLE_CHAT_INTERNAL_WEBHOOK_URL;
}

export type ChatPostResult = { ok: boolean; skipped?: boolean };

/** Post a plain-text message to a Google Chat space. Best-effort; never throws. */
export async function postToChatSpace(space: ChatSpace, text: string): Promise<ChatPostResult> {
    const url = webhookFor(space);
    if (!url) {
        console.warn(
            `[google-chat] no webhook for "${space}" space (set GOOGLE_CHAT_${space.toUpperCase()}_WEBHOOK_URL); skipping.`
        );
        return { ok: false, skipped: true };
    }
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=UTF-8" },
            body: JSON.stringify({ text }),
            signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        if (!res.ok) {
            console.error(`[google-chat] "${space}" webhook returned ${res.status}`);
            return { ok: false };
        }
        return { ok: true };
    } catch (err) {
        console.error("[google-chat] post failed", err instanceof Error ? err.message : err);
        return { ok: false };
    }
}

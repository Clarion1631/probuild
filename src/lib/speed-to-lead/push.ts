import { postTextToWebhook } from "@/lib/chat-webhook";

/**
 * Push to Justin (spec Goal 3: "ntfy, with the Leads Chat space as fallback").
 * Never throws — a push failure must not fail the intake/dispatch it reports on.
 */
const PUSH_TIMEOUT_MS = 8_000;

export interface PushResult {
    sent: boolean;
    via: "ntfy" | "chat" | "none";
    reason?: string;
}

async function sendNtfy(title: string, message: string): Promise<{ ok: boolean; reason?: string }> {
    const topic = process.env.SPEED_TO_LEAD_NTFY_TOPIC;
    if (!topic || !topic.trim()) return { ok: false, reason: "no ntfy topic configured" };
    const base = (process.env.SPEED_TO_LEAD_NTFY_BASE_URL || "https://ntfy.sh").trim().replace(/\/+$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
    try {
        const res = await fetch(`${base}/${encodeURIComponent(topic.trim())}`, {
            method: "POST",
            headers: { Title: title, Priority: "high" },
            body: message,
            signal: controller.signal,
        });
        if (!res.ok) return { ok: false, reason: `ntfy responded ${res.status}` };
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.name : "network error" };
    } finally {
        clearTimeout(timer);
    }
}

/** Justin's own push topic — Goal 3 (web lead / Voice voicemail or missed call), under 5 minutes. */
export async function pushToJustin(title: string, message: string): Promise<PushResult> {
    const ntfy = await sendNtfy(title, message);
    if (ntfy.ok) return { sent: true, via: "ntfy" };

    const chatUrl = process.env.SPEED_TO_LEAD_CHAT_WEBHOOK_URL;
    const chat = await postTextToWebhook(chatUrl, `*${title}*\n${message}`);
    if (chat.sent) return { sent: true, via: "chat" };

    console.error("[speed-to-lead] push failed on both channels", { ntfyReason: ntfy.reason, chatReason: chat.reason });
    return { sent: false, via: "none", reason: ntfy.reason ?? chat.reason };
}

import { Resend } from 'resend';
import { prisma } from './prisma';

const resendApiKey = process.env.RESEND_API_KEY || 're_dummy_fallback';
const resend = new Resend(resendApiKey);

export type FrozenNotification = {
    from: string;
    to: string[];
    replyTo: string;
    subject: string;
    html: string;
    text: string;
    cc?: string[];
    bcc?: string[];
};

type FrozenNotificationSendResult = {
    data?: { id?: string } | null;
    error?: unknown;
};

type FrozenNotificationDependencies = {
    send: (
        payload: FrozenNotification,
        options: { idempotencyKey: string },
    ) => Promise<FrozenNotificationSendResult>;
};

function sanitizeEmailHeader(value: string): string {
    return value.replace(/[\r\n]+/g, " ").trim();
}

function uniqueRecipients(values: string[] | undefined, excluded = new Set<string>()): string[] {
    const byKey = new Map<string, string>();
    for (const raw of values ?? []) {
        const value = raw.trim();
        const key = value.toLowerCase();
        if (value && !excluded.has(key) && !byKey.has(key)) byKey.set(key, value);
    }
    return [...byKey.values()];
}

function htmlToPlainText(html: string): string {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Build the complete byte-stable, JSON-serializable payload used by durable
 * email jobs. All dynamic recipients/settings must be resolved by the caller
 * before this function is called; retries reuse the returned object verbatim.
 */
export function buildFrozenNotification(input: {
    to: string[];
    subject: string;
    html: string;
    fromName?: string;
    replyTo?: string;
    cc?: string[];
    bcc?: string[];
}): FrozenNotification {
    const to = uniqueRecipients(input.to);
    const toKeys = new Set(to.map(value => value.toLowerCase()));
    const cc = uniqueRecipients(input.cc, toKeys);
    const visibleKeys = new Set([...toKeys, ...cc.map(value => value.toLowerCase())]);
    const bcc = uniqueRecipients(input.bcc, visibleKeys);
    const displayName = sanitizeEmailHeader(input.fromName || "Golden Touch Remodeling") || "Golden Touch Remodeling";
    const subject = sanitizeEmailHeader(input.subject);
    const replyTo = sanitizeEmailHeader(input.replyTo || "jadkins@goldentouchremodeling.com");
    return {
        from: `${displayName} <notifications@goldentouchremodeling.com>`,
        to,
        ...(cc.length ? { cc } : {}),
        ...(bcc.length ? { bcc } : {}),
        replyTo,
        subject,
        html: input.html,
        text: htmlToPlainText(input.html),
    };
}

/** Send an already-frozen payload with one stable Resend idempotency key. */
export async function sendFrozenNotification(
    dispatch: FrozenNotification,
    idempotencyKey: string,
    dependencies?: FrozenNotificationDependencies,
): Promise<{ success: true; id: string } | { success: false; ambiguous: boolean }> {
    if (dispatch.to.length === 0 || !idempotencyKey.trim()) return { success: false, ambiguous: false };
    // Preserve sendNotification's established local/test behavior. Calling the
    // Resend SDK with the dummy fallback would turn every local durable job
    // into a retry (and would still make an unwanted outbound HTTP request).
    // Explicit injected dependencies remain authoritative in focused tests.
    if (!dependencies && resendApiKey === 're_dummy_fallback') {
        return { success: true, id: "mock_resend_id_123" };
    }
    const provider = dependencies ?? {
        send: (payload: FrozenNotification, options: { idempotencyKey: string }) => resend.emails.send(payload, options),
    };
    try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const response = await Promise.race([
            provider.send(dispatch, { idempotencyKey }),
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error("Email provider request timed out")), 8_000);
            }),
        ]).finally(() => {
            if (timeout) clearTimeout(timeout);
        });
        if (response.error) {
            console.error("Resend API returned error:", response.error);
            return { success: false, ambiguous: false };
        }
        if (!response.data?.id) {
            console.error("Resend API returned no message id");
            return { success: false, ambiguous: true };
        }
        return { success: true, id: response.data.id };
    } catch (error) {
        console.error("Failed to send Resend email:", error);
        // A connection error or timeout may happen after the provider accepted
        // the request. Callers must retry only with this same payload/key.
        return { success: false, ambiguous: true };
    }
}

// Fallback internal-copy address for client-facing documents. Used only when the
// editable "System Notification Email" setting (Settings → Company) is unset.
// BCC'd so the client never sees the internal address. Override via env var.
export const CLIENT_DOC_COPY_EMAIL = (process.env.CLIENT_DOC_COPY_EMAIL || "notifications@goldentouchremodeling.com").trim();

export async function sendNotification(
    toEmail: string,
    subject: string,
    htmlContent: string,
    attachments?: { filename: string, content: Buffer }[],
    options?: { fromName?: string; replyTo?: string; cc?: string[]; bcc?: string[]; copyToInternal?: boolean }
): Promise<{ success: boolean; id?: string }> {
    // The "to" can be comma-separated (e.g. the System Notification Email setting
    // holding several team addresses) — split into a proper recipient list.
    const toList = toEmail ? toEmail.split(",").map(e => e.trim()).filter(Boolean) : [];
    if (toList.length === 0) {
        return { success: false };
    }

    if (resendApiKey === 're_dummy_fallback') {
        if (process.env.NODE_ENV !== 'production') {
            console.log("-----------------------------------------");
            console.log(`[MOCK EMAIL NOTIFICATION]`);
            console.log(`To: ${toEmail}`);
            console.log(`Subject: ${subject}`);
            console.log(`Content: ${htmlContent.substring(0, 100)}...`);
            if (attachments) {
                console.log(`Attached ${attachments.length} files.`);
            }
            console.log("-----------------------------------------");
        }
        return { success: true, id: "mock_resend_id_123" };
    }

    // Strip HTML tags for plain text version (improves deliverability)
    const textContent = htmlToPlainText(htmlContent);

    const displayName = options?.fromName || 'Golden Touch Remodeling';

    // Resolve BCC: any explicit bcc, plus an optional internal copy of client-facing
    // docs. Deduped (case-insensitive) and never duplicating the To/CC recipients.
    const bccByKey = new Map<string, string>();
    for (const e of options?.bcc || []) { if (e?.trim()) bccByKey.set(e.trim().toLowerCase(), e.trim()); }
    if (options?.copyToInternal) {
        // Editable in Settings → Company ("System Notification Email"); falls back
        // to CLIENT_DOC_COPY_EMAIL when that setting is unset.
        let copyAddr = CLIENT_DOC_COPY_EMAIL;
        try {
            const s = await prisma.companySettings.findUnique({ where: { id: 'singleton' }, select: { notificationEmail: true } });
            if (s?.notificationEmail?.trim()) copyAddr = s.notificationEmail.trim();
        } catch { /* keep fallback */ }
        for (const addr of copyAddr.split(",").map(e => e.trim()).filter(Boolean)) {
            const key = addr.toLowerCase();
            const dup = toList.some(e => e.toLowerCase() === key) || (options?.cc || []).some(e => e.toLowerCase() === key);
            if (!dup) bccByKey.set(key, addr);
        }
    }
    const bccList = bccByKey.size > 0 ? [...bccByKey.values()] : undefined;

    try {
        const data = await resend.emails.send({
            from: `${displayName} <notifications@goldentouchremodeling.com>`,
            to: toList,
            replyTo: options?.replyTo || 'jadkins@goldentouchremodeling.com',
            subject: subject,
            html: htmlContent,
            text: textContent,
            attachments: attachments,
            cc: options?.cc,
            bcc: bccList
        });
        if (data.error) {
            console.error("Resend API returned error:", data.error);
            return { success: false };
        }
        return { success: true, id: data.data?.id };
    } catch (error) {
        console.error("Failed to send Resend email:", error);
        return { success: false };
    }
}
export async function checkEmailStatus(emailId: string): Promise<string | null> {
    if (!emailId) return null;
    if (resendApiKey === 're_dummy_fallback') return "delivered";
    try {
        const result = await resend.emails.get(emailId);
        return result.data?.last_event || null;
    } catch (error) {
        console.error("Failed to check email status:", error);
        return null;
    }
}

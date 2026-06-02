import { Resend } from 'resend';
import { prisma } from './prisma';

const resendApiKey = process.env.RESEND_API_KEY || 're_dummy_fallback';
const resend = new Resend(resendApiKey);

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
    if (!toEmail) {
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
    const textContent = htmlContent
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

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
        if (copyAddr) {
            const key = copyAddr.toLowerCase();
            const dup = toEmail.toLowerCase() === key || (options?.cc || []).some(e => e.toLowerCase() === key);
            if (!dup) bccByKey.set(key, copyAddr);
        }
    }
    const bccList = bccByKey.size > 0 ? [...bccByKey.values()] : undefined;

    try {
        const data = await resend.emails.send({
            from: `${displayName} <notifications@goldentouchremodeling.com>`,
            to: [toEmail],
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

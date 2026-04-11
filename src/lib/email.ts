import { Resend } from 'resend';

const resendApiKey = process.env.RESEND_API_KEY || 're_dummy_fallback';
const resend = new Resend(resendApiKey);

export async function sendNotification(
    toEmail: string,
    subject: string,
    htmlContent: string,
    attachments?: { filename: string, content: Buffer }[],
    options?: { fromName?: string; replyTo?: string; cc?: string[] }
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

    try {
        const data = await resend.emails.send({
            from: `${displayName} <notifications@goldentouchremodeling.com>`,
            to: [toEmail],
            replyTo: options?.replyTo || 'jadkins@goldentouchremodeling.com',
            subject: subject,
            html: htmlContent,
            text: textContent,
            attachments: attachments,
            cc: options?.cc
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

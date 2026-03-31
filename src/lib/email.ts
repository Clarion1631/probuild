import { Resend } from 'resend';

const resendApiKey = process.env.RESEND_API_KEY || 're_dummy_fallback';
const resend = new Resend(resendApiKey);

export async function sendNotification(
    toEmail: string,
    subject: string,
    htmlContent: string,
    attachments?: { filename: string, content: Buffer }[],
    options?: { fromName?: string; replyTo?: string; cc?: string[] }
) {
    if (!toEmail) {
        console.log("No notification email configured. Skipping email dispatch.");
        return;
    }

    if (resendApiKey === 're_dummy_fallback') {
        console.log("-----------------------------------------");
        console.log(`[MOCK EMAIL NOTIFICATION]`);
        console.log(`To: ${toEmail}`);
        console.log(`Subject: ${subject}`);
        console.log(`Content: ${htmlContent.substring(0, 100)}...`);
        if (attachments) {
            console.log(`Attached ${attachments.length} files.`);
        }
        console.log("-----------------------------------------");
        return;
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
        console.log("Email dispatched via Resend:", data);
    } catch (error) {
        console.error("Failed to send Resend email:", error);
    }
}

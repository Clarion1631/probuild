import { Resend } from 'resend';

const resendApiKey = process.env.RESEND_API_KEY || 're_dummy_fallback';
const resend = new Resend(resendApiKey);

export async function sendNotification(
    toEmail: string,
    subject: string,
    htmlContent: string,
    attachments?: { filename: string, content: Buffer }[]
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

    try {
        const data = await resend.emails.send({
            from: 'ProBuild Notifications <notifications@probuild-app.com>',
            to: [toEmail],
            subject: subject,
            html: htmlContent,
            attachments: attachments
        });
        console.log("Email dispatched via Resend:", data);
    } catch (error) {
        console.error("Failed to send Resend email:", error);
    }
}

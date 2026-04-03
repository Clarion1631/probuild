import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;

export async function sendSMS(toPhone: string, body: string) {
    if (!toPhone) {
        return;
    }

    // Normalize phone number — ensure it starts with +1 for US
    let normalized = toPhone.replace(/[^+\d]/g, '');
    if (!normalized.startsWith('+')) {
        if (normalized.length === 10) {
            normalized = '+1' + normalized;
        } else if (normalized.length === 11 && normalized.startsWith('1')) {
            normalized = '+' + normalized;
        }
    }

    if (!accountSid || !authToken || !fromNumber) {
        console.log("-----------------------------------------");
        console.log(`[MOCK SMS NOTIFICATION]`);
        console.log(`To: ${normalized}`);
        console.log(`From: ${fromNumber || '+10000000000'}`);
        console.log(`Body: ${body}`);
        console.log("-----------------------------------------");
        return;
    }

    try {
        const client = twilio(accountSid, authToken);
        const message = await client.messages.create({
            body,
            from: fromNumber,
            to: normalized,
        });
        return message;
    } catch (error) {
        console.error("Failed to send Twilio SMS:", error);
    }
}

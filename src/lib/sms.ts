import twilio from "twilio";
import { normalizeE164 } from "./phone";

export type SmsResult =
    | { ok: true; messageSid: string }
    | { ok: false; error: string; mocked?: boolean };

export async function sendSMS(toPhone: string, body: string): Promise<SmsResult> {
    const normalized = normalizeE164(toPhone);
    if (!normalized) {
        return { ok: false, error: "invalid_phone" };
    }

    // Read at call time so warm instances always see current env vars.
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

    const haveCreds = accountSid && authToken && (messagingServiceSid || fromNumber);
    if (!haveCreds) {
        if (process.env.NODE_ENV !== "production") {
            console.log("-----------------------------------------");
            console.log(`[MOCK SMS NOTIFICATION]`);
            console.log(`To: ${normalized}`);
            console.log(`Body: ${body}`);
            console.log("-----------------------------------------");
        } else {
            console.error("[sendSMS] missing credentials — accountSid:", !!accountSid, "authToken:", !!authToken, "messagingServiceSid:", !!messagingServiceSid, "fromNumber:", !!fromNumber);
        }
        return { ok: false, error: "missing_credentials", mocked: true };
    }

    try {
        const client = twilio(accountSid!, authToken!);
        const params: Record<string, string> = { body, to: normalized };
        if (messagingServiceSid) {
            params.messagingServiceSid = messagingServiceSid;
        } else if (fromNumber) {
            params.from = fromNumber;
        }
        const message = await client.messages.create(params as any);
        return { ok: true, messageSid: message.sid };
    } catch (err: any) {
        console.error("[sendSMS] Twilio error:", err?.message || err);
        return { ok: false, error: err?.message || "twilio_error" };
    }
}

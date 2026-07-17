// E.164 normalization for US/Canada phone numbers.
// Used by client write paths (Client.primaryPhoneE164 column) and the
// Twilio inbound webhook to look up clients by their phone number.
export function normalizeE164(input: string | null | undefined): string | null {
    if (!input) return null;
    const cleaned = String(input).replace(/[^+\d]/g, "");
    if (cleaned.startsWith("+")) {
        return cleaned.length >= 11 ? cleaned : null;
    }
    if (cleaned.length === 10) return "+1" + cleaned;
    if (cleaned.length === 11 && cleaned.startsWith("1")) return "+" + cleaned;
    return null;
}

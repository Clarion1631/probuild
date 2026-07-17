// Tax-exemption certificate status for a Client. WA DOR requires a reseller
// permit / exemption certificate on file for every tax-exempt sale.
//
// Expiry dates are stored as date-only values (UTC midnight DateTimes), so all
// comparisons and formatting read the UTC calendar day — otherwise a cert
// expiring "2026-06-30" would display/flip a day early in Pacific time.

export type TaxCertStatus = "missing" | "expired" | "valid";

export function getTaxCertStatus(
    cert: { url?: string | null; expiresAt?: string | Date | null } | null | undefined
): TaxCertStatus {
    if (!cert?.url) return "missing";
    if (cert.expiresAt) {
        const exp = new Date(cert.expiresAt);
        if (!isNaN(exp.getTime())) {
            // Valid through the end of the stated calendar day, local time.
            const endOfDay = new Date(exp.getUTCFullYear(), exp.getUTCMonth(), exp.getUTCDate(), 23, 59, 59, 999);
            if (endOfDay.getTime() < Date.now()) return "expired";
        }
    }
    return "valid";
}

export function formatCertExpiry(expiresAt: string | Date): string {
    return new Date(expiresAt).toLocaleDateString(undefined, { timeZone: "UTC" });
}

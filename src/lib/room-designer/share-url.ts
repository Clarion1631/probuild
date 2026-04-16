// Helpers for constructing and validating share URLs. Only pure helpers here
// — `generateShareToken` lives in `share-token.ts` because it pulls in
// `node:crypto`, which must not be imported from the client bundle.

/**
 * Build the absolute share URL. Falls back to relative path when NEXTAUTH_URL
 * / NEXT_PUBLIC_APP_URL aren't set so dev doesn't crash, but production should
 * always have at least one of them.
 */
export function buildShareUrl(token: string): string {
    const base =
        process.env.NEXT_PUBLIC_APP_URL ??
        process.env.NEXTAUTH_URL ??
        "";
    const trimmed = base.replace(/\/+$/, "");
    return `${trimmed}/share/room/${token}`;
}

/** Token format guard — rejects obviously malformed input before a DB hit. */
export function isValidShareToken(token: string | null | undefined): token is string {
    return typeof token === "string" && /^[a-f0-9]{24,64}$/.test(token);
}

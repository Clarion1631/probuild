import { SignJWT, jwtVerify } from "jose";

function getJwtSecret(): Uint8Array {
    const secret = process.env.CLIENT_PORTAL_SECRET || process.env.NEXTAUTH_SECRET;
    if (!secret) throw new Error("CLIENT_PORTAL_SECRET (or NEXTAUTH_SECRET fallback) is not configured");
    return new TextEncoder().encode(secret);
}

export async function signClientPortalToken(clientId: string, email: string): Promise<string> {
    return new SignJWT({ clientId, email })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("365d")
        .sign(getJwtSecret());
}

/**
 * Build a passwordless portal link for a client.
 *
 * When we know the client, the link routes through `/api/portal/verify`, which
 * validates the signed token, drops the `client_portal_token` cookie, and then
 * redirects to `nextPath` — so a single click logs the client into the whole
 * portal, not just the destination page. Falls back to a bare link (which still
 * works for staff or Google-logged-in clients) when the client is unknown.
 */
export async function buildClientPortalUrl(
    clientId: string | null | undefined,
    email: string | null | undefined,
    nextPath: string,
): Promise<string> {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    if (clientId && email) {
        const token = await signClientPortalToken(clientId, email.toLowerCase());
        return `${appUrl}/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(nextPath)}`;
    }
    return `${appUrl}${nextPath}`;
}

export async function verifyClientPortalToken(token: string): Promise<{ clientId: string; email: string } | null> {
    try {
        const { payload } = await jwtVerify(token, getJwtSecret());
        if (!payload.clientId || !payload.email) return null;
        return { clientId: payload.clientId as string, email: payload.email as string };
    } catch {
        return null;
    }
}

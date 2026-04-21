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
        .setExpirationTime("7d")
        .sign(getJwtSecret());
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

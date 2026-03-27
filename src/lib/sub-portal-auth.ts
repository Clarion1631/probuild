import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import { prisma } from "@/lib/prisma";

const JWT_SECRET = new TextEncoder().encode(
    process.env.SUB_PORTAL_SECRET || "sub-portal-dev-secret-change-me"
);

export interface SubPortalSession {
    subId: string;
    email: string;
}

/**
 * Reads and verifies the sub_portal_token cookie.
 * Returns the subcontractor record or null if unauthenticated.
 */
export async function getSubPortalSession() {
    try {
        const cookieStore = await cookies();
        const token = cookieStore.get("sub_portal_token")?.value;

        if (!token) return null;

        const { payload } = await jwtVerify(token, JWT_SECRET);

        if (!payload.subId || !payload.email) return null;

        const sub = await prisma.subcontractor.findUnique({
            where: { id: payload.subId as string },
        });

        if (!sub || sub.status !== "ACTIVE") return null;

        return sub;
    } catch {
        return null;
    }
}

import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { cookies } from "next/headers";
import { verifyClientPortalToken } from "@/lib/client-portal-auth";

/**
 * Resolve the currently logged-in portal user to a single Client row by email.
 *
 * `Client.email` is nullable and NOT unique in the schema, so blindly joining
 * on email can cross-authorize unrelated clients that happen to share an address.
 * This helper collapses to `null` if the email maps to zero OR more-than-one
 * client rows — refusing ambiguous matches rather than leaking access.
 *
 * Returns the exact `clientId` on success so downstream queries can filter by
 * `{ clientId }` instead of `{ client: { email } }`.
 *
 * This lives outside `actions.ts` because `actions.ts` is marked `"use server"`
 * and importing from a route handler would turn every call into an RPC.
 */
export async function resolveSessionClientId(): Promise<string | null> {
    // Path 1: NextAuth session (staff previewing portal, or client with Google login)
    const session = await getServerSession(authOptions);
    const email = session?.user?.email?.toLowerCase();
    if (email) {
        const matches = await prisma.client.findMany({
            where: { email },
            select: { id: true },
            take: 2,
        });
        if (matches.length === 1) return matches[0].id;
    }

    // Path 2: client portal magic-link cookie (clients clicking email links)
    try {
        const cookieStore = await cookies();
        const portalToken = cookieStore.get("client_portal_token")?.value;
        if (portalToken) {
            const payload = await verifyClientPortalToken(portalToken);
            if (payload?.clientId) {
                const client = await prisma.client.findUnique({
                    where: { id: payload.clientId },
                    select: { id: true },
                });
                if (client) return client.id;
            }
        }
    } catch {}

    return null;
}

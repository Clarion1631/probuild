import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
    const session = await getServerSession(authOptions);
    const email = session?.user?.email?.toLowerCase();
    if (!email) return null;
    const matches = await prisma.client.findMany({
        where: { email },
        select: { id: true },
        take: 2, // only need to detect duplicates
    });
    if (matches.length !== 1) return null;
    return matches[0].id;
}

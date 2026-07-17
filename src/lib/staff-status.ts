import { prisma } from "@/lib/prisma";

/**
 * Resolve staff account status from the database instead of trusting a JWT.
 * Missing users and explicitly disabled users both fail closed.
 */
export async function isStaffAccountEnabled(email: string): Promise<boolean> {
    const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        select: { status: true },
    });

    return !!user && user.status !== "DISABLED";
}

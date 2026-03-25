import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectivePermissions } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// GET: return current user's permissions for client-side gating
export async function GET() {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            include: {
                permissions: true,
                projectAccess: true,
            },
        });

        if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

        const isAdmin = user.role === "ADMIN" || user.role === "MANAGER";

        // Use shared helper — applies role-based defaults when no UserPermission record exists
        const effectivePermissions = getEffectivePermissions(user);

        return NextResponse.json({
            role: user.role,
            isAdmin,
            permissions: effectivePermissions,
            projectIds: (user.projectAccess || []).map((pa: any) => pa.projectId),
        });
    } catch (error: any) {
        console.error("GET /api/me/permissions error:", error);
        return NextResponse.json({ error: "Internal server error", details: error.message }, { status: 500 });
    }
}

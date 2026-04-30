import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOnly } from "@/lib/mobile-auth";
import { getEffectivePermissions } from "@/lib/permissions";
import { toNum } from "@/lib/prisma-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    const auth = await authenticateMobileOnly(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const fullUser = await prisma.user.findUnique({
        where: { id: user.id },
        include: {
            permissions: true,
            projectAccess: { select: { projectId: true } },
            assignedProjects: {
                where: { status: { not: "Closed" } },
                select: {
                    id: true,
                    number: true,
                    name: true,
                    status: true,
                    location: true,
                    locationLat: true,
                    locationLng: true,
                    geofenceRadiusMeters: true,
                    color: true,
                    clientId: true,
                },
                orderBy: { viewedAt: "desc" },
            },
        },
    });

    if (!fullUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const permissions = getEffectivePermissions(fullUser);

    return NextResponse.json({
        user: {
            id: fullUser.id,
            email: fullUser.email,
            name: fullUser.name,
            role: fullUser.role,
            status: fullUser.status,
            hourlyRate: toNum(fullUser.hourlyRate),
            burdenRate: toNum(fullUser.burdenRate),
        },
        permissions,
        assignedProjects: fullUser.assignedProjects,
    });
}

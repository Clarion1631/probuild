import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

// GET /api/activity?projectId=X&actorType=CLIENT (actorType optional)
export async function GET(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");
    const actorType = searchParams.get("actorType");

    if (!projectId) {
        return NextResponse.json({ error: "projectId required" }, { status: 400 });
    }

    // Verify project-level access
    const callerUser = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: {
            role: true,
            projectAccess: { where: { projectId }, select: { projectId: true } },
        },
    });
    const isAdmin = callerUser && ["ADMIN", "MANAGER"].includes(callerUser.role);
    if (!callerUser || (!isAdmin && callerUser.projectAccess.length === 0)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const activities = await prisma.activityLog.findMany({
        where: {
            projectId,
            ...(actorType ? { actorType } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 50,
    });

    return NextResponse.json({ activities });
}

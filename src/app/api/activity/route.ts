import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

// GET /api/activity?projectId=X&actorType=CLIENT (actorType optional)
export async function GET(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");
    const actorType = searchParams.get("actorType");

    if (!projectId) {
        return NextResponse.json({ error: "projectId required" }, { status: 400 });
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

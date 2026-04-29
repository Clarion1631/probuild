export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
    const auth = await authenticateMobileOrSession(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;

    const { id: projectId } = await params;
    const projectError = await assertProjectAccess(user, projectId);
    if (projectError) return projectError;

    const tasks = await prisma.scheduleTask.findMany({
        where: { projectId },
        include: {
            assignments: {
                include: { user: { select: { id: true, name: true, email: true } } },
            },
            punchItems: { orderBy: { order: "asc" } },
            dependencies: {
                include: {
                    predecessor: { select: { id: true, name: true, status: true } },
                },
            },
        },
        orderBy: [{ order: "asc" }, { startDate: "asc" }],
    });

    return NextResponse.json(JSON.parse(JSON.stringify(tasks)));
}

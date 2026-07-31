import { NextResponse } from "next/server";
export const dynamic = 'force-dynamic';
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { OPEN_PROJECT_STATUSES } from "@/lib/project-status";

export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    // Optional comma-separated Project.status filter. Only open-project statuses
    // are kept — this can only narrow the role-based filtering below, never widen
    // it (so it can't be used to pull Closed Complete/Lost projects through here).
    const statusParam = new URL(req.url).searchParams.get("status");
    const requestedStatuses = statusParam
        ? statusParam.split(",").map(s => s.trim()).filter(s => OPEN_PROJECT_STATUSES.includes(s))
        : null;
    if (requestedStatuses && requestedStatuses.length === 0) {
        return NextResponse.json({ error: "invalid status filter" }, { status: 400 });
    }
    const statusFilter = requestedStatuses ? { in: requestedStatuses } : {};

    let projects;

    if (user.role === 'MANAGER' || user.role === 'ADMIN') {
        projects = await prisma.project.findMany({
            where: { status: { not: "Closed", ...statusFilter } },
            orderBy: { createdAt: 'desc' },
        });
    } else {
        const [accessRecords, crewProjects] = await Promise.all([
            prisma.projectAccess.findMany({
                where: { userId: user.id },
                select: { projectId: true },
            }),
            prisma.project.findMany({
                where: { crew: { some: { id: user.id } } },
                select: { id: true },
            }),
        ]);

        const allIds = [...new Set([
            ...accessRecords.map(a => a.projectId),
            ...crewProjects.map(p => p.id),
        ])];

        projects = allIds.length === 0 ? [] : await prisma.project.findMany({
            where: { id: { in: allIds }, status: { not: "Closed", ...statusFilter } },
            orderBy: { createdAt: 'desc' },
        });
    }

    return NextResponse.json(projects);
}

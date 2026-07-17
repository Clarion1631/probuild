import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";

export const dynamic = "force-dynamic";

// GET /api/mobile/schedule/today
// Returns the caller's tasks scheduled to be active today (or today ± 1 day for slop).
// ADMIN/MANAGER see all open projects' tasks; FIELD_CREW see only tasks on projects
// they're crew-assigned to or assigned to via TaskAssignment.
// Hybrid auth: Bearer token (mobile) OR NextAuth session (web debug).
export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 1);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    end.setDate(end.getDate() + 1);

    const baseWhere: any = {
        startDate: { lte: end },
        endDate: { gte: start },
    };

    const isFullAccess = user.role === "ADMIN" || user.role === "MANAGER";
    if (!isFullAccess) {
        // FIELD_CREW: tasks on projects they're crew on OR tasks they're individually assigned to
        const crewProjects = await prisma.project.findMany({
            where: { crew: { some: { id: user.id } } },
            select: { id: true },
        });
        const access = await prisma.projectAccess.findMany({
            where: { userId: user.id },
            select: { projectId: true },
        });
        const projectIds = Array.from(new Set([...crewProjects.map(p => p.id), ...access.map(a => a.projectId)]));
        baseWhere.OR = [
            { projectId: { in: projectIds } },
            { assignments: { some: { userId: user.id } } },
        ];
    }

    const tasks = await prisma.scheduleTask.findMany({
        where: baseWhere,
        orderBy: [{ projectId: "asc" }, { startDate: "asc" }],
        select: {
            id: true,
            name: true,
            startDate: true,
            endDate: true,
            color: true,
            progress: true,
            status: true,
            estimatedHours: true,
            projectId: true,
            project: { select: { id: true, name: true, color: true, location: true } },
            assignments: {
                where: { userId: user.id },
                select: { role: true },
                take: 1,
            },
        },
    });

    const out = tasks.map(t => ({
        id: t.id,
        name: t.name,
        startDate: t.startDate.toISOString().split("T")[0],
        endDate: t.endDate.toISOString().split("T")[0],
        color: t.color,
        progress: t.progress,
        status: t.status,
        estimatedHours: t.estimatedHours ?? null,
        projectId: t.projectId,
        projectName: t.project?.name ?? "",
        projectColor: t.project?.color ?? null,
        projectLocation: t.project?.location ?? null,
        isAssignedToMe: t.assignments.length > 0,
    }));

    return NextResponse.json({ tasks: out });
}

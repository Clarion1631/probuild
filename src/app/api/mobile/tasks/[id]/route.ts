import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";

export const dynamic = "force-dynamic";

// GET /api/mobile/tasks/:id
// Returns the task + recent comments (with photos) + assignment info for the caller.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;
    const { id } = await params;

    const task = await prisma.scheduleTask.findUnique({
        where: { id },
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
            comments: {
                orderBy: { createdAt: "desc" },
                take: 50,
                include: {
                    user: { select: { id: true, name: true, email: true } },
                    photos: { orderBy: { createdAt: "asc" }, select: { id: true, url: true } },
                },
            },
            punchItems: {
                orderBy: { order: "asc" },
                select: { id: true, name: true, completed: true },
            },
        },
    });

    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!task.projectId) return NextResponse.json({ error: "Task not on a project (lead-only tasks not supported)" }, { status: 400 });

    const fail = await assertProjectAccess(user, task.projectId);
    if (fail) return fail;

    return NextResponse.json({
        task: {
            id: task.id,
            name: task.name,
            startDate: task.startDate.toISOString().split("T")[0],
            endDate: task.endDate.toISOString().split("T")[0],
            color: task.color,
            progress: task.progress,
            status: task.status,
            estimatedHours: task.estimatedHours ?? null,
            projectId: task.projectId,
            projectName: task.project?.name ?? "",
            projectColor: task.project?.color ?? null,
            projectLocation: task.project?.location ?? null,
            punchItems: task.punchItems,
            comments: task.comments.map(c => ({
                id: c.id,
                text: c.text,
                createdAt: c.createdAt.toISOString(),
                authorName: c.user?.name || c.user?.email || c.subcontractorName || "Unknown",
                authorEmail: c.user?.email ?? null,
                authorIsMe: c.userId === user.id,
                photos: c.photos,
            })),
        },
    });
}

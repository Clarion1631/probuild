import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";
import { toMobileCrew } from "@/lib/mobile-task-crew";

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
            doneWhen: true,
            blockedReason: true,
            scheduledTime: true,
            projectId: true,
            project: { select: { id: true, name: true, color: true, location: true } },
            assignments: {
                // Only activated accounts are crew the field should see; deactivated
                // users stay in the assignment table for history but never in the app.
                where: { user: { status: "ACTIVATED" } },
                select: { role: true, user: { select: { id: true, name: true } } },
            },
            // Linked estimate line item + its cost code — lets the mobile geofence
            // "clock in here?" nudge preselect the matching phase for one-tap clock-in.
            estimateItemId: true,
            estimateItem: { select: { costCode: { select: { code: true, name: true } } } },
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
            doneWhen: task.doneWhen ?? null,
            blockedReason: task.blockedReason ?? null,
            scheduledTime: task.scheduledTime ?? null,
            projectId: task.projectId,
            projectName: task.project?.name ?? "",
            projectColor: task.project?.color ?? null,
            projectLocation: task.project?.location ?? null,
            crew: toMobileCrew(task.assignments),
            estimateItemId: task.estimateItemId ?? null,
            costCode: task.estimateItem?.costCode ? { code: task.estimateItem.costCode.code, name: task.estimateItem.costCode.name } : null,
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

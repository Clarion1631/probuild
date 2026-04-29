export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";

type Params = { params: Promise<{ id: string; itemId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
    const auth = await authenticateMobileOrSession(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;

    const { id: taskId, itemId } = await params;

    const body = await req.json().catch(() => ({}));
    const { photoUrl } = (body ?? {}) as { photoUrl?: string };

    const punchItem = await prisma.taskPunchItem.findUnique({
        where: { id: itemId },
        include: { task: { select: { id: true, projectId: true } } },
    });
    if (!punchItem) {
        return NextResponse.json({ error: "Punch item not found" }, { status: 404 });
    }
    if (punchItem.taskId !== taskId) {
        return NextResponse.json(
            { error: "Punch item does not belong to this task" },
            { status: 400 },
        );
    }
    if (!punchItem.task.projectId) {
        return NextResponse.json({ error: "Task is not linked to a project" }, { status: 400 });
    }

    const projectError = await assertProjectAccess(user, punchItem.task.projectId);
    if (projectError) return projectError;

    const updated = await prisma.taskPunchItem.update({
        where: { id: itemId },
        data: {
            completed: true,
            ...(typeof photoUrl === "string" && photoUrl.trim()
                ? { photoUrl: photoUrl.trim() }
                : {}),
        },
    });

    return NextResponse.json(JSON.parse(JSON.stringify(updated)));
}

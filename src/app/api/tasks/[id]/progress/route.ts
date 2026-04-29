export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
    const auth = await authenticateMobileOrSession(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;

    const { id } = await params;
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { progress, status } = body as { progress?: number; status?: string };

    if (progress !== undefined) {
        if (typeof progress !== "number" || !Number.isFinite(progress)) {
            return NextResponse.json({ error: "progress must be a number" }, { status: 400 });
        }
        if (progress < 0 || progress > 100) {
            return NextResponse.json({ error: "progress must be 0–100" }, { status: 400 });
        }
    }

    const task = await prisma.scheduleTask.findUnique({
        where: { id },
        select: { id: true, projectId: true },
    });
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!task.projectId) {
        return NextResponse.json({ error: "Task is not linked to a project" }, { status: 400 });
    }

    const projectError = await assertProjectAccess(user, task.projectId);
    if (projectError) return projectError;

    const data: Prisma.ScheduleTaskUpdateInput = {};
    if (progress !== undefined) {
        data.progress = Math.round(progress);
    }
    if (status !== undefined) {
        if (typeof status !== "string" || !status.trim()) {
            return NextResponse.json({ error: "status must be a non-empty string" }, { status: 400 });
        }
        data.status = status;
    }
    // Auto-complete wins: if progress hit 100, force status regardless of any
    // value the caller supplied alongside it.
    if (progress !== undefined && progress >= 100) {
        data.status = "Complete";
    }

    const updated = await prisma.scheduleTask.update({
        where: { id },
        data,
    });

    return NextResponse.json(JSON.parse(JSON.stringify(updated)));
}

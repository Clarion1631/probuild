import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";

export const dynamic = "force-dynamic";

// POST /api/mobile/tasks/:id/comments
// Body: { text: string, photoUrls?: string[] }
// Identity comes from auth (Bearer token or NextAuth session) — never the body.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;
    const { id: taskId } = await params;

    let body: { text?: unknown; photoUrls?: unknown } = {};
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    const photoUrls = Array.isArray(body.photoUrls)
        ? body.photoUrls.filter((u): u is string => typeof u === "string" && u.length > 0).slice(0, 10)
        : [];

    if (!text && photoUrls.length === 0) {
        return NextResponse.json({ error: "Comment must include text or at least one photo" }, { status: 400 });
    }

    const task = await prisma.scheduleTask.findUnique({
        where: { id: taskId },
        select: { id: true, projectId: true },
    });
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!task.projectId) return NextResponse.json({ error: "Task not on a project" }, { status: 400 });

    const fail = await assertProjectAccess(user, task.projectId);
    if (fail) return fail;

    const comment = await prisma.taskComment.create({
        data: {
            taskId,
            text: text || "(photo)",
            userId: user.id,
            photos: photoUrls.length > 0 ? { create: photoUrls.map(url => ({ url })) } : undefined,
        },
        include: {
            user: { select: { id: true, name: true, email: true } },
            photos: { orderBy: { createdAt: "asc" }, select: { id: true, url: true } },
        },
    });

    return NextResponse.json({
        comment: {
            id: comment.id,
            text: comment.text,
            createdAt: comment.createdAt.toISOString(),
            authorName: comment.user?.name || comment.user?.email || "Unknown",
            authorEmail: comment.user?.email ?? null,
            authorIsMe: true,
            photos: comment.photos,
        },
    });
}

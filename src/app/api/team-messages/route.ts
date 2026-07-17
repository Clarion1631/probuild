import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

async function checkProjectAccess(email: string, projectId: string) {
    const user = await prisma.user.findUnique({
        where: { email },
        select: {
            id: true,
            role: true,
            projectAccess: { where: { projectId }, select: { projectId: true } },
        },
    });
    if (!user) return null;
    const isAdmin = ["ADMIN", "MANAGER"].includes(user.role);
    if (!isAdmin && user.projectAccess.length === 0) return null;
    return user;
}

// GET /api/team-messages?projectId=X
export async function GET(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");
    if (!projectId) {
        return NextResponse.json({ error: "projectId required" }, { status: 400 });
    }

    const user = await checkProjectAccess(session.user.email, projectId);
    if (!user) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const messages = await prisma.teamMessage.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({ messages });
}

// POST /api/team-messages
export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { projectId, body } = await request.json();
    if (!projectId || !body?.trim()) {
        return NextResponse.json({ error: "projectId and body required" }, { status: 400 });
    }

    const user = await checkProjectAccess(session.user.email, projectId);
    if (!user) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const authorName = session.user.name || session.user.email || "Team Member";

    const message = await prisma.teamMessage.create({
        data: {
            projectId,
            authorId: user.id,
            authorName,
            body: body.trim().slice(0, 10000),
        },
    });

    return NextResponse.json(message, { status: 201 });
}

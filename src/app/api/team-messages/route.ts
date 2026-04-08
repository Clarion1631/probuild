import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

// GET /api/team-messages?projectId=X
export async function GET(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");
    if (!projectId) {
        return NextResponse.json({ error: "projectId required" }, { status: 400 });
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
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { projectId, body } = await request.json();
    if (!projectId || !body?.trim()) {
        return NextResponse.json({ error: "projectId and body required" }, { status: 400 });
    }

    const authorName = session.user.name || session.user.email || "Team Member";

    // Resolve authorId from User table
    let authorId: string | null = null;
    if (session.user.email) {
        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { id: true },
        });
        authorId = user?.id ?? null;
    }

    const message = await prisma.teamMessage.create({
        data: {
            projectId,
            authorId,
            authorName,
            body: body.trim(),
        },
    });

    return NextResponse.json(message, { status: 201 });
}

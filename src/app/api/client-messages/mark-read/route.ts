import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

// POST /api/client-messages/mark-read
// Body: { leadId: string } OR { projectId: string }
// Marks all unread INBOUND ClientMessages for the entity as read.
// Requires the session user to have access to the resource.
export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { leadId, projectId } = body;

    if (!leadId && !projectId) {
        return NextResponse.json({ error: "leadId or projectId required" }, { status: 400 });
    }

    // Resolve the session user
    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { id: true, role: true },
    });
    if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Authorization guard: verify access to the resource
    if (projectId) {
        if (user.role !== "ADMIN" && user.role !== "MANAGER") {
            const access = await prisma.projectAccess.findUnique({
                where: { userId_projectId: { userId: user.id, projectId } },
                select: { id: true },
            });
            if (!access) {
                // Also allow crew members
                const crewAccess = await prisma.project.findFirst({
                    where: { id: projectId, crew: { some: { id: user.id } } },
                    select: { id: true },
                });
                if (!crewAccess) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
        }
    } else if (leadId) {
        // For leads: ADMIN/MANAGER always have access; other roles are blocked
        if (user.role !== "ADMIN" && user.role !== "MANAGER") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
    }

    const where = leadId
        ? { leadId, direction: "INBOUND", readAt: null }
        : { projectId, direction: "INBOUND", readAt: null };

    const { count } = await prisma.clientMessage.updateMany({
        where,
        data: { readAt: new Date() },
    });

    return NextResponse.json({ marked: count });
}

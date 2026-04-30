import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

// POST /api/client-messages/mark-read
// Body: { clientId: string } OR { leadId: string } OR { projectId: string }
// Marks all unread INBOUND ClientMessages as read.
// clientId marks ALL messages for the client (unified view);
// leadId/projectId marks entity-scoped messages only (legacy).
export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { clientId, leadId, projectId } = body;

    if (!clientId && !leadId && !projectId) {
        return NextResponse.json({ error: "clientId, leadId, or projectId required" }, { status: 400 });
    }

    // Resolve the session user
    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { id: true, role: true },
    });
    if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Authorization guard
    if (clientId) {
        // Client-level: ADMIN/MANAGER bypass; others must have access to at
        // least one of the client's projects.
        if (user.role !== "ADMIN" && user.role !== "MANAGER") {
            const hasAccess = await prisma.project.findFirst({
                where: {
                    clientId,
                    OR: [
                        { userAccess: { some: { userId: user.id } } },
                        { crew: { some: { id: user.id } } },
                    ],
                },
                select: { id: true },
            });
            if (!hasAccess) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
    } else if (projectId) {
        if (user.role !== "ADMIN" && user.role !== "MANAGER") {
            const access = await prisma.projectAccess.findUnique({
                where: { userId_projectId: { userId: user.id, projectId } },
                select: { id: true },
            });
            if (!access) {
                const crewAccess = await prisma.project.findFirst({
                    where: { id: projectId, crew: { some: { id: user.id } } },
                    select: { id: true },
                });
                if (!crewAccess) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
        }
    } else if (leadId) {
        if (user.role !== "ADMIN" && user.role !== "MANAGER") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
    }

    // Build the where clause based on which key was provided
    const where = clientId
        ? { clientId, direction: "INBOUND", readAt: null }
        : leadId
            ? { leadId, direction: "INBOUND", readAt: null }
            : { projectId, direction: "INBOUND", readAt: null };

    const { count } = await prisma.clientMessage.updateMany({
        where,
        data: { readAt: new Date() },
    });

    return NextResponse.json({ marked: count });
}

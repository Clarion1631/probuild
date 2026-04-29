import { NextResponse } from "next/server";
export const dynamic = 'force-dynamic';
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";

export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    let projects;

    if (user.role === 'MANAGER' || user.role === 'ADMIN') {
        // Admins and Managers see all projects
        projects = await prisma.project.findMany({
            orderBy: { createdAt: 'desc' }
        });
    } else {
        // Other roles: filter by ProjectAccess records
        const accessRecords = await prisma.projectAccess.findMany({
            where: { userId: user.id },
            select: { projectId: true },
        });
        const allowedIds = accessRecords.map(a => a.projectId);

        if (allowedIds.length === 0) {
            // Fall back to crew assignment if no ProjectAccess records exist yet
            projects = await prisma.project.findMany({
                where: {
                    crew: { some: { id: user.id } }
                },
                orderBy: { createdAt: 'desc' }
            });
        } else {
            projects = await prisma.project.findMany({
                where: { id: { in: allowedIds } },
                orderBy: { createdAt: 'desc' }
            });
        }
    }

    return NextResponse.json(projects);
}

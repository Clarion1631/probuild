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
        projects = await prisma.project.findMany({
            where: { status: { not: "Closed" } },
            orderBy: { createdAt: 'desc' },
        });
    } else {
        const [accessRecords, crewProjects] = await Promise.all([
            prisma.projectAccess.findMany({
                where: { userId: user.id },
                select: { projectId: true },
            }),
            prisma.project.findMany({
                where: { crew: { some: { id: user.id } } },
                select: { id: true },
            }),
        ]);

        const allIds = [...new Set([
            ...accessRecords.map(a => a.projectId),
            ...crewProjects.map(p => p.id),
        ])];

        projects = allIds.length === 0 ? [] : await prisma.project.findMany({
            where: { id: { in: allIds }, status: { not: "Closed" } },
            orderBy: { createdAt: 'desc' },
        });
    }

    return NextResponse.json(projects);
}

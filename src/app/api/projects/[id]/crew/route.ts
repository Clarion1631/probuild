export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({
        where: { email: session.user.email! }
    });

    if (!user || (user.role !== 'MANAGER' && user.role !== 'ADMIN')) {
        return NextResponse.json({ error: "Forbidden. Managers only." }, { status: 403 });
    }

    const projectId = (await params).id;
    const body = await req.json();
    const { crewIds } = body; // Array of user IDs

    if (!Array.isArray(crewIds)) {
        return NextResponse.json({ error: "Invalid crew assignment data" }, { status: 400 });
    }

    try {
        const oldCrew = await prisma.project.findUnique({
            where: { id: projectId },
            select: { crew: { select: { id: true } } },
        });
        const oldCrewIds = oldCrew?.crew.map(c => c.id) ?? [];

        const project = await prisma.project.update({
            where: { id: projectId },
            data: {
                crew: {
                    set: crewIds.map((id: string) => ({ id }))
                }
            },
            include: {
                crew: true
            }
        });

        const removedIds = oldCrewIds.filter((id: string) => !crewIds.includes(id));
        const ops = [];
        if (removedIds.length > 0) {
            ops.push(prisma.projectAccess.deleteMany({
                where: { projectId, userId: { in: removedIds } },
            }));
        }
        if (crewIds.length > 0) {
            ops.push(prisma.projectAccess.createMany({
                data: crewIds.map((userId: string) => ({ userId, projectId })),
                skipDuplicates: true,
            }));
        }
        if (ops.length > 0) await prisma.$transaction(ops);

        return NextResponse.json(project.crew);
    } catch (error) {
        console.error("Error saving crew assignments:", error);
        return NextResponse.json({ error: "Failed to save crew assignments" }, { status: 500 });
    }
}

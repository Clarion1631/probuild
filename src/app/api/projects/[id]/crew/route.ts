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
        // Disconnect all existing crew and connect only the provided ones.
        const project = await prisma.project.update({
            where: { id: projectId },
            data: {
                crew: {
                    set: crewIds.map(id => ({ id }))
                }
            },
            include: {
                crew: true
            }
        });

        return NextResponse.json(project.crew);
    } catch (error) {
        console.error("Error saving crew assignments:", error);
        return NextResponse.json({ error: "Failed to save crew assignments" }, { status: 500 });
    }
}

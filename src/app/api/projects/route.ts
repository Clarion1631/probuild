import { NextResponse } from "next/server";
export const dynamic = 'force-dynamic';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    let user;

    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        user = await prisma.user.findUnique({ where: { id: token } });
    }

    if (!user && session?.user?.email) {
        user = await prisma.user.findUnique({ where: { email: session.user.email } });
    }

    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    let projects;

    if (user.role === 'MANAGER' || user.role === 'ADMIN') {
        // Managers see all projects loosely sorted by recent
        projects = await prisma.project.findMany({
            orderBy: { createdAt: 'desc' }
        });
    } else {
        // Employees only see assigned projects
        projects = await prisma.project.findMany({
            where: {
                crew: {
                    some: {
                        id: user.id
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    return NextResponse.json(projects);
}

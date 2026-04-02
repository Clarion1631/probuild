export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Returns top-level estimate items (budget buckets) for a project
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    let authorized = false;

    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        const user = await prisma.user.findUnique({ where: { id: token } });
        if (user) authorized = true;
    }

    if (!authorized && session?.user) authorized = true;
    if (!authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const projectId = (await params).id;

    // Top-level items only (parentId null) from all estimates on this project
    const items = await prisma.estimateItem.findMany({
        where: {
            estimate: { projectId },
            parentId: null,
        },
        select: {
            id: true,
            name: true,
            total: true,
            costCode: { select: { code: true, name: true } },
        },
        orderBy: { order: 'asc' },
    });

    return NextResponse.json(items);
}

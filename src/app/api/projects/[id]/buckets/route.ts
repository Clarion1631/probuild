import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    let authorized = false;

    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        const user = await prisma.user.findUnique({ where: { id: token } });
        if (user) authorized = true;
    }

    if (!authorized && session?.user) {
        authorized = true;
    }

    if (!authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // params.id is awaitable in Next.js 15, but since Next 13-14 it's sync. Assuming Next 14 here.
    const projectId = (await params).id;

    const budget = await prisma.budget.findFirst({
        where: { projectId },
        include: {
            buckets: true
        }
    });

    if (!budget) {
        return NextResponse.json([]); // Return empty array if no budget found
    }

    return NextResponse.json(budget.buckets);
}

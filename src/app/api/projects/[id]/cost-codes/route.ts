export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Returns the distinct cost codes used in estimates for this project
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

    const projectId = (await params).id;

    // Find all estimates for this project, then get the distinct cost codes used in their items
    const items = await prisma.estimateItem.findMany({
        where: {
            estimate: { projectId },
            costCodeId: { not: null }
        },
        select: {
            costCodeId: true,
            costCode: true,
        },
        distinct: ['costCodeId'],
    });

    const costCodes = items
        .filter(i => i.costCode)
        .map(i => i.costCode);

    return NextResponse.json(costCodes);
}

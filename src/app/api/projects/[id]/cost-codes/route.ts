export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";

// Returns the distinct cost codes used in estimates for this project
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const projectId = (await params).id;
    const fail = await assertProjectAccess(auth.user, projectId);
    if (fail) return fail;

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

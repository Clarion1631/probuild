export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";

// Returns top-level estimate items (budget buckets) for a project
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const projectId = (await params).id;
    const fail = await assertProjectAccess(auth.user, projectId);
    if (fail) return fail;

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

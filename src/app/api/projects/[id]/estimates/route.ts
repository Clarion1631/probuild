import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const projectId = (await params).id;
    const fail = await assertProjectAccess(auth.user, projectId);
    if (fail) return fail;

    try {
        const estimates = await prisma.estimate.findMany({
            where: {
                projectId,
                status: { in: ["Approved", "Invoiced", "Partially Paid"] },
                archivedAt: null,
            },
            select: {
                id: true,
                title: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        return NextResponse.json(estimates);
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

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

    const budget = await (prisma as any).budget?.findFirst({
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

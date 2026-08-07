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

    const { searchParams } = new URL(req.url);
    const estimateId = searchParams.get("estimateId");

    const estimateFilter: any = {
        projectId,
        status: { in: ["Approved", "Invoiced", "Partially Paid", "Paid"] },
        archivedAt: null,
    };

    if (estimateId) {
        estimateFilter.id = estimateId;
    }

    // The chargeable unit is the COST-CODED item, wherever it sits. Flat
    // estimates (e.g. Hoppe) code their top-level items; sectioned estimates
    // (e.g. Mesplay, Berg) keep top-level rows as uncoded Sections and code
    // the leaf children — offering only parentId-null rows there meant crew
    // could ONLY pick uncoded sections, which is precisely how time entries
    // ended up with no cost code.
    const select = {
        id: true,
        name: true,
        total: true,
        costCodeId: true,
        costCode: { select: { code: true, name: true } },
    } as const;

    const codedItems = await prisma.estimateItem.findMany({
        where: {
            estimate: estimateFilter,
            costCodeId: { not: null },
        },
        select,
        orderBy: { order: 'asc' },
    });
    if (codedItems.length > 0) {
        return NextResponse.json(codedItems);
    }

    // Fully uncoded estimate — fall back to the legacy top-level list so the
    // picker still shows something (those entries chargeless, as before).
    const items = await prisma.estimateItem.findMany({
        where: {
            estimate: estimateFilter,
            parentId: null,
        },
        select,
        orderBy: { order: 'asc' },
    });

    return NextResponse.json(items);
}

export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";
import { resolveChargeableItems } from "@/lib/time-suggestion";

// Returns the CHARGEABLE estimate items for a project's clock-in picker —
// resolveChargeableItems is the single authority (leaves resolved to their
// nearest coded same-estimate ancestor, deduped; per-estimate legacy fallback
// when an estimate has no coded items). Rows carry estimateId/estimateTitle so
// clients can group when a project has more than one eligible estimate.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const projectId = (await params).id;
    const fail = await assertProjectAccess(auth.user, projectId);
    if (fail) return fail;

    const { searchParams } = new URL(req.url);
    const estimateId = searchParams.get("estimateId");

    const { items } = await resolveChargeableItems(projectId);
    const filtered = estimateId ? items.filter(item => item.estimateId === estimateId) : items;

    return NextResponse.json(filtered);
}

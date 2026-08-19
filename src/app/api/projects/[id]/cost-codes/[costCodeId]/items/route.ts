export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";
import { isCostCodeAllowedForProject } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { decidePhaseItemStep, resolvePhaseItems } from "@/lib/phase-items";
import { prismaPhaseItemsDataSource } from "@/lib/phase-items-db";

// GET /api/projects/[id]/cost-codes/[costCodeId]/items
//
// The optional SECOND step of crew clock-in. After the crew taps a phase, this
// answers "and which line item?" — but only when that question is real:
//
//   action=auto   -> exactly one item; the client attaches it with NO extra tap
//   action=choose -> 2+ items; show just these rows
//   action=none   -> no coded items (e.g. the Safety phase); clock in on the
//                    phase alone
//
// Measured on prod, 51.9% of phases hold exactly one item, so most clock-ins
// gain an item link for free. Capturing the item yields the phase too
// (resolveCostCode derives one from the other), which is what makes per-item
// variance possible without adding taps.
//
// The phase is re-validated against THIS project with the same shared helper the
// picker and POST /api/time-entries use, so a caller cannot enumerate another
// job's line items by guessing a cost code id.
export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string; costCodeId: string }> }
) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { id: projectId, costCodeId } = await params;
    const fail = await assertProjectAccess(auth.user, projectId);
    if (fail) return fail;

    // "The cost code exists" is not a permission — it must be a phase of THIS
    // project (mirrors the clock-in validator's PHASE_NOT_ON_PROJECT check).
    const allowed = await isCostCodeAllowedForProject(prismaPhaseDataSource, projectId, costCodeId);
    if (!allowed) {
        return NextResponse.json(
            { error: "That phase is not available on this project", code: "PHASE_NOT_ON_PROJECT" },
            { status: 400 }
        );
    }

    const items = await resolvePhaseItems(prismaPhaseItemsDataSource, projectId, costCodeId);
    const decision = decidePhaseItemStep(items);

    return NextResponse.json({
        action: decision.kind,
        // Always the full list, so a client can render its own UI without a
        // second request; `action` is the recommendation, not a restriction.
        items,
        autoSelectItemId: decision.kind === "auto" ? decision.item.estimateItemId : null,
    });
}

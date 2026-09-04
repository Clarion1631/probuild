// The one Prisma-backed implementation of PhaseDataSource. Lives apart from
// src/lib/project-phases.ts so that module stays free of Prisma imports and
// its rules can be unit-tested without a database — the split mirrors
// src/lib/phase-options.ts (pure) vs its route (I/O).

import { prisma } from "@/lib/prisma";
import {
    PHASE_ELIGIBLE_ESTIMATE_WHERE,
    SAFETY_COST_CODE,
    type PhaseCostCode,
    type PhaseDataSource,
} from "@/lib/project-phases";

export const prismaPhaseDataSource: PhaseDataSource = {
    async getProject(projectId) {
        return prisma.project.findUnique({ where: { id: projectId }, select: { id: true, status: true } });
    },

    async getEstimateCostCodes(projectId) {
        // Only estimates that represent committed work count — the same
        // predicate the clock-in route applies to an `estimateItemId`. Without
        // this the picker offered codes from drafts, rejected revisions, and
        // archived estimates that the server would then refuse.
        const items = await prisma.estimateItem.findMany({
            where: {
                estimate: { projectId, ...PHASE_ELIGIBLE_ESTIMATE_WHERE },
                costCodeId: { not: null },
                // A DEACTIVATED code is not a phase anybody may post to. It was
                // read through and handed back with `isActive: false` attached,
                // which every caller then had to remember to check — and the
                // validation path did not, so a code retired company-wide still
                // passed "is this a phase of this job?". The Safety phase has
                // always been filtered this way (getSafetyCostCode returns null
                // for an inactive row); this makes the estimate half agree.
                costCode: { isActive: true },
            },
            select: { costCode: { select: { id: true, code: true, name: true, description: true, isActive: true } } },
            distinct: ["costCodeId"],
        });
        return items
            .map((item) => item.costCode)
            .filter((costCode): costCode is NonNullable<typeof costCode> => !!costCode)
            .map(
                (costCode): PhaseCostCode => ({
                    id: costCode.id,
                    code: costCode.code,
                    name: costCode.name,
                    description: costCode.description,
                    isActive: costCode.isActive,
                })
            );
    },

    async getSafetyCostCode() {
        const costCode = await prisma.costCode.findUnique({ where: { code: SAFETY_COST_CODE } });
        if (!costCode || !costCode.isActive) return null;
        return {
            id: costCode.id,
            code: costCode.code,
            name: costCode.name,
            description: costCode.description,
            isActive: costCode.isActive,
        };
    },
};

// Prisma-backed PhaseItemsDataSource. Split from src/lib/phase-items.ts so the
// rules there stay database-free and unit-testable — same convention as
// project-phases.ts / project-phases-db.ts.

import { prisma } from "@/lib/prisma";
import { isEstimateSectionRow, type EstimateItemLike } from "@/lib/estimate-item-payload";
import { PHASE_ELIGIBLE_ESTIMATE_WHERE } from "@/lib/project-phases";
import type { PhaseItemOption, PhaseItemsDataSource } from "@/lib/phase-items";

export const prismaPhaseItemsDataSource: PhaseItemsDataSource = {
    async getItemsForPhase(projectId, costCodeId) {
        // Fetch per-ESTIMATE rather than filtering items directly: section-row
        // detection needs an item's full sibling set to see whether anything
        // claims it as a parent. Filtering to one cost code first would hide
        // those children and let a section header masquerade as a leaf — which
        // would offer the crew a header row that rolls up its children's totals.
        const estimates = await prisma.estimate.findMany({
            where: { projectId, ...PHASE_ELIGIBLE_ESTIMATE_WHERE },
            select: {
                id: true,
                items: {
                    select: {
                        id: true, name: true, order: true, total: true,
                        type: true, parentId: true, costCodeId: true,
                    },
                },
            },
        });

        const options: PhaseItemOption[] = [];
        for (const estimate of estimates) {
            for (const item of estimate.items) {
                if (item.costCodeId !== costCodeId) continue;
                // A section header mirrors its children's totals; offering one
                // would double-count the phase if it were ever charged.
                // Cast to the shape the helper actually needs, NOT `never`:
                // `never` silently accepts a projection that has dropped
                // id/type/parentId, which would degrade section detection to
                // "nothing is a section" and start offering rollup headers to
                // crews with no compiler warning. (Review finding.)
                if (
                    isEstimateSectionRow(
                        item as EstimateItemLike,
                        estimate.items as EstimateItemLike[]
                    )
                ) {
                    continue;
                }
                // An unnamed row is unreadable on a phone — the crew cannot tell
                // it apart from any other, so it is not a real choice.
                const name = item.name?.trim();
                if (!name) continue;
                options.push({
                    estimateItemId: item.id,
                    name,
                    order: item.order ?? 0,
                    total: Number(item.total ?? 0),
                });
            }
        }
        return options;
    },
};

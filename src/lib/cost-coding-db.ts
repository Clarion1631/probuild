// The one Prisma-backed implementation of CostCodingDataSource. Kept apart from
// src/lib/cost-coding.ts so that module stays free of Prisma imports and its
// rules are unit-testable without a database — the same split as
// project-phases.ts / project-phases-db.ts.

import { prisma } from "@/lib/prisma";
import type { CostCodingDataSource } from "@/lib/cost-coding";

export const prismaCostCodingDataSource: CostCodingDataSource = {
    async getCostCode(costCodeId) {
        return prisma.costCode.findUnique({
            where: { id: costCodeId },
            select: { id: true, isActive: true },
        });
    },

    async getLineItem(lineItemId) {
        const item = await prisma.estimateItem.findUnique({
            where: { id: lineItemId },
            select: {
                costCodeId: true,
                costTypeId: true,
                costCode: { select: { isActive: true } },
            },
        });
        if (!item) return null;
        return {
            costCodeId: item.costCodeId,
            costTypeId: item.costTypeId,
            // null (not false) when there is no linked code at all — the rule
            // distinguishes "no code" from "inactive code" and reports each
            // differently, so collapsing them here would lose that.
            costCodeIsActive: item.costCode ? item.costCode.isActive : null,
        };
    },
};

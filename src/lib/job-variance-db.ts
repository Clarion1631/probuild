// Server-side data loading for the variance report. Kept out of the page
// component so the page stays presentational and this stays swappable.
//
// Expense has NO projectId column — it reaches a project through its estimate
// (`where: { estimate: { projectId } }`). Querying expense.projectId throws
// PrismaClientValidationError, which once made a job's expenses look like $0.

import { prisma } from "@/lib/prisma";
import { isEstimateSectionRow } from "@/lib/estimate-item-payload";
import { computeProjectVariance, type ProjectVariance, type VarianceEstimateItem } from "@/lib/job-variance";
import { PHASE_ELIGIBLE_ESTIMATE_WHERE } from "@/lib/project-phases";

export interface ProjectVarianceReport {
    projectId: string;
    projectName: string;
    status: string;
    variance: ProjectVariance;
}

export async function loadProjectVariance(projectIds?: string[]): Promise<ProjectVarianceReport[]> {
    const projects = await prisma.project.findMany({
        where: { status: "In Progress", ...(projectIds ? { id: { in: projectIds } } : {}) },
        select: { id: true, name: true, status: true },
        orderBy: { name: "asc" },
    });

    // One lookup for every active cost code, so unbudgeted phases can be NAMED
    // rather than rendering as an anonymous "N/A" row.
    const allCodes = await prisma.costCode.findMany({ select: { id: true, code: true, name: true } });
    const costCodeLabels = new Map(allCodes.map((c) => [c.id, { code: c.code, name: c.name }]));

    const reports: ProjectVarianceReport[] = [];

    for (const project of projects) {
        const estimates = await prisma.estimate.findMany({
            // Same eligibility predicate as the crew's phase list, so the budget
            // side and the capture side describe the same work.
            where: { projectId: project.id, ...PHASE_ELIGIBLE_ESTIMATE_WHERE },
            select: {
                id: true,
                items: {
                    select: {
                        id: true, name: true, type: true, parentId: true, total: true,
                        costCodeId: true,
                        costCode: { select: { code: true, name: true } },
                        costType: { select: { name: true } },
                    },
                },
            },
        });

        // Section headers mirror their children's totals — including one would
        // double its phase's budget and manufacture a fake favourable variance.
        const items: VarianceEstimateItem[] = [];
        for (const estimate of estimates) {
            for (const row of estimate.items) {
                if (isEstimateSectionRow(row as never, estimate.items as never)) continue;
                items.push({
                    id: row.id,
                    name: row.name?.trim() || "(unnamed line item)",
                    costCodeId: row.costCodeId,
                    costCode: row.costCode ? { code: row.costCode.code, name: row.costCode.name } : null,
                    costTypeName: row.costType?.name ?? null,
                    type: row.type ?? null,
                    total: Number(row.total ?? 0),
                });
            }
        }

        const [timeRows, expenseRows] = await Promise.all([
            prisma.timeEntry.findMany({
                where: { projectId: project.id },
                select: { costCodeId: true, estimateItemId: true, laborCost: true, burdenCost: true },
            }),
            prisma.expense.findMany({
                where: { estimate: { projectId: project.id } },
                select: { costCodeId: true, itemId: true, amount: true },
            }),
        ]);

        reports.push({
            projectId: project.id,
            projectName: project.name,
            status: project.status,
            variance: computeProjectVariance({
                items,
                timeEntries: timeRows.map((t) => ({
                    costCodeId: t.costCodeId,
                    estimateItemId: t.estimateItemId,
                    laborCost: Number(t.laborCost ?? 0),
                    burdenCost: Number(t.burdenCost ?? 0),
                })),
                expenses: expenseRows.map((e) => ({
                    costCodeId: e.costCodeId,
                    itemId: e.itemId,
                    amount: Number(e.amount ?? 0),
                })),
                costCodeLabels,
            }),
        });
    }

    return reports;
}

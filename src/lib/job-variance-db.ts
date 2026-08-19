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
import { OVERHEAD_PROJECT_ID } from "@/lib/overhead-project";

export interface ProjectVarianceReport {
    projectId: string;
    projectName: string;
    status: string;
    variance: ProjectVariance;
}

export async function loadProjectVariance(projectIds?: string[]): Promise<ProjectVarianceReport[]> {
    const projects = await prisma.project.findMany({
        where: {
            status: "In Progress",
            // The overhead bucket ("Shop") is not a job: no client, no bid, no
            // meaningful budget. On prod it showed $71,991 of actuals against a
            // $12,511 nominal budget at 0% attribution — the biggest and least
            // actionable row on the report. An explicit projectIds request still
            // wins, so it stays inspectable on purpose.
            ...(projectIds ? { id: { in: projectIds } } : { id: { not: OVERHEAD_PROJECT_ID } }),
        },
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

        // ── Approved CHANGE ORDERS are budget too ───────────────────────────
        // Peer-review finding (HIGH). Budget came only from EstimateItem, but
        // approved change-order scope lives in the separate ChangeOrderItem
        // table. Costs for that work still land on the job (labor via
        // TimeEntry.projectId, materials via the parent estimate), so omitting
        // the CO budget manufactures an overrun on every job with an approved CO.
        //
        // Verified on prod 2026-08-19: Berg ADU carries an approved CO worth
        // $4,629.63 and Shop $1,000 — Berg's reported overrun was overstated by
        // exactly that amount until this was added.
        //
        // ONLY "Approved" counts. Draft and Sent change orders are proposals,
        // not committed work — counting them would inflate the budget and hide
        // real overruns (prod currently holds $67k of Draft/Sent CO scope).
        // ChangeOrderItem is a FLAT table (no parentId), so there are no section
        // rows to exclude here, unlike EstimateItem.
        // KNOWN RISK, verified clear on prod 2026-08-19. `ChangeOrderItem` has
        // NO provenance column (no sourceEstimateItemId), so nothing structurally
        // prevents a CO generated FROM estimate lines from duplicating scope that
        // the estimate already budgets — which would inflate the budget and hide
        // a real overrun. Checked both approved COs on prod: "Deposit for Added
        // Items" (Berg ADU, $4,629.63) and "Added items" (Shop, $1,000) are
        // genuinely additional scope with no same-named estimate line. Re-check
        // this if change orders ever start being generated from estimate rows.
        const changeOrderItems = await prisma.changeOrderItem.findMany({
            where: { changeOrder: { projectId: project.id, status: "Approved" } },
            select: {
                id: true, name: true, total: true, type: true,
                costCodeId: true,
                costCode: { select: { code: true, name: true } },
                costType: { select: { name: true } },
            },
        });
        for (const row of changeOrderItems) {
            items.push({
                id: row.id,
                name: row.name?.trim() ? `${row.name.trim()} (CO)` : "(unnamed change order item)",
                costCodeId: row.costCodeId,
                costCode: row.costCode ? { code: row.costCode.code, name: row.costCode.name } : null,
                costTypeName: row.costType?.name ?? null,
                type: row.type ?? null,
                total: Number(row.total ?? 0),
            });
        }

        // Item pool for ATTRIBUTION, which is broader than the budget pool.
        //
        // Second-review finding (latent). `items` above holds only BUDGET rows
        // (eligible estimates + approved COs). But the expense query below
        // deliberately counts spend on Draft/archived estimates too, and such an
        // expense can carry an `itemId` pointing at its own estimate's coded
        // item. Resolving links against the budget pool alone would discard that
        // link and dump the money into "unattributed", overstating how little we
        // know. Today this is harmless — prod has 0/562 expenses with an itemId —
        // but it becomes live the moment material item-coding starts, which is
        // the next planned piece of work.
        //
        // These extra rows carry a cost code for ATTRIBUTION but contribute NO
        // budget: `budgetItemIds` marks the real budget rows, and anything not in
        // that set is passed with `total: 0`. Spend against them therefore shows
        // up as an unbudgeted phase — visible and honest — rather than vanishing.
        const budgetItemIds = new Set(items.map((row) => row.id));
        const attributionOnlyItems = await prisma.estimateItem.findMany({
            where: {
                estimate: { projectId: project.id },
                id: { notIn: [...budgetItemIds] },
                costCodeId: { not: null },
            },
            select: {
                id: true, name: true, type: true,
                costCodeId: true,
                costCode: { select: { code: true, name: true } },
                costType: { select: { name: true } },
            },
        });
        for (const row of attributionOnlyItems) {
            items.push({
                id: row.id,
                name: row.name?.trim() || "(unnamed line item)",
                costCodeId: row.costCodeId,
                costCode: row.costCode ? { code: row.costCode.code, name: row.costCode.name } : null,
                costTypeName: row.costType?.name ?? null,
                type: row.type ?? null,
                // NO budget — this row exists only so a posting linked to it can
                // still reach the right phase and line item.
                total: 0,
            });
        }

        const [timeRows, expenseRows] = await Promise.all([
            prisma.timeEntry.findMany({
                where: { projectId: project.id },
                select: { costCodeId: true, estimateItemId: true, laborCost: true, burdenCost: true },
            }),
            prisma.expense.findMany({
                // DELIBERATELY NOT filtered by estimate status.
                //
                // Peer review flagged the asymmetry with the budget side and
                // proposed applying PHASE_ELIGIBLE_ESTIMATE_WHERE here too. That
                // was tried and REVERTED after checking prod: 320 expenses worth
                // $84,741 sit on Draft estimates — including 100% of Hoppe
                // Bathroom's spend ($12,758) and the Shop bucket ($71,984).
                // Filtering them out hides money that was genuinely spent and
                // makes every affected job look under budget. That is exactly the
                // failure this rebuild exists to end.
                //
                // The asymmetry is correct and intentional: an estimate's status
                // governs what we PROMISED (budget), never what we PAID (actual).
                // A cost is real the moment it leaves the bank. Where that lands
                // with no matching budget, it surfaces honestly as an unbudgeted
                // phase or in the unattributed bucket — visible, not silently
                // dropped.
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

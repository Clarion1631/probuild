import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { withTxRetry } from "./tx-retry";
import { OPEN_PROJECT_STATUSES } from "./project-status";
import { CLOSED_PROJECT_STATUSES, CLOSED_LEAD_STAGES } from "./gpt-estimate";
import { formatDate, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";

// Session-free core of the company pipeline dashboard + start-calendar flows
// (.specs/PB-pipeline-001-company-dashboard.md), shared by the permission-gated
// server page/actions and the MCP connector (whose auth is the shared secret at
// the transport). Same architectural rule as billing-core.ts: actions.ts is
// "use server", so every export there is a remotely invokable endpoint —
// auth-free logic must live here, NOT there.
//
// Money-path discipline: the ONLY money-model field this module ever writes is
// `dueDate` on EstimatePaymentSchedule and on non-QuickBooks-pushed, unpaid
// PaymentSchedule rows — never amounts, statuses, or QB fields, and never a
// partial shift of a QB-pushed mirror group.

// Estimate statuses that count as the project's contract value (plan R1 fix 10,
// R2 fix 4): the job is sold and the number is real.
const CONTRACT_ESTIMATE_STATUSES = ["Approved", "Invoiced", "Partially Paid", "Paid"];

export type ScheduleActor = { type: "TEAM" | "SYSTEM"; name: string };

/**
 * Strict day-only start-date parser, shared by the MCP tool and the UI server
 * action so no timezone-bearing or overflowing value can reach the core.
 * Accepts exactly YYYY-MM-DD and round-trip validates it (catches rollover
 * input like "2026-13-45" that a bare regex would pass). Throws otherwise.
 */
export function parseStartDateInput(raw: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        throw new Error(`Invalid start date "${raw}" — use YYYY-MM-DD (no time component).`);
    }
    const parsed = parseUTCDate(raw);
    if (formatDate(parsed) !== raw) {
        throw new Error(`Invalid start date "${raw}" — not a real calendar date.`);
    }
    return parsed;
}

export interface PipelineProject {
    id: string;
    name: string;
    client: string | null;
    status: string;
    startDate: string | null;
    // totalAmount of the project's most recent Approved/Invoiced/Partially
    // Paid/Paid estimate; null when none exists.
    contractValue: number | null;
}

export interface PipelineLead {
    id: string;
    name: string;
    client: string | null;
    stage: string;
    expectedStartDate: string | null;
    targetRevenue: number | null;
    latestEstimateStatus: string | null;
    latestEstimateTotal: number | null;
}

export interface CompanyPipeline {
    estimating: PipelineLead[];
    waitingToStart: PipelineProject[];
    scheduled: PipelineProject[];
    inProgress: PipelineProject[];
    substantialCompletion: PipelineProject[];
}

/**
 * The company book of work: open leads (the Estimating stage) plus every open
 * project bucketed by pipeline stage. "Scheduled" is derived, not a status —
 * a Waiting-to-Start project with a startDate set.
 */
export async function getCompanyPipeline(): Promise<CompanyPipeline> {
    const [leads, projects] = await Promise.all([
        prisma.lead.findMany({
            where: { stage: { notIn: CLOSED_LEAD_STAGES } },
            orderBy: { createdAt: "desc" },
            select: {
                id: true, name: true, stage: true, expectedStartDate: true, targetRevenue: true,
                client: { select: { name: true } },
                estimates: {
                    orderBy: { createdAt: "desc" },
                    take: 1,
                    select: { status: true, totalAmount: true },
                },
            },
        }),
        prisma.project.findMany({
            where: { status: { in: OPEN_PROJECT_STATUSES } },
            orderBy: { createdAt: "desc" },
            select: {
                id: true, name: true, status: true, startDate: true,
                client: { select: { name: true } },
                estimates: {
                    where: { status: { in: CONTRACT_ESTIMATE_STATUSES } },
                    orderBy: { createdAt: "desc" },
                    take: 1,
                    select: { totalAmount: true },
                },
            },
        }),
    ]);

    const bucket = (p: (typeof projects)[number]): PipelineProject => ({
        id: p.id,
        name: p.name,
        client: p.client?.name ?? null,
        status: p.status,
        startDate: p.startDate ? p.startDate.toISOString() : null,
        contractValue: p.estimates[0] ? Number(p.estimates[0].totalAmount) : null,
    });

    const waitingToStart: PipelineProject[] = [];
    const scheduled: PipelineProject[] = [];
    const inProgress: PipelineProject[] = [];
    const substantialCompletion: PipelineProject[] = [];
    for (const p of projects) {
        const row = bucket(p);
        if (p.status === "Waiting to Start") (p.startDate ? scheduled : waitingToStart).push(row);
        else if (p.status === "In Progress") inProgress.push(row);
        else if (p.status === "Substantial Completion") substantialCompletion.push(row);
    }

    return {
        estimating: leads.map(l => ({
            id: l.id,
            name: l.name,
            client: l.client?.name ?? null,
            stage: l.stage,
            expectedStartDate: l.expectedStartDate ? l.expectedStartDate.toISOString() : null,
            targetRevenue: l.targetRevenue != null ? Number(l.targetRevenue) : null,
            latestEstimateStatus: l.estimates[0]?.status ?? null,
            latestEstimateTotal: l.estimates[0] ? Number(l.estimates[0].totalAmount) : null,
        })),
        waitingToStart,
        scheduled,
        inProgress,
        substantialCompletion,
    };
}

export interface CalendarProjectStart {
    id: string;
    name: string;
    client: string | null;
    status: string;
    startDate: string;
}

export interface CalendarLeadStart {
    id: string;
    name: string;
    client: string | null;
    stage: string;
    expectedStartDate: string;
}

export interface CalendarMilestone {
    id: string;
    name: string;
    amount: number;
    dueDate: string;
    invoiceId: string;
    invoiceCode: string;
    projectId: string | null;
    projectName: string | null;
    anchoredToTask: boolean; // scheduleTaskId link set
    inQuickBooks: boolean;   // qbInvoiceId set — due date is customer-facing in QBO
}

export interface StartCalendar {
    from: string;
    to: string;
    projectStarts: CalendarProjectStart[];
    leadStarts: CalendarLeadStart[];
    // null unless includeFinancials was passed (page passes it for ADMIN only —
    // managers/finance never receive milestone amounts in the payload).
    milestones: CalendarMilestone[] | null;
}

/**
 * Everything landing on the company start calendar in [from, to): project
 * start markers, lead expected starts, and — only when includeFinancials —
 * unpaid (Pending) milestones due in range.
 *
 * `to` is an EXCLUSIVE UTC-day bound (documented so the two callers stay
 * consistent): the dashboard passes the day AFTER its 42-day grid's last date;
 * the MCP tool passes from + N days to list exactly N calendar days.
 */
export async function getStartCalendar(
    from: Date,
    to: Date,
    opts: { includeFinancials?: boolean } = {},
): Promise<StartCalendar> {
    const [projects, leads, milestones] = await Promise.all([
        prisma.project.findMany({
            where: { startDate: { gte: from, lt: to } },
            orderBy: { startDate: "asc" },
            select: { id: true, name: true, status: true, startDate: true, client: { select: { name: true } } },
        }),
        prisma.lead.findMany({
            where: { stage: { notIn: CLOSED_LEAD_STAGES }, expectedStartDate: { gte: from, lt: to } },
            orderBy: { expectedStartDate: "asc" },
            select: { id: true, name: true, stage: true, expectedStartDate: true, client: { select: { name: true } } },
        }),
        opts.includeFinancials
            ? prisma.paymentSchedule.findMany({
                where: { status: "Pending", dueDate: { gte: from, lt: to } },
                orderBy: { dueDate: "asc" },
                select: {
                    id: true, name: true, amount: true, dueDate: true, scheduleTaskId: true, qbInvoiceId: true,
                    invoice: { select: { id: true, code: true, project: { select: { id: true, name: true } } } },
                },
            })
            : Promise.resolve(null),
    ]);

    return {
        from: from.toISOString(),
        to: to.toISOString(),
        projectStarts: projects.map(p => ({
            id: p.id,
            name: p.name,
            client: p.client?.name ?? null,
            status: p.status,
            startDate: p.startDate!.toISOString(),
        })),
        leadStarts: leads.map(l => ({
            id: l.id,
            name: l.name,
            client: l.client?.name ?? null,
            stage: l.stage,
            expectedStartDate: l.expectedStartDate!.toISOString(),
        })),
        milestones: milestones
            ? milestones.map(m => ({
                id: m.id,
                name: m.name,
                amount: Number(m.amount),
                dueDate: m.dueDate!.toISOString(),
                invoiceId: m.invoice.id,
                invoiceCode: m.invoice.code,
                projectId: m.invoice.project?.id ?? null,
                projectName: m.invoice.project?.name ?? null,
                anchoredToTask: !!m.scheduleTaskId,
                inQuickBooks: !!m.qbInvoiceId,
            }))
            : null,
    };
}

export interface SkippedQbMilestone {
    estimatePaymentScheduleId: string | null;
    name: string;
    paymentScheduleIds: string[];
}

export interface SetProjectStartDateResult {
    projectId: string;
    previousStartDate: string | null;
    startDate: string | null;
    shiftedTasks: number;
    shiftedMilestones: number;
    skippedQbMilestones: SkippedQbMilestone[];
    notes: string[];
}

/**
 * Move (or clear) a project's company-level start marker. When the project is
 * still Waiting to Start and had a previous startDate, the whole job plan
 * moves with it (default): every ScheduleTask shifts by the same delta, and
 * payment milestones anchored to those tasks shift on BOTH mirrors — the
 * linked EstimatePaymentSchedule row and its unpaid PaymentSchedule clones
 * (found via sourceScheduleId, plus any directly task-linked stragglers).
 *
 * Never shifts: closed projects (rejected), In-Progress/later projects
 * (marker only), clearing the marker (startDate null), and any
 * sourceScheduleId mirror group where ANY clone has qbInvoiceId set — those
 * are reported in skippedQbMilestones for manual/QB-side handling, because the
 * customer-facing QBO invoice carries the old date.
 *
 * Every call writes an ActivityLog row (actorType TEAM for UI, SYSTEM for MCP).
 */
export async function setProjectStartDate(input: {
    projectId: string;
    startDate: Date | null;
    shiftJobTasks?: boolean;
    actor: ScheduleActor;
}): Promise<SetProjectStartDateResult> {
    const { projectId, startDate, actor } = input;
    const shiftJobTasks = input.shiftJobTasks !== false; // default true

    // Retry wrapper per the repo's money-path convention (see tx-retry.ts): a
    // rolled-back write-conflict on the shared pooler re-runs against fresh state.
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        // Serialize concurrent start-date moves: lock the project row BEFORE
        // reading the current marker, so two moves can never compute their
        // deltas from the same stale startDate (lost-update / double-shift race).
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;

        const project = await tx.project.findUnique({
            where: { id: projectId },
            select: { id: true, name: true, status: true, startDate: true },
        });
        if (!project) throw new Error("Project not found");
        if (CLOSED_PROJECT_STATUSES.includes(project.status)) {
            throw new Error(`Cannot move the start date of a closed project (${project.status})`);
        }

        const previousStartDate = project.startDate;
        await tx.project.update({ where: { id: projectId }, data: { startDate } });

        const notes: string[] = [];
        const skippedQbMilestones: SkippedQbMilestone[] = [];
        let shiftedTasks = 0;
        let shiftedMilestones = 0;

        // Delta shift only applies to a Waiting-to-Start project with both an
        // old and a new date — first-time sets, clears, and In-Progress moves
        // only move the marker. The shift is day-granular: the strict input
        // parser (parseStartDateInput) only admits YYYY-MM-DD, and the same
        // whole-day interval is applied uniformly to tasks and milestones.
        const shiftMs = previousStartDate && startDate ? startDate.getTime() - previousStartDate.getTime() : 0;
        const shiftDays = Math.round(shiftMs / 86_400_000);
        const canShift = shiftJobTasks && project.status === "Waiting to Start" && shiftDays !== 0;

        if (project.status !== "Waiting to Start") {
            notes.push(`Project is "${project.status}" — only the start marker moved; job tasks were not shifted.`);
        } else if (!shiftJobTasks) {
            notes.push("shiftJobTasks was false — job tasks and milestones were left in place.");
        }

        if (canShift) {
            // Postgres parses 'N days' / '-N days' intervals, so the sign works
            // for backward moves. Everything below is bounded round trips
            // (O(1) in the number of tasks/milestones).
            const daysParam = String(shiftDays);

            // (a) Every job task shifts in ONE update.
            shiftedTasks = await tx.$executeRaw`
                UPDATE "ScheduleTask"
                SET "startDate" = "startDate" + (${daysParam} || ' days')::interval,
                    "endDate" = "endDate" + (${daysParam} || ' days')::interval,
                    "updatedAt" = NOW()
                WHERE "projectId" = ${projectId}
            `;

            // (b) Milestone mirror groups anchored to this project's tasks:
            // two bounded reads, then skip/shift computed in memory. The
            // complete sourceScheduleId group (estimate-side row + all sibling
            // invoice-side clones) shifts together or not at all.
            //
            // Both reads take FOR UPDATE row locks (Prisma findMany cannot
            // lock) on the COMPLETE candidate set — every EPS row linked to a
            // task of this project and every PaymentSchedule clone in those
            // sourceScheduleId groups or directly task-linked. A concurrent QB
            // push therefore cannot persist qbInvoiceId onto any of them until
            // this transaction commits: the "any clone has qbInvoiceId → skip
            // ENTIRE group" decision is stable, and the guarded bulk updates
            // below always apply to exactly the locked set — a group is fully
            // shifted or fully skipped, never partially shifted.
            const linkedEps = await tx.$queryRaw<{ id: string; name: string; dueDate: Date | null }[]>`
                SELECT eps."id", eps."name", eps."dueDate"
                FROM "EstimatePaymentSchedule" eps
                JOIN "ScheduleTask" st ON st."id" = eps."scheduleTaskId"
                WHERE st."projectId" = ${projectId}
                FOR UPDATE OF eps
            `;
            const linkedEpsIds = linkedEps.map(e => e.id);
            const linkedEpsIdSet = new Set(linkedEpsIds);
            const linkedClones = await tx.$queryRaw<{ id: string; name: string; status: string; dueDate: Date | null; qbInvoiceId: string | null; sourceScheduleId: string | null }[]>`
                SELECT ps."id", ps."name", ps."status", ps."dueDate", ps."qbInvoiceId", ps."sourceScheduleId"
                FROM "PaymentSchedule" ps
                WHERE ps."scheduleTaskId" IN (
                        SELECT st."id" FROM "ScheduleTask" st WHERE st."projectId" = ${projectId}
                   )
                   OR ps."sourceScheduleId" IN (
                        SELECT eps."id"
                        FROM "EstimatePaymentSchedule" eps
                        JOIN "ScheduleTask" est ON est."id" = eps."scheduleTaskId"
                        WHERE est."projectId" = ${projectId}
                   )
                FOR UPDATE
            `;

            const clonesByEps = new Map<string, typeof linkedClones>();
            const soloClones: typeof linkedClones = [];
            for (const c of linkedClones) {
                if (c.sourceScheduleId && linkedEpsIdSet.has(c.sourceScheduleId)) {
                    const group = clonesByEps.get(c.sourceScheduleId) ?? [];
                    group.push(c);
                    clonesByEps.set(c.sourceScheduleId, group);
                } else {
                    // Directly task-linked row outside any sourceScheduleId
                    // group — treated as its own group.
                    soloClones.push(c);
                }
            }

            // Skip decision: a group with ANY qb-pushed clone never shifts.
            const shiftEpsIds: string[] = [];
            const shiftGroupIds: string[] = [];
            for (const eps of linkedEps) {
                const group = clonesByEps.get(eps.id) ?? [];
                if (group.some(c => c.qbInvoiceId)) {
                    skippedQbMilestones.push({
                        estimatePaymentScheduleId: eps.id,
                        name: eps.name,
                        paymentScheduleIds: group.map(c => c.id),
                    });
                    notes.push(`Skipped "${eps.name}" — already pushed to QuickBooks; update the due date on the QBO invoice manually.`);
                    continue;
                }
                if (eps.dueDate) shiftEpsIds.push(eps.id);
                shiftGroupIds.push(eps.id);
            }
            const shiftSoloIds: string[] = [];
            for (const c of soloClones) {
                if (c.qbInvoiceId) {
                    skippedQbMilestones.push({
                        estimatePaymentScheduleId: null,
                        name: c.name,
                        paymentScheduleIds: [c.id],
                    });
                    notes.push(`Skipped "${c.name}" — already pushed to QuickBooks; update the due date on the QBO invoice manually.`);
                    continue;
                }
                if (c.status === "Pending" && c.dueDate) shiftSoloIds.push(c.id);
            }

            // Atomic check-and-set on every invoice-side milestone write: the
            // "qbInvoiceId" IS NULL guard (plus status = 'Pending') turns a QB
            // push that lands mid-transaction into a 0-row match instead of a
            // silent overwrite of a customer-facing due date. Residual race:
            // the external QBO invoice can exist for a sub-second window before
            // qbInvoiceId is persisted locally — that window is deliberately
            // accepted and handled by the existing resend_invoice repair flow.
            //
            // With the FOR UPDATE locks taken above, a QB push can no longer
            // reach these rows mid-transaction at all — the guards and the
            // post-update reconciliation below are defense-in-depth (e.g. a
            // future lock-free code path), and the reconciliation should never
            // fire in practice.
            if (shiftEpsIds.length > 0) {
                shiftedMilestones += await tx.$executeRaw`
                    UPDATE "EstimatePaymentSchedule"
                    SET "dueDate" = "dueDate" + (${daysParam} || ' days')::interval
                    WHERE "id" IN (${Prisma.join(shiftEpsIds)})
                      AND "dueDate" IS NOT NULL
                `;
            }
            if (shiftGroupIds.length > 0) {
                shiftedMilestones += await tx.$executeRaw`
                    UPDATE "PaymentSchedule"
                    SET "dueDate" = "dueDate" + (${daysParam} || ' days')::interval
                    WHERE "sourceScheduleId" IN (${Prisma.join(shiftGroupIds)})
                      AND "qbInvoiceId" IS NULL
                      AND "status" = 'Pending'
                      AND "dueDate" IS NOT NULL
                `;
            }
            if (shiftSoloIds.length > 0) {
                shiftedMilestones += await tx.$executeRaw`
                    UPDATE "PaymentSchedule"
                    SET "dueDate" = "dueDate" + (${daysParam} || ' days')::interval
                    WHERE "id" IN (${Prisma.join(shiftSoloIds)})
                      AND "qbInvoiceId" IS NULL
                      AND "status" = 'Pending'
                      AND "dueDate" IS NOT NULL
                `;
            }

            // Re-read every invoice-side row we intended to shift: any row
            // that matched 0 because a qbInvoiceId appeared mid-transaction is
            // surfaced for manual/QB-side fixing (never silently dropped).
            // Should never fire while the FOR UPDATE reads above are in place.
            const intendedCloneIds = [
                ...linkedClones
                    .filter(c => c.sourceScheduleId && shiftGroupIds.includes(c.sourceScheduleId) && !c.qbInvoiceId && c.status === "Pending" && c.dueDate)
                    .map(c => c.id),
                ...shiftSoloIds,
            ];
            if (intendedCloneIds.length > 0) {
                const afterRows = await tx.paymentSchedule.findMany({
                    where: { id: { in: intendedCloneIds } },
                    select: { id: true, name: true, qbInvoiceId: true, sourceScheduleId: true },
                });
                for (const row of afterRows) {
                    if (!row.qbInvoiceId) continue;
                    skippedQbMilestones.push({
                        estimatePaymentScheduleId: row.sourceScheduleId ?? null,
                        name: row.name,
                        paymentScheduleIds: [row.id],
                    });
                    notes.push(`"${row.name}" was pushed to QuickBooks while the start date was moving — its due date was left unchanged; update the QBO invoice manually.`);
                }
            }
        }

        await tx.activityLog.create({
            data: {
                projectId,
                actorType: actor.type,
                actorName: actor.name,
                action: "moved_project_start",
                entityType: "project",
                entityId: projectId,
                entityName: project.name,
                metadata: JSON.stringify({
                    previousStartDate: previousStartDate ? previousStartDate.toISOString() : null,
                    startDate: startDate ? startDate.toISOString() : null,
                    shiftedTasks,
                    shiftedMilestones,
                    skippedQbMilestones: skippedQbMilestones.length,
                }),
            },
        });

        return {
            projectId,
            previousStartDate: previousStartDate ? previousStartDate.toISOString() : null,
            startDate: startDate ? startDate.toISOString() : null,
            shiftedTasks,
            shiftedMilestones,
            skippedQbMilestones,
            notes,
        };
    }));
}

export interface CashflowBucket {
    total: number;
    count: number;
}

export interface CashflowOutlook {
    overdue: CashflowBucket;      // due before today (UTC calendar day)
    days0to30: CashflowBucket;    // due today through +30 UTC days
    days31to60: CashflowBucket;
    days61to90: CashflowBucket;
    noDueDateCount: number;       // Pending milestones with no dueDate (excluded from buckets)
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * ADMIN-only cash outlook: Pending milestones only (Paid and Canceled
 * excluded), bucketed by dueDate into non-overlapping, non-cumulative UTC
 * calendar-day windows. Pending milestones past 90 days out or with no dueDate
 * are not in any bucket (the latter are counted separately).
 */
export async function getCashflowOutlook(): Promise<CashflowOutlook> {
    const milestones = await prisma.paymentSchedule.findMany({
        where: { status: "Pending" },
        select: { amount: true, dueDate: true },
    });

    const now = new Date();
    const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const out: CashflowOutlook = {
        overdue: { total: 0, count: 0 },
        days0to30: { total: 0, count: 0 },
        days31to60: { total: 0, count: 0 },
        days61to90: { total: 0, count: 0 },
        noDueDateCount: 0,
    };

    for (const m of milestones) {
        if (!m.dueDate) {
            out.noDueDateCount++;
            continue;
        }
        const dueUtcMs = Date.UTC(m.dueDate.getUTCFullYear(), m.dueDate.getUTCMonth(), m.dueDate.getUTCDate());
        const dayDiff = Math.round((dueUtcMs - todayUtcMs) / 86_400_000);
        const bucket =
            dayDiff < 0 ? out.overdue
            : dayDiff <= 30 ? out.days0to30
            : dayDiff <= 60 ? out.days31to60
            : dayDiff <= 90 ? out.days61to90
            : null;
        if (!bucket) continue; // further out than 90 days — not part of the outlook
        bucket.total += Number(m.amount);
        bucket.count++;
    }

    out.overdue.total = round2(out.overdue.total);
    out.days0to30.total = round2(out.days0to30.total);
    out.days31to60.total = round2(out.days31to60.total);
    out.days61to90.total = round2(out.days61to90.total);
    return out;
}

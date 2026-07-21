import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { withTxRetry } from "./tx-retry";
import { OPEN_PROJECT_STATUSES } from "./project-status";
import { CLOSED_PROJECT_STATUSES, CLOSED_LEAD_STAGES } from "./gpt-estimate";
import { formatDate, parseUTCDate, addDays, getMonthGrid, getDefaultColorForTaskName } from "@/app/projects/[id]/schedule/schedule-utils";

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
// R2 fix 4): the job is sold and the number is real. Also the qualifying set
// for schedule generation (same selection rule, PB-pipeline-002 R1 fix 6).
export const CONTRACT_ESTIMATE_STATUSES = ["Approved", "Invoiced", "Partially Paid", "Paid"];

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

export interface PipelineCrewMember {
    id: string;
    name: string;
    // User status (PENDING/ACTIVATED/DISABLED) — the dashboard picker renders
    // assigned non-ACTIVATED members as removable "(inactive)" entries.
    status: string;
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
    // Project.crew (the same relation the dashboard picker writes).
    crew: PipelineCrewMember[];
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
                crew: { select: { id: true, name: true, email: true, status: true } },
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
        crew: p.crew.map(u => ({ id: u.id, name: u.name || u.email, status: u.status })),
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

// ─────────────────────────────────────────────────────────────────────────────
// Workstream A — Estimate → schedule generation (PB-pipeline-002)
// ─────────────────────────────────────────────────────────────────────────────

function utcDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Labor classification (R1 fix 5 — EstimateItem has NO `unit` field): a line
// counts as Labor when costType?.name ?? type equals "Labor", case-insensitive.
function isLaborLine(line: { type: string; costTypeName: string | null }): boolean {
    return (line.costTypeName ?? line.type ?? "").toLowerCase() === "labor";
}

const HOUR_LIKE_BUDGET_UNITS = new Set(["hr", "hrs", "hour", "hours"]);
function isHourLikeBudgetUnit(budgetUnit: string | null): boolean {
    return !!budgetUnit && HOUR_LIKE_BUDGET_UNITS.has(budgetUnit.toLowerCase());
}

interface EstimateLine {
    id: string;
    name: string;
    type: string;
    quantity: number;
    budgetUnit: string | null;
    total: number;
    parentId: string | null;
    costTypeName: string | null;
}

export interface GeneratedTaskRow {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    type: string;
    color: string;
    order: number;
    status: string;
    progress: number;
    estimatedHours: number | null;
    estimateItemId: string | null;
    parentId: string | null;
}

export interface GenerateScheduleResult {
    estimateCode: string;
    created: GeneratedTaskRow[];
    skipped: number;
    milestonesLinked: number;
    notes: string[];
}

/**
 * Generate a project's schedule from its completed estimate: phase parent
 * tasks with children, flat tasks for phase-less estimates, and milestone
 * tasks for the payment schedule — then link the milestone mirrors and
 * initialize null dueDates. EVERYTHING runs in ONE transaction (withTxRetry;
 * Project row FOR UPDATE first, same lock family as P1).
 *
 * Phase windows: window = startDate → endDate if set, else startDate + 42d,
 * extended to phaseCount days when phases exceed it. Reserve 1 day per phase,
 * then distribute the remainder proportionally by labor-dollar share
 * (Hamilton/largest-remainder: floor each ideal share, leftover days to the
 * largest fractional remainders, ties by estimate order) — slices sum exactly
 * to the window. Bounds [start, end) end-exclusive as in P1.
 *
 * Milestones — ONE canonical date rule: EPS rows ordered by (order, id),
 * percentages accumulated → the cumulative-percentage point of the window
 * (fixed-amount/unordered rows at window end); the milestone task date =
 * EPS.dueDate if set, else that derived point. dueDate is initialized from
 * that date ONLY on rows that are Pending AND null-dated AND not QB-pushed;
 * linking (scheduleTaskId on the EPS row AND every unpaid clone) happens
 * regardless of qbInvoiceId — linking is not a QBO mutation.
 *
 * mode "merge" (default) skips items already task-linked. mode "regenerate"
 * deletes generated tasks first, where deletable means the FULL eligibility
 * predicate (provenance + progress 0 + Not Started + no timeEntries/comments/
 * punchItems/assignments/subAssignments/dependency rows), evaluated per phase
 * SUBTREE — a protected descendant keeps the whole subtree (never a cascade
 * through protected work).
 */
export async function generateScheduleFromEstimate(input: {
    estimateId: string;
    mode?: "merge" | "regenerate";
    actor: ScheduleActor;
}): Promise<GenerateScheduleResult> {
    const mode = input.mode ?? "merge";
    if (mode !== "merge" && mode !== "regenerate") throw new Error(`Unknown generation mode "${mode}"`);

    return withTxRetry(() => prisma.$transaction(async (tx) => {
        // Lock-then-read, mirroring setProjectStartDate exactly: resolve the
        // project id with a minimal read, take the Project row lock, and ONLY
        // THEN re-read the full estimate (items, paymentSchedules — clones are
        // read under their own FOR UPDATE below) — so a concurrent start-date
        // move can't shift dueDates between the read and the lock.
        const estimateRef = await tx.estimate.findUnique({
            where: { id: input.estimateId },
            select: { id: true, code: true, status: true, projectId: true },
        });
        if (!estimateRef) throw new Error("Estimate not found");
        if (!CONTRACT_ESTIMATE_STATUSES.includes(estimateRef.status)) {
            throw new Error(`Estimate ${estimateRef.code} is "${estimateRef.status}" — only Approved, Invoiced, Partially Paid, or Paid estimates can generate a schedule.`);
        }
        if (!estimateRef.projectId) {
            throw new Error(`Estimate ${estimateRef.code} is attached to a lead, not a project — convert the lead to a project first.`);
        }
        const projectId = estimateRef.projectId;

        // Same lock family as P1 start-date moves and invoice cloning:
        // serialize generation against both on this project.
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
        const project = await tx.project.findUnique({
            where: { id: projectId },
            select: { id: true, name: true, startDate: true, endDate: true },
        });
        if (!project) throw new Error("Project not found");
        if (!project.startDate) {
            throw new Error(`Project "${project.name}" has no start date yet — set one on the company dashboard before generating its schedule.`);
        }

        // Full estimate read INSIDE the lock.
        const estimate = await tx.estimate.findUniqueOrThrow({
            where: { id: input.estimateId },
            include: {
                items: {
                    orderBy: { order: "asc" },
                    include: { costType: { select: { name: true } } },
                },
                paymentSchedules: {
                    orderBy: [{ order: "asc" }, { id: "asc" }],
                    select: { id: true, name: true, percentage: true, dueDate: true, status: true, scheduleTaskId: true, order: true },
                },
            },
        });

        const notes: string[] = [];
        const start = utcDay(project.startDate);
        const windowEndBase = project.endDate ? utcDay(project.endDate) : addDays(start, 42);

        // Split top-level lines into phases (have children) and flat lines.
        const lines: EstimateLine[] = estimate.items.map(i => ({
            id: i.id,
            name: i.name,
            type: i.type,
            quantity: i.quantity,
            budgetUnit: i.budgetUnit,
            total: Number(i.total),
            parentId: i.parentId,
            costTypeName: i.costType?.name ?? null,
        }));
        const topLevel = lines.filter(l => !l.parentId);
        const childrenOf = new Map<string, EstimateLine[]>();
        for (const l of lines) {
            if (!l.parentId) continue;
            const arr = childrenOf.get(l.parentId) ?? [];
            arr.push(l);
            childrenOf.set(l.parentId, arr);
        }
        const hasPhases = topLevel.some(l => (childrenOf.get(l.id) ?? []).length > 0);
        // Allocation units (estimate order): every top-level line when phases
        // exist (childless top-levels become single-task phases); the flat
        // lines otherwise.
        const units = topLevel;
        const unitCount = units.length;

        let windowDays = Math.max(1, Math.round((windowEndBase.getTime() - start.getTime()) / 86_400_000));
        // Phases extend the window to fit; flat placement packs instead.
        if (hasPhases && unitCount > windowDays) windowDays = unitCount;

        // Reserve 1 day per unit, then distribute the remaining
        // windowDays − unitCount days by labor-dollar share (floor each ideal;
        // leftover to largest fractional remainders, ties by estimate order).
        const laborDollarsOf = (line: EstimateLine): number => {
            const own = isLaborLine(line) ? line.total : 0;
            return own + (childrenOf.get(line.id) ?? []).reduce((s, k) => s + (isLaborLine(k) ? k.total : 0), 0);
        };
        const allocateWindow = (count: number, laborDollars: number[]): number[] => {
            const remainder = windowDays - count;
            if (remainder <= 0) return laborDollars.map(() => 1);
            const totalLabor = laborDollars.reduce((s, n) => s + n, 0);
            const ideals = laborDollars.map(d => (totalLabor > 0 ? (remainder * d) / totalLabor : remainder / count));
            const days = ideals.map(x => 1 + Math.floor(x));
            let leftover = windowDays - days.reduce((s, n) => s + n, 0);
            const byFraction = ideals
                .map((x, i) => ({ i, frac: x - Math.floor(x) }))
                .sort((a, b) => b.frac - a.frac || a.i - b.i);
            for (let k = 0; leftover > 0 && byFraction.length > 0; k++) {
                days[byFraction[k % byFraction.length].i]++;
                leftover--;
            }
            return days;
        };

        // ── regenerate: delete eligible generated subtrees first ──
        if (mode === "regenerate") {
            const allTasks = await tx.scheduleTask.findMany({
                where: { projectId },
                select: {
                    id: true, parentId: true, generatedFromEstimateId: true, progress: true, status: true,
                    _count: {
                        select: {
                            timeEntries: true, comments: true, punchItems: true,
                            assignments: true, subAssignments: true,
                            dependencies: true, dependents: true,
                        },
                    },
                },
            });
            const byParent = new Map<string | null, typeof allTasks>();
            for (const t of allTasks) {
                const arr = byParent.get(t.parentId) ?? [];
                arr.push(t);
                byParent.set(t.parentId, arr);
            }
            const generatedIds = new Set(allTasks.filter(t => t.generatedFromEstimateId === estimate.id).map(t => t.id));
            // The FULL eligibility predicate, evaluated at delete time.
            const isDeletable = (t: (typeof allTasks)[number]) =>
                t.generatedFromEstimateId === estimate.id &&
                t.progress === 0 &&
                t.status === "Not Started" &&
                t._count.timeEntries === 0 &&
                t._count.comments === 0 &&
                t._count.punchItems === 0 &&
                t._count.assignments === 0 &&
                t._count.subAssignments === 0 &&
                t._count.dependencies === 0 &&
                t._count.dependents === 0;
            // Subtree roots: generated tasks whose parent is not generated from
            // this estimate. Delete a subtree only when EVERY descendant is
            // deletable — the parent delete cascades, so anything less would
            // cut through protected work.
            const roots = allTasks.filter(t => generatedIds.has(t.id) && (!t.parentId || !generatedIds.has(t.parentId)));
            let keptSubtrees = 0;
            for (const root of roots) {
                const subtree: typeof allTasks = [];
                const stack = [root];
                while (stack.length) {
                    const cur = stack.pop()!;
                    subtree.push(cur);
                    for (const child of byParent.get(cur.id) ?? []) stack.push(child);
                }
                if (subtree.every(isDeletable)) {
                    await tx.scheduleTask.delete({ where: { id: root.id } });
                } else {
                    keptSubtrees++;
                }
            }
            if (keptSubtrees > 0) {
                notes.push(`Kept ${keptSubtrees} generated subtree${keptSubtrees === 1 ? "" : "s"} untouched — work was logged or edits made (progress, status, time, comments, punch items, assignments, or dependencies).`);
            }
        }

        const maxOrder = await tx.scheduleTask.aggregate({ where: { projectId }, _max: { order: true } });
        let nextOrder = (maxOrder._max.order ?? -1) + 1;

        // Link state for merge-skip — read AFTER any regenerate deletion:
        // deleting a generated task drops its estimateItemId link and SetNulls
        // the EPS scheduleTaskId, so pre-delete reads would be stale here.
        const itemIds = lines.map(l => l.id);
        const existingLinked = itemIds.length
            ? await tx.scheduleTask.findMany({
                where: { estimateItemId: { in: itemIds } },
                select: { id: true, estimateItemId: true },
            })
            : [];
        const taskIdByItemId = new Map(existingLinked.map(t => [t.estimateItemId!, t.id]));
        const freshEpsLinks = await tx.estimatePaymentSchedule.findMany({
            where: { estimateId: estimate.id },
            select: { id: true, scheduleTaskId: true },
        });
        const freshTaskIdByEps = new Map(freshEpsLinks.map(e => [e.id, e.scheduleTaskId]));

        const createdRows: GeneratedTaskRow[] = [];
        let skipped = 0;

        const TYPE_COLORS: Record<string, string> = { Material: "#3b82f6", Labor: "#f59e0b", Subcontractor: "#8b5cf6" };
        const colorFor = (line: EstimateLine) =>
            getDefaultColorForTaskName(line.name) || TYPE_COLORS[line.costTypeName ?? line.type] || "#4c9a2a";

        const createTask = async (data: {
            name: string; startDate: Date; endDate: Date; color: string; order: number;
            type: string; estimatedHours: number | null; estimateItemId: string | null; parentId: string | null;
        }) => {
            const row = await tx.scheduleTask.create({
                data: {
                    projectId,
                    status: "Not Started",
                    progress: 0,
                    generatedFromEstimateId: estimate.id,
                    ...data,
                },
            });
            createdRows.push({
                id: row.id,
                name: row.name,
                startDate: row.startDate.toISOString(),
                endDate: row.endDate.toISOString(),
                type: row.type,
                color: row.color,
                order: row.order,
                status: row.status,
                progress: row.progress,
                estimatedHours: row.estimatedHours,
                estimateItemId: row.estimateItemId,
                parentId: row.parentId,
            });
            return row;
        };

        // Flat/leaf placement: sequential in estimate order, each task's
        // [start, end) computed from proportional boundaries —
        // start_i = windowStart + floor(i × windowDays / n),
        // end_i   = windowStart + floor((i+1) × windowDays / n) —
        // so the slices cover the window EXACTLY (no flooring shortfall) and
        // the last task ends at the window end. When taskCount > windowDays
        // the proportional endpoints can coincide, so the end becomes
        // start + 1 day instead — the spec's one-day minimum always holds
        // (multiple tasks share a start day, order preserved via `order`).
        const placeLeaves = async (leafLines: EstimateLine[], winStart: Date, winDays: number, parentTaskId: string | null) => {
            const pending = leafLines.filter(l => !taskIdByItemId.has(l.id));
            skipped += leafLines.length - pending.length;
            const n = pending.length;
            if (n === 0) return;
            const days = Math.max(1, winDays);
            const packed = n > days;
            for (let k = 0; k < n; k++) {
                const line = pending[k];
                const tStart = addDays(winStart, Math.floor((k * days) / n));
                const tEnd = packed
                    ? addDays(tStart, 1)
                    : addDays(winStart, Math.floor(((k + 1) * days) / n));
                await createTask({
                    name: line.name,
                    startDate: tStart,
                    endDate: tEnd,
                    color: colorFor(line),
                    order: nextOrder++,
                    type: "task",
                    estimatedHours: isHourLikeBudgetUnit(line.budgetUnit) ? line.quantity : null,
                    estimateItemId: line.id,
                    parentId: parentTaskId,
                });
            }
        };

        if (hasPhases) {
            const sliceDays = allocateWindow(unitCount, units.map(laborDollarsOf));
            let cursor = start;
            for (let u = 0; u < unitCount; u++) {
                const unit = units[u];
                const sliceStart = cursor;
                const sliceEnd = addDays(sliceStart, sliceDays[u]);
                cursor = sliceEnd;
                const kids = childrenOf.get(unit.id) ?? [];
                if (kids.length === 0) {
                    // Childless top-level inside a phased estimate: single-task slice.
                    await placeLeaves([unit], sliceStart, sliceDays[u], null);
                    continue;
                }
                let parentTaskId = taskIdByItemId.get(unit.id) ?? null;
                if (parentTaskId) {
                    skipped++;
                } else {
                    const parent = await createTask({
                        name: unit.name,
                        startDate: sliceStart,
                        endDate: sliceEnd,
                        color: colorFor(unit),
                        order: nextOrder++,
                        type: "task",
                        estimatedHours: null,
                        estimateItemId: unit.id,
                        parentId: null,
                    });
                    parentTaskId = parent.id;
                }
                // Children split the phase window by the flat-placement rule.
                await placeLeaves(kids, sliceStart, sliceDays[u], parentTaskId);
            }
        } else {
            await placeLeaves(units, start, windowDays, null);
        }

        // ── Milestones — ONE canonical date rule ──
        const epsRows = estimate.paymentSchedules; // already ordered by (order, id)
        const canonicalByEps = new Map<string, Date>();
        const milestoneTaskIdByEps = new Map<string, string>();
        let cumPct = 0;
        for (const eps of epsRows) {
            const pct = eps.percentage != null ? Number(eps.percentage) : null;
            if (pct != null) cumPct += pct;
            const derived = pct != null
                ? addDays(start, Math.round((Math.min(cumPct, 100) / 100) * windowDays))
                : addDays(start, windowDays); // fixed-amount/unordered → window end
            const canonical = eps.dueDate ? utcDay(eps.dueDate) : derived;
            canonicalByEps.set(eps.id, canonical);

            const existingTaskId = freshTaskIdByEps.get(eps.id);
            if (existingTaskId) {
                // Already task-linked (kept subtree / prior run): merge-skip,
                // but remember the link so later-created clones still attach.
                milestoneTaskIdByEps.set(eps.id, existingTaskId);
                skipped++;
                continue;
            }
            const mTask = await createTask({
                name: eps.name,
                startDate: canonical,
                endDate: addDays(canonical, 1),
                color: "#f59e0b",
                order: nextOrder++,
                type: "milestone",
                estimatedHours: null,
                estimateItemId: null,
                parentId: null,
            });
            milestoneTaskIdByEps.set(eps.id, mTask.id);
        }

        // Link EPS rows AND every unpaid clone in their sourceScheduleId groups
        // — regardless of qbInvoiceId (linking is not a QBO mutation; the QB
        // whole-group skip applies ONLY to due-date WRITES, per P1). dueDate is
        // initialized from the canonical date ONLY on rows that are Pending AND
        // null-dated AND not QB-pushed — paid/settled rows are never rewritten,
        // QB-pushed clones keep their QB-visible date and are noted. All under
        // FOR UPDATE row locks on the decision set (P1 family).
        let milestonesLinked = 0;
        const epsIds = epsRows.map(e => e.id);
        if (epsIds.length > 0) {
            const lockedEps = await tx.$queryRaw<{ id: string; status: string; dueDate: Date | null }[]>`
                SELECT e."id", e."status", e."dueDate"
                FROM "EstimatePaymentSchedule" e
                WHERE e."id" IN (${Prisma.join(epsIds)})
                FOR UPDATE
            `;
            const lockedClones = await tx.$queryRaw<{ id: string; name: string; status: string; dueDate: Date | null; qbInvoiceId: string | null; sourceScheduleId: string | null }[]>`
                SELECT p."id", p."name", p."status", p."dueDate", p."qbInvoiceId", p."sourceScheduleId"
                FROM "PaymentSchedule" p
                WHERE p."sourceScheduleId" IN (${Prisma.join(epsIds)})
                FOR UPDATE
            `;
            const clonesByEps = new Map<string, typeof lockedClones>();
            for (const c of lockedClones) {
                if (!c.sourceScheduleId) continue;
                const arr = clonesByEps.get(c.sourceScheduleId) ?? [];
                arr.push(c);
                clonesByEps.set(c.sourceScheduleId, arr);
            }

            for (const eps of lockedEps) {
                const taskId = milestoneTaskIdByEps.get(eps.id);
                const canonical = canonicalByEps.get(eps.id);
                if (!taskId || !canonical) continue;

                // Upsert-style link (skip where already set).
                milestonesLinked += await tx.$executeRaw`
                    UPDATE "EstimatePaymentSchedule"
                    SET "scheduleTaskId" = ${taskId}
                    WHERE "id" = ${eps.id} AND "scheduleTaskId" IS NULL
                `;
                // Initialize the dueDate ONLY on Pending null-dated rows.
                if (eps.status === "Pending" && !eps.dueDate) {
                    await tx.$executeRaw`
                        UPDATE "EstimatePaymentSchedule"
                        SET "dueDate" = ${canonical}
                        WHERE "id" = ${eps.id} AND "status" = 'Pending' AND "dueDate" IS NULL
                    `;
                }

                // Every unpaid clone in the group — link regardless of QB state.
                milestonesLinked += await tx.$executeRaw`
                    UPDATE "PaymentSchedule"
                    SET "scheduleTaskId" = ${taskId}
                    WHERE "sourceScheduleId" = ${eps.id} AND "scheduleTaskId" IS NULL AND "status" <> 'Paid'
                `;
                // Pending null-dated non-QB clones get the canonical date.
                await tx.$executeRaw`
                    UPDATE "PaymentSchedule"
                    SET "dueDate" = ${canonical}
                    WHERE "sourceScheduleId" = ${eps.id} AND "status" = 'Pending' AND "dueDate" IS NULL AND "qbInvoiceId" IS NULL
                `;
                // QB-pushed null-date clones keep their QB-visible date (empty);
                // the income overlay projects them on their linked task date.
                for (const c of clonesByEps.get(eps.id) ?? []) {
                    if (c.qbInvoiceId && c.status === "Pending" && !c.dueDate) {
                        notes.push(`Milestone "${c.name}" is already pushed to QuickBooks — its due date was left unset locally; it appears as projected income on its linked task date.`);
                    }
                }
            }
        }

        await tx.activityLog.create({
            data: {
                projectId,
                actorType: input.actor.type,
                actorName: input.actor.name,
                action: "generated_schedule",
                entityType: "project",
                entityId: projectId,
                entityName: project.name,
                metadata: JSON.stringify({
                    estimateId: estimate.id,
                    estimateCode: estimate.code,
                    mode,
                    created: createdRows.length,
                    skipped,
                    milestonesLinked,
                }),
            },
        });

        return { estimateCode: estimate.code, created: createdRows, skipped, milestonesLinked, notes };
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Workstream B — Crew on the company calendar (PB-pipeline-002)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectCrewMember {
    id: string;
    name: string;
}

/**
 * Replace a project's crew (Project.crew — the same relation the dashboard
 * picker writes and getCrewConflicts reads) via a connect/disconnect diff.
 * Every id must be an ACTIVATED user. Idempotent; writes a "set_project_crew"
 * ActivityLog row.
 */
export async function setProjectCrew(input: {
    projectId: string;
    userIds: string[];
    actor: ScheduleActor;
}): Promise<{ projectId: string; crew: ProjectCrewMember[] }> {
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${input.projectId} FOR UPDATE`;
        const project = await tx.project.findUnique({
            where: { id: input.projectId },
            select: { id: true, name: true, crew: { select: { id: true, name: true, email: true } } },
        });
        if (!project) throw new Error("Project not found");

        const wanted = [...new Set(input.userIds)];
        const users = wanted.length
            ? await tx.user.findMany({
                where: { id: { in: wanted } },
                select: { id: true, name: true, email: true, status: true },
            })
            : [];
        const byId = new Map(users.map(u => [u.id, u]));
        const missing = wanted.filter(id => !byId.has(id));
        if (missing.length > 0) throw new Error(`Unknown user id(s): ${missing.join(", ")}`);
        const notActivated = users.filter(u => u.status !== "ACTIVATED");
        if (notActivated.length > 0) {
            throw new Error(`Crew members must be ACTIVATED users: ${notActivated.map(u => u.name || u.email).join(", ")}`);
        }

        const current = project.crew.map(u => u.id);
        const toConnect = wanted.filter(id => !current.includes(id));
        const toDisconnect = current.filter(id => !wanted.includes(id));
        await tx.project.update({
            where: { id: input.projectId },
            data: {
                crew: {
                    connect: toConnect.map(id => ({ id })),
                    disconnect: toDisconnect.map(id => ({ id })),
                },
            },
        });

        await tx.activityLog.create({
            data: {
                projectId: input.projectId,
                actorType: input.actor.type,
                actorName: input.actor.name,
                action: "set_project_crew",
                entityType: "project",
                entityId: input.projectId,
                entityName: project.name,
                metadata: JSON.stringify({ added: toConnect, removed: toDisconnect, crewIds: wanted }),
            },
        });

        return {
            projectId: input.projectId,
            crew: wanted.map(id => ({ id, name: byId.get(id)!.name || byId.get(id)!.email })),
        };
    }));
}

export interface CrewConflictPair {
    projectA: { id: string; name: string };
    projectB: { id: string; name: string };
    overlapStart: string;
    overlapEnd: string;
}

export interface CrewConflict {
    userId: string;
    name: string;
    pairs: CrewConflictPair[];
}

/**
 * Crew double-bookings within [from, to): a conflict = one user in the crew of
 * two different projects whose windows overlap within the range. Window =
 * startDate → (endDate ?? latest task endDate ?? startDate + 1 day) — the
 * 1-day fallback means two crews booked on the same day DO conflict; overlaps
 * use half-open [start, end) bounds. Bounded queries; overlap computed in
 * memory. (TaskAssignment-level precision is Phase 3.)
 */
export async function getCrewConflicts(from: Date, to: Date): Promise<CrewConflict[]> {
    const projects = await prisma.project.findMany({
        where: { startDate: { not: null }, crew: { some: {} } },
        select: {
            id: true, name: true, startDate: true, endDate: true,
            crew: { select: { id: true, name: true, email: true } },
            scheduleTasks: { orderBy: { endDate: "desc" }, take: 1, select: { endDate: true } },
        },
    });

    const windows = projects.map(p => {
        const start = utcDay(p.startDate!);
        const rawEnd = p.endDate
            ? utcDay(p.endDate)
            : p.scheduleTasks[0]
                ? utcDay(p.scheduleTasks[0].endDate)
                : addDays(start, 1);
        return {
            id: p.id,
            name: p.name,
            start,
            end: rawEnd > start ? rawEnd : addDays(start, 1),
            crew: p.crew,
        };
    });

    // Group windows by crew user, then check each pair of that user's projects.
    const byUser = new Map<string, { name: string; windows: typeof windows }>();
    for (const w of windows) {
        for (const u of w.crew) {
            const entry = byUser.get(u.id) ?? { name: u.name || u.email, windows: [] };
            entry.windows.push(w);
            byUser.set(u.id, entry);
        }
    }

    const conflicts: CrewConflict[] = [];
    for (const [userId, { name, windows: userWindows }] of byUser) {
        if (userWindows.length < 2) continue;
        const pairs: CrewConflictPair[] = [];
        for (let i = 0; i < userWindows.length; i++) {
            for (let j = i + 1; j < userWindows.length; j++) {
                const a = userWindows[i];
                const b = userWindows[j];
                const oStart = a.start > b.start ? a.start : b.start;
                const oEnd = a.end < b.end ? a.end : b.end;
                if (oStart >= oEnd) continue; // half-open: no overlap
                // The overlap must intersect the visible range.
                if (oEnd <= from || oStart >= to) continue;
                pairs.push({
                    projectA: { id: a.id, name: a.name },
                    projectB: { id: b.id, name: b.name },
                    overlapStart: oStart.toISOString(),
                    overlapEnd: oEnd.toISOString(),
                });
            }
        }
        if (pairs.length > 0) conflicts.push({ userId, name, pairs });
    }
    return conflicts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workstream C — Money/hours overlays (ADMIN-only, data-layer enforced as P1)
// ─────────────────────────────────────────────────────────────────────────────

export interface OverlayIncomeItem {
    id: string;
    name: string;
    amount: number;
    dueDate: string | null;
    // Shared rule: dueDate ?? linked milestone task's startDate. Used by BOTH
    // the calendar income layer and the project strip's "Income due", so
    // overlays and tasks agree by construction.
    effectiveDueDate: string;
    invoiceId: string;
    invoiceCode: string;
    projectId: string | null;
    projectName: string | null;
    anchoredToTask: boolean;
    inQuickBooks: boolean;
}

export interface OverlayExpenseItem {
    id: string;
    amount: number;
    vendor: string | null;
    date: string;
    projectId: string | null;
    projectName: string | null;
}

export interface OverlayHoursItem {
    id: string;
    userId: string;
    userName: string;
    projectId: string;
    projectName: string | null;
    startTime: string;
    durationHours: number;
}

export interface CalendarOverlays {
    income: OverlayIncomeItem[];
    expenses: OverlayExpenseItem[];
    hours: OverlayHoursItem[];
}

/**
 * ADMIN-path calendar overlays: income (Pending milestones by the shared
 * effectiveDueDate rule), expenses (Expense.date in range, project via
 * estimate), hours (TimeEntry.startTime date in range). Read-only.
 */
export async function getCalendarOverlays(from: Date, to: Date): Promise<CalendarOverlays> {
    const [milestones, expenses, hours] = await Promise.all([
        prisma.paymentSchedule.findMany({
            where: {
                status: "Pending",
                OR: [
                    { dueDate: { gte: from, lt: to } },
                    { dueDate: null, scheduleTask: { startDate: { gte: from, lt: to } } },
                ],
            },
            orderBy: { createdAt: "asc" },
            select: {
                id: true, name: true, amount: true, dueDate: true, scheduleTaskId: true, qbInvoiceId: true,
                scheduleTask: { select: { startDate: true } },
                invoice: { select: { id: true, code: true, project: { select: { id: true, name: true } } } },
            },
        }),
        prisma.expense.findMany({
            where: { date: { gte: from, lt: to } },
            orderBy: { date: "asc" },
            select: {
                id: true, amount: true, vendor: true, date: true,
                estimate: { select: { projectId: true, project: { select: { id: true, name: true } } } },
            },
        }),
        prisma.timeEntry.findMany({
            where: { startTime: { gte: from, lt: to } },
            orderBy: { startTime: "asc" },
            select: {
                id: true, userId: true, startTime: true, durationHours: true,
                user: { select: { name: true, email: true } },
                project: { select: { id: true, name: true } },
            },
        }),
    ]);

    return {
        income: milestones.map(m => {
            const effective = m.dueDate ?? m.scheduleTask?.startDate ?? null;
            return {
                id: m.id,
                name: m.name,
                amount: Number(m.amount),
                dueDate: m.dueDate ? m.dueDate.toISOString() : null,
                effectiveDueDate: effective!.toISOString(),
                invoiceId: m.invoice.id,
                invoiceCode: m.invoice.code,
                projectId: m.invoice.project?.id ?? null,
                projectName: m.invoice.project?.name ?? null,
                anchoredToTask: !!m.scheduleTaskId,
                inQuickBooks: !!m.qbInvoiceId,
            };
        }),
        expenses: expenses.map(e => ({
            id: e.id,
            amount: Number(e.amount),
            vendor: e.vendor,
            date: e.date!.toISOString(),
            projectId: e.estimate?.project?.id ?? null,
            projectName: e.estimate?.project?.name ?? null,
        })),
        hours: hours.map(h => ({
            id: h.id,
            userId: h.userId,
            userName: h.user.name || h.user.email,
            projectId: h.project.id,
            projectName: h.project.name ?? null,
            startTime: h.startTime.toISOString(),
            durationHours: h.durationHours ?? 0,
        })),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard page assembly (PB-pipeline-002, R1 fix 10 — directly testable)
// ─────────────────────────────────────────────────────────────────────────────

export interface DashboardProjectRow extends PipelineProject {
    taskCount: number;
    hasQualifyingEstimate: boolean;
}

export interface ProjectMonthStripRow {
    projectId: string;
    projectName: string;
    incomeDue: number;
    received: number;
    expenses: number;
    laborBurdened: number;
    hoursActual: number;
    hoursEstimated: number;
    net: number;
}

export interface CompanyDashboardData {
    month: string;
    role: string;
    canEdit: boolean;
    isAdmin: boolean;
    pipeline: {
        estimating: CompanyPipeline["estimating"];
        waitingToStart: DashboardProjectRow[];
        scheduled: DashboardProjectRow[];
        inProgress: DashboardProjectRow[];
        substantialCompletion: CompanyPipeline["substantialCompletion"];
    };
    calendar: StartCalendar;
    cashflow: CashflowOutlook | null;
    teamMembers: { id: string; name: string; email: string }[] | null;
    crewConflicts: CrewConflict[] | null;
    overlays: CalendarOverlays | null;
    strip: ProjectMonthStripRow[] | null;
}

/**
 * Per-project month strip (ADMIN only). Exact semantics:
 *   Income due = Pending milestone sums by effectiveDueDate
 *   Received   = Paid milestone sums by COALESCE(paymentDate, paidAt)
 *   Expenses   = sum by Expense.date
 *   Labor (actual, burdened) = laborCost + burdenCost sums
 *   Hours      = actual TimeEntry hours vs estimatedHours of month-overlapping tasks
 *   Net        = Received − Expenses − burdened Labor (profitability convention)
 */
async function getProjectMonthStrip(from: Date, to: Date): Promise<ProjectMonthStripRow[]> {
    const openProjects = await prisma.project.findMany({
        where: { status: { in: OPEN_PROJECT_STATUSES } },
        select: { id: true, name: true },
    });
    if (openProjects.length === 0) return [];
    const nameOf = new Map(openProjects.map(p => [p.id, p.name]));

    const [pendingMilestones, paidMilestones, expenseRows, timeRows, overlappingTasks] = await Promise.all([
        // Income due: effectiveDueDate = dueDate ?? linkedTask.startDate.
        prisma.paymentSchedule.findMany({
            where: { status: "Pending" },
            select: {
                amount: true, dueDate: true,
                scheduleTask: { select: { startDate: true } },
                invoice: { select: { projectId: true } },
            },
        }),
        // Received: bucketed by COALESCE(paymentDate, paidAt) — never dueDate.
        prisma.paymentSchedule.findMany({
            where: {
                status: "Paid",
                OR: [
                    { paymentDate: { gte: from, lt: to } },
                    { paymentDate: null, paidAt: { gte: from, lt: to } },
                ],
            },
            select: { amount: true, paymentDate: true, paidAt: true, invoice: { select: { projectId: true } } },
        }),
        prisma.expense.findMany({
            where: { date: { gte: from, lt: to } },
            select: { amount: true, estimate: { select: { projectId: true } } },
        }),
        prisma.timeEntry.findMany({
            where: { startTime: { gte: from, lt: to } },
            select: { projectId: true, durationHours: true, laborCost: true, burdenCost: true },
        }),
        prisma.scheduleTask.findMany({
            where: { startDate: { lt: to }, endDate: { gt: from }, estimatedHours: { not: null } },
            select: { projectId: true, estimatedHours: true },
        }),
    ]);

    const sums = new Map<string, ProjectMonthStripRow>();
    const row = (projectId: string): ProjectMonthStripRow => {
        let r = sums.get(projectId);
        if (!r) {
            r = {
                projectId,
                projectName: nameOf.get(projectId) ?? "Unknown",
                incomeDue: 0, received: 0, expenses: 0,
                laborBurdened: 0, hoursActual: 0, hoursEstimated: 0, net: 0,
            };
            sums.set(projectId, r);
        }
        return r;
    };

    for (const m of pendingMilestones) {
        const pid = m.invoice.projectId;
        if (!pid || !nameOf.has(pid)) continue;
        const effective = m.dueDate ?? m.scheduleTask?.startDate ?? null;
        if (!effective || effective < from || effective >= to) continue;
        row(pid).incomeDue += Number(m.amount);
    }
    for (const m of paidMilestones) {
        const pid = m.invoice.projectId;
        if (!pid || !nameOf.has(pid)) continue;
        row(pid).received += Number(m.amount);
    }
    for (const e of expenseRows) {
        const pid = e.estimate?.projectId;
        if (!pid || !nameOf.has(pid)) continue;
        row(pid).expenses += Number(e.amount);
    }
    for (const t of timeRows) {
        if (!nameOf.has(t.projectId)) continue;
        const r = row(t.projectId);
        r.hoursActual += t.durationHours ?? 0;
        r.laborBurdened += Number(t.laborCost ?? 0) + Number(t.burdenCost ?? 0);
    }
    for (const t of overlappingTasks) {
        if (!t.projectId || !nameOf.has(t.projectId)) continue;
        row(t.projectId).hoursEstimated += t.estimatedHours ?? 0;
    }

    const round2 = (n: number) => Math.round(n * 100) / 100;
    return [...sums.values()]
        .map(r => ({
            ...r,
            incomeDue: round2(r.incomeDue),
            received: round2(r.received),
            expenses: round2(r.expenses),
            laborBurdened: round2(r.laborBurdened),
            hoursActual: round2(r.hoursActual),
            hoursEstimated: round2(r.hoursEstimated),
            net: round2(r.received - r.expenses - r.laborBurdened),
        }))
        .filter(r => r.incomeDue !== 0 || r.received !== 0 || r.expenses !== 0 || r.laborBurdened !== 0 || r.hoursActual !== 0 || r.hoursEstimated !== 0)
        .sort((a, b) => a.projectName.localeCompare(b.projectName));
}

/**
 * All data the company dashboard page needs, assembled in one place so the
 * page stays thin and the role matrix is directly testable: overlays + the
 * per-project strip are ONLY queried and serialized when role === "ADMIN";
 * crew conflicts and the picker list only for ADMIN/MANAGER (canEdit).
 * `month` must be a validated "YYYY-MM" string (the page validates).
 */
export async function getCompanyDashboardData(
    userLike: { role: string },
    month: string,
): Promise<CompanyDashboardData> {
    const role = userLike.role;
    const isAdmin = role === "ADMIN";
    const canEdit = role === "ADMIN" || role === "MANAGER";

    // Same 42-day grid as the calendar; `to` exclusive (getStartCalendar rule).
    const grid = getMonthGrid(parseUTCDate(`${month}-01`));
    const from = grid[0];
    const to = new Date(grid[grid.length - 1].getTime() + 86_400_000);

    const [pipeline, calendar, cashflow, crewConflicts, overlays, strip] = await Promise.all([
        getCompanyPipeline(),
        // The income layer comes from overlays (effectiveDueDate) for ADMIN, so
        // the calendar fetch stays financial-free here.
        getStartCalendar(from, to, { includeFinancials: false }),
        isAdmin ? getCashflowOutlook() : Promise.resolve(null),
        canEdit ? getCrewConflicts(from, to) : Promise.resolve(null),
        isAdmin ? getCalendarOverlays(from, to) : Promise.resolve(null),
        isAdmin ? getProjectMonthStrip(from, to) : Promise.resolve(null),
    ]);

    // Button data for "Generate schedule": Waiting/Scheduled rows show it only
    // when the project has a qualifying estimate AND zero schedule tasks.
    const rowIds = [
        ...pipeline.waitingToStart.map(p => p.id),
        ...pipeline.scheduled.map(p => p.id),
        ...pipeline.inProgress.map(p => p.id),
    ];
    const [taskCounts, qualifying] = await Promise.all([
        prisma.scheduleTask.groupBy({ by: ["projectId"], where: { projectId: { in: rowIds } }, _count: { id: true } }),
        prisma.estimate.groupBy({ by: ["projectId"], where: { projectId: { in: rowIds }, status: { in: CONTRACT_ESTIMATE_STATUSES } }, _count: { id: true } }),
    ]);
    const taskCountOf = new Map(taskCounts.map(t => [t.projectId, t._count.id]));
    const hasQualifying = new Set(qualifying.map(q => q.projectId));
    const enrich = (p: PipelineProject): DashboardProjectRow => ({
        ...p,
        taskCount: taskCountOf.get(p.id) ?? 0,
        hasQualifyingEstimate: hasQualifying.has(p.id),
    });

    // Picker list is pre-filtered to ACTIVATED (getTeamMembers stays unchanged
    // for other callers) and only sent to roles that can edit.
    const teamMembers = canEdit
        ? (await prisma.user.findMany({
            where: { status: "ACTIVATED" },
            orderBy: { name: "asc" },
            select: { id: true, name: true, email: true },
        })).map(u => ({ id: u.id, name: u.name || u.email, email: u.email }))
        : null;

    return {
        month,
        role,
        canEdit,
        isAdmin,
        pipeline: {
            estimating: pipeline.estimating,
            waitingToStart: pipeline.waitingToStart.map(enrich),
            scheduled: pipeline.scheduled.map(enrich),
            inProgress: pipeline.inProgress.map(enrich),
            substantialCompletion: pipeline.substantialCompletion,
        },
        calendar,
        cashflow,
        teamMembers,
        crewConflicts,
        overlays,
        strip,
    };
}

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { withTxRetry } from "./tx-retry";
import { OPEN_PROJECT_STATUSES } from "./project-status";
import { CLOSED_PROJECT_STATUSES, CLOSED_LEAD_STAGES } from "./gpt-estimate";
import { coSignedAmount, coTaxRate } from "./co-tax";
import { foldTaskEvidence } from "./task-evidence";
import { recomputeProjectProjectionInTransaction } from "./project-projection";
import { formatDate, parseUTCDate, addDays, getMonthGrid, getDefaultColorForTaskName } from "@/app/projects/[id]/schedule/schedule-utils";

// Session-free core of the company pipeline dashboard + start-calendar flows
// (.specs/PB-pipeline-001-company-dashboard.md), shared by the permission-gated
// server page/actions and the MCP connector (whose auth is the shared secret at
// the transport). Same architectural rule as billing-core.ts: actions.ts is
// "use server", so every export there is a remotely invokable endpoint —
// auth-free logic must live here, NOT there.
//
// Money-path discipline: this module writes `dueDate` only for the guarded P1
// start-date shift, and `scheduleTaskId` for estimate/CO milestone linking.
// It never writes amounts, statuses, or QB fields, and never partially shifts
// a QB-pushed mirror group. Phase 3 CO paths write scheduleTaskId only.

// Estimate statuses that count as the project's contract value (plan R1 fix 10,
// R2 fix 4): the job is sold and the number is real. Also the qualifying set
// for schedule generation (same selection rule, PB-pipeline-002 R1 fix 6).
export const CONTRACT_ESTIMATE_STATUSES = ["Approved", "Invoiced", "Partially Paid", "Paid"];

export function canonicalContractEstimateQuery(projectId: string) {
    return {
        where: {
            projectId,
            status: { in: CONTRACT_ESTIMATE_STATUSES },
        },
        orderBy: { createdAt: "desc" as const },
    };
}

export type ScheduleActor = { type: "TEAM" | "SYSTEM"; name: string };

export interface LockedTaskAssignmentParent {
    id: string;
    projectId: string;
    name: string;
}

/**
 * Canonical lock order for every TaskAssignment writer: parent Project first,
 * then the ScheduleTask row. The final read verifies the task did not move
 * between the caller's access check and lock acquisition.
 */
export async function lockTaskAssignmentParent(
    tx: Prisma.TransactionClient,
    taskId: string,
    expectedProjectId?: string,
): Promise<LockedTaskAssignmentParent> {
    const reference = expectedProjectId
        ? { projectId: expectedProjectId }
        : await tx.scheduleTask.findUnique({
            where: { id: taskId },
            select: { projectId: true },
        });
    if (!reference?.projectId) throw new Error("Task is not attached to a project");
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${reference.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ScheduleTask" WHERE id = ${taskId} FOR UPDATE`;
    const locked = await tx.scheduleTask.findUnique({
        where: { id: taskId },
        select: { id: true, projectId: true, name: true },
    });
    if (!locked || locked.projectId !== reference.projectId) {
        throw new Error("Task moved to another project; refresh and retry");
    }
    return {
        id: locked.id,
        projectId: locked.projectId,
        name: locked.name,
    };
}

export async function touchTaskAssignmentRevision(
    tx: Prisma.TransactionClient,
    taskId: string,
): Promise<void> {
    await tx.scheduleTask.update({
        where: { id: taskId },
        data: { updatedAt: new Date() },
    });
}

// The company shop — 5305 NE 121st Ave, Vancouver WA — anchor point for the
// crew-availability panel's "how far is this job" distance (not money; safe
// to serialize for every role).
const SHOP_LAT = 45.6617;
const SHOP_LNG = -122.5484;

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const EARTH_RADIUS_MILES = 3958.8;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_MILES * c;
}

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
    // User role — the picker renders an assigned FINANCE user (excluded from
    // the pickable teamMembers list) as a removable "(finance)" entry.
    role: string;
}

export interface PipelineProject {
    id: string;
    name: string;
    updatedAt: string;
    client: string | null;
    location: string | null;
    status: string;
    startDate: string | null;
    // Target end date (PB-schedule-002 item 3). Feeds getEffectiveProjectRange
    // (bar rendering) AND effectiveWorkEnd (CO placement + the project-window
    // conflict rule) via the same raw Date value — see effectiveWorkEnd's
    // doc comment for the shared semantics.
    endDate: string | null;
    projectedEndDate: string | null;
    projectedEndComputedAt: string | null;
    color: string | null;
    // totalAmount of the project's most recent Approved/Invoiced/Partially
    // Paid/Paid estimate; null when none exists.
    contractValue: number | null;
    // Project.crew (the same relation the dashboard picker writes).
    crew: PipelineCrewMember[];
    // Great-circle miles from the shop, rounded to a whole number; null when
    // the project has no geocoded location yet. Not money — serialized for
    // every role.
    distanceMilesFromShop: number | null;
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
                id: true, name: true, status: true, startDate: true, endDate: true, projectedEndDate: true, projectedEndComputedAt: true, updatedAt: true, color: true,
                location: true,
                locationLat: true, locationLng: true,
                client: { select: { name: true } },
                crew: { select: { id: true, name: true, email: true, status: true, role: true } },
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
        updatedAt: p.updatedAt.toISOString(),
        client: p.client?.name ?? null,
        location: p.location,
        status: p.status,
        startDate: p.startDate ? p.startDate.toISOString() : null,
        endDate: p.endDate ? p.endDate.toISOString() : null,
        projectedEndDate: p.projectedEndDate ? p.projectedEndDate.toISOString() : null,
        projectedEndComputedAt: p.projectedEndComputedAt ? p.projectedEndComputedAt.toISOString() : null,
        color: p.color,
        contractValue: p.estimates[0] ? Number(p.estimates[0].totalAmount) : null,
        crew: p.crew.map(u => ({ id: u.id, name: u.name || u.email, status: u.status, role: u.role })),
        distanceMilesFromShop: p.locationLat != null && p.locationLng != null
            ? Math.round(haversineMiles(SHOP_LAT, SHOP_LNG, p.locationLat, p.locationLng))
            : null,
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

export interface PersistedScheduleTaskDate {
    id: string;
    startDate: string;
    endDate: string;
}

export interface SetProjectStartDateResult {
    projectId: string;
    previousStartDate: string | null;
    startDate: string | null;
    shiftedTasks: number;
    shiftedTaskDates: PersistedScheduleTaskDate[];
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
export interface SetProjectStartDateInput {
    projectId: string;
    startDate: Date | null;
    shiftJobTasks?: boolean;
    actor: ScheduleActor;
}

interface InternalSetProjectStartDateInput extends SetProjectStartDateInput {
    transaction?: Prisma.TransactionClient;
    writeActivityLog?: boolean;
    skipAutoGenerate?: boolean;
}

async function runSetProjectStartDate(
    input: InternalSetProjectStartDateInput,
): Promise<SetProjectStartDateResult> {
    const { projectId, startDate, actor } = input;
    const shiftJobTasks = input.shiftJobTasks !== false; // default true

    // Retry wrapper per the repo's money-path convention (see tx-retry.ts): a
    // rolled-back write-conflict on the shared pooler re-runs against fresh state.
    const execute = async (tx: Prisma.TransactionClient) => {
        // Serialize concurrent start-date moves: lock the project row BEFORE
        // reading the current marker, so two moves can never compute their
        // deltas from the same stale startDate (lost-update / double-shift race).
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;

        const project = await tx.project.findUnique({
            where: { id: projectId },
            select: { id: true, name: true, status: true, startDate: true, endDate: true },
        });
        if (!project) throw new Error("Project not found");
        if (CLOSED_PROJECT_STATUSES.includes(project.status)) {
            throw new Error(`Cannot move the start date of a closed project (${project.status})`);
        }

        const previousStartDate = project.startDate;
        await tx.project.update({ where: { id: projectId }, data: { startDate } });

        const notes: string[] = [];
        // Preserve the endDate > startDate invariant under the same lock: a
        // start moved past a saved end would flip the window negative and
        // collapse estimate-generation windowDays to the 1-day clamp. Clearing
        // (not silently shifting) keeps the human in charge of the new end.
        if (startDate && project.endDate && project.endDate.getTime() <= startDate.getTime()) {
            await tx.project.update({ where: { id: projectId }, data: { endDate: null } });
            notes.push(`Saved end date ${project.endDate.toISOString().slice(0, 10)} was on or before the new start — cleared; set a new end date if needed.`);
        }
        const skippedQbMilestones: SkippedQbMilestone[] = [];
        let shiftedTasks = 0;
        let shiftedTaskDates: PersistedScheduleTaskDate[] = [];
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
            const shiftedTaskRows = await tx.$queryRaw<{ id: string; startDate: Date; endDate: Date }[]>`
                UPDATE "ScheduleTask"
                SET "startDate" = "startDate" + (${daysParam} || ' days')::interval,
                    "endDate" = "endDate" + (${daysParam} || ' days')::interval,
                    "updatedAt" = NOW()
                WHERE "projectId" = ${projectId}
                RETURNING "id", "startDate", "endDate"
            `;
            shiftedTaskDates = shiftedTaskRows
                .map(task => ({
                    id: task.id,
                    startDate: task.startDate.toISOString(),
                    endDate: task.endDate.toISOString(),
                }))
                .sort((a, b) => a.id.localeCompare(b.id));
            shiftedTasks = shiftedTaskDates.length;

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

        await recomputeProjectProjectionInTransaction(tx, projectId);

        if (input.writeActivityLog !== false) {
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
                        notes,
                    }),
                },
            });
        }

        return {
            projectId,
            previousStartDate: previousStartDate ? previousStartDate.toISOString() : null,
            startDate: startDate ? startDate.toISOString() : null,
            shiftedTasks,
            shiftedTaskDates,
            shiftedMilestones,
            skippedQbMilestones,
            notes,
        };
    };
    const result = input.transaction
        ? await execute(input.transaction)
        : await withTxRetry(() => prisma.$transaction(execute));

    // Post-commit best-effort generation hook (PB-pipeline-003): sign first,
    // date later ⇒ the schedule appears by itself. Fires when the project ends
    // up dated with zero tasks and a qualifying estimate; failures are caught
    // and surface in notes[], never fail the date move.
    if (!input.skipAutoGenerate && startDate !== null) {
        try {
            const [taskCount, qualifying] = await Promise.all([
                prisma.scheduleTask.count({ where: { projectId } }),
                prisma.estimate.findFirst({
                    ...canonicalContractEstimateQuery(projectId),
                    select: { id: true, code: true },
                }),
            ]);
            if (taskCount === 0 && qualifying) {
                const gen = await generateScheduleFromEstimate({
                    estimateId: qualifying.id,
                    mode: "merge",
                    requireEmptyProject: true,
                    actor,
                });
                result.notes.push(`Schedule auto-generated from estimate ${qualifying.code} (${gen.created.length} task${gen.created.length === 1 ? "" : "s"}).`);
            }
        } catch (e: any) {
            result.notes.push(`Schedule auto-generation failed (the date move succeeded): ${e?.message ?? e}`);
        }
    }

    return result;
}

export async function setProjectStartDate(
    input: SetProjectStartDateInput,
): Promise<SetProjectStartDateResult> {
    return runSetProjectStartDate(input);
}

export async function setProjectStartDateInTransaction(
    tx: Prisma.TransactionClient,
    input: SetProjectStartDateInput & { writeActivityLog?: boolean },
): Promise<SetProjectStartDateResult> {
    return runSetProjectStartDate({
        ...input,
        transaction: tx,
        writeActivityLog: input.writeActivityLog,
        skipAutoGenerate: true,
    });
}

export interface ShiftNotStartedTasksInput {
    projectId: string;
    deltaDays: number;
    actor: { type: "TEAM" | "SYSTEM"; name: string };
}

export interface ShiftNotStartedTasksResult {
    projectId: string;
    deltaDays: number;
    shiftedTaskIds: string[];
    shiftedTaskDates: PersistedScheduleTaskDate[];
    shiftedTasks: number;
    notes: string[];
}

/**
 * Shift only exact `Not Started` tasks on an active project. Explicitly dated
 * Pending payment milestones stay fixed and are returned as operator notes;
 * this path never changes the project marker or any payment/money row.
 */
interface InternalShiftNotStartedTasksInput extends ShiftNotStartedTasksInput {
    transaction?: Prisma.TransactionClient;
    writeActivityLog?: boolean;
}

async function runShiftNotStartedTasks(
    input: InternalShiftNotStartedTasksInput,
): Promise<ShiftNotStartedTasksResult> {
    const { projectId, deltaDays, actor } = input;
    if (!Number.isSafeInteger(deltaDays) || deltaDays === 0) {
        throw new Error("deltaDays must be a nonzero whole integer");
    }
    // Hard magnitude cap: a schedule never legitimately moves more than a year
    // in one gesture, and an unbounded delta from a direct action call could
    // push dates outside representable ranges.
    if (Math.abs(deltaDays) > 365) {
        throw new Error("deltaDays cannot exceed 365 days in a single shift");
    }

    const execute = async (tx: Prisma.TransactionClient) => {
        // Keep this lock first: all schedule moves serialize on Project before
        // selecting child tasks, matching setProjectStartDate's lock family.
        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
        const project = await tx.project.findUnique({
            where: { id: projectId },
            select: { id: true, name: true, status: true },
        });
        if (!project) throw new Error("Project not found");
        if (project.status !== "In Progress") {
            throw new Error("Only In Progress projects can shift Not Started tasks");
        }

        const tasks = await tx.$queryRaw<{ id: string; startDate: Date; endDate: Date }[]>`
            SELECT "id", "startDate", "endDate"
            FROM "ScheduleTask"
            WHERE "projectId" = ${projectId}
              AND "status" = 'Not Started'
            ORDER BY "id"
            FOR UPDATE
        `;
        const shiftedTaskIds = tasks.map(task => task.id);
        const shiftedTaskDates: PersistedScheduleTaskDate[] = [];

        for (const task of tasks) {
            const shiftedStartDate = addDays(task.startDate, deltaDays);
            const shiftedEndDate = addDays(task.endDate, deltaDays);
            await tx.$executeRaw`
                UPDATE "ScheduleTask"
                SET "startDate" = ${shiftedStartDate},
                    "endDate" = ${shiftedEndDate},
                    "updatedAt" = NOW()
                WHERE "id" = ${task.id}
            `;
            shiftedTaskDates.push({
                id: task.id,
                startDate: shiftedStartDate.toISOString(),
                endDate: shiftedEndDate.toISOString(),
            });
        }

        const notes: string[] = [];
        if (shiftedTaskIds.length > 0) {
            const estimateMilestones = await tx.estimatePaymentSchedule.findMany({
                where: {
                    scheduleTaskId: { in: shiftedTaskIds },
                    status: "Pending",
                    dueDate: { not: null },
                },
                orderBy: { id: "asc" },
                select: { id: true, name: true },
            });
            const invoiceMilestones = await tx.paymentSchedule.findMany({
                where: {
                    scheduleTaskId: { in: shiftedTaskIds },
                    status: "Pending",
                    dueDate: { not: null },
                },
                orderBy: { id: "asc" },
                select: { id: true, name: true },
            });
            // CO payment rows carry the same task link since PB-pipeline-003 and
            // have no status column — any explicit dueDate is billing's authority.
            const coMilestones = await tx.changeOrderPaymentSchedule.findMany({
                where: {
                    scheduleTaskId: { in: shiftedTaskIds },
                    dueDate: { not: null },
                },
                orderBy: { id: "asc" },
                select: { id: true, name: true },
            });
            for (const milestone of estimateMilestones) {
                notes.push(`Estimate milestone "${milestone.name}" (${milestone.id}) has an explicit due date and was not shifted.`);
            }
            for (const milestone of invoiceMilestones) {
                notes.push(`Invoice milestone "${milestone.name}" (${milestone.id}) has an explicit due date and was not shifted.`);
            }
            for (const milestone of coMilestones) {
                notes.push(`Change-order milestone "${milestone.name}" (${milestone.id}) has an explicit due date and was not shifted.`);
            }
        }

        await recomputeProjectProjectionInTransaction(tx, projectId);

        if (input.writeActivityLog !== false) {
            await tx.activityLog.create({
                data: {
                    projectId,
                    actorType: actor.type,
                    actorName: actor.name,
                    action: "shift_not_started_tasks",
                    entityType: "project",
                    entityId: projectId,
                    entityName: project.name,
                    metadata: JSON.stringify({
                        deltaDays,
                        shiftedTasks: shiftedTaskIds.length,
                        shiftedTaskIds,
                        explicitDueDateMilestones: notes.length,
                    }),
                },
            });
        }

        return {
            projectId,
            deltaDays,
            shiftedTaskIds,
            shiftedTaskDates,
            shiftedTasks: shiftedTaskIds.length,
            notes,
        };
    };
    return input.transaction
        ? execute(input.transaction)
        : withTxRetry(() => prisma.$transaction(execute));
}

export async function shiftNotStartedTasks(
    input: ShiftNotStartedTasksInput,
): Promise<ShiftNotStartedTasksResult> {
    return runShiftNotStartedTasks(input);
}

export async function shiftNotStartedTasksInTransaction(
    tx: Prisma.TransactionClient,
    input: ShiftNotStartedTasksInput & { writeActivityLog?: boolean },
): Promise<ShiftNotStartedTasksResult> {
    return runShiftNotStartedTasks({
        ...input,
        transaction: tx,
        writeActivityLog: input.writeActivityLog,
    });
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

export function deriveEstimateItemHours(item: {
    quantity: number;
    budgetUnit: string | null;
    childCount?: number;
}): number | null {
    if ((item.childCount ?? 0) > 0) return null;
    return isHourLikeBudgetUnit(item.budgetUnit) ? item.quantity : null;
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

// Thrown when an automatic-path precondition fails (zero-task enforcement).
// Hooks treat this class as an expected quiet skip; anything else is a failure.
export class ScheduleGenerationPreconditionError extends Error {}

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
export interface GenerateScheduleInput {
    estimateId: string;
    mode?: "merge" | "regenerate";
    requireEmptyProject?: boolean;
    actor: ScheduleActor;
}

interface InternalGenerateScheduleInput extends GenerateScheduleInput {
    transaction?: Prisma.TransactionClient;
}

async function runGenerateScheduleFromEstimate(
    input: InternalGenerateScheduleInput,
): Promise<GenerateScheduleResult> {
    const mode = input.mode ?? "merge";
    if (mode !== "merge" && mode !== "regenerate") throw new Error(`Unknown generation mode "${mode}"`);

    const execute = async (tx: Prisma.TransactionClient) => {
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

        // Automatic paths (approveEstimate hook, setProjectStartDate hook,
        // dashboard button) pass requireEmptyProject: generation only fires on
        // a zero-task schedule, enforced HERE under the Project lock so a
        // concurrent manual task can't stack a generated schedule on top
        // (P2's merge mode alone only skips already-linked estimate items).
        if (input.requireEmptyProject) {
            const existingTaskCount = await tx.scheduleTask.count({ where: { projectId } });
            if (existingTaskCount > 0) {
                throw new ScheduleGenerationPreconditionError(
                    `Project "${project.name}" already has ${existingTaskCount} schedule task${existingTaskCount === 1 ? "" : "s"} — automatic generation only runs on an empty schedule.`
                );
            }
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
                    estimatedHours: deriveEstimateItemHours(line),
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

        await recomputeProjectProjectionInTransaction(tx, projectId);
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
    };
    return input.transaction
        ? execute(input.transaction)
        : withTxRetry(() => prisma.$transaction(execute));
}

export async function generateScheduleFromEstimate(
    input: GenerateScheduleInput,
): Promise<GenerateScheduleResult> {
    return runGenerateScheduleFromEstimate(input);
}

export async function generateScheduleFromEstimateInTransaction(
    tx: Prisma.TransactionClient,
    input: GenerateScheduleInput,
): Promise<GenerateScheduleResult> {
    return runGenerateScheduleFromEstimate({ ...input, transaction: tx });
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
export interface SetProjectCrewInput {
    projectId: string;
    userIds: string[];
    actor: ScheduleActor;
}

interface InternalSetProjectCrewInput extends SetProjectCrewInput {
    transaction?: Prisma.TransactionClient;
}

async function runSetProjectCrew(
    input: InternalSetProjectCrewInput,
): Promise<{ projectId: string; crew: ProjectCrewMember[] }> {
    const execute = async (tx: Prisma.TransactionClient) => {
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

        const current = project.crew.map(u => u.id);
        const toConnect = wanted.filter(id => !current.includes(id));
        const toDisconnect = current.filter(id => !wanted.includes(id));

        // ACTIVATED is required only for users being ADDED — a project already
        // carrying a legacy inactive/finance crew member (kept or removed) must
        // never throw; only a NEW non-ACTIVATED addition is rejected.
        const notActivated = toConnect.map(id => byId.get(id)!).filter(u => u.status !== "ACTIVATED");
        if (notActivated.length > 0) {
            throw new Error(`Crew members must be ACTIVATED users: ${notActivated.map(u => u.name || u.email).join(", ")}`);
        }
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
    };
    return input.transaction
        ? execute(input.transaction)
        : withTxRetry(() => prisma.$transaction(execute));
}

export async function setProjectCrew(
    input: SetProjectCrewInput,
): Promise<{ projectId: string; crew: ProjectCrewMember[] }> {
    return runSetProjectCrew(input);
}

export async function setProjectCrewInTransaction(
    tx: Prisma.TransactionClient,
    input: SetProjectCrewInput,
): Promise<{ projectId: string; crew: ProjectCrewMember[] }> {
    return runSetProjectCrew({ ...input, transaction: tx });
}

export interface CrewConflictPair {
    projectA: { id: string; name: string };
    projectB: { id: string; name: string };
    overlapStart: string;
    overlapEnd: string;
    // Present for TaskAssignment-window conflicts (v2 precision).
    taskA?: { id: string; name: string; startDate: string; endDate: string };
    taskB?: { id: string; name: string; startDate: string; endDate: string };
}

export interface CrewConflict {
    userId: string;
    name: string;
    pairs: CrewConflictPair[];
}

/**
 * Crew double-bookings within [from, to), v2 (PB-pipeline-003):
 *  1. TaskAssignment windows — a user assigned to tasks on DIFFERENT projects
 *     whose [start, end) windows overlap within the range → pairs with task
 *     names + dates.
 *  2. Per-(userId, projectId) project-window fallback (R1 fix 6): only
 *     user–project pairs with NO task assignments in range use the P2
 *     project-window rule, so task coverage on project A never suppresses
 *     fallback coverage on project B. Windows: startDate → effectiveWorkEnd
 *     (startDate+1d remains only the duration fallback for empty projects).
 * Union of both, deduped per project pair (task-based entries win).
 */
export async function getCrewConflicts(from: Date, to: Date): Promise<CrewConflict[]> {
    const [assignments, projects] = await Promise.all([
        prisma.taskAssignment.findMany({
            where: { task: { projectId: { not: null }, startDate: { lt: to }, endDate: { gt: from } } },
            select: {
                userId: true,
                user: { select: { id: true, name: true, email: true } },
                task: {
                    select: {
                        id: true, name: true, startDate: true, endDate: true, projectId: true,
                        project: { select: { id: true, name: true } },
                    },
                },
            },
        }),
        prisma.project.findMany({
            where: { startDate: { not: null }, crew: { some: {} } },
            select: {
                id: true, name: true, startDate: true, endDate: true,
                crew: { select: { id: true, name: true, email: true } },
                scheduleTasks: { where: { type: { not: "milestone" } }, orderBy: { endDate: "desc" }, take: 1, select: { endDate: true } },
            },
        }),
    ]);

    // Half-open [start, end) overlap, intersected with the visible range.
    const overlaps = (aS: Date, aE: Date, bS: Date, bE: Date): [Date, Date] | null => {
        const s = aS > bS ? aS : bS;
        const e = aE < bE ? aE : bE;
        if (s >= e) return null;
        if (e <= from || s >= to) return null;
        return [s, e];
    };

    const byUser = new Map<string, CrewConflict>();
    const pushPair = (userId: string, name: string, pair: CrewConflictPair, taskBased: boolean) => {
        let entry = byUser.get(userId);
        if (!entry) {
            entry = { userId, name, pairs: [] };
            byUser.set(userId, entry);
        }
        const key = [pair.projectA.id, pair.projectB.id].sort().join("|");
        const existingIdx = entry.pairs.findIndex(p => [p.projectA.id, p.projectB.id].sort().join("|") === key);
        if (existingIdx >= 0) {
            // Task-based precision wins over the fallback for the same pair.
            if (taskBased && !entry.pairs[existingIdx].taskA && !entry.pairs[existingIdx].taskB) entry.pairs[existingIdx] = pair;
        } else {
            entry.pairs.push(pair);
        }
    };

    // (1) TaskAssignment windows.
    type UserWindow = {
        projectId: string;
        projectName: string;
        start: Date;
        end: Date;
        task?: { id: string; name: string; startDate: string; endDate: string };
    };
    const windowsByUser = new Map<string, { name: string; windows: UserWindow[] }>();
    const addWindow = (userId: string, name: string, window: UserWindow) => {
        let entry = windowsByUser.get(userId);
        if (!entry) {
            entry = { name, windows: [] };
            windowsByUser.set(userId, entry);
        }
        entry.windows.push(window);
    };
    const assignedUserProjects = new Set<string>(); // "userId|projectId" with ≥1 assignment in range
    for (const a of assignments) {
        const projectId = a.task.projectId!;
        assignedUserProjects.add(`${a.userId}|${projectId}`);
        addWindow(a.userId, a.user.name || a.user.email, {
            projectId,
            projectName: a.task.project?.name ?? "",
            start: a.task.startDate,
            end: a.task.endDate,
            task: {
                id: a.task.id,
                name: a.task.name,
                startDate: a.task.startDate.toISOString(),
                endDate: a.task.endDate.toISOString(),
            },
        });
    }

    // (2) Project-window fallback per (userId, projectId).
    const fallbackWindows = projects.map(p => {
        const start = utcDay(p.startDate!);
        const rawEnd = effectiveWorkEnd(p, p.scheduleTasks[0]?.endDate ?? null);
        return {
            id: p.id,
            name: p.name,
            start,
            end: rawEnd > start ? rawEnd : addDays(start, 1),
            crew: p.crew,
        };
    });
    for (const w of fallbackWindows) {
        for (const u of w.crew) {
            if (assignedUserProjects.has(`${u.id}|${w.id}`)) continue; // task windows cover this pair
            addWindow(u.id, u.name || u.email, {
                projectId: w.id,
                projectName: w.name,
                start: w.start,
                end: w.end,
            });
        }
    }
    // Compare the complete per-user union so task A is tested against fallback B.
    for (const [userId, { name, windows: userWindows }] of windowsByUser) {
        for (let i = 0; i < userWindows.length; i++) {
            for (let j = i + 1; j < userWindows.length; j++) {
                const a = userWindows[i];
                const b = userWindows[j];
                if (a.projectId === b.projectId) continue;
                const o = overlaps(a.start, a.end, b.start, b.end);
                if (!o) continue;
                pushPair(userId, name, {
                    projectA: { id: a.projectId, name: a.projectName },
                    projectB: { id: b.projectId, name: b.projectName },
                    overlapStart: o[0].toISOString(),
                    overlapEnd: o[1].toISOString(),
                    taskA: a.task,
                    taskB: b.task,
                }, !!a.task || !!b.task);
            }
        }
    }

    return [...byUser.values()];
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
    scheduleTaskId: string | null;
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

export interface OverlayChangeOrderItem {
    paymentScheduleId: string;
    changeOrderId: string;
    code: string;
    title: string;
    name: string;
    amount: number;
    // Per-row effectiveDueDate (dueDate ?? linkedTask.startDate), or — for a
    // zero-payment-row CO — the synthesized milestone task's date.
    effectiveDueDate: string;
    projectId: string | null;
    projectName: string | null;
    // Always true here: billed COs are EXCLUDED (their invoice clones flow
    // through the existing PaymentSchedule income queries — no double counting).
    projected: true;
}

export interface CalendarOverlays {
    income: OverlayIncomeItem[];
    expenses: OverlayExpenseItem[];
    hours: OverlayHoursItem[];
    changeOrders: OverlayChangeOrderItem[];
}

/**
 * Approved-but-unbilled change-order money as projected income (PB-pipeline-003):
 * each ChangeOrderPaymentSchedule row at its effectiveDueDate, or — for a CO
 * with ZERO payment rows — the CO's signedAmount (totalAmount + tax via
 * co-tax.ts) at the synthesized milestone task's date. Billed COs (detected by
 * the billing-core name-prefix convention) are excluded so the same money
 * never appears twice.
 */
export async function getChangeOrderOverlayRows(from: Date, to: Date): Promise<OverlayChangeOrderItem[]> {
    const cos = await prisma.changeOrder.findMany({
        where: { status: "Approved" },
        select: {
            id: true, code: true, title: true, totalAmount: true, projectId: true,
            estimate: { select: { taxExempt: true, taxRatePercent: true, taxRateName: true } },
            project: { select: { id: true, name: true } },
            paymentSchedules: {
                orderBy: [{ order: "asc" }, { id: "asc" }],
                select: { id: true, name: true, amount: true, dueDate: true, scheduleTaskId: true },
            },
            generatedScheduleTasks: { where: { type: "milestone" }, orderBy: [{ order: "asc" }, { id: "asc" }], select: { id: true, startDate: true } },
        },
    });
    if (cos.length === 0) return [];

    // Billed detection: a milestone named `${code} — …` on the CO's project
    // (billing-core convention), same as billChangeOrderCore's idempotency check.
    const projectIds = [...new Set(cos.map(c => c.projectId))];
    const billedMilestones = await prisma.paymentSchedule.findMany({
        where: { invoice: { projectId: { in: projectIds } }, name: { startsWith: "CO-" }, status: { not: "Canceled" } },
        select: { name: true, invoice: { select: { projectId: true } } },
    });
    // Billing idempotency is scoped to the project; CO codes are not globally unique.
    const isBilled = (projectId: string, code: string) => billedMilestones.some(
        m => m.invoice.projectId === projectId && m.name.startsWith(`${code} `),
    );
    const rows: OverlayChangeOrderItem[] = [];
    for (const co of cos) {
        if (isBilled(co.projectId, co.code)) continue;
        const taskStartById = new Map(co.generatedScheduleTasks.map(t => [t.id, t.startDate]));
        if (co.paymentSchedules.length > 0) {
            for (const row of co.paymentSchedules) {
                const effective = row.dueDate ?? (row.scheduleTaskId ? taskStartById.get(row.scheduleTaskId) : undefined) ?? null;
                if (!effective || effective < from || effective >= to) continue;
                rows.push({
                    paymentScheduleId: row.id,
                    changeOrderId: co.id,
                    code: co.code,
                    title: co.title,
                    name: row.name,
                    amount: Number(row.amount),
                    effectiveDueDate: effective.toISOString(),
                    projectId: co.project?.id ?? null,
                    projectName: co.project?.name ?? null,
                    projected: true,
                });
            }
        } else {
            const signedAmount = coSignedAmount(Number(co.totalAmount), co.estimate);
            const synthDate = co.generatedScheduleTasks[0]?.startDate ?? null;
            if (!synthDate || synthDate < from || synthDate >= to) continue;
            rows.push({
                paymentScheduleId: `synthetic:${co.id}`,
                changeOrderId: co.id,
                code: co.code,
                title: co.title,
                name: `${co.code} payment`,
                amount: signedAmount,
                effectiveDueDate: synthDate.toISOString(),
                projectId: co.project?.id ?? null,
                projectName: co.project?.name ?? null,
                projected: true,
            });
        }
    }
    return rows;
}

/**
 * ADMIN-path calendar overlays: income (Pending milestones by the shared
 * effectiveDueDate rule), expenses (Expense.date in range, project via
 * estimate), hours (TimeEntry.startTime date in range). Read-only.
 */
export async function getCalendarOverlays(
    from: Date,
    to: Date,
    suppliedChangeOrders?: OverlayChangeOrderItem[],
): Promise<CalendarOverlays> {
    const [milestones, expenses, hours, changeOrders] = await Promise.all([
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
        suppliedChangeOrders ?? getChangeOrderOverlayRows(from, to),
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
                scheduleTaskId: m.scheduleTaskId,
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
        changeOrders,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard page assembly (PB-pipeline-002, R1 fix 10 — directly testable)
// ─────────────────────────────────────────────────────────────────────────────

export interface UnappliedChangeOrderSummary {
    count: number;
    items: { id: string; code: string }[];
}

export async function getUnappliedChangeOrders(
    projectIds: string[],
): Promise<Record<string, UnappliedChangeOrderSummary>> {
    if (projectIds.length === 0) return {};
    const rows = await prisma.changeOrder.findMany({
        where: {
            projectId: { in: projectIds },
            status: "Approved",
            generatedScheduleTasks: { none: {} },
        },
        orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
        select: { id: true, code: true, projectId: true },
    });
    const result: Record<string, UnappliedChangeOrderSummary> = {};
    for (const row of rows) {
        const summary = result[row.projectId] ?? { count: 0, items: [] };
        summary.count++;
        summary.items.push({ id: row.id, code: row.code });
        result[row.projectId] = summary;
    }
    return result;
}

export interface DashboardTaskAssignment {
    id: string;
    userId: string;
    name: string;
    status: string;
    userRole: string;
    assignmentRole: string;
}

export interface DashboardTaskComment {
    text: string;
    authorName: string;
    createdAt: string;
}

export interface DashboardTaskRow {
    id: string;
    name: string;
    updatedAt: string;
    startDate: string;
    endDate: string;
    color: string | null;
    parentId: string | null;
    progress: number;
    status: string;
    type: string;
    doneWhen: string | null;
    blockedReason: string | null;
    clientStage: string | null;
    scheduledTime: string | null;
    confirmationStatus: string | null;
    pendingMaterials: number;
    stagedMaterials: number;
    missingMaterials: number;
    assignments: DashboardTaskAssignment[];
    // Hover-card notes (owner-feedback round, item 3): most recent 2 task
    // comments, newest first — same TaskComment source the project schedule
    // page already shows, no new writes/schema.
    latestComments: DashboardTaskComment[];
    // Evidence freshness (see lib/task-evidence.ts). Direct = someone worked
    // this task (bound punch, completed punch item). Indirect = office activity
    // near it (comment, material move, project-level daily log). Kept apart so
    // one project daily log can't mark every overlapping task confirmed.
    lastDirectEvidenceAt: string | null;
    lastIndirectEvidenceAt: string | null;
}

export interface DashboardProjectRow extends PipelineProject {
    taskCount: number;
    hasQualifyingEstimate: boolean;
    // Approved COs with no provenance tasks yet (the "Apply CO" affordance).
    unappliedChangeOrders: { count: number; items: { id: string; code: string }[] };
    // Expandable task list with per-task crew (assignments carry user status so
    // the picker can render inactive-removable entries).
    tasks: DashboardTaskRow[];
    // Recent punches the binding resolver left unattached — evidence collected
    // but unusable. Surfaced so ambiguity can't quietly erode the coverage read.
    unboundPunches: number;
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
    // Approved-unbilled CO money projected in range (billed COs flow through
    // incomeDue via their PaymentSchedule clones — no double counting).
    coProjected: number;
}

export interface CompanyDashboardData {
    month: string;
    role: string;
    canEdit: boolean;
    isAdmin: boolean;
    // Pipeline money (contractValue, targetRevenue, latestEstimateTotal) is
    // serialized only for holders of financialReports; schedules-only viewers
    // (FIELD_CREW/EMPLOYEE read-only board) get nulls — redaction happens at
    // serialization, matching the overlays/cashflow/strip rule.
    canSeeFinancials: boolean;
    pipeline: {
        estimating: CompanyPipeline["estimating"];
        waitingToStart: DashboardProjectRow[];
        scheduled: DashboardProjectRow[];
        inProgress: DashboardProjectRow[];
        substantialCompletion: DashboardProjectRow[];
    };
    calendar: StartCalendar;
    cashflow: CashflowOutlook | null;
    // burdenedHourlyRate is MONEY (hourlyRate + burdenRate) — present only
    // when canSeeFinancials is true; absent (never null) otherwise, same
    // redaction convention as contractValue/targetRevenue below.
    teamMembers: { id: string; name: string; email: string; role: string; burdenedHourlyRate?: number }[] | null;
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
 *   CO (projected) = Approved-unbilled CO money in range (billed flows via incomeDue)
 */
async function getProjectMonthStrip(from: Date, to: Date, coRows: OverlayChangeOrderItem[]): Promise<ProjectMonthStripRow[]> {
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
                coProjected: 0,
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
    for (const c of coRows) {
        if (!c.projectId || !nameOf.has(c.projectId)) continue;
        row(c.projectId).coProjected += c.amount;
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
            coProjected: round2(r.coProjected),
        }))
        .filter(r => r.incomeDue !== 0 || r.received !== 0 || r.expenses !== 0 || r.laborBurdened !== 0 || r.hoursActual !== 0 || r.hoursEstimated !== 0 || r.coProjected !== 0)
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
    userLike: { role: string; canSeeFinancials?: boolean },
    month: string,
): Promise<CompanyDashboardData> {
    const role = userLike.role;
    const isAdmin = role === "ADMIN";
    const canEdit = role === "ADMIN" || role === "MANAGER";
    // Explicit flag wins (the page computes hasPermission(user, "financialReports")
    // so per-user overrides are honored); the role fallback mirrors the default
    // permission matrix for callers that don't pass it.
    const canSeeFinancials = userLike.canSeeFinancials ?? !["FIELD_CREW", "EMPLOYEE"].includes(role);

    // Same 42-day grid as the calendar; `to` exclusive (getStartCalendar rule).
    const grid = getMonthGrid(parseUTCDate(`${month}-01`));
    const from = grid[0];
    const to = new Date(grid[grid.length - 1].getTime() + 86_400_000);

    const coRowsPromise = isAdmin
        ? getChangeOrderOverlayRows(from, to)
        : Promise.resolve([] as OverlayChangeOrderItem[]);
    const [pipeline, calendar, cashflow, crewConflicts, overlays, strip] = await Promise.all([
        getCompanyPipeline(),
        // The income layer comes from overlays (effectiveDueDate) for ADMIN, so
        // the calendar fetch stays financial-free here.
        getStartCalendar(from, to, { includeFinancials: false }),
        isAdmin ? getCashflowOutlook() : Promise.resolve(null),
        // Conflicts feed BOTH the month-scoped conflicts card AND the
        // availability grid (always today..today+14, regardless of the viewed
        // month). Two separate window fetches — NOT a min/max hull, which
        // would (a) pull every intervening conflict when viewing a distant
        // month and (b) let getCrewConflicts' one-interval-per-pair rule
        // displace the availability-date interval with a month-gap one.
        // Results merge with per-interval dedupe; views filter to their own
        // window (badges by grid range, availability by day-in-pair-range).
        canEdit ? (async () => {
            const now = new Date();
            const localToday = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
            const availabilityFrom = addDays(localToday, -1);
            const availabilityTo = addDays(localToday, 15);
            const [monthConflicts, availabilityConflicts] = await Promise.all([
                getCrewConflicts(from, to),
                availabilityFrom >= from && availabilityTo <= to
                    ? Promise.resolve([] as CrewConflict[]) // fully inside the grid — one fetch suffices
                    : getCrewConflicts(availabilityFrom, availabilityTo),
            ]);
            const byUser = new Map<string, CrewConflict>();
            for (const conflict of [...monthConflicts, ...availabilityConflicts]) {
                const existing = byUser.get(conflict.userId);
                if (!existing) {
                    byUser.set(conflict.userId, { ...conflict, pairs: [...conflict.pairs] });
                    continue;
                }
                const seen = new Set(existing.pairs.map(pair =>
                    [pair.projectA.id, pair.projectB.id, pair.overlapStart, pair.overlapEnd, pair.taskA?.id ?? "", pair.taskB?.id ?? ""].join("|"),
                ));
                for (const pair of conflict.pairs) {
                    const key = [pair.projectA.id, pair.projectB.id, pair.overlapStart, pair.overlapEnd, pair.taskA?.id ?? "", pair.taskB?.id ?? ""].join("|");
                    if (!seen.has(key)) existing.pairs.push(pair);
                }
            }
            return [...byUser.values()];
        })() : Promise.resolve(null),
        isAdmin ? coRowsPromise.then(rows => getCalendarOverlays(from, to, rows)) : Promise.resolve(null),
        isAdmin ? coRowsPromise.then(rows => getProjectMonthStrip(from, to, rows)) : Promise.resolve(null),
    ]);

    // Button data for "Generate schedule": Waiting/Scheduled rows show it only
    // when the project has a qualifying estimate AND zero schedule tasks.
    const rowIds = [
        ...pipeline.waitingToStart.map(p => p.id),
        ...pipeline.scheduled.map(p => p.id),
        ...pipeline.inProgress.map(p => p.id),
        ...pipeline.substantialCompletion.map(p => p.id),
    ];
    const [taskRows, qualifying, unappliedByProject, materialCounts, punchEvidence, punchItemEvidence, dailyLogEvidence, unboundPunches] = await Promise.all([
        prisma.scheduleTask.findMany({
            where: { projectId: { in: rowIds } },
            orderBy: [{ order: "asc" }, { startDate: "asc" }, { id: "asc" }],
            select: {
                id: true, projectId: true, name: true, startDate: true, endDate: true, updatedAt: true, color: true, parentId: true, progress: true, status: true, type: true,
                doneWhen: true, blockedReason: true, clientStage: true, scheduledTime: true, confirmationStatus: true,
                assignments: {
                    orderBy: { createdAt: "asc" },
                    select: { id: true, userId: true, role: true, user: { select: { name: true, email: true, status: true, role: true } } },
                },
                // Hover-card notes (item 3): capped at 2, newest first — same
                // audience as the project schedule page's own comment thread
                // (not money, no extra gate).
                comments: {
                    orderBy: { createdAt: "desc" },
                    take: 2,
                    select: { text: true, createdAt: true, subcontractorName: true, user: { select: { name: true, email: true } } },
                },
            },
        }),
        prisma.estimate.groupBy({ by: ["projectId"], where: { projectId: { in: rowIds }, status: { in: CONTRACT_ESTIMATE_STATUSES } }, _count: { id: true } }),
        getUnappliedChangeOrders(rowIds),
        // All statuses, not just the three counted ones: `resolved` is the final
        // transition, so filtering it out here would hide the most recent
        // statusChangedAt. Resolved rows are dropped from the COUNTS below.
        prisma.taskMaterial.groupBy({
            by: ["taskId", "status"],
            where: { task: { projectId: { in: rowIds } } },
            _count: { id: true },
            _max: { statusChangedAt: true },
        }),
        // ── Evidence aggregates (3 queries, batched — never per chip) ──
        prisma.timeEntry.groupBy({
            by: ["scheduleTaskId"],
            where: { projectId: { in: rowIds }, scheduleTaskId: { not: null } },
            _max: { startTime: true },
        }),
        prisma.taskPunchItem.groupBy({
            by: ["taskId"],
            where: { task: { projectId: { in: rowIds } }, completed: true },
            _max: { completedAt: true },
        }),
        prisma.dailyLog.groupBy({
            by: ["projectId"],
            where: { projectId: { in: rowIds } },
            _max: { date: true },
        }),
        // Punches the resolver couldn't tie to a task. Windowed to the recent
        // past so pre-feature history doesn't pin this at a permanent large
        // number — it's meant to show evidence we're losing NOW.
        prisma.timeEntry.groupBy({
            by: ["projectId"],
            where: {
                projectId: { in: rowIds },
                scheduleTaskId: null,
                startTime: { gte: new Date(Date.now() - 14 * 86_400_000) },
            },
            _count: { id: true },
        }),
    ]);
    const materialCountsByTask = new Map<string, { pending: number; staged: number; missing: number }>();
    const materialStatusAtByTask = new Map<string, Date>();
    for (const count of materialCounts) {
        const current = materialCountsByTask.get(count.taskId) ?? { pending: 0, staged: 0, missing: 0 };
        if (count.status === "pending" || count.status === "staged" || count.status === "missing") {
            current[count.status] = count._count.id;
        }
        materialCountsByTask.set(count.taskId, current);
        const changedAt = count._max.statusChangedAt;
        const seen = materialStatusAtByTask.get(count.taskId);
        if (changedAt && (!seen || changedAt > seen)) materialStatusAtByTask.set(count.taskId, changedAt);
    }
    const punchAtByTask = new Map<string, Date>();
    for (const row of punchEvidence) {
        if (row.scheduleTaskId && row._max.startTime) punchAtByTask.set(row.scheduleTaskId, row._max.startTime);
    }
    const punchItemAtByTask = new Map<string, Date>();
    for (const row of punchItemEvidence) {
        if (row._max.completedAt) punchItemAtByTask.set(row.taskId, row._max.completedAt);
    }
    const dailyLogAtByProject = new Map<string, Date>();
    for (const row of dailyLogEvidence) {
        if (row._max.date) dailyLogAtByProject.set(row.projectId, row._max.date);
    }
    const tasksByProject = new Map<string, DashboardTaskRow[]>();
    for (const task of taskRows) {
        if (!task.projectId) continue;
        const rows = tasksByProject.get(task.projectId) ?? [];
        const taskMaterialCounts = materialCountsByTask.get(task.id) ?? { pending: 0, staged: 0, missing: 0 };
        rows.push({
            id: task.id,
            name: task.name,
            updatedAt: task.updatedAt.toISOString(),
            startDate: task.startDate.toISOString(),
            endDate: task.endDate.toISOString(),
            color: task.color,
            parentId: task.parentId,
            progress: task.progress,
            status: task.status,
            type: task.type,
            doneWhen: task.doneWhen,
            blockedReason: task.blockedReason,
            clientStage: task.clientStage,
            scheduledTime: task.scheduledTime,
            confirmationStatus: task.confirmationStatus,
            pendingMaterials: taskMaterialCounts.pending,
            stagedMaterials: taskMaterialCounts.staged,
            missingMaterials: taskMaterialCounts.missing,
            assignments: task.assignments.map(a => ({
                id: a.id,
                userId: a.userId,
                name: a.user.name || a.user.email,
                status: a.user.status,
                userRole: a.user.role,
                assignmentRole: a.role,
            })),
            latestComments: task.comments.map(c => ({
                text: c.text,
                authorName: c.user?.name ?? c.user?.email ?? c.subcontractorName ?? "Unknown",
                createdAt: c.createdAt.toISOString(),
            })),
            // Comments are already loaded newest-first (take: 2), so the head IS
            // the max createdAt — no fourth aggregate needed for it.
            ...foldTaskEvidence({
                lastTimeEntryAt: punchAtByTask.get(task.id),
                lastPunchItemCompletedAt: punchItemAtByTask.get(task.id),
                lastCommentAt: task.comments[0]?.createdAt,
                lastMaterialStatusAt: materialStatusAtByTask.get(task.id),
                lastProjectDailyLogAt: dailyLogAtByProject.get(task.projectId),
            }),
        });
        tasksByProject.set(task.projectId, rows);
    }
    const unboundPunchesByProject = new Map<string, number>();
    for (const row of unboundPunches) unboundPunchesByProject.set(row.projectId, row._count.id);
    const hasQualifying = new Set(qualifying.map(q => q.projectId));
    const enrich = (p: PipelineProject): DashboardProjectRow => ({
        ...p,
        taskCount: tasksByProject.get(p.id)?.length ?? 0,
        hasQualifyingEstimate: hasQualifying.has(p.id),
        tasks: tasksByProject.get(p.id) ?? [],
        unappliedChangeOrders: unappliedByProject[p.id] ?? { count: 0, items: [] },
        unboundPunches: unboundPunchesByProject.get(p.id) ?? 0,
    });

    // Picker list is pre-filtered to ACTIVATED, non-FINANCE (getTeamMembers
    // stays unchanged for other callers) and only sent to roles that can edit
    // — bookkeeper accounts must never be offered as job crew. Display names
    // that collide (e.g. two "Justin Adkins" accounts) get their email
    // appended so the picker stays unambiguous.
    const teamMembersRaw = canEdit
        ? await prisma.user.findMany({
            // Owner call 2026-07-23: only people DESIGNATED as crew are
            // schedulable — no admins/office in the pickers or availability.
            // Already-assigned non-crew still render as removable entries.
            where: { status: "ACTIVATED", role: "FIELD_CREW" },
            orderBy: { name: "asc" },
            select: { id: true, name: true, email: true, role: true, hourlyRate: true, burdenRate: true },
        })
        : [];
    const teamMembers = canEdit
        ? (() => {
            const rows = teamMembersRaw.map(u => ({
                id: u.id,
                name: u.name || u.email,
                email: u.email,
                role: u.role,
                // MONEY — only serialized for financialReports holders (the
                // availability panel's planned-$ row needs it; the picker UI
                // ignores the extra field).
                ...(canSeeFinancials ? { burdenedHourlyRate: round2(Number(u.hourlyRate) + Number(u.burdenRate)) } : {}),
            }));
            // Names stay bare — no email disambiguation (owner call 2026-07-23:
            // full addresses wrapped across six lines in the crew checklist and
            // a 9-person crew knows who's who; duplicate-name accounts simply
            // render twice, and the email remains in the serialized field for
            // any UI that ever needs a tooltip).
            return rows;
        })()
        : null;

    // Money redaction for schedules-only viewers: null out pipeline dollar
    // fields at serialization (the UI renders "—" for null). Task/crew/date
    // data stays intact — that's what the read-only board needs.
    const redactProject = (p: DashboardProjectRow): DashboardProjectRow =>
        canSeeFinancials ? p : { ...p, contractValue: null };
    const redactLead = (l: CompanyPipeline["estimating"][number]): CompanyPipeline["estimating"][number] =>
        canSeeFinancials ? l : { ...l, targetRevenue: null, latestEstimateTotal: null };

    return {
        month,
        role,
        canEdit,
        isAdmin,
        canSeeFinancials,
        pipeline: {
            estimating: pipeline.estimating.map(redactLead),
            waitingToStart: pipeline.waitingToStart.map(enrich).map(redactProject),
            scheduled: pipeline.scheduled.map(enrich).map(redactProject),
            inProgress: pipeline.inProgress.map(enrich).map(redactProject),
            substantialCompletion: pipeline.substantialCompletion.map(enrich).map(redactProject),
        },
        calendar,
        cashflow,
        teamMembers,
        crewConflicts,
        overlays,
        strip,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Workstream A hook — auto-generate on estimate signature (PB-pipeline-003)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort post-approval schedule generation. Fires only when the estimate
 * belongs to a project WITH a start date (the setProjectStartDate hook covers
 * the "sign first, date later" loop); the generator's requireEmptyProject
 * enforcement decides inside its own locked tx. NEVER throws: the zero-task
 * precondition is an expected quiet skip, and any real failure is logged
 * (console + ActivityLog where possible) — approval can never roll back.
 */
export async function autoGenerateScheduleForApprovedEstimate(
    estimateId: string,
): Promise<{ generated: boolean; note: string | null }> {
    let estimate: { id: string; code: string; projectId: string | null; project: { startDate: Date | null } | null } | null = null;
    try {
        estimate = await prisma.estimate.findUnique({
            where: { id: estimateId },
            select: { id: true, code: true, projectId: true, project: { select: { startDate: true } } },
        });
        if (!estimate?.projectId || !estimate.project?.startDate) return { generated: false, note: null };
        const result = await generateScheduleFromEstimate({
            estimateId,
            mode: "merge",
            requireEmptyProject: true,
            actor: { type: "SYSTEM", name: "system" },
        });
        return { generated: result.created.length > 0, note: null };
    } catch (e: any) {
        if (e instanceof ScheduleGenerationPreconditionError) {
            // Manual tasks already exist — the auto path simply doesn't fire.
            return { generated: false, note: null };
        }
        console.error("[autoGenerateScheduleForApprovedEstimate] generation failed (approval unaffected):", e?.message ?? e);
        try {
            if (!estimate?.projectId) return { generated: false, note: String(e?.message ?? e) };
            await prisma.activityLog.create({
                data: {
                    projectId: estimate.projectId,
                    actorType: "SYSTEM",
                    actorName: "system",
                    action: "schedule_autogen_failed",
                    entityType: "project",
                    entityId: estimate.projectId,
                    metadata: JSON.stringify({ estimateId, estimateCode: estimate.code, error: String(e?.message ?? e).slice(0, 500) }),
                },
            });
        } catch { /* best-effort */ }
        return { generated: false, note: String(e?.message ?? e) };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Workstream B — Change orders adjust the schedule + cash (PB-pipeline-003)
// ─────────────────────────────────────────────────────────────────────────────

// Thrown when a CO-application precondition fails (not Approved / no startDate).
// The billing auto-hook skips this class quietly; anything else is an issue.
export class CoSchedulePreconditionError extends Error {}

/**
 * One shared definition (R1 fix 3): the end of actual WORK on the project —
 * max(Project.endDate, max(endDate of NON-milestone tasks)) ?? startDate.
 * Payment milestone tasks never extend the work window, and an empty project
 * falls back to startDate. Used by BOTH CO placement and the project-window
 * conflict rule.
 */
function effectiveWorkEnd(
    project: { startDate: Date | null; endDate: Date | null },
    latestWorkEnd: Date | null,
): Date {
    const candidates = [project.endDate, latestWorkEnd].filter((d): d is Date => !!d);
    if (candidates.length === 0) return utcDay(project.startDate!);
    return utcDay(new Date(Math.max(...candidates.map(d => d.getTime()))));
}

async function computeEffectiveWorkEnd(
    tx: Prisma.TransactionClient,
    project: { id: string; startDate: Date | null; endDate: Date | null },
): Promise<Date> {
    const latestWork = await tx.scheduleTask.aggregate({
        where: { projectId: project.id, type: { not: "milestone" } },
        _max: { endDate: true },
    });
    return effectiveWorkEnd(project, latestWork._max.endDate);
}

export interface ApplyChangeOrderResult {
    changeOrderCode: string;
    projectId: string;
    created: GeneratedTaskRow[];
    skipped: number;
    milestonesLinked: number;
    notes: string[];
}

/**
 * Apply an Approved change order to the project schedule: one parent task
 * `CO-##### · title` + flat children from its items (deductions create NO task
 * — noted for manual trimming), placed as a contiguous block starting exactly
 * at effectiveWorkEnd (end-exclusive bounds, so no empty day). The CO window
 * is labor-calibrated from the CO's POSITIVE labor lines vs the original
 * estimate's burn rate (fallback: 1 day per non-negative item, packed).
 * Milestone tasks per ChangeOrderPaymentSchedule row (canonical dueDate ??
 * cumulative amount-share of the CO window by (order, id)); a CO with ZERO
 * payment rows gets one synthesized `CO-##### payment` milestone at the block
 * end projecting signedAmount (totalAmount + tax via co-tax.ts).
 *
 * Money-path: sets scheduleTaskId on CO payment rows AND billed clones
 * (name-prefix match) regardless of QB state; NO amount/status/QB/dueDate
 * writes anywhere. mode "merge" (default) skips task creation when provenance
 * tasks exist (linking still converges); "regenerate" rebuilds only
 * provenance-tagged subtrees passing the P2 full eligibility predicate.
 */
export interface ApplyChangeOrderScheduleInput {
    changeOrderId: string;
    mode?: "merge" | "regenerate";
    actor: ScheduleActor;
}

interface InternalApplyChangeOrderScheduleInput extends ApplyChangeOrderScheduleInput {
    transaction?: Prisma.TransactionClient;
}

async function runApplyChangeOrderToSchedule(
    input: InternalApplyChangeOrderScheduleInput,
): Promise<ApplyChangeOrderResult> {
    const mode = input.mode ?? "merge";
    if (mode !== "merge" && mode !== "regenerate") throw new Error(`Unknown mode "${mode}"`);

    const execute = async (tx: Prisma.TransactionClient) => {
        // Lock-then-read (same discipline as generation and start-date moves).
        const coRef = await tx.changeOrder.findUnique({
            where: { id: input.changeOrderId },
            select: { id: true, projectId: true },
        });
        if (!coRef) throw new CoSchedulePreconditionError("Change order not found");
        const projectId = coRef.projectId;

        await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
        const project = await tx.project.findUnique({
            where: { id: projectId },
            select: { id: true, name: true, startDate: true, endDate: true },
        });
        if (!project) throw new CoSchedulePreconditionError("Project not found");
        // Parent-before-child lock order: Project first, then the CO snapshot.
        await tx.$queryRaw`SELECT id FROM "ChangeOrder" WHERE id = ${input.changeOrderId} FOR UPDATE`;
        if (!project.startDate) {
            throw new CoSchedulePreconditionError(`Project "${project.name}" has no start date yet — set one on the company dashboard before applying change orders to its schedule.`);
        }

        // Full CO read INSIDE the lock (items, payment rows, estimate tax + labor).
        const co = await tx.changeOrder.findUniqueOrThrow({
            where: { id: input.changeOrderId },
            include: {
                items: { orderBy: { order: "asc" }, include: { costType: { select: { name: true } } } },
                paymentSchedules: { orderBy: [{ order: "asc" }, { id: "asc" }] },
                estimate: {
                    select: {
                        id: true, taxExempt: true, taxRatePercent: true, taxRateName: true,
                        items: { include: { costType: { select: { name: true } } } },
                    },
                },
            },
        });
        if (co.status !== "Approved") {
            throw new CoSchedulePreconditionError(`Change order ${co.code} is "${co.status}" — only Approved change orders adjust the schedule.`);
        }

        const notes: string[] = [];
        const createdRows: GeneratedTaskRow[] = [];
        let skipped = 0;
        let milestonesLinked = 0;

        // ── regenerate: delete eligible CO-provenance subtrees first ──
        if (mode === "regenerate") {
            // Freeze the task decision set before inspecting child counts. FK
            // inserts cannot slip between the eligibility snapshot and delete.
            await tx.$queryRaw`
                SELECT id FROM "ScheduleTask"
                WHERE "projectId" = ${projectId}
                ORDER BY id
                FOR UPDATE
            `;
            const allTasks = await tx.scheduleTask.findMany({
                where: { projectId },
                select: {
                    id: true, parentId: true, generatedFromChangeOrderId: true, progress: true, status: true,
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
            const generatedIds = new Set(allTasks.filter(t => t.generatedFromChangeOrderId === co.id).map(t => t.id));
            const isDeletable = (t: (typeof allTasks)[number]) =>
                t.generatedFromChangeOrderId === co.id &&
                t.progress === 0 &&
                t.status === "Not Started" &&
                t._count.timeEntries === 0 &&
                t._count.comments === 0 &&
                t._count.punchItems === 0 &&
                t._count.assignments === 0 &&
                t._count.subAssignments === 0 &&
                t._count.dependencies === 0 &&
                t._count.dependents === 0;
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
                notes.push(`Kept ${keptSubtrees} generated CO subtree${keptSubtrees === 1 ? "" : "s"} untouched — work was logged or edits made.`);
            }
        }

        const start = utcDay(project.startDate);
        const workEnd = await computeEffectiveWorkEnd(tx, project);
        const coWindowStart = workEnd;

        // Milestone task lookup used for linking — by CO payment row id, plus
        // the ordered list of CO milestone tasks (for billed-clone linking).
        const milestoneTaskIdByRowId = new Map<string, string>();
        const milestoneTaskIds: string[] = [];
        let coWindowDays = 0;

        const maxOrder = await tx.scheduleTask.aggregate({ where: { projectId }, _max: { order: true } });
        let nextOrder = (maxOrder._max.order ?? -1) + 1;
        const createTask = async (data: {
            name: string; startDate: Date; endDate: Date; color: string; order: number;
            type: string; parentId: string | null;
        }) => {
            const row = await tx.scheduleTask.create({
                data: {
                    projectId,
                    status: "Not Started",
                    progress: 0,
                    generatedFromChangeOrderId: co.id,
                    estimatedHours: null,
                    estimateItemId: null,
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

        const items = co.items.map(i => ({
            id: i.id, name: i.name, type: i.type, total: Number(i.total), costTypeName: i.costType?.name ?? null,
        }));
        const taskItems = items.filter(i => i.total >= 0);
        const estimateWindowEnd = project.endDate ? utcDay(project.endDate) : addDays(start, 42);
        const estimateWindowDays = Math.max(1, Math.round((estimateWindowEnd.getTime() - start.getTime()) / 86_400_000));
        const estimateLaborDollars = co.estimate.items.reduce((sum, item) => {
            const labor = (item.costType?.name ?? item.type ?? "").toLowerCase() === "labor";
            const total = Number(item.total);
            return sum + (labor && total > 0 ? total : 0);
        }, 0);
        const coLaborDollars = items.reduce((sum, item) => {
            const labor = (item.costTypeName ?? item.type ?? "").toLowerCase() === "labor";
            return sum + (labor && item.total > 0 ? item.total : 0);
        }, 0);
        const burnRate = estimateLaborDollars > 0 ? estimateLaborDollars / estimateWindowDays : 0;
        const laborDays = burnRate > 0 && coLaborDollars > 0 ? Math.max(1, Math.round(coLaborDollars / burnRate)) : 0;
        const calculatedWindowDays = Math.max(1, laborDays || taskItems.length);

        const provenanceCount = await tx.scheduleTask.count({ where: { generatedFromChangeOrderId: co.id } });

        if (provenanceCount > 0) {
            skipped++;
            notes.push(`${co.code} is already on the schedule — existing protected/provenance tasks were preserved.`);
            let existingParent = await tx.scheduleTask.findFirst({
                where: { generatedFromChangeOrderId: co.id, type: { not: "milestone" }, parentId: null },
                orderBy: [{ order: "asc" }, { id: "asc" }],
                select: { id: true, startDate: true, endDate: true },
            });
            if (!existingParent && mode === "regenerate") {
                coWindowDays = calculatedWindowDays;
                existingParent = await createTask({
                    name: `${co.code} · ${co.title}`,
                    startDate: coWindowStart,
                    endDate: addDays(coWindowStart, coWindowDays),
                    color: "#8b5cf6",
                    order: nextOrder++,
                    type: "task",
                    parentId: null,
                });
                const n = taskItems.length;
                for (let k = 0; k < n; k++) {
                    const childStart = addDays(coWindowStart, Math.floor((k * coWindowDays) / n));
                    const proportionalEnd = addDays(coWindowStart, Math.floor(((k + 1) * coWindowDays) / n));
                    await createTask({
                        name: taskItems[k].name,
                        startDate: childStart,
                        endDate: proportionalEnd > childStart ? proportionalEnd : addDays(childStart, 1),
                        color: "#8b5cf6",
                        order: nextOrder++,
                        type: "task",
                        parentId: existingParent.id,
                    });
                }
                for (const item of items.filter(item => item.total < 0)) {
                    notes.push(`Deduction "${item.name}" reduces scope — no task created; trim existing tasks manually if needed.`);
                }
            }
            const milestoneBase = existingParent?.startDate ?? coWindowStart;
            coWindowDays = existingParent
                ? Math.max(1, Math.round((existingParent.endDate.getTime() - existingParent.startDate.getTime()) / 86_400_000))
                : calculatedWindowDays;
            const existingMilestones = await tx.scheduleTask.findMany({
                where: { generatedFromChangeOrderId: co.id, type: "milestone" },
                orderBy: [{ order: "asc" }, { id: "asc" }],
                select: { id: true },
            });
            const existingIds = new Set(existingMilestones.map(task => task.id));
            const usedIds = new Set<string>();
            for (const row of co.paymentSchedules) {
                if (row.scheduleTaskId && existingIds.has(row.scheduleTaskId)) {
                    milestoneTaskIdByRowId.set(row.id, row.scheduleTaskId);
                    usedIds.add(row.scheduleTaskId);
                }
            }
            const available = existingMilestones.filter(task => !usedIds.has(task.id));
            for (const row of co.paymentSchedules) {
                if (milestoneTaskIdByRowId.has(row.id)) continue;
                const task = available.shift();
                if (task) milestoneTaskIdByRowId.set(row.id, task.id);
            }
            if (mode === "regenerate") {
                const totalRowsAmount = co.paymentSchedules.reduce((sum, row) => sum + Number(row.amount), 0);
                let cumulative = 0;
                for (const row of co.paymentSchedules) {
                    cumulative += Number(row.amount);
                    if (milestoneTaskIdByRowId.has(row.id)) continue;
                    const derived = totalRowsAmount > 0
                        ? addDays(milestoneBase, Math.round((Math.min(cumulative, totalRowsAmount) / totalRowsAmount) * coWindowDays))
                        : addDays(milestoneBase, coWindowDays);
                    const canonical = row.dueDate ? utcDay(row.dueDate) : derived;
                    const task = await createTask({
                        name: row.name,
                        startDate: canonical,
                        endDate: addDays(canonical, 1),
                        color: "#f59e0b",
                        order: nextOrder++,
                        type: "milestone",
                        parentId: null,
                    });
                    milestoneTaskIdByRowId.set(row.id, task.id);
                }
                if (co.paymentSchedules.length === 0 && existingMilestones.length === 0) {
                    const blockEnd = addDays(milestoneBase, coWindowDays);
                    const task = await createTask({
                        name: `${co.code} payment`,
                        startDate: blockEnd,
                        endDate: addDays(blockEnd, 1),
                        color: "#f59e0b",
                        order: nextOrder++,
                        type: "milestone",
                        parentId: null,
                    });
                    milestoneTaskIds.push(task.id);
                }
            }
            if (co.paymentSchedules.length > 0) {
                milestoneTaskIds.push(...co.paymentSchedules.map(row => milestoneTaskIdByRowId.get(row.id)).filter((id): id is string => !!id));
            } else if (milestoneTaskIds.length === 0) {
                milestoneTaskIds.push(...existingMilestones.map(task => task.id));
            }
        } else {
            // Deduction items create NO task — they reduce scope (Phase 4 trims;
            // for now the PM adjusts existing tasks manually).
            for (const i of items.filter(i => i.total < 0)) {
                notes.push(`Deduction "${i.name}" (−$${Math.abs(i.total).toFixed(2)}) reduces scope — no task created; trim existing tasks manually if needed.`);
                skipped++;
            }

            // Labor-calibrated CO window: the CO's POSITIVE labor dollars
            // (negative labor lines excluded so a mixed addition/deduction CO
            // doesn't shorten the block) vs the ORIGINAL estimate's burn rate.
            // Fallback: 1 day per non-negative item, packed. Every child gets a
            // 1-day minimum, so the window never shrinks below the child count.
            coWindowDays = calculatedWindowDays;

            // Parent task: the contiguous block starting exactly at
            // effectiveWorkEnd (end-exclusive bounds — no empty day).
            const parentTask = await createTask({
                name: `${co.code} · ${co.title}`,
                startDate: coWindowStart,
                endDate: addDays(coWindowStart, coWindowDays),
                color: "#8b5cf6",
                order: nextOrder++,
                type: "task",
                parentId: null,
            });

            // Children: P2 proportional-boundary rule inside the CO window.
            const n = taskItems.length;
            for (let k = 0; k < n; k++) {
                const line = taskItems[k];
                const childStart = addDays(coWindowStart, Math.floor((k * coWindowDays) / n));
                const proportionalEnd = addDays(coWindowStart, Math.floor(((k + 1) * coWindowDays) / n));
                await createTask({
                    name: line.name,
                    startDate: childStart,
                    endDate: proportionalEnd > childStart ? proportionalEnd : addDays(childStart, 1),
                    color: "#8b5cf6",
                    order: nextOrder++,
                    type: "task",
                    parentId: parentTask.id,
                });
            }

            // Milestones: canonical date = dueDate if set, else cumulative
            // amount-share of the CO window by (order, id).
            const totalRowsAmount = co.paymentSchedules.reduce((s, r) => s + Number(r.amount), 0);
            if (co.paymentSchedules.length > 0) {
                let cumAmount = 0;
                for (const row of co.paymentSchedules) {
                    cumAmount += Number(row.amount);
                    const derived = totalRowsAmount > 0
                        ? addDays(coWindowStart, Math.round((Math.min(cumAmount, totalRowsAmount) / totalRowsAmount) * coWindowDays))
                        : addDays(coWindowStart, coWindowDays);
                    const canonical = row.dueDate ? utcDay(row.dueDate) : derived;
                    const mTask = await createTask({
                        name: row.name,
                        startDate: canonical,
                        endDate: addDays(canonical, 1),
                        color: "#f59e0b",
                        order: nextOrder++,
                        type: "milestone",
                        parentId: null,
                    });
                    milestoneTaskIds.push(mTask.id);
                    milestoneTaskIdByRowId.set(row.id, mTask.id);
                }
            } else {
                // Zero-row fallback (R1 fix 4): one synthesized milestone at the
                // CO block's end projecting signedAmount (totalAmount + tax via
                // co-tax.ts — the same amount billing will invoice).
                const signedAmount = coSignedAmount(Number(co.totalAmount), co.estimate);
                const blockEnd = addDays(coWindowStart, coWindowDays);
                const mTask = await createTask({
                    name: `${co.code} payment`,
                    startDate: blockEnd,
                    endDate: addDays(blockEnd, 1),
                    color: "#f59e0b",
                    order: nextOrder++,
                    type: "milestone",
                    parentId: null,
                });
                milestoneTaskIds.push(mTask.id);
                notes.push(`${co.code} has no payment schedule rows — synthesized one "${co.code} payment" milestone ($${signedAmount.toFixed(2)} projected) at the block end.`);
            }
        }

        // ── Linking (fresh + merge-converged): set scheduleTaskId on the CO
        // payment rows AND the billed clone(s), regardless of billing/QB state
        // (linking is not a money mutation). NO dueDate writes anywhere.
        for (const row of co.paymentSchedules) {
            const taskId = milestoneTaskIdByRowId.get(row.id);
            if (!taskId) continue;
            milestonesLinked += await tx.$executeRaw`
                UPDATE "ChangeOrderPaymentSchedule"
                SET "scheduleTaskId" = ${taskId}
                WHERE "id" = ${row.id}
                  AND "scheduleTaskId" IS DISTINCT FROM ${taskId}
            `;
        }
        // Billed clones are linked deterministically by creation order to the
        // corresponding ordered CO milestone (today billing creates one clone).
        const billedClones = await tx.paymentSchedule.findMany({
            where: {
                invoice: { projectId },
                name: { startsWith: `${co.code} — ` },
                status: { not: "Canceled" },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true },
        });
        for (let idx = 0; idx < billedClones.length; idx++) {
            const cloneTarget = milestoneTaskIds[Math.min(idx, milestoneTaskIds.length - 1)];
            if (!cloneTarget) continue;
            milestonesLinked += await tx.$executeRaw`
                UPDATE "PaymentSchedule"
                SET "scheduleTaskId" = ${cloneTarget}
                WHERE "id" = ${billedClones[idx].id}
                  AND "scheduleTaskId" IS DISTINCT FROM ${cloneTarget}
            `;
        }

        await recomputeProjectProjectionInTransaction(tx, projectId);
        await tx.activityLog.create({
            data: {
                projectId,
                actorType: input.actor.type,
                actorName: input.actor.name,
                action: "applied_change_order_schedule",
                entityType: "project",
                entityId: projectId,
                entityName: project.name,
                metadata: JSON.stringify({
                    changeOrderId: co.id,
                    changeOrderCode: co.code,
                    mode,
                    created: createdRows.length,
                    skipped,
                    milestonesLinked,
                }),
            },
        });

        return { changeOrderCode: co.code, projectId, created: createdRows, skipped, milestonesLinked, notes };
    };
    return input.transaction
        ? execute(input.transaction)
        : withTxRetry(() => prisma.$transaction(execute));
}

export async function applyChangeOrderToSchedule(
    input: ApplyChangeOrderScheduleInput,
): Promise<ApplyChangeOrderResult> {
    return runApplyChangeOrderToSchedule(input);
}

export async function applyChangeOrderToScheduleInTransaction(
    tx: Prisma.TransactionClient,
    input: ApplyChangeOrderScheduleInput,
): Promise<ApplyChangeOrderResult> {
    return runApplyChangeOrderToSchedule({ ...input, transaction: tx });
}

// ─────────────────────────────────────────────────────────────────────────────
// Workstream C — Task-level crew (PB-pipeline-003)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace a task's crew (TaskAssignment rows) via a delete/create diff. Every
 * id must be an ACTIVATED user (same validation as setProjectCrew); role stays
 * "assigned". Idempotent; writes a "set_task_crew" ActivityLog row.
 */
export interface SetTaskCrewInput {
    taskId: string;
    userIds: string[];
    actor: ScheduleActor;
}

export interface SetTaskCrewResult {
    taskId: string;
    projectId: string;
    assignments: { id: string; userId: string; name: string; role: string }[];
}

interface InternalSetTaskCrewInput extends SetTaskCrewInput {
    transaction?: Prisma.TransactionClient;
}

async function runSetTaskCrew(
    input: InternalSetTaskCrewInput,
): Promise<SetTaskCrewResult> {
    const execute = async (tx: Prisma.TransactionClient) => {
        const lockedParent = await lockTaskAssignmentParent(tx, input.taskId);
        const task = await tx.scheduleTask.findUnique({
            where: { id: input.taskId },
            select: {
                id: true, name: true, projectId: true,
                project: { select: { name: true } },
                assignments: { select: { id: true, userId: true } },
            },
        });
        if (!task) throw new Error("Task not found");
        if (!task.projectId) throw new Error("Task is not attached to a project");
        if (task.projectId !== lockedParent.projectId) throw new Error("Task moved to another project; refresh and retry");

        const wanted = [...new Set(input.userIds)];
        const users = wanted.length
            ? await tx.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true, email: true, status: true } })
            : [];
        const byId = new Map(users.map(u => [u.id, u]));
        const missing = wanted.filter(id => !byId.has(id));
        if (missing.length > 0) throw new Error(`Unknown user id(s): ${missing.join(", ")}`);

        const current = task.assignments.map(a => a.userId);
        const toAdd = wanted.filter(id => !current.includes(id));
        const toRemove = current.filter(id => !wanted.includes(id));

        // ACTIVATED is required only for users being ADDED — same added-only
        // rule as setProjectCrew, so a task already carrying an inactive
        // assignee never blocks unrelated edits.
        const notActivated = toAdd.map(id => byId.get(id)!).filter(u => u.status !== "ACTIVATED");
        if (notActivated.length > 0) {
            throw new Error(`Task crew members must be ACTIVATED users: ${notActivated.map(u => u.name || u.email).join(", ")}`);
        }
        if (toRemove.length > 0) {
            await tx.taskAssignment.deleteMany({ where: { taskId: input.taskId, userId: { in: toRemove } } });
        }
        for (const userId of toAdd) {
            // Lead assignment is intentionally not settable here yet; task crew changes remain assigned until the later lead-management PR.
            await tx.taskAssignment.create({ data: { taskId: input.taskId, userId, role: "assigned" } });
        }
        if (toAdd.length > 0 || toRemove.length > 0) {
            await touchTaskAssignmentRevision(tx, input.taskId);
        }

        await tx.activityLog.create({
            data: {
                projectId: task.projectId,
                actorType: input.actor.type,
                actorName: input.actor.name,
                action: "set_task_crew",
                entityType: "project",
                entityId: task.projectId,
                entityName: task.project?.name ?? null,
                metadata: JSON.stringify({ taskId: input.taskId, taskName: task.name, added: toAdd, removed: toRemove, userIds: wanted }),
            },
        });

        const final = await tx.taskAssignment.findMany({
            where: { taskId: input.taskId },
            select: { id: true, userId: true, role: true, user: { select: { name: true, email: true } } },
        });
        return {
            taskId: input.taskId,
            projectId: task.projectId,
            assignments: final.map(a => ({
                id: a.id,
                userId: a.userId,
                name: a.user.name || a.user.email,
                role: a.role,
            })),
        };
    };
    return input.transaction
        ? execute(input.transaction)
        : withTxRetry(() => prisma.$transaction(execute));
}

export async function setTaskCrew(input: SetTaskCrewInput): Promise<SetTaskCrewResult> {
    return runSetTaskCrew(input);
}

export async function setTaskCrewInTransaction(
    tx: Prisma.TransactionClient,
    input: SetTaskCrewInput,
): Promise<SetTaskCrewResult> {
    return runSetTaskCrew({ ...input, transaction: tx });
}

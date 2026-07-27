// Usage: set ALLOW_PROD_VERIFY=1 when DATABASE_URL targets Supabase; this verifier creates and deletes fixtures.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { Prisma } from "@prisma/client";

import { prisma } from "../src/lib/prisma";
import { getCompanyDashboardData, setProjectCrew, setProjectStartDate, setTaskCrew, shiftNotStartedTasks } from "../src/lib/schedule-core";
import { canAccessProject, hasPermission } from "../src/lib/permissions";
import { withTxRetry } from "../src/lib/tx-retry";
import { addTaskComment, saveCompanyScheduleTaskDatesAction, updateProjectEndDateAction } from "../src/lib/actions";

type Check = [label: string, passed: boolean];

function serializable(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Prisma.Decimal.isDecimal(value)) return value.toString();
    if (Array.isArray(value)) return value.map(serializable);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, serializable(nested)]));
    }
    return value;
}

function snapshot(value: unknown): string {
    return JSON.stringify(serializable(value));
}

function withoutTaskDates(value: Record<string, unknown>): string {
    const rest = { ...value };
    delete rest.startDate;
    delete rest.endDate;
    // updatedAt legitimately advances on a shift (raw UPDATE sets NOW() to
    // preserve @updatedAt semantics) — asserted separately, not as identity.
    delete rest.updatedAt;
    return snapshot(rest);
}

async function main() {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (databaseUrl.includes("supabase.c") && process.env.ALLOW_PROD_VERIFY !== "1") {
        console.error(
            "[verify-schedule-board] REFUSING TO RUN: DATABASE_URL points at Supabase.\n" +
            "This script creates and deletes verification fixtures in the target database.\n" +
            "Set ALLOW_PROD_VERIFY=1 to opt in."
        );
        process.exit(1);
    }

    const checks: Check[] = [];
    const check = (label: string, passed: boolean) => checks.push([label, passed]);
    const tag = randomUUID();
    const DAY = 86_400_000;
    const base = Date.UTC(2040, 4, 1);
    const at = (day: number) => new Date(base + day * DAY);
    const month = "2040-05";
    const actor = { type: "TEAM" as const, name: `Board verifier ${tag}` };

    const projectIds: string[] = [];
    const estimateIds: string[] = [];
    const invoiceIds: string[] = [];
    const userIds: string[] = [];
    let clientId: string | null = null;

    try {
        const client = await prisma.client.create({
            data: {
                name: `BOARD VERIFY ${tag} DELETE ME`,
                initials: "BV",
                email: `board-client-${tag}@example.invalid`,
            },
        });
        clientId = client.id;

        const project = await prisma.project.create({
            data: {
                name: `BOARD VERIFY ${tag} DELETE ME`,
                clientId: client.id,
                status: "In Progress",
                startDate: at(0),
                color: "#123456",
                // Shop coordinates exactly — distanceMilesFromShop must be 0.
                locationLat: 45.6617,
                locationLng: -122.5484,
            },
        });
        projectIds.push(project.id);

        const notStarted = await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                name: "Not started",
                startDate: at(1),
                endDate: at(4),
                status: "Not Started",
                color: "#abcdef",
                progress: 15,
            },
        });
        const active = await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                name: "Active",
                startDate: at(4),
                endDate: at(7),
                status: "In Progress",
            },
        });
        const complete = await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                name: "Complete",
                startDate: at(7),
                endDate: at(9),
                status: "Completed",
            },
        });
        const milestoneTask = await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                name: "Billing anchor",
                startDate: at(4),
                endDate: at(4),
                status: "Not Started",
                type: "milestone",
            },
        });

        const estimate = await prisma.estimate.create({
            data: {
                title: `Board verify estimate ${tag}`,
                projectId: project.id,
                code: `BOARD-EST-${tag}`,
                status: "Approved",
                totalAmount: 1000,
                balanceDue: 1000,
            },
        });
        estimateIds.push(estimate.id);

        const invoice = await prisma.invoice.create({
            data: {
                code: `BOARD-INV-${tag}`,
                projectId: project.id,
                clientId: client.id,
                estimateId: estimate.id,
                status: "Issued",
                totalAmount: 1000,
                subtotal: 900,
                taxRate: 10,
                taxAmount: 100,
                balanceDue: 1000,
            },
        });
        invoiceIds.push(invoice.id);

        const explicitEstimateMilestone = await prisma.estimatePaymentSchedule.create({
            data: {
                estimateId: estimate.id,
                name: `Explicit estimate milestone ${tag}`,
                amount: 300,
                dueDate: at(12),
                status: "Pending",
                scheduleTaskId: notStarted.id,
            },
        });
        const nullDatedPayment = await prisma.paymentSchedule.create({
            data: {
                invoiceId: invoice.id,
                name: `Null-date invoice milestone ${tag}`,
                amount: 300,
                dueDate: null,
                status: "Pending",
                scheduleTaskId: notStarted.id,
                qbInvoiceId: `QB-NULL-${tag}`,
                qbInvoiceLink: `https://example.invalid/invoice/${tag}/null-date`,
                qbPaymentId: `QB-PAY-NULL-${tag}`,
                qbSyncedAt: at(-2),
                qbInvoiceSentAt: at(-1),
                qbSyncError: "verify-null-date",
            },
        });
        const explicitPaymentMilestone = await prisma.paymentSchedule.create({
            data: {
                invoiceId: invoice.id,
                name: `Explicit invoice milestone ${tag}`,
                amount: 700,
                dueDate: at(16),
                status: "Pending",
                scheduleTaskId: milestoneTask.id,
                qbInvoiceId: `QB-EXPLICIT-${tag}`,
                qbInvoiceLink: `https://example.invalid/invoice/${tag}/explicit`,
                qbPaymentId: `QB-PAY-EXPLICIT-${tag}`,
                qbSyncedAt: at(-2),
                qbInvoiceSentAt: at(-1),
                qbSyncError: "verify-explicit",
            },
        });

        const waitingProject = await prisma.project.create({
            data: {
                name: `BOARD WAITING VERIFY ${tag} DELETE ME`,
                clientId: client.id,
                status: "Waiting to Start",
                startDate: at(30),
                color: "#654321",
                // Exactly 1 degree of latitude north of the shop, same
                // longitude — a pure-meridian great-circle distance, exactly
                // EARTH_RADIUS_MILES * (pi/180) =~ 69.09 mi, rounds to 69.
                locationLat: 46.6617,
                locationLng: -122.5484,
            },
        });
        projectIds.push(waitingProject.id);
        const waitingTask = await prisma.scheduleTask.create({
            data: {
                projectId: waitingProject.id,
                name: `Waiting task ${tag}`,
                startDate: at(31),
                endDate: at(33),
                status: "Not Started",
            },
        });

        const substantialProject = await prisma.project.create({
            data: {
                name: `BOARD SUBSTANTIAL VERIFY ${tag} DELETE ME`,
                clientId: client.id,
                status: "Substantial Completion",
                startDate: at(34),
                color: "#112233",
            },
        });
        projectIds.push(substantialProject.id);
        const substantialTask = await prisma.scheduleTask.create({
            data: {
                projectId: substantialProject.id,
                name: `Substantial task ${tag}`,
                startDate: at(35),
                endDate: at(37),
                status: "Not Started",
            },
        });

        for (const role of ["ADMIN", "MANAGER", "FINANCE", "FIELD_CREW"] as const) {
            const dashboard = await getCompanyDashboardData({ role }, month);
            const row = dashboard.pipeline.inProgress.find(candidate => candidate.id === project.id);
            const task = row?.tasks.find(candidate => candidate.id === notStarted.id);
            const additiveFieldsPresent = !!row
                && row.color === "#123456"
                && !!task
                && task.color === "#abcdef"
                && Object.prototype.hasOwnProperty.call(task, "parentId")
                && task.parentId === null
                && task.progress === 15;
            check(`${role} dashboard includes project/task color, parentId, and progress`, additiveFieldsPresent);
            const substantialRow = dashboard.pipeline.substantialCompletion.find(candidate => candidate.id === substantialProject.id);
            check(`${role} dashboard enriches Substantial Completion rows and tasks`, substantialRow?.tasks.some(task => task.id === substantialTask.id) === true);
            // distanceMilesFromShop is NOT money — serialized identically for
            // every role, including FIELD_CREW and FINANCE.
            check(`${role} dashboard computes distanceMilesFromShop = 0 for a shop-coordinate project`, row?.distanceMilesFromShop === 0);
            check(`${role} dashboard leaves distanceMilesFromShop null for an ungeocoded project`, substantialRow?.distanceMilesFromShop === null);
            if (role === "ADMIN") {
                check("ADMIN dashboard includes overlays, cashflow, and strip", dashboard.overlays !== null && dashboard.cashflow !== null && dashboard.strip !== null);
            } else {
                check(`${role} dashboard omits overlays, cashflow, and strip`, dashboard.overlays === null && dashboard.cashflow === null && dashboard.strip === null);
            }
            // Pipeline money redaction: financialReports holders see dollars;
            // schedules-only viewers (FIELD_CREW default) get nulls everywhere.
            const expectFinancials = role !== "FIELD_CREW";
            check(`${role} dashboard canSeeFinancials matches the role default`, dashboard.canSeeFinancials === expectFinancials);
            if (expectFinancials) {
                check(`${role} dashboard serializes the fixture contractValue`, row?.contractValue === 1000);
            } else {
                const everyPipelineProject = [
                    ...dashboard.pipeline.waitingToStart,
                    ...dashboard.pipeline.scheduled,
                    ...dashboard.pipeline.inProgress,
                    ...dashboard.pipeline.substantialCompletion,
                ];
                check(`${role} dashboard redacts contractValue in every pipeline bucket`, everyPipelineProject.length > 0
                    && everyPipelineProject.every(candidate => candidate.contractValue === null));
                check(`${role} dashboard redacts lead targetRevenue and latestEstimateTotal`, dashboard.pipeline.estimating.every(
                    candidate => candidate.targetRevenue === null && candidate.latestEstimateTotal === null,
                ));
            }
        }

        // Explicit canSeeFinancials override wins over the role default (the page
        // passes hasPermission(user, "financialReports"), honoring per-user overrides).
        const overriddenManager = await getCompanyDashboardData({ role: "MANAGER", canSeeFinancials: false }, month);
        check("explicit canSeeFinancials=false overrides the MANAGER role default", overriddenManager.canSeeFinancials === false
            && overriddenManager.pipeline.inProgress.every(candidate => candidate.contractValue === null)
            && overriddenManager.pipeline.estimating.every(candidate => candidate.targetRevenue === null && candidate.latestEstimateTotal === null));
        // teamMembers.role is always serialized (crew-availability panel role
        // filter); burdenedHourlyRate is MONEY — present only when the caller
        // can see financials, absent (not null) otherwise.
        check("overridden MANAGER teamMembers carry role but omit burdenedHourlyRate (money gated off)",
            (overriddenManager.teamMembers ?? []).length > 0
            && (overriddenManager.teamMembers ?? []).every(m => typeof m.role === "string" && !Object.prototype.hasOwnProperty.call(m, "burdenedHourlyRate")));
        const adminDashboardForTeam = await getCompanyDashboardData({ role: "ADMIN" }, month);
        check("ADMIN teamMembers carry role and burdenedHourlyRate (money visible)",
            (adminDashboardForTeam.teamMembers ?? []).length > 0
            && (adminDashboardForTeam.teamMembers ?? []).every(m => typeof m.role === "string" && typeof m.burdenedHourlyRate === "number"));
        const waitingRowForDistance = [...adminDashboardForTeam.pipeline.waitingToStart, ...adminDashboardForTeam.pipeline.scheduled]
            .find(candidate => candidate.id === waitingProject.id);
        check("dashboard computes distanceMilesFromShop for a known 1-degree-latitude offset (~69 mi)",
            waitingRowForDistance?.distanceMilesFromShop === 69);

        // ── Owner-feedback round (2026-07-22), item 3: hover-card notes ──
        // latestComments serialization — newest-first, capped at 2, author
        // fallback chain (user.name -> user.email -> subcontractorName ->
        // "Unknown"). Explicit createdAt values keep ordering deterministic
        // regardless of DB clock precision.
        const commentNamedUser = await prisma.user.create({
            data: { email: `board-comment-named-${tag}@example.invalid`, name: `Board Commenter ${tag}`, role: "FIELD_CREW", status: "ACTIVATED" },
        });
        const commentUnnamedUser = await prisma.user.create({
            data: { email: `board-comment-unnamed-${tag}@example.invalid`, name: null, role: "FIELD_CREW", status: "ACTIVATED" },
        });
        userIds.push(commentNamedUser.id, commentUnnamedUser.id);
        const oldestComment = await prisma.taskComment.create({
            data: { taskId: notStarted.id, text: `Oldest note ${tag} — capped out of latestComments`, subcontractorName: `Sub Crew ${tag}`, createdAt: at(-3) },
        });
        const middleComment = await prisma.taskComment.create({
            data: { taskId: notStarted.id, text: `Middle note ${tag}`, userId: commentUnnamedUser.id, createdAt: at(-2) },
        });
        const newestComment = await prisma.taskComment.create({
            data: { taskId: notStarted.id, text: `Newest note ${tag}`, userId: commentNamedUser.id, createdAt: at(-1) },
        });
        const commentsDashboard = await getCompanyDashboardData({ role: "ADMIN" }, month);
        const commentsRow = commentsDashboard.pipeline.inProgress.find(candidate => candidate.id === project.id);
        const commentsTask = commentsRow?.tasks.find(candidate => candidate.id === notStarted.id);
        check("latestComments is capped at 2, newest first",
            commentsTask?.latestComments.length === 2
            && commentsTask.latestComments[0].text === newestComment.text
            && commentsTask.latestComments[1].text === middleComment.text
            && commentsTask.latestComments.every(c => c.text !== oldestComment.text));
        check("latestComments falls back to user.email when the user has no name",
            commentsTask?.latestComments[1].authorName === commentUnnamedUser.email);
        check("latestComments uses user.name when present",
            commentsTask?.latestComments[0].authorName === commentNamedUser.name);

        // addTaskComment previously had NO auth check at all — hardened to
        // assertScheduleTaskAccess (same gate updateScheduleTask/every other
        // per-task mutation in this file uses). Reachability asserted the
        // same way as the other actions above: this script runs outside a
        // request scope, so a real auth wall is the expected outcome.
        let addTaskCommentRan = false;
        let addTaskCommentErr = "";
        try {
            await addTaskComment(notStarted.id, `Reachability probe ${tag}`);
            addTaskCommentRan = true;
        } catch (error) {
            addTaskCommentErr = String((error as Error)?.message ?? error);
        }
        check("addTaskComment is reachable (runs, or hits the expected script auth wall outside a request scope)",
            addTaskCommentRan || /Forbidden|Unauthorized|outside a request scope|headers/i.test(addTaskCommentErr));

        const allTasksBeforeZero = snapshot(await prisma.scheduleTask.findMany({
            where: { projectId: project.id },
            orderBy: { id: "asc" },
        }));
        let zeroRejected = false;
        try {
            await shiftNotStartedTasks({ projectId: project.id, deltaDays: 0, actor });
        } catch (error) {
            zeroRejected = /nonzero whole integer/i.test(String((error as Error).message));
        }
        const allTasksAfterZero = snapshot(await prisma.scheduleTask.findMany({
            where: { projectId: project.id },
            orderBy: { id: "asc" },
        }));
        check("zero delta rejects before changing rows", zeroRejected && allTasksAfterZero === allTasksBeforeZero);

        let fractionalRejected = false;
        try {
            await shiftNotStartedTasks({ projectId: project.id, deltaDays: 1.5, actor });
        } catch (error) {
            fractionalRejected = /nonzero whole integer/i.test(String((error as Error).message));
        }
        check("fractional delta rejects", fractionalRejected);

        let oversizedRejected = false;
        try {
            await shiftNotStartedTasks({ projectId: project.id, deltaDays: 366, actor });
        } catch (error) {
            oversizedRejected = /cannot exceed 365/i.test(String((error as Error).message));
        }
        check("delta beyond 365 days rejects", oversizedRejected);

        const projectBefore = snapshot(await prisma.project.findUniqueOrThrow({ where: { id: project.id } }));
        const notStartedBefore = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: notStarted.id } });
        const milestoneTaskBefore = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: milestoneTask.id } });
        const activeBefore = snapshot(await prisma.scheduleTask.findUniqueOrThrow({ where: { id: active.id } }));
        const completeBefore = snapshot(await prisma.scheduleTask.findUniqueOrThrow({ where: { id: complete.id } }));
        const estimateMilestoneBefore = snapshot(await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: explicitEstimateMilestone.id } }));
        const nullPaymentBefore = snapshot(await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: nullDatedPayment.id } }));
        const explicitPaymentBefore = snapshot(await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: explicitPaymentMilestone.id } }));

        const result = await shiftNotStartedTasks({ projectId: project.id, deltaDays: 3, actor });

        const projectAfter = snapshot(await prisma.project.findUniqueOrThrow({ where: { id: project.id } }));
        const notStartedAfter = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: notStarted.id } });
        const milestoneTaskAfter = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: milestoneTask.id } });
        const activeAfter = snapshot(await prisma.scheduleTask.findUniqueOrThrow({ where: { id: active.id } }));
        const completeAfter = snapshot(await prisma.scheduleTask.findUniqueOrThrow({ where: { id: complete.id } }));
        const estimateMilestoneAfter = snapshot(await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: explicitEstimateMilestone.id } }));
        const nullPaymentAfter = snapshot(await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: nullDatedPayment.id } }));
        const explicitPaymentAfter = snapshot(await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: explicitPaymentMilestone.id } }));

        const expectedShiftedIds = [notStarted.id, milestoneTask.id].sort();
        check("+3 shifts only exact Not Started tasks", result.shiftedTasks === 2 && snapshot(result.shiftedTaskIds) === snapshot(expectedShiftedIds));
        check("Not Started shift returns exact persisted affected task dates", snapshot(result.shiftedTaskDates) === snapshot([
            { id: notStarted.id, startDate: at(4).toISOString(), endDate: at(7).toISOString() },
            { id: milestoneTask.id, startDate: at(7).toISOString(), endDate: at(7).toISOString() },
        ].sort((a, b) => a.id.localeCompare(b.id))));
        check("Not Started task retains duration and non-date fields", notStartedAfter.startDate.getTime() === at(4).getTime()
            && notStartedAfter.endDate.getTime() === at(7).getTime()
            && notStartedAfter.endDate.getTime() - notStartedAfter.startDate.getTime() === notStartedBefore.endDate.getTime() - notStartedBefore.startDate.getTime()
            && withoutTaskDates(notStartedAfter as unknown as Record<string, unknown>) === withoutTaskDates(notStartedBefore as unknown as Record<string, unknown>));
        check("Not Started milestone retains zero duration and non-date fields", milestoneTaskAfter.startDate.getTime() === at(7).getTime()
            && milestoneTaskAfter.endDate.getTime() === at(7).getTime()
            && milestoneTaskAfter.endDate.getTime() - milestoneTaskAfter.startDate.getTime() === milestoneTaskBefore.endDate.getTime() - milestoneTaskBefore.startDate.getTime()
            && withoutTaskDates(milestoneTaskAfter as unknown as Record<string, unknown>) === withoutTaskDates(milestoneTaskBefore as unknown as Record<string, unknown>));
        check("shifted task updatedAt advances", new Date(String(notStartedAfter.updatedAt)).getTime() > new Date(String(notStartedBefore.updatedAt)).getTime()
            && new Date(String(milestoneTaskAfter.updatedAt)).getTime() > new Date(String(milestoneTaskBefore.updatedAt)).getTime());
        check("In Progress task row remains byte-identical", activeAfter === activeBefore);
        check("Completed task row remains byte-identical", completeAfter === completeBefore);
        check("Project row and startDate remain byte-identical", projectAfter === projectBefore);
        check("Estimate milestone row remains byte-identical", estimateMilestoneAfter === estimateMilestoneBefore);
        check("null-dated PaymentSchedule row including QB fields remains byte-identical", nullPaymentAfter === nullPaymentBefore);
        check("explicit-dated PaymentSchedule row including QB fields remains byte-identical", explicitPaymentAfter === explicitPaymentBefore);
        check("notes identify only explicit-due-date anchored milestones", result.notes.length === 2
            && result.notes.some(note => note.includes(explicitEstimateMilestone.id) && note.includes(explicitEstimateMilestone.name))
            && result.notes.some(note => note.includes(explicitPaymentMilestone.id) && note.includes(explicitPaymentMilestone.name))
            && result.notes.every(note => !note.includes(nullDatedPayment.id)));

        const logs = await prisma.activityLog.findMany({
            where: { projectId: project.id, action: "shift_not_started_tasks" },
            orderBy: { createdAt: "asc" },
        });
        const metadata = JSON.parse(logs[0]?.metadata ?? "{}");
        check("one shift_not_started_tasks ActivityLog records actor and metadata", logs.length === 1
            && logs[0]?.actorType === actor.type
            && logs[0]?.actorName === actor.name
            && logs[0]?.entityType === "project"
            && logs[0]?.entityId === project.id
            && metadata.deltaDays === 3
            && metadata.shiftedTasks === 2
            && snapshot(metadata.shiftedTaskIds) === snapshot(expectedShiftedIds)
            && metadata.explicitDueDateMilestones === 2);

        const waitingProjectBefore = snapshot(await prisma.project.findUniqueOrThrow({ where: { id: waitingProject.id } }));
        const waitingTaskBefore = snapshot(await prisma.scheduleTask.findUniqueOrThrow({ where: { id: waitingTask.id } }));
        let waitingRejected = false;
        try {
            await shiftNotStartedTasks({ projectId: waitingProject.id, deltaDays: 3, actor });
        } catch (error) {
            waitingRejected = /Only In Progress projects/i.test(String((error as Error).message));
        }
        const waitingProjectAfter = snapshot(await prisma.project.findUniqueOrThrow({ where: { id: waitingProject.id } }));
        const waitingTaskAfter = snapshot(await prisma.scheduleTask.findUniqueOrThrow({ where: { id: waitingTask.id } }));
        check("Waiting-to-Start fixture rejects and remains byte-identical", waitingRejected
            && waitingProjectAfter === waitingProjectBefore
            && waitingTaskAfter === waitingTaskBefore);

        const waitingMoveResult = await setProjectStartDate({
            projectId: waitingProject.id,
            startDate: at(33),
            shiftJobTasks: true,
            actor,
        });
        const waitingTaskMoved = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: waitingTask.id } });
        check("Waiting full shift returns exact persisted affected task dates", waitingMoveResult.startDate === at(33).toISOString()
            && waitingMoveResult.shiftedTasks === 1
            && snapshot(waitingMoveResult.shiftedTaskDates) === snapshot([
                { id: waitingTask.id, startDate: at(34).toISOString(), endDate: at(36).toISOString() },
            ])
            && waitingTaskMoved.startDate.getTime() === at(34).getTime()
            && waitingTaskMoved.endDate.getTime() === at(36).getTime());

        let retryAttempts = 0;
        const retryProbe = await withTxRetry(async () => {
            retryAttempts++;
            if (retryAttempts === 1) {
                throw new Prisma.PrismaClientKnownRequestError("schedule-board retry probe", {
                    code: "P2034",
                    clientVersion: Prisma.prismaVersion.client,
                });
            }
            return "retried";
        });
        check("withTxRetry retries one P2034 conflict and succeeds on attempt two", retryProbe === "retried" && retryAttempts === 2);

        const scheduleCoreSource = readFileSync(new URL("../src/lib/schedule-core.ts", import.meta.url), "utf8");
        // B1 moved the shift core into the private runShiftNotStartedTasks
        // (the export is now a thin delegator so Publish can run it inside
        // its own transaction) — the invariant lives in the runner's body.
        const shiftRunnerStart = scheduleCoreSource.indexOf("async function runShiftNotStartedTasks");
        const shiftStart = shiftRunnerStart >= 0 ? shiftRunnerStart : scheduleCoreSource.indexOf("export async function shiftNotStartedTasks");
        const shiftEnd = scheduleCoreSource.indexOf("export interface CashflowBucket", shiftStart);
        const shiftBody = scheduleCoreSource.slice(shiftStart, shiftEnd);
        const projectLockIndex = shiftBody.indexOf('SELECT id FROM "Project"');
        const taskLockIndex = shiftBody.indexOf('FROM "ScheduleTask"');
        check("source wraps shiftNotStartedTasks in withTxRetry", shiftStart >= 0 && shiftBody.includes("withTxRetry(() => prisma.$transaction"));
        check("source locks Project before ordered Not Started task selection", projectLockIndex >= 0
            && taskLockIndex > projectLockIndex
            && shiftBody.includes('"status" = \'Not Started\'')
            && shiftBody.includes('ORDER BY "id"')
            && shiftBody.includes("FOR UPDATE"));
        check("source has no project or payment-table update in shift core", !shiftBody.includes("tx.project.update")
            && !/UPDATE\s+"(?:EstimatePaymentSchedule|PaymentSchedule|ChangeOrderPaymentSchedule)"/i.test(shiftBody)
            && !/tx\.(?:estimatePaymentSchedule|paymentSchedule|changeOrderPaymentSchedule)\.(?:update|updateMany)/.test(shiftBody));
        check("project and selective shift results expose exact persisted affected task dates",
            /interface SetProjectStartDateResult[\s\S]*?shiftedTaskDates:\s*PersistedScheduleTaskDate\[\]/.test(scheduleCoreSource)
            && /interface ShiftNotStartedTasksResult[\s\S]*?shiftedTaskDates:\s*PersistedScheduleTaskDate\[\]/.test(scheduleCoreSource)
            && /UPDATE "ScheduleTask"[\s\S]*?RETURNING "id", "startDate", "endDate"/.test(scheduleCoreSource));

        const actionsSource = readFileSync(new URL("../src/lib/actions.ts", import.meta.url), "utf8");
        const scheduleTaskCoreSource = readFileSync(new URL("../src/lib/schedule-task-core.ts", import.meta.url), "utf8");
        const actionStart = actionsSource.indexOf("export async function shiftNotStartedTasksAction");
        const actionEnd = actionsSource.indexOf("export async function generateProjectScheduleAction", actionStart);
        const actionBody = actionsSource.slice(actionStart, actionEnd);
        check("action wrapper is ADMIN/MANAGER gated and revalidates both boards", actionStart >= 0
            && actionBody.includes('["ADMIN", "MANAGER"].includes(caller.role)')
            && actionBody.includes('revalidatePath("/company-dashboard")')
            && actionBody.includes('revalidatePath("/projects")')
            && actionBody.includes("shiftNotStartedTasks({")
            && !actionBody.includes("sendNotification"));
        const canonicalTaskActionStart = actionsSource.indexOf("export async function updateScheduleTask");
        const canonicalTaskActionEnd = actionsSource.indexOf("export async function deleteScheduleTask", canonicalTaskActionStart);
        const canonicalTaskActionBody = actionsSource.slice(canonicalTaskActionStart, canonicalTaskActionEnd);
        check("canonical task action preserves schedule permission and project access for date mutations", canonicalTaskActionStart >= 0
            && canonicalTaskActionBody.includes("await assertScheduleTaskAccess(taskId)")
            && !canonicalTaskActionBody.includes('["ADMIN", "MANAGER"].includes(user.role)')
            && canonicalTaskActionBody.includes("updateScheduleTaskInTransaction(")
            && canonicalTaskActionBody.includes('revalidatePath("/company-dashboard")')
            && scheduleTaskCoreSource.includes("parseStartDateInput")
            && scheduleTaskCoreSource.includes("lockTaskAssignmentParent(tx, taskId")
            && scheduleTaskCoreSource.includes('persisted.type === "milestone"'));
        const companyTaskAdapterStart = actionsSource.indexOf("export async function updateCompanyScheduleTaskDatesAction");
        const companyTaskAdapterEnd = actionsSource.indexOf("export async function updateProjectStatus", companyTaskAdapterStart);
        const companyTaskAdapterBody = actionsSource.slice(companyTaskAdapterStart, companyTaskAdapterEnd);
        check("company task-date adapter is exact-role authorization around the one canonical action", companyTaskAdapterStart >= 0
            && companyTaskAdapterBody.includes('["ADMIN", "MANAGER"].includes(caller.role)')
            && (companyTaskAdapterBody.match(/updateScheduleTask\(/g) ?? []).length === 1
            && !/parseStartDateInput|withTxRetry|\$transaction|\$queryRaw|scheduleTask\.update|activityLog\.create|revalidatePath/.test(companyTaskAdapterBody)
            && !scheduleCoreSource.includes("updateCompanyScheduleTaskDates"));
        const authorizedFieldCrew = {
            role: "FIELD_CREW",
            permissions: null,
            projectAccess: [{ projectId: project.id }],
            assignedProjects: [],
        };
        check("authorized FIELD_CREW retains canonical schedule-task access but is outside the company-board adapter roles",
            hasPermission(authorizedFieldCrew, "schedules")
            && canAccessProject(authorizedFieldCrew, project.id)
            && !["ADMIN", "MANAGER"].includes(authorizedFieldCrew.role));
        check("TEAM actor expression stays pinned to the authenticated caller", actionBody.includes('actor: { type: "TEAM", name: caller.name || caller.email }'));

        // ── PB-schedule-002 item 2: updateProjectColor previously had NO auth
        // check at all — tightened to assertScheduleProjectAccess (schedules
        // permission + project access), the same gate the other per-project
        // schedule mutations in this file use. ──
        const colorActionStart = actionsSource.indexOf("export async function updateProjectColor");
        const colorActionEnd = actionsSource.indexOf("export async function updateProjectTags", colorActionStart);
        const colorActionBody = actionsSource.slice(colorActionStart, colorActionEnd);
        check("updateProjectColor is gated behind assertScheduleProjectAccess (schedules permission + project access)",
            colorActionStart >= 0 && colorActionBody.includes("await assertScheduleProjectAccess(projectId)"));

        // ── PB-schedule-002 item 3: updateProjectEndDateAction — ADMIN/MANAGER
        // gate, end<=start rejection, single ActivityLog row, revalidation.
        // The write/validation path is asserted at the source level (like the
        // other gated actions above) since this script runs outside a request
        // scope and can't authenticate as ADMIN/MANAGER; the reachability call
        // below only proves the action hits the same expected auth wall
        // saveCompanyScheduleTaskDatesAction does further down. ──
        const endDateActionStart = actionsSource.indexOf("export async function updateProjectEndDateAction");
        const endDateActionEnd = actionsSource.indexOf("// Shift unfinished work on an active project", endDateActionStart);
        const endDateActionBody = actionsSource.slice(endDateActionStart, endDateActionEnd);
        check("updateProjectEndDateAction exists and is ADMIN/MANAGER gated",
            endDateActionStart >= 0 && endDateActionBody.includes('["ADMIN", "MANAGER"].includes(caller.role)'));
        check("updateProjectEndDateAction validates with parseStartDateInput, rejects end <= start under the Project row lock, writes one set_project_end_date ActivityLog row, and revalidates both boards",
            endDateActionBody.includes("parseStartDateInput(endDateISO)")
            && endDateActionBody.includes('FOR UPDATE')
            && endDateActionBody.includes("withTxRetry")
            && endDateActionBody.includes("endDate.getTime() <= locked.startDate.getTime()")
            && endDateActionBody.includes('throw new Error("End date must be after the project\'s start date")')
            && endDateActionBody.includes('action: "set_project_end_date"')
            && endDateActionBody.includes("previousEndDate:")
            && endDateActionBody.includes('revalidatePath("/company-dashboard")')
            && endDateActionBody.includes('revalidatePath("/projects")'));

        const endDateProject = await prisma.project.create({
            data: {
                name: `BOARD ENDDATE VERIFY ${tag} DELETE ME`,
                clientId: client.id,
                status: "Waiting to Start",
                startDate: at(40),
                endDate: at(50),
            },
        });
        projectIds.push(endDateProject.id);

        // getEffectiveProjectRange/serialization (item 3): Project.endDate must
        // reach the dashboard row as-is (ISO string), and getEffectiveProjectRange
        // (useBarLayout.ts) must treat it as a direct end candidate — asserted at
        // the pure-function level in verify-schedule-board-layout.ts; here only
        // the DB -> serialized-row leg is exercised.
        const endDateDashboard = await getCompanyDashboardData({ role: "ADMIN" }, month);
        const endDateRow = [...endDateDashboard.pipeline.waitingToStart, ...endDateDashboard.pipeline.scheduled]
            .find(candidate => candidate.id === endDateProject.id);
        check("dashboard serializes Project.endDate onto the pipeline row",
            endDateRow?.endDate === at(50).toISOString());
        const noEndDateRow = endDateDashboard.pipeline.inProgress.find(candidate => candidate.id === project.id);
        check("dashboard leaves endDate null for a project with none set", noEndDateRow?.endDate === null);

        let endDateActionRan = false;
        let endDateActionErr = "";
        try {
            await updateProjectEndDateAction(endDateProject.id, "2040-08-01");
            endDateActionRan = true;
        } catch (error) {
            endDateActionErr = String((error as Error)?.message ?? error);
        }
        check("updateProjectEndDateAction is reachable (runs, or hits the expected script auth wall outside a request scope)",
            endDateActionRan || /Forbidden|Unauthorized|outside a request scope|headers/i.test(endDateActionErr));

        // ── Owner-feedback round: crew ACTIVATED-added-only validation (fix 1),
        // FINANCE exclusion + name disambiguation (fix 7), batch task-date save
        // (fix 2) ──
        const crewUsers = [
            // hourlyRate/burdenRate: exact known values to assert
            // burdenedHourlyRate = round2(hourlyRate + burdenRate) = 30.85.
            await prisma.user.create({ data: { email: `board-active-${tag}@example.invalid`, name: `Board Active ${tag}`, role: "FIELD_CREW", status: "ACTIVATED", hourlyRate: 24.75, burdenRate: 6.10 } }),
            await prisma.user.create({ data: { email: `board-pending-${tag}@example.invalid`, name: `Board Pending ${tag}`, role: "FIELD_CREW", status: "PENDING" } }),
            await prisma.user.create({ data: { email: `board-legacy-${tag}@example.invalid`, name: `Board Legacy ${tag}`, role: "FIELD_CREW", status: "DISABLED" } }),
            await prisma.user.create({ data: { email: `board-finance-${tag}@example.invalid`, name: `Board Finance ${tag}`, role: "FINANCE", status: "ACTIVATED" } }),
            await prisma.user.create({ data: { email: `board-dupe-a-${tag}@example.invalid`, name: `Board Dupe ${tag}`, role: "FIELD_CREW", status: "ACTIVATED" } }),
            await prisma.user.create({ data: { email: `board-dupe-b-${tag}@example.invalid`, name: `Board Dupe ${tag}`, role: "FIELD_CREW", status: "ACTIVATED" } }),
        ];
        userIds.push(...crewUsers.map(u => u.id));
        const [activeUser, pendingUser, legacyUser, financeUser, dupeUserA, dupeUserB] = crewUsers;

        const crewProject = await prisma.project.create({
            data: {
                name: `BOARD CREW VERIFY ${tag} DELETE ME`,
                clientId: client.id,
                status: "Waiting to Start",
                startDate: at(20),
                crew: { connect: [{ id: activeUser.id }, { id: legacyUser.id }] },
            },
        });
        projectIds.push(crewProject.id);
        const crewTask = await prisma.scheduleTask.create({
            data: { projectId: crewProject.id, name: `Crew task ${tag}`, startDate: at(21), endDate: at(22), status: "Not Started" },
        });
        await prisma.taskAssignment.createMany({
            data: [
                { taskId: crewTask.id, userId: activeUser.id, role: "assigned" },
                { taskId: crewTask.id, userId: legacyUser.id, role: "assigned" },
            ],
        });

        const crewKeepResult = await setProjectCrew({ projectId: crewProject.id, userIds: [activeUser.id, legacyUser.id], actor });
        check("setProjectCrew: keeping an already-assigned inactive member does not throw",
            crewKeepResult.crew.length === 2 && crewKeepResult.crew.some(c => c.id === legacyUser.id));

        const crewRemoveResult = await setProjectCrew({ projectId: crewProject.id, userIds: [activeUser.id], actor });
        check("setProjectCrew: removing an inactive member never throws",
            crewRemoveResult.crew.length === 1 && crewRemoveResult.crew[0].id === activeUser.id);

        let addNonActivatedRejected = false;
        try {
            await setProjectCrew({ projectId: crewProject.id, userIds: [activeUser.id, pendingUser.id], actor });
        } catch (error) {
            addNonActivatedRejected = /ACTIVATED/i.test(String((error as Error).message));
        }
        const crewAfterAddReject = await prisma.project.findUniqueOrThrow({ where: { id: crewProject.id }, select: { crew: { select: { id: true } } } });
        check("setProjectCrew: adding a NEW non-ACTIVATED user still rejects, existing crew untouched",
            addNonActivatedRejected && crewAfterAddReject.crew.length === 1 && crewAfterAddReject.crew[0].id === activeUser.id);

        const taskKeepResult = await setTaskCrew({ taskId: crewTask.id, userIds: [activeUser.id, legacyUser.id], actor });
        check("setTaskCrew: keeping an already-assigned inactive member does not throw",
            taskKeepResult.assignments.length === 2 && taskKeepResult.assignments.some(a => a.userId === legacyUser.id));

        const taskRemoveResult = await setTaskCrew({ taskId: crewTask.id, userIds: [activeUser.id], actor });
        check("setTaskCrew: removing an inactive member never throws",
            taskRemoveResult.assignments.length === 1 && taskRemoveResult.assignments[0].userId === activeUser.id);

        let taskAddNonActivatedRejected = false;
        try {
            await setTaskCrew({ taskId: crewTask.id, userIds: [activeUser.id, pendingUser.id], actor });
        } catch (error) {
            taskAddNonActivatedRejected = /ACTIVATED/i.test(String((error as Error).message));
        }
        const taskAssignmentsAfterReject = await prisma.taskAssignment.findMany({ where: { taskId: crewTask.id } });
        check("setTaskCrew: adding a NEW non-ACTIVATED user still rejects, existing assignments untouched",
            taskAddNonActivatedRejected && taskAssignmentsAfterReject.length === 1 && taskAssignmentsAfterReject[0].userId === activeUser.id);

        await prisma.project.update({ where: { id: crewProject.id }, data: { crew: { connect: [{ id: legacyUser.id }, { id: financeUser.id }] } } });
        const dashboardForCrew = await getCompanyDashboardData({ role: "ADMIN" }, month);
        check("teamMembers picker excludes FINANCE-role users", !(dashboardForCrew.teamMembers ?? []).some(u => u.id === financeUser.id));
        const crewProjectRow = [...dashboardForCrew.pipeline.waitingToStart, ...dashboardForCrew.pipeline.scheduled]
            .find(candidate => candidate.id === crewProject.id);
        const financeCrewEntry = crewProjectRow?.crew.find(c => c.id === financeUser.id);
        check("assigned FINANCE user still appears as a removable crew entry with role carried",
            !!financeCrewEntry && financeCrewEntry.role === "FINANCE");
        const inactiveCrewEntry = crewProjectRow?.crew.find(c => c.id === legacyUser.id);
        check("assigned DISABLED user still appears as a removable crew entry", !!inactiveCrewEntry && inactiveCrewEntry.status !== "ACTIVATED");

        const dupeEntries = (dashboardForCrew.teamMembers ?? []).filter(u => u.id === dupeUserA.id || u.id === dupeUserB.id);
        // Owner call 2026-07-23: NO email decoration in picker names ever —
        // full addresses wrapped across six lines in the crew checklist.
        // Duplicate display names render as-is (email stays in its own field).
        check("teamMembers never decorates names with emails, even for duplicates",
            dupeEntries.length === 2 && dupeEntries.every(u => !u.name.includes("@")) && dupeEntries[0].name === dupeEntries[1].name);
        const soloNamedEntry = (dashboardForCrew.teamMembers ?? []).find(u => u.id === activeUser.id);
        check("teamMembers leaves unique display names unmodified",
            soloNamedEntry?.name === (activeUser.name ?? activeUser.email) && !soloNamedEntry.name.includes("@"));
        check("teamMembers.burdenedHourlyRate is exactly hourlyRate + burdenRate, rounded to 2dp",
            soloNamedEntry?.role === "FIELD_CREW" && soloNamedEntry?.burdenedHourlyRate === 30.85);

        const scheduleCoreCrewStart = scheduleCoreSource.indexOf("async function runSetProjectCrew");
        const scheduleCoreCrewEnd = scheduleCoreSource.indexOf("export interface CrewConflictPair", scheduleCoreCrewStart);
        const scheduleCoreCrewBody = scheduleCoreSource.slice(scheduleCoreCrewStart, scheduleCoreCrewEnd);
        check("source validates ACTIVATED only for users being added to project crew",
            scheduleCoreCrewBody.includes("toConnect.map(id => byId.get(id)!).filter(u => u.status !== \"ACTIVATED\")"));
        const scheduleCoreTaskCrewStart = scheduleCoreSource.indexOf("async function runSetTaskCrew");
        const scheduleCoreTaskCrewBody = scheduleCoreSource.slice(scheduleCoreTaskCrewStart);
        check("source validates ACTIVATED only for users being added to task crew",
            scheduleCoreTaskCrewBody.includes("toAdd.map(id => byId.get(id)!).filter(u => u.status !== \"ACTIVATED\")"));
        check("teamMembers query is FIELD_CREW-only (no admins/office/finance schedulable)", scheduleCoreSource.includes('where: { status: "ACTIVATED", role: "FIELD_CREW" }'));

        // Batch task-date save (fix 2) — ADMIN/MANAGER gated, loops the ONE
        // canonical updateScheduleTask (not a second mutation core), isolates
        // per-task failures, and reports per-task results.
        const batchActionStart = actionsSource.indexOf("export async function saveCompanyScheduleTaskDatesAction");
        const batchActionEnd = actionsSource.indexOf("export async function updateProjectColor", batchActionStart);
        const batchActionBody = actionsSource.slice(batchActionStart, batchActionEnd);
        check("saveCompanyScheduleTaskDatesAction exists and is ADMIN/MANAGER gated",
            batchActionStart >= 0 && batchActionBody.includes('["ADMIN", "MANAGER"].includes(caller.role)'));
        check("saveCompanyScheduleTaskDatesAction loops the canonical updateScheduleTask exactly once per deduped change (not a second mutation core)",
            (batchActionBody.match(/updateScheduleTask\(/g) ?? []).length === 1
            && batchActionBody.includes("for (const change of deduped)")
            && batchActionBody.includes('if (changes.length > 200) throw new Error("Too many schedule changes')
            && batchActionBody.includes("new Map(changes.map(change => [change.taskId, change]))"));
        check("saveCompanyScheduleTaskDatesAction isolates per-task failures and reports per-task ok/succeeded/failed results",
            batchActionBody.includes("try {") && batchActionBody.includes("catch (err")
            && batchActionBody.includes("ok: true") && batchActionBody.includes("ok: false")
            && batchActionBody.includes("succeeded:") && batchActionBody.includes("failed:"));

        let batchActionRan = false;
        let batchActionErr = "";
        try {
            const batchResult = await saveCompanyScheduleTaskDatesAction([{ taskId: crewTask.id, startDate: "2040-06-01", endDate: "2040-06-02" }]);
            batchActionRan = true;
            check("saveCompanyScheduleTaskDatesAction returns per-task results when it runs in a request scope",
                Array.isArray(batchResult.results) && typeof batchResult.succeeded === "number" && typeof batchResult.failed === "number");
        } catch (error) {
            batchActionErr = String((error as Error)?.message ?? error);
        }
        check("saveCompanyScheduleTaskDatesAction is reachable (runs, or hits the expected script auth wall outside a request scope)",
            batchActionRan || /Unauthorized|Forbidden|outside a request scope|headers/i.test(batchActionErr));

        const boardSource = readFileSync(new URL("../src/app/company-dashboard/schedule-board/ScheduleBoard.tsx", import.meta.url), "utf8");
        const monthSource = readFileSync(new URL("../src/app/company-dashboard/schedule-board/MonthBarsView.tsx", import.meta.url), "utf8");
        const timelineSource = readFileSync(new URL("../src/app/company-dashboard/schedule-board/TimelineView.tsx", import.meta.url), "utf8");
        const projectBarSource = readFileSync(new URL("../src/app/company-dashboard/schedule-board/ProjectBar.tsx", import.meta.url), "utf8");
        const projectDrawerSource = readFileSync(new URL("../src/app/company-dashboard/schedule-board/BoardProjectDrawer.tsx", import.meta.url), "utf8");
        const drawerShellSource = readFileSync(new URL("../src/app/company-dashboard/schedule-board/BoardDrawerShell.tsx", import.meta.url), "utf8");
        const taskBlockSource = readFileSync(new URL("../src/app/company-dashboard/schedule-board/TaskBlockSegment.tsx", import.meta.url), "utf8");
        const availabilityPanelSource = readFileSync(new URL("../src/app/company-dashboard/schedule-board/AvailabilityPanel.tsx", import.meta.url), "utf8");
        const scheduleBoardSources = [boardSource, monthSource, timelineSource, projectBarSource, projectDrawerSource, drawerShellSource, taskBlockSource, availabilityPanelSource];
        check("source forwards canEdit through both views to ProjectBar", monthSource.includes("canEdit={data.canEdit}")
            && timelineSource.includes("canEdit={data.canEdit}"));
        check("source forwards canEdit from ProjectBar to TaskBlockSegment", projectBarSource.includes("<TaskBlockSegment")
            && projectBarSource.includes("canEdit={canEdit}"));
        check("source guards milestone inputs behind the ADMIN overlay payload", monthSource.includes("const adminOverlays = data.isAdmin ? data.overlays : null")
            && timelineSource.includes("const adminOverlays = data.isAdmin ? data.overlays : null")
            && monthSource.includes("const milestoneMaps = adminOverlays ?")
            && timelineSource.includes("const visibleIncomeMilestones = adminOverlays && showIncome"));
        check("source persists the board view with the exact storage key", boardSource.includes('const BOARD_VIEW_STORAGE_KEY = "gtr-company-schedule-board-view"')
            && boardSource.includes("localStorage.getItem(BOARD_VIEW_STORAGE_KEY)")
            && boardSource.includes("localStorage.setItem(BOARD_VIEW_STORAGE_KEY, nextView)"));
        check("schedule-board components do not import or call money-fetch functions", scheduleBoardSources.every(source =>
            !/\b(?:getCashflowOutlook|getChangeOrderOverlayRows|getCalendarOverlays|getCompanyDashboardData)\b/.test(source)
            && !/\bfetch\s*\(/.test(source)));

        // ── Crew-availability panel (item PB-crew-availability) ──
        check("availability panel is rendered only for canEdit roles", boardSource.includes("{data.canEdit && <AvailabilityPanel"));
        check("availability panel's planned-$/day row is gated on canSeeFinancials", availabilityPanelSource.includes("{canSeeFinancials && (")
            && availabilityPanelSource.indexOf("Planned $/day") > availabilityPanelSource.indexOf("{canSeeFinancials && ("));
        check("availability panel derives from the DashboardProjectRow/DashboardTaskRow shape already on data (no direct prisma access)",
            !/\bprisma\b/.test(availabilityPanelSource));
        check("project drawer replaces the ProjectBar popover and surfaces the shop distance line",
            !projectBarSource.includes("FloatingPopover")
            && projectDrawerSource.includes("project.distanceMilesFromShop != null")
            && projectDrawerSource.includes("mi from shop")
            && projectDrawerSource.includes("layout=\"list\"")
            && drawerShellSource.includes("w-[min(420px,calc(100vw-1rem))]"));
    } finally {
        let cleanupPassed = false;
        try {
            if (estimateIds.length > 0) {
                await prisma.estimate.deleteMany({ where: { id: { in: estimateIds } } });
            }
            if (projectIds.length > 0) {
                await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
            }
            if (userIds.length > 0) {
                await prisma.user.deleteMany({ where: { id: { in: userIds } } });
            }
            if (clientId) {
                await prisma.client.deleteMany({ where: { id: clientId } });
            }

            const [projectsLeft, estimatesLeft, invoicesLeft, usersLeft, clientLeft] = await Promise.all([
                prisma.project.count({ where: { id: { in: projectIds } } }),
                prisma.estimate.count({ where: { id: { in: estimateIds } } }),
                prisma.invoice.count({ where: { id: { in: invoiceIds } } }),
                prisma.user.count({ where: { id: { in: userIds } } }),
                clientId ? prisma.client.count({ where: { id: clientId } }) : Promise.resolve(0),
            ]);
            cleanupPassed = projectsLeft === 0 && estimatesLeft === 0 && invoicesLeft === 0 && usersLeft === 0 && clientLeft === 0;
        } catch (error) {
            console.error("Fixture cleanup error:", error);
        }
        check("fixture cleanup removed collected client/project/estimate/invoice/user IDs", cleanupPassed);
    }

    let failures = 0;
    for (const [label, passed] of checks) {
        console.log(`${passed ? "PASS" : "FAIL"}  ${label}`);
        if (!passed) failures++;
    }
    if (failures > 0) throw new Error(`${failures} schedule-board verification check(s) failed`);
    console.log("ALL SCHEDULE BOARD CHECKS PASSED");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

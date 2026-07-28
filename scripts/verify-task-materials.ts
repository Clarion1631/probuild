// Behavioral verification for SPEC-c task materials and staging.
//
// This script exercises the session-free mutation/query core with isolated
// database fixtures, and statically verifies that authenticated Server Action
// wrappers and UI boundaries use that core safely.
//
// The release orchestrator must apply scripts/apply-task-materials-schema.mjs
// before the DB cases can pass. This verifier never applies schema itself.
//
// Usage against Supabase:
//   ALLOW_PROD_VERIFY=1 npx tsx scripts/verify-task-materials.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { prisma } from "../src/lib/prisma";
import {
    addTaskMaterialCore,
    deleteTaskMaterialCore,
    getStagingQueueCore,
    getTaskMaterialsCore,
    importEstimateMaterialsCore,
    setTaskMaterialStatusCore,
    updateTaskMaterialCore,
    type TaskMaterialActor,
} from "../src/lib/task-materials-core";

const DAY = 86_400_000;
const BASE = Date.UTC(2045, 2, 10);
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const FIXTURE_PREFIX = `TASK MATERIAL VERIFY ${RUN_ID}`;

function day(offset: number): Date {
    return new Date(BASE + offset * DAY);
}

function dayKey(offset: number): string {
    return day(offset).toISOString().slice(0, 10);
}

function source(path: string): string {
    return readFileSync(new URL(path, import.meta.url), "utf8");
}

async function rejectsWith(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
    let message = "";
    try {
        await run();
    } catch (error) {
        message = String((error as Error)?.message ?? error);
    }
    assert.match(message, pattern);
}

async function main() {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (databaseUrl.includes("supabase.c") && process.env.ALLOW_PROD_VERIFY !== "1") {
        console.error(
            "[verify-task-materials] REFUSING TO RUN: DATABASE_URL points at Supabase.\n" +
            "This script creates and deletes verification fixtures.\n" +
            "Set ALLOW_PROD_VERIFY=1 to opt in.",
        );
        process.exit(1);
    }

    const actionsSource = source("../src/lib/actions.ts");
    const coreSource = source("../src/lib/task-materials-core.ts");
    const scheduleCoreSource = source("../src/lib/schedule-core.ts");
    const schemaSource = source("../prisma/schema.prisma");
    const applySource = source("./apply-task-materials-schema.mjs");
    const detailSource = source("../src/app/projects/[id]/schedule/TaskDetailPanel.tsx");
    const materialSectionSource = source("../src/app/projects/[id]/schedule/TaskMaterialsSection.tsx");
    const dispatchCardSource = source("../src/app/company-dashboard/schedule-board/DispatchJobCard.tsx");
    const dispatchViewSource = source("../src/app/company-dashboard/schedule-board/DispatchView.tsx");
    const stagingPageSource = source("../src/app/company-dashboard/staging/page.tsx");
    const stagingClientSource = source("../src/app/company-dashboard/staging/StagingQueueClient.tsx");

    // Schema and migration contract.
    assert.match(schemaSource, /model TaskMaterial \{/);
    for (const field of [
        "taskId",
        "text",
        "quantity",
        "unit",
        "location",
        "status",
        "sourceKind",
        "sourceEstimateItemId",
        "resolutionNote",
        "order",
        "createdById",
        "statusChangedById",
        "statusChangedAt",
    ]) {
        assert.match(schemaSource, new RegExp(`\\b${field}\\b`), `TaskMaterial must include ${field}`);
    }
    assert.match(schemaSource, /@@index\(\[taskId, status\]\)/);
    assert.match(applySource, /CREATE TABLE IF NOT EXISTS "TaskMaterial"/);
    assert.match(applySource, /ENABLE ROW LEVEL SECURITY/);
    assert.doesNotMatch(applySource, /CREATE POLICY/i, "server-only TaskMaterial must not gain anon/authenticated policies");

    // Authenticated Server Action wrappers must keep the canonical schedule
    // task gate. The core is deliberately session-free for deterministic DB
    // verification, but it is not a Server Action surface.
    for (const functionName of [
        "getTaskMaterials",
        "addTaskMaterial",
        "updateTaskMaterial",
        "setTaskMaterialStatus",
        "deleteTaskMaterial",
        "importEstimateMaterials",
    ]) {
        const start = actionsSource.indexOf(`export async function ${functionName}(`);
        const end = actionsSource.indexOf("export async function", start + 1);
        const body = actionsSource.slice(start, end < 0 ? undefined : end);
        assert.ok(start >= 0, `${functionName} must exist in actions.ts`);
        assert.match(body, /assertScheduleTaskAccess\(/, `${functionName} must use the canonical task access gate`);
    }
    const stagingActionStart = actionsSource.indexOf("export async function getStagingQueue(");
    const stagingActionEnd = actionsSource.indexOf("export async function", stagingActionStart + 1);
    const stagingActionBody = actionsSource.slice(stagingActionStart, stagingActionEnd < 0 ? undefined : stagingActionEnd);
    assert.ok(stagingActionStart >= 0, "getStagingQueue must exist");
    assert.match(stagingActionBody, /assertStagingQueueAccess\(/);
    assert.match(actionsSource, /\["ADMIN", "MANAGER", "FIELD_CREW"\]/);

    // Domain and provenance rules live in the session-free core and are
    // enforced again by the DB behavioral cases below.
    assert.match(coreSource, /Resolved materials require a resolution note/);
    assert.match(coreSource, /canonicalContractEstimateQuery\(task\.projectId\)/);
    assert.match(coreSource, /isTaskActiveOnDay\(/);
    assert.match(coreSource, /createdById: (?:input\.)?actor\.userId/);
    assert.match(coreSource, /statusChangedById: (?:input\.)?actor\.userId/);
    assert.match(coreSource, /statusChangedAt:/);

    // Dashboard serialization is counts-only. The task contract and card may
    // know integers, but no material text or rows may cross this boundary.
    const dashboardTaskStart = scheduleCoreSource.indexOf("export interface DashboardTaskRow");
    const dashboardTaskEnd = scheduleCoreSource.indexOf("export interface", dashboardTaskStart + 1);
    const dashboardTaskContract = scheduleCoreSource.slice(dashboardTaskStart, dashboardTaskEnd);
    for (const field of ["pendingMaterials", "stagedMaterials", "missingMaterials"]) {
        assert.match(dashboardTaskContract, new RegExp(`${field}: number;`));
    }
    assert.doesNotMatch(dashboardTaskContract, /TaskMaterial|materials:|materialText|\btext:/);
    assert.match(scheduleCoreSource, /taskMaterial\.groupBy\(/);
    assert.doesNotMatch(scheduleCoreSource, /materials:\s*\{\s*(?:select|include)[\s\S]*?text:/);
    assert.match(dispatchCardSource, /pendingMaterials/);
    assert.match(dispatchCardSource, /stagedMaterials/);
    assert.match(dispatchCardSource, /missingMaterials/);
    assert.match(dispatchCardSource, /\\u\{1F4E6\}|📦/u);

    // Task drawer and staging-page render/action wiring.
    assert.match(detailSource, /TaskMaterialsSection/);
    assert.match(detailSource, /estimateItemId=\{task\.estimateItemId(?: \?\? null)?\}/);
    for (const action of [
        "getTaskMaterials",
        "addTaskMaterial",
        "updateTaskMaterial",
        "setTaskMaterialStatus",
        "deleteTaskMaterial",
        "importEstimateMaterials",
    ]) {
        assert.match(materialSectionSource, new RegExp(`\\b${action}\\b`));
    }
    assert.match(materialSectionSource, /Materials/);
    assert.match(materialSectionSource, /\[@media\(hover:none\)\]:opacity-100/);
    assert.match(stagingPageSource, /\["ADMIN", "MANAGER", "FIELD_CREW"\]/);
    assert.match(stagingPageSource, /hasPermission\(effectiveUser, "schedules"\)/);
    assert.doesNotMatch(stagingPageSource, /financialReports|contractValue|totalAmount|budget/i);
    assert.match(stagingClientSource, /getStagingQueue/);
    assert.match(stagingClientSource, /setTaskMaterialStatus/);
    assert.match(stagingClientSource, /Missing/);
    assert.match(stagingClientSource, /Today/);
    assert.match(dispatchViewSource, /href="\/company-dashboard\/staging"/);
    assert.match(dispatchViewSource, /Staging queue/);

    console.log("PASS static schema, auth, serializer, and render contracts");

    const collected = {
        clientIds: [] as string[],
        projectIds: [] as string[],
        estimateIds: [] as string[],
        userIds: [] as string[],
    };

    let cleanupPassed = false;
    try {
        const client = await prisma.client.create({
            data: {
                name: `${FIXTURE_PREFIX} CLIENT DELETE ME`,
                initials: "TM",
                email: `task-material-client-${RUN_ID}@example.invalid`,
            },
        });
        collected.clientIds.push(client.id);

        const creator = await prisma.user.create({
            data: {
                email: `task-material-creator-${RUN_ID}@example.invalid`,
                name: `${FIXTURE_PREFIX} Creator`,
                role: "FIELD_CREW",
                status: "ACTIVATED",
            },
        });
        const otherCrew = await prisma.user.create({
            data: {
                email: `task-material-other-${RUN_ID}@example.invalid`,
                name: `${FIXTURE_PREFIX} Other`,
                role: "FIELD_CREW",
                status: "ACTIVATED",
            },
        });
        const manager = await prisma.user.create({
            data: {
                email: `task-material-manager-${RUN_ID}@example.invalid`,
                name: `${FIXTURE_PREFIX} Manager`,
                role: "MANAGER",
                status: "ACTIVATED",
            },
        });
        collected.userIds.push(creator.id, otherCrew.id, manager.id);

        const creatorActor: TaskMaterialActor = {
            userId: creator.id,
            role: creator.role,
            name: creator.name ?? creator.email,
        };
        const otherActor: TaskMaterialActor = {
            userId: otherCrew.id,
            role: otherCrew.role,
            name: otherCrew.name ?? otherCrew.email,
        };
        const managerActor: TaskMaterialActor = {
            userId: manager.id,
            role: manager.role,
            name: manager.name ?? manager.email,
        };

        const project = await prisma.project.create({
            data: {
                name: `${FIXTURE_PREFIX} PROJECT DELETE ME`,
                clientId: client.id,
                status: "In Progress",
                startDate: day(0),
                color: "#4f46e5",
                location: "123 Verify Way",
                userAccess: {
                    create: [
                        { userId: creator.id },
                        { userId: otherCrew.id },
                    ],
                },
            },
        });
        collected.projectIds.push(project.id);

        const estimate = await prisma.estimate.create({
            data: {
                title: `${FIXTURE_PREFIX} CONTRACT`,
                projectId: project.id,
                code: `TM-${RUN_ID}`,
                status: "Approved",
                totalAmount: 100,
                balanceDue: 100,
            },
        });
        collected.estimateIds.push(estimate.id);

        const rootItem = await prisma.estimateItem.create({
            data: {
                estimateId: estimate.id,
                name: "Cabinet installation",
                type: "Labor",
                order: 0,
            },
        });
        const plywoodItem = await prisma.estimateItem.create({
            data: {
                estimateId: estimate.id,
                parentId: rootItem.id,
                name: "Cabinet-grade plywood",
                type: "Material",
                quantity: 4,
                budgetUnit: "sheet",
                order: 1,
            },
        });
        const screwsItem = await prisma.estimateItem.create({
            data: {
                estimateId: estimate.id,
                parentId: rootItem.id,
                name: "Cabinet screws",
                type: "Material",
                quantity: 2,
                budgetUnit: "box",
                order: 2,
            },
        });
        await prisma.estimateItem.create({
            data: {
                estimateId: estimate.id,
                parentId: rootItem.id,
                name: "Install cabinets",
                type: "Labor",
                quantity: 8,
                budgetUnit: "hour",
                order: 3,
            },
        });

        const task = await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                estimateItemId: rootItem.id,
                name: "Install cabinets",
                startDate: day(0),
                endDate: day(2),
                status: "Not Started",
                order: 0,
            },
        });
        const milestone = await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                name: "Cabinet delivery",
                startDate: day(2),
                endDate: day(2),
                type: "milestone",
                status: "Not Started",
                order: 1,
            },
        });

        const waitingProject = await prisma.project.create({
            data: {
                name: `${FIXTURE_PREFIX} WAITING DELETE ME`,
                clientId: client.id,
                status: "Waiting to Start",
                startDate: day(0),
            },
        });
        collected.projectIds.push(waitingProject.id);
        const waitingTask = await prisma.scheduleTask.create({
            data: {
                projectId: waitingProject.id,
                name: "Waiting task",
                startDate: day(0),
                endDate: day(3),
            },
        });

        // Add/update/status provenance and domain rules.
        const disposable = await addTaskMaterialCore({
            taskId: task.id,
            input: { text: "Disposable shim", quantity: 1, unit: "pack", location: "Truck" },
            actor: creatorActor,
        });
        assert.equal(disposable.createdById, creator.id);
        await rejectsWith(
            () => deleteTaskMaterialCore({ materialId: disposable.id, actor: otherActor }),
            /Only the creator, an admin, or a manager can delete/i,
        );
        assert.ok(await prisma.taskMaterial.findUnique({ where: { id: disposable.id } }));
        await deleteTaskMaterialCore({ materialId: disposable.id, actor: creatorActor });
        assert.equal(await prisma.taskMaterial.count({ where: { id: disposable.id } }), 0);

        const manual = await addTaskMaterialCore({
            taskId: task.id,
            input: {
                text: "Jobsite primer",
                quantity: 2.5,
                unit: "gal",
                location: "Garage",
            },
            actor: creatorActor,
        });
        assert.equal(manual.sourceKind, "manual");
        assert.equal(manual.createdById, creator.id);
        assert.equal(manual.quantity, 2.5);

        const updated = await updateTaskMaterialCore({
            materialId: manual.id,
            input: {
                text: "Low-VOC jobsite primer",
                quantity: 3,
                unit: "gal",
                location: "North garage",
            },
            actor: creatorActor,
        });
        assert.equal(updated.text, "Low-VOC jobsite primer");
        assert.equal(updated.location, "North garage");

        await rejectsWith(
            () => setTaskMaterialStatusCore({
                materialId: manual.id,
                status: "resolved",
                actor: otherActor,
            }),
            /Resolved materials require a resolution note/i,
        );
        assert.equal((await prisma.taskMaterial.findUniqueOrThrow({ where: { id: manual.id } })).status, "pending");

        const staged = await setTaskMaterialStatusCore({
            materialId: manual.id,
            status: "staged",
            actor: otherActor,
        });
        assert.equal(staged.status, "staged");
        assert.equal(staged.statusChangedById, otherCrew.id);
        assert.ok(staged.statusChangedAt);

        const resolved = await setTaskMaterialStatusCore({
            materialId: manual.id,
            status: "resolved",
            resolutionNote: "Substituted the approved low-VOC product.",
            actor: managerActor,
        });
        assert.equal(resolved.resolutionNote, "Substituted the approved low-VOC product.");
        assert.equal(resolved.statusChangedById, manager.id);

        const provenanceLogs = await prisma.activityLog.findMany({
            where: {
                projectId: project.id,
                entityType: "task_material",
                entityId: manual.id,
            },
            orderBy: { createdAt: "asc" },
        });
        assert.ok(provenanceLogs.some(log => log.action === "add_task_material" && log.actorName === creatorActor.name));
        assert.ok(provenanceLogs.some(log => log.action === "set_task_material_status" && log.actorName === otherActor.name));
        assert.ok(provenanceLogs.some(log => log.action === "set_task_material_status" && log.actorName === managerActor.name));
        console.log("PASS add/update/status/delete rules and actor provenance");

        // Canonical estimate import is additive and deduplicated.
        const manualPending = await addTaskMaterialCore({
            taskId: task.id,
            input: { text: "Manual protection paper", quantity: 1, unit: "roll", location: "Shop" },
            actor: creatorActor,
        });
        const firstImport = await importEstimateMaterialsCore({ taskId: task.id, actor: managerActor });
        assert.equal(firstImport.created, 2);
        const importedAfterFirst = await prisma.taskMaterial.findMany({
            where: { taskId: task.id, sourceKind: "estimate" },
            orderBy: { sourceEstimateItemId: "asc" },
        });
        assert.deepEqual(
            new Set(importedAfterFirst.map(row => row.sourceEstimateItemId)),
            new Set([plywoodItem.id, screwsItem.id]),
        );
        assert.ok(importedAfterFirst.every(row => row.createdById === manager.id));

        const stagedEstimate = importedAfterFirst.find(row => row.sourceEstimateItemId === plywoodItem.id)!;
        await setTaskMaterialStatusCore({
            materialId: stagedEstimate.id,
            status: "staged",
            actor: creatorActor,
        });
        await prisma.estimateItem.update({
            where: { id: plywoodItem.id },
            data: { name: "Renamed plywood must not overwrite", quantity: 99 },
        });
        const hingesItem = await prisma.estimateItem.create({
            data: {
                estimateId: estimate.id,
                parentId: rootItem.id,
                name: "Soft-close hinges",
                type: "Material",
                quantity: 12,
                budgetUnit: "ea",
                order: 4,
            },
        });

        const secondImport = await importEstimateMaterialsCore({ taskId: task.id, actor: managerActor });
        assert.equal(secondImport.created, 1);
        assert.equal((await prisma.taskMaterial.findUniqueOrThrow({ where: { id: stagedEstimate.id } })).text, "Cabinet-grade plywood");
        assert.equal((await prisma.taskMaterial.findUniqueOrThrow({ where: { id: stagedEstimate.id } })).status, "staged");
        assert.equal((await prisma.taskMaterial.findUniqueOrThrow({ where: { id: manualPending.id } })).text, "Manual protection paper");
        assert.equal((await prisma.taskMaterial.findUniqueOrThrow({ where: { id: manualPending.id } })).status, "pending");
        assert.equal(
            await prisma.taskMaterial.count({
                where: { taskId: task.id, sourceEstimateItemId: hingesItem.id },
            }),
            1,
        );
        assert.equal((await importEstimateMaterialsCore({ taskId: task.id, actor: managerActor })).created, 0);
        console.log("PASS canonical estimate import, deduplication, and sacred-row preservation");

        // Queue grouping/counts and half-open date semantics.
        const missing = await addTaskMaterialCore({
            taskId: task.id,
            input: { text: "Missing queue probe", quantity: 1, unit: "ea", location: "Shop" },
            actor: creatorActor,
        });
        await setTaskMaterialStatusCore({
            materialId: missing.id,
            status: "missing",
            resolutionNote: "Vendor shorted the order.",
            actor: creatorActor,
        });
        await addTaskMaterialCore({
            taskId: milestone.id,
            input: { text: "Milestone delivery packet", quantity: 1, unit: "packet" },
            actor: creatorActor,
        });
        await addTaskMaterialCore({
            taskId: waitingTask.id,
            input: { text: "Must stay outside In Progress queue", quantity: 1, unit: "ea" },
            actor: managerActor,
        });

        const activeQueue = await getStagingQueueCore(dayKey(1));
        const activeGroup = activeQueue.projects.find(group => group.projectId === project.id);
        assert.ok(activeGroup);
        assert.ok(activeGroup.materials.some(row => row.taskId === task.id));
        assert.ok(activeGroup.materials.every(row => row.taskId !== milestone.id));
        assert.ok(activeQueue.projects.every(group => group.projectId !== waitingProject.id));
        assert.equal(activeGroup.counts.pending, activeGroup.materials.filter(row => row.status === "pending").length);
        assert.equal(activeGroup.counts.staged, activeGroup.materials.filter(row => row.status === "staged").length);
        assert.equal(activeGroup.counts.missing, activeGroup.materials.filter(row => row.status === "missing").length);
        assert.equal(activeQueue.counts.pending, activeQueue.projects.reduce((sum, group) => sum + group.counts.pending, 0));
        assert.equal(activeQueue.counts.staged, activeQueue.projects.reduce((sum, group) => sum + group.counts.staged, 0));
        assert.equal(activeQueue.counts.missing, activeQueue.projects.reduce((sum, group) => sum + group.counts.missing, 0));

        const boundaryQueue = await getStagingQueueCore(dayKey(2));
        const boundaryGroup = boundaryQueue.projects.find(group => group.projectId === project.id);
        assert.ok(boundaryGroup);
        assert.ok(boundaryGroup.materials.some(row => row.taskId === milestone.id), "milestone is active on its start day");
        assert.ok(boundaryGroup.materials.every(row => row.taskId !== task.id), "normal task end is half-open");
        console.log("PASS staging grouping/counts and half-open active-day boundaries");

        const rows = await getTaskMaterialsCore(task.id);
        assert.ok(rows.length >= 5);
        assert.ok(rows.every(row => typeof row.quantity === "number" || row.quantity === null));

        const managerDisposable = await addTaskMaterialCore({
            taskId: task.id,
            input: { text: "Manager delete probe" },
            actor: creatorActor,
        });
        await deleteTaskMaterialCore({ materialId: managerDisposable.id, actor: managerActor });
        assert.equal(await prisma.taskMaterial.count({ where: { id: managerDisposable.id } }), 0);
        console.log("PASS task-material read serialization and manager deletion");
    } finally {
        try {
            if (collected.estimateIds.length > 0) {
                await prisma.estimate.deleteMany({ where: { id: { in: collected.estimateIds } } });
            }
            if (collected.projectIds.length > 0) {
                await prisma.project.deleteMany({ where: { id: { in: collected.projectIds } } });
            }
            if (collected.userIds.length > 0) {
                await prisma.user.deleteMany({ where: { id: { in: collected.userIds } } });
            }
            if (collected.clientIds.length > 0) {
                await prisma.client.deleteMany({ where: { id: { in: collected.clientIds } } });
            }

            const [clientsLeft, projectsLeft, estimatesLeft, usersLeft] = await Promise.all([
                prisma.client.count({ where: { id: { in: collected.clientIds } } }),
                prisma.project.count({ where: { id: { in: collected.projectIds } } }),
                prisma.estimate.count({ where: { id: { in: collected.estimateIds } } }),
                prisma.user.count({ where: { id: { in: collected.userIds } } }),
            ]);
            cleanupPassed = clientsLeft === 0 && projectsLeft === 0 && estimatesLeft === 0 && usersLeft === 0;
        } catch (error) {
            console.error("Fixture cleanup error:", error);
        }
        console.log(`${cleanupPassed ? "PASS" : "FAIL"} fixture cleanup`);
    }

    assert.equal(cleanupPassed, true);
    console.log("task-materials verification: PASS");
}

main()
    .catch(error => {
        console.error("task-materials verification: FAIL");
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await prisma.$disconnect();
        } catch {
            // Static-contract failures can happen before DATABASE_URL is loaded.
        }
    });

// Behavioral verification for SPEC-f MCP schedule tools.
//
// This verifier never applies schema. The release orchestrator must run
// scripts/apply-mcp-confirmations-schema.mjs before the DB cases can pass.
//
// Usage against Supabase:
//   $env:ALLOW_PROD_VERIFY="1"
//   npx tsx --env-file=.env.local scripts/verify-mcp-schedule-tools.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { prisma } from "../src/lib/prisma";

const DAY = 86_400_000;
const BASE = Date.UTC(2048, 4, 4);
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const FIXTURE_PREFIX = `MCP SCHEDULE VERIFY ${RUN_ID}`;

function day(offset: number): Date {
    return new Date(BASE + offset * DAY);
}

function dayKey(offset: number): string {
    return day(offset).toISOString().slice(0, 10);
}

function source(path: string): string {
    return readFileSync(new URL(path, import.meta.url), "utf8");
}

function loadDatabaseUrl(): string {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    for (const file of [".env.local", ".env"]) {
        if (!existsSync(file)) continue;
        const match = readFileSync(file, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
        if (match) {
            process.env.DATABASE_URL = match[1];
            return match[1];
        }
    }
    return "";
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

function normalizedKey(key: string): string {
    return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const FORBIDDEN_AVAILABILITY_KEYS = new Set([
    "email",
    "rate",
    "hourlyrate",
    "burdenrate",
    "burdenedhourlyrate",
    "cost",
    "amount",
    "total",
    "budget",
    "revenue",
    "contractvalue",
    "financials",
]);

function assertNoFinancialKeys(value: unknown, path = "availability"): void {
    if (Array.isArray(value)) {
        value.forEach((child, index) => assertNoFinancialKeys(child, `${path}[${index}]`));
        return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        // materialCounts.{pending,staged,missing,resolved,total} are item
        // COUNTS, not money — the one sanctioned "total" in MCP output.
        if (path.endsWith(".materialCounts") && normalizedKey(key) === "total") continue;
        assert.ok(
            !FORBIDDEN_AVAILABILITY_KEYS.has(normalizedKey(key)),
            `${path}.${key} is forbidden in MCP availability output`,
        );
        assertNoFinancialKeys(child, `${path}.${key}`);
    }
}

function confirmationToken(result: any): string {
    assert.equal(result.confirmationRequired, true);
    assert.equal(typeof result.preview, "string");
    assert.ok(result.preview.length > 0);
    assert.match(result.confirmToken, /^[a-f0-9]{64}$/);
    assert.ok(Date.parse(result.expiresAt) > Date.now());
    return result.confirmToken;
}

async function main() {
    const databaseUrl = loadDatabaseUrl();
    if (databaseUrl.includes("supabase.c") && process.env.ALLOW_PROD_VERIFY !== "1") {
        console.error(
            "[verify-mcp-schedule-tools] REFUSING TO RUN: DATABASE_URL points at Supabase.\n" +
            "This script creates and deletes verification fixtures.\n" +
            "Set ALLOW_PROD_VERIFY=1 to opt in.",
        );
        process.exit(1);
    }

    // This file is intentionally the first implementation artifact. Its first
    // pre-implementation run must fail here, before any production module or
    // schema change exists.
    const coreUrl = new URL("../src/lib/mcp-schedule-tools.ts", import.meta.url);
    assert.ok(
        existsSync(coreUrl),
        "src/lib/mcp-schedule-tools.ts does not exist yet (expected RED before implementation)",
    );

    const routeSource = source("../src/app/api/mcp/[transport]/route.ts");
    const schemaSource = source("../prisma/schema.prisma");
    const coreSource = source("../src/lib/mcp-schedule-tools.ts");
    const taskCoreSource = source("../src/lib/schedule-task-core.ts");
    const applySource = source("./apply-mcp-confirmations-schema.mjs");

    // Static schema/security and registry contract.
    assert.match(schemaSource, /model McpConfirmation \{/);
    for (const field of [
        "token",
        "toolName",
        "argsHash",
        "preview",
        "createdAt",
        "expiresAt",
        "consumedAt",
    ]) {
        assert.match(schemaSource, new RegExp(`\\b${field}\\b`), `McpConfirmation must include ${field}`);
    }
    assert.match(schemaSource, /\btoken\s+String\s+@unique/);
    assert.match(applySource, /CREATE TABLE IF NOT EXISTS "McpConfirmation"/);
    assert.match(applySource, /ENABLE ROW LEVEL SECURITY/);
    assert.doesNotMatch(applySource, /CREATE POLICY/i, "server-only confirmations must have no anon/authenticated policy");
    assert.match(coreSource, /randomBytes\(32\)\.toString\("hex"\)/);
    assert.match(coreSource, /createHash\("sha256"\)/);
    assert.match(coreSource, /consumedAt:\s*null/);
    assert.match(coreSource, /expiresAt:\s*\{\s*gt:/);
    assert.match(coreSource, /updateMany\(/);
    assert.match(coreSource, /prisma\.\$transaction\(/);
    assert.match(taskCoreSource, /Prisma\.TransactionClient/);

    for (const toolName of [
        "get_project_schedule",
        "plan_schedule",
        "update_task_dates",
        "set_task_status",
        "assign_task_crew",
        "list_crew_availability",
        "set_project_start_date",
        "generate_project_schedule",
        "assign_project_crew",
        "apply_change_order_to_schedule",
    ]) {
        assert.match(routeSource, new RegExp(`"${toolName}"`), `${toolName} must stay registered`);
    }
    for (const adapter of [
        "getProjectSchedule",
        "planSchedule",
        "updateTaskDates",
        "setTaskStatus",
        "assignTaskCrew",
        "listCrewAvailability",
        "setProjectStartDateWithConfirmation",
        "generateProjectScheduleWithConfirmation",
        "assignProjectCrewWithConfirmation",
        "applyChangeOrderToScheduleWithConfirmation",
    ]) {
        assert.match(routeSource, new RegExp(`\\b${adapter}\\b`), `route must delegate to ${adapter}`);
    }
    assert.match(routeSource, /YYYY-MM-DD/);
    assert.match(routeSource, /confirmation token|confirmToken/i);
    assert.match(routeSource, /serverInfo:\s*\{\s*name:\s*"probuild",\s*version:\s*"(?!1\.10\.0)[^"]+"/);

    // Customer-facing send tools deliberately stay on the established HMAC
    // flow; schedule writers must not call that stateless helper.
    assert.match(routeSource, /function mintPreviewToken/);
    assert.match(routeSource, /function verifyPreviewToken/);
    const scheduleStart = routeSource.indexOf('"get_company_schedule"');
    const scheduleRegistry = routeSource.slice(scheduleStart);
    assert.doesNotMatch(scheduleRegistry, /mintPreviewToken|verifyPreviewToken/);
    console.log("PASS static confirmation schema, RLS, registry, and delegation contracts");

    const tools: any = await import("../src/lib/mcp-schedule-tools");
    const confirmationDelegate = (prisma as any).mcpConfirmation;

    // Fails cleanly with P2021 until the release orchestrator applies the new
    // table. No fixture is written before this schema readiness check.
    await confirmationDelegate.findFirst({ select: { id: true } });

    const collected = {
        clientIds: [] as string[],
        projectIds: [] as string[],
        userIds: [] as string[],
        confirmationTokens: [] as string[],
    };
    let cleanupPassed = false;

    try {
        const client = await prisma.client.create({
            data: {
                name: `${FIXTURE_PREFIX} CLIENT DELETE ME`,
                initials: "MS",
                email: `mcp-schedule-client-${RUN_ID}@example.invalid`,
            },
        });
        collected.clientIds.push(client.id);

        const alice = await prisma.user.create({
            data: {
                email: `alice-${RUN_ID}@example.invalid`,
                name: "Alice Johnson",
                role: "FIELD_CREW",
                status: "ACTIVATED",
            },
        });
        const bob = await prisma.user.create({
            data: {
                email: `bob-${RUN_ID}@example.invalid`,
                name: "Bob Stone",
                role: "FIELD_CREW",
                status: "ACTIVATED",
            },
        });
        const samOne = await prisma.user.create({
            data: {
                email: `sam-one-${RUN_ID}@example.invalid`,
                name: "Sam Rivera",
                role: "FIELD_CREW",
                status: "ACTIVATED",
            },
        });
        const samTwo = await prisma.user.create({
            data: {
                email: `sam-two-${RUN_ID}@example.invalid`,
                name: "Sam Taylor",
                role: "FIELD_CREW",
                status: "ACTIVATED",
            },
        });
        collected.userIds.push(alice.id, bob.id, samOne.id, samTwo.id);

        const project = await prisma.project.create({
            data: {
                name: `${FIXTURE_PREFIX} PROJECT DELETE ME`,
                clientId: client.id,
                status: "In Progress",
                startDate: day(0),
                endDate: day(20),
                color: "#2563eb",
                crew: { connect: [{ id: alice.id }, { id: bob.id }] },
            },
        });
        collected.projectIds.push(project.id);

        const lifecycleTask = await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                name: "Lifecycle probe",
                startDate: day(1),
                endDate: day(3),
                status: "Not Started",
            },
        });
        const expiredTask = await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                name: "Expired probe",
                startDate: day(2),
                endDate: day(4),
                status: "Not Started",
            },
        });
        const tamperTask = await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                name: "Tamper probe",
                startDate: day(3),
                endDate: day(5),
                status: "Not Started",
            },
        });
        const concurrentTask = await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                name: "Concurrent probe",
                startDate: day(4),
                endDate: day(6),
                status: "Not Started",
            },
        });

        // Confirmation lifecycle: happy path consumes once, replay fails.
        const happyArgs = { taskId: lifecycleTask.id, startDate: dayKey(5), endDate: dayKey(7) };
        const happyPreview = await tools.updateTaskDates(happyArgs);
        const happyToken = confirmationToken(happyPreview);
        collected.confirmationTokens.push(happyToken);
        const happy = await tools.updateTaskDates({ ...happyArgs, confirmToken: happyToken });
        assert.equal(happy.confirmed, true);
        const lifecycleAfter = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: lifecycleTask.id } });
        assert.equal(lifecycleAfter.startDate.toISOString().slice(0, 10), dayKey(5));
        assert.ok((await confirmationDelegate.findUniqueOrThrow({ where: { token: happyToken } })).consumedAt);
        await rejectsWith(
            () => tools.updateTaskDates({ ...happyArgs, confirmToken: happyToken }),
            /already used|consumed|confirmation/i,
        );

        // Expired tokens fail without mutating the task.
        const expiredArgs = { taskId: expiredTask.id, startDate: dayKey(6), endDate: dayKey(8) };
        const expiredPreview = await tools.updateTaskDates(expiredArgs);
        const expiredToken = confirmationToken(expiredPreview);
        collected.confirmationTokens.push(expiredToken);
        await confirmationDelegate.update({
            where: { token: expiredToken },
            data: { expiresAt: new Date(Date.now() - 1_000) },
        });
        await rejectsWith(
            () => tools.updateTaskDates({ ...expiredArgs, confirmToken: expiredToken }),
            /expired/i,
        );
        assert.equal(
            (await prisma.scheduleTask.findUniqueOrThrow({ where: { id: expiredTask.id } })).startDate.toISOString().slice(0, 10),
            dayKey(2),
        );

        // A token is bound to canonical arguments.
        const tamperArgs = { taskId: tamperTask.id, startDate: dayKey(7), endDate: dayKey(9) };
        const tamperPreview = await tools.updateTaskDates(tamperArgs);
        const tamperToken = confirmationToken(tamperPreview);
        collected.confirmationTokens.push(tamperToken);
        await rejectsWith(
            () => tools.updateTaskDates({ ...tamperArgs, endDate: dayKey(10), confirmToken: tamperToken }),
            /arguments|tamper|match|confirmation/i,
        );
        assert.equal(
            (await prisma.scheduleTask.findUniqueOrThrow({ where: { id: tamperTask.id } })).startDate.toISOString().slice(0, 10),
            dayKey(3),
        );

        // Concurrent double-consume: the claim and schedule mutation share one
        // transaction, so exactly one contender commits.
        const concurrentArgs = { taskId: concurrentTask.id, startDate: dayKey(8), endDate: dayKey(10) };
        const concurrentPreview = await tools.updateTaskDates(concurrentArgs);
        const concurrentToken = confirmationToken(concurrentPreview);
        collected.confirmationTokens.push(concurrentToken);
        const contenders = await Promise.allSettled([
            tools.updateTaskDates({ ...concurrentArgs, confirmToken: concurrentToken }),
            tools.updateTaskDates({ ...concurrentArgs, confirmToken: concurrentToken }),
        ]);
        assert.equal(contenders.filter(result => result.status === "fulfilled").length, 1);
        assert.equal(contenders.filter(result => result.status === "rejected").length, 1);
        console.log("PASS confirmation happy path, replay, expiry, tamper, and concurrent single-consume");

        // Bulk creation resolves first and full names, preserves lead role, and
        // creates every task inside the confirmation transaction.
        const planArgs = {
            projectId: project.id,
            tasks: [
                {
                    name: "Demo kitchen",
                    startDate: dayKey(10),
                    endDate: dayKey(12),
                    crewNames: ["Alice", "Bob Stone"],
                    leadName: "Alice Johnson",
                    doneWhen: "Kitchen is cleared and swept",
                    estimatedHours: 16,
                },
                {
                    name: "Owner walkthrough",
                    startDate: dayKey(12),
                    endDate: dayKey(12),
                    type: "appointment",
                    scheduledTime: "14:30",
                    crewNames: ["Bob"],
                },
            ],
        };
        const planPreview = await tools.planSchedule(planArgs);
        const planToken = confirmationToken(planPreview);
        collected.confirmationTokens.push(planToken);
        assert.match(planPreview.preview, /Demo kitchen/);
        assert.match(planPreview.preview, /Owner walkthrough/);
        assert.match(planPreview.preview, /Alice Johnson/);
        const planned = await tools.planSchedule({ ...planArgs, confirmToken: planToken });
        assert.equal(planned.confirmed, true);
        assert.equal(planned.created.length, 2);
        const demo = await prisma.scheduleTask.findFirstOrThrow({
            where: { projectId: project.id, name: "Demo kitchen" },
            include: { assignments: true },
        });
        assert.equal(demo.assignments.length, 2);
        assert.equal(demo.assignments.find(assignment => assignment.role === "lead")?.userId, alice.id);

        await rejectsWith(
            () => tools.planSchedule({
                projectId: project.id,
                tasks: [{
                    name: "Ambiguous crew probe",
                    startDate: dayKey(13),
                    endDate: dayKey(14),
                    crewNames: ["Sam"],
                }],
            }),
            /ambiguous.*Sam Rivera.*Sam Taylor|Sam Rivera.*Sam Taylor.*ambiguous/i,
        );

        // A failure discovered during execution rolls back earlier creates.
        const atomicArgs = {
            projectId: project.id,
            tasks: [
                { name: "Atomic first", startDate: dayKey(14), endDate: dayKey(15) },
                { name: "Atomic second", startDate: dayKey(15), endDate: dayKey(16), crewNames: ["Bob"] },
            ],
        };
        const atomicPreview = await tools.planSchedule(atomicArgs);
        const atomicToken = confirmationToken(atomicPreview);
        collected.confirmationTokens.push(atomicToken);
        await prisma.user.update({ where: { id: bob.id }, data: { status: "DISABLED" } });
        await rejectsWith(
            () => tools.planSchedule({ ...atomicArgs, confirmToken: atomicToken }),
            /ACTIVATED|crew/i,
        );
        await prisma.user.update({ where: { id: bob.id }, data: { status: "ACTIVATED" } });
        assert.equal(
            await prisma.scheduleTask.count({
                where: { projectId: project.id, name: { in: ["Atomic first", "Atomic second"] } },
            }),
            0,
        );
        console.log("PASS plan_schedule bulk create, crew resolution, ambiguity, and transaction rollback");

        // Thin wrappers retain the canonical domain rules.
        await rejectsWith(
            () => tools.setTaskStatus({ taskId: demo.id, status: "Blocked" }),
            /Blocked tasks require a reason/i,
        );
        const blockedArgs = { taskId: demo.id, status: "Blocked", blockedReason: "Waiting for inspection" };
        const blockedPreview = await tools.setTaskStatus(blockedArgs);
        const blockedToken = confirmationToken(blockedPreview);
        collected.confirmationTokens.push(blockedToken);
        await tools.setTaskStatus({ ...blockedArgs, confirmToken: blockedToken });
        assert.equal((await prisma.scheduleTask.findUniqueOrThrow({ where: { id: demo.id } })).blockedReason, "Waiting for inspection");

        await rejectsWith(
            () => tools.updateTaskDates({ taskId: demo.id, startDate: dayKey(18), endDate: dayKey(17) }),
            /end date/i,
        );

        const crewArgs = {
            taskId: demo.id,
            crewNames: ["Bob Stone"],
            leadName: "Bob",
        };
        const crewPreview = await tools.assignTaskCrew(crewArgs);
        const crewToken = confirmationToken(crewPreview);
        collected.confirmationTokens.push(crewToken);
        const crewResult = await tools.assignTaskCrew({ ...crewArgs, confirmToken: crewToken });
        assert.equal(crewResult.assignments.length, 1);
        assert.equal(crewResult.assignments[0].userId, bob.id);
        assert.equal(crewResult.assignments[0].role, "lead");
        console.log("PASS status, dates, and task-crew wrappers enforce canonical rules");

        await prisma.taskMaterial.create({
            data: {
                taskId: demo.id,
                text: "Dust barrier",
                status: "pending",
                sourceKind: "manual",
            },
        });
        await prisma.taskMaterial.create({
            data: {
                taskId: demo.id,
                text: "Floor protection",
                status: "staged",
                sourceKind: "manual",
            },
        });
        const projectSchedule = await tools.getProjectSchedule({ jobName: project.name });
        assertNoFinancialKeys(projectSchedule);
        assert.equal(projectSchedule.projectId, project.id);
        const demoRead = projectSchedule.tasks.find((task: any) => task.id === demo.id);
        assert.ok(demoRead);
        assert.deepEqual(demoRead.materialCounts, { pending: 1, staged: 1, missing: 0, resolved: 0, total: 2 });
        assert.equal(demoRead.leadName, "Bob Stone");
        assert.equal(demoRead.doneWhen, "Kitchen is cleared and swept");

        const availability = await tools.listCrewAvailability({ startDate: dayKey(10), days: 7 });
        assertNoFinancialKeys(availability);
        assert.ok(Array.isArray(availability.crew));
        assert.ok(availability.crew.every((member: any) => member.days.length === 7));
        const aliceAvailability = availability.crew.find((member: any) => member.userId === alice.id);
        // Alice stays in the roster (ACTIVATED FIELD_CREW) even though the
        // crew-wrapper test above reassigned "Demo kitchen" to Bob only —
        // so the BOOKED expectation belongs to Bob, and Alice reads free.
        assert.ok(aliceAvailability);
        assert.ok(aliceAvailability.days.every((entry: any) => !entry.bookedTasks.includes("Demo kitchen")));
        const bobAvailability = availability.crew.find((member: any) => member.userId === bob.id);
        assert.ok(bobAvailability);
        assert.ok(
            bobAvailability.days.some((entry: any) =>
                entry.status === "booked" && entry.bookedTasks.includes("Demo kitchen"),
            ),
        );
        console.log("PASS project schedule detail/material counts and financial-free crew availability");
    } finally {
        try {
            if (collected.confirmationTokens.length > 0) {
                await confirmationDelegate.deleteMany({
                    where: { token: { in: collected.confirmationTokens } },
                });
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

            const [confirmationsLeft, clientsLeft, projectsLeft, usersLeft] = await Promise.all([
                confirmationDelegate.count({ where: { token: { in: collected.confirmationTokens } } }),
                prisma.client.count({ where: { id: { in: collected.clientIds } } }),
                prisma.project.count({ where: { id: { in: collected.projectIds } } }),
                prisma.user.count({ where: { id: { in: collected.userIds } } }),
            ]);
            cleanupPassed = confirmationsLeft === 0 && clientsLeft === 0 && projectsLeft === 0 && usersLeft === 0;
        } catch (error) {
            console.error("Fixture cleanup error:", error);
        }
        console.log(`${cleanupPassed ? "PASS" : "FAIL"} fixture cleanup`);
    }

    assert.equal(cleanupPassed, true);
    console.log("mcp-schedule-tools verification: PASS");
}

main()
    .catch(error => {
        console.error("mcp-schedule-tools verification: FAIL");
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await prisma.$disconnect();
        } catch {
            // Static RED and missing-schema failures can happen before Prisma connects.
        }
    });

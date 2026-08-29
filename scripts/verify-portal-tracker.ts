// Behavioral and render-contract verification for SPEC PR-E:
// customer portal project tracker + curated updates.
//
// This verifier never applies schema. It runs pure/static checks everywhere,
// then runs isolated DB fixtures only when DATABASE_URL is non-production or
// ALLOW_PROD_VERIFY=1 explicitly opts into the guarded Supabase run.
//
// Usage:
//   npx tsx scripts/verify-portal-tracker.ts
//   $env:ALLOW_PROD_VERIFY="1"; npx tsx scripts/verify-portal-tracker.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { prisma } from "../src/lib/prisma";
import {
    CLIENT_STAGES,
    assertPortalProjectAccessCore,
    buildPortalWhoIsComing,
    buildProjectTracker,
    computeDailyLogSharedContentHash,
    getPortalProjectTrackerCore,
    getPortalUpdatesFeedCore,
    portalVisibilityAllows,
    setDailyLogPortalShareCore,
    type PortalTrackerTask,
} from "../src/lib/portal-tracker";

const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);
const FIXTURE_PREFIX = `PORTAL TRACKER VERIFY ${RUN_ID}`;
const BASE_DATE = new Date("2042-04-06T12:00:00.000Z");
let databaseTouched = false;

function source(path: string): string {
    return readFileSync(new URL(path, import.meta.url), "utf8");
}

function date(dayOffset: number): Date {
    return new Date(BASE_DATE.getTime() + dayOffset * 86_400_000);
}

function trackerTask(
    input: Partial<PortalTrackerTask> & Pick<PortalTrackerTask, "id" | "name">,
): PortalTrackerTask {
    return {
        id: input.id,
        name: input.name,
        startDate: input.startDate ?? date(0),
        endDate: input.endDate ?? input.startDate ?? date(0),
        color: input.color ?? "#2563eb",
        progress: input.progress ?? 0,
        status: input.status ?? "Not Started",
        type: input.type ?? "task",
        order: input.order ?? 0,
        costCodeName: input.costCodeName ?? null,
        // Must be forwarded: dropping it silently made every clientStage case
        // vacuous — the assertions passed while never exercising the tag at all.
        clientStage: input.clientStage ?? null,
        scheduledTime: input.scheduledTime ?? null,
        confirmationStatus: input.confirmationStatus ?? null,
        assignments: input.assignments ?? [],
        subAssignments: input.subAssignments ?? [],
    };
}

function normalizedKey(key: string): string {
    return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const FORBIDDEN_PAYLOAD_KEYS = new Set([
    "email",
    "hourlyrate",
    "burdenrate",
    "rate",
    "issues",
    "blockedreason",
    "weather",
    "materials",
    "materialsdelivered",
    "crewonsite",
    "author",
    "createdby",
    "internalnotes",
    "estimatedhours",
    "assignee",
]);

function assertClientSafeKeys(value: unknown, path = "payload"): void {
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertClientSafeKeys(item, `${path}[${index}]`));
        return;
    }
    if (!value || typeof value !== "object") return;

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        assert.ok(
            !FORBIDDEN_PAYLOAD_KEYS.has(normalizedKey(key)),
            `${path}.${key} is forbidden in a portal payload`,
        );
        assertClientSafeKeys(child, `${path}.${key}`);
    }
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

function runPureCases(): void {
    assert.deepEqual(
        CLIENT_STAGES.map(stage => stage.label),
        [
            "Planning & Permits",
            "Demo",
            "Framing",
            "Rough-ins",
            "Drywall",
            "Finishes",
            "Punch list",
            "Complete",
        ],
    );

    const mapped = buildProjectTracker([
        trackerTask({
            id: "demo",
            name: "Kitchen demolition",
            status: "Complete",
            progress: 100,
            startDate: date(-4),
        }),
        trackerTask({
            id: "rough",
            name: "Run branch circuits",
            costCodeName: "Electrical rough-in",
            status: "In Progress",
            progress: 50,
            startDate: date(0),
        }),
        trackerTask({
            id: "finish",
            name: "Install custom cabinets",
            status: "Not Started",
            progress: 0,
            startDate: date(3),
        }),
        trackerTask({
            id: "punch",
            name: "Final punch walk",
            status: "Not Started",
            progress: 0,
            startDate: date(8),
        }),
    ]);
    assert.equal(mapped.stages.find(stage => stage.label === "Demo")?.state, "complete");
    assert.equal(mapped.stages.find(stage => stage.label === "Rough-ins")?.state, "current");
    assert.equal(mapped.stages.find(stage => stage.label === "Rough-ins")?.pct, 50);
    assert.equal(mapped.stages.find(stage => stage.label === "Finishes")?.state, "upcoming");
    assert.equal(
        mapped.overallPct,
        Math.round(mapped.stages.reduce((sum, stage) => sum + stage.pct, 0) / mapped.stages.length),
        "overall must be the mean of the per-stage percentages",
    );
    // The inspection timeline is not a tracker stage; the eight-stage rail's
    // mean is therefore 44%, not the prior nine-stage 39% expectation.
    assert.equal(mapped.overallPct, 44);

    assert.equal(buildProjectTracker([]).overallPct, 0, "a project with no tasks stays at 0%");

    const emptyLeadingStages = buildProjectTracker([
        trackerTask({
            id: "shop-frame",
            name: "Frame partition walls",
            status: "Not Started",
            progress: 0,
            startDate: date(0),
        }),
    ]);
    assert.equal(emptyLeadingStages.stages[0].state, "complete");
    assert.equal(emptyLeadingStages.stages[1].state, "complete");
    assert.equal(emptyLeadingStages.stages[2].state, "current");
    assert.equal(
        emptyLeadingStages.overallPct,
        25,
        "empty-but-passed stages must count toward the overall roundel",
    );

    const framingTask = trackerTask({
        id: "override-frame",
        name: "Frame partition walls",
        status: "Not Started",
        progress: 0,
        startDate: date(0),
    });
    const overrideForward = buildProjectTracker([framingTask], "Drywall");
    assert.deepEqual(
        overrideForward.stages.map(stage => stage.state),
        ["complete", "complete", "complete", "complete", "current", "upcoming", "upcoming", "upcoming"],
        "an override pins the current stage regardless of task positions",
    );
    assert.equal(overrideForward.overallPct, 50);

    const overrideBackward = buildProjectTracker([
        trackerTask({
            id: "override-demo",
            name: "Kitchen demolition",
            status: "Complete",
            progress: 100,
            startDate: date(0),
        }),
    ], "Demo");
    assert.equal(overrideBackward.stages[1].state, "current");
    assert.equal(
        overrideBackward.stages[1].pct,
        99,
        "an overridden current stage must clamp to 99 so it never reads complete",
    );

    const overrideUnknown = buildProjectTracker([framingTask], "Not A Stage");
    assert.deepEqual(
        overrideUnknown.stages.map(stage => stage.state),
        emptyLeadingStages.stages.map(stage => stage.state),
        "an unknown override label must fall back to task-derived position",
    );

    const overrideNoTasks = buildProjectTracker([], "Framing");
    assert.equal(overrideNoTasks.stages[2].state, "current");
    assert.equal(overrideNoTasks.overallPct, 25, "an override must drive the roundel even with no tasks");

    const overrideFirst = buildProjectTracker([framingTask], "Planning & Permits");
    assert.equal(overrideFirst.stages[0].state, "current");
    assert.equal(overrideFirst.overallPct, 0);

    const overrideLast = buildProjectTracker([framingTask], "Complete");
    assert.equal(overrideLast.stages[7].state, "current");
    assert.equal(overrideLast.overallPct, 88);

    const overrideLastWithWork = buildProjectTracker([
        trackerTask({ id: "closeout", name: "Project closeout", status: "Complete", progress: 100 }),
    ], "Complete");
    assert.equal(overrideLastWithWork.stages[7].state, "current");
    assert.equal(
        overrideLastWithWork.overallPct,
        99,
        "a current stage must never let the roundel round up to 100%",
    );

    const overrideWithAllComplete = buildProjectTracker([
        trackerTask({ id: "ac-1", name: "Frame walls", status: "Complete", progress: 100 }),
    ], "Drywall");
    assert.equal(
        overrideWithAllComplete.stages[4].state,
        "current",
        "an override must win over the all-tasks-complete shortcut",
    );
    assert.equal(overrideWithAllComplete.overallPct, 50);

    const nearestFallback = buildProjectTracker([
        trackerTask({
            id: "fallback-demo",
            name: "Demo",
            status: "Complete",
            progress: 100,
            startDate: date(0),
        }),
        trackerTask({
            id: "unmapped",
            name: "Set temporary protection",
            status: "Not Started",
            progress: 0,
            startDate: date(1),
        }),
        trackerTask({
            id: "fallback-frame",
            name: "Frame partition walls",
            status: "Not Started",
            progress: 0,
            startDate: date(2),
        }),
    ]);
    assert.equal(
        nearestFallback.stages.find(stage => stage.label === "Demo")?.pct,
        50,
        "an equidistant unmatched task must use the earlier dated stage anchor",
    );

    const proportionalFallback = buildProjectTracker([
        trackerTask({ id: "only-a", name: "Mobilize alpha", progress: 10, status: "In Progress", startDate: date(0) }),
        trackerTask({ id: "only-b", name: "Mobilize beta", progress: 50, status: "In Progress", startDate: date(1) }),
        trackerTask({ id: "only-c", name: "Mobilize gamma", progress: 90, status: "In Progress", startDate: date(2) }),
    ]);
    assert.equal(proportionalFallback.stages[0].pct, 10);
    assert.equal(proportionalFallback.stages[4].pct, 50);
    assert.equal(proportionalFallback.stages[7].pct, 90);
    assert.equal(proportionalFallback.stages[0].state, "current");

    const allComplete = buildProjectTracker([
        trackerTask({ id: "done", name: "Project complete", status: "Complete", progress: 12 }),
    ]);
    assert.equal(allComplete.overallPct, 99);
    assert.equal(allComplete.stages[7].state, "current");

    const visitors = buildPortalWhoIsComing([
        trackerTask({
            id: "crew-a",
            name: "Install blocking",
            startDate: date(0),
            endDate: date(1),
            assignments: [
                { id: "a1", userId: "u1", firstName: "Amy" },
                { id: "a2", userId: "u2", firstName: "Luis" },
            ],
            subAssignments: [{ id: "s1", companyName: "Red Point Electric" }],
        }),
        trackerTask({
            id: "crew-b",
            name: "Continue blocking",
            startDate: date(0),
            endDate: date(0),
            assignments: [{ id: "a3", userId: "u1", firstName: "Amy" }],
            subAssignments: [{ id: "s2", companyName: "Red Point Electric" }],
        }),
        trackerTask({
            id: "inspection",
            name: "Framing inspection",
            type: "appointment",
            startDate: date(2),
            endDate: date(2),
            scheduledTime: "09:30",
            confirmationStatus: "confirmed",
        }),
        trackerTask({
            id: "measure",
            name: "Countertop template",
            type: "appointment",
            startDate: date(3),
            endDate: date(3),
            scheduledTime: "13:00",
            confirmationStatus: "requested",
        }),
        trackerTask({
            id: "outside-window",
            name: "Later visit",
            startDate: date(8),
            endDate: date(8),
            assignments: [{ id: "late", userId: "u3", firstName: "Late" }],
        }),
    ], BASE_DATE);
    assert.deepEqual(visitors[0].crew, ["Amy", "Luis"]);
    assert.deepEqual(visitors[0].subcontractors, ["Red Point Electric"]);
    assert.equal(visitors[2].appointments[0].confirmationStatus, "confirmed");
    assert.equal(visitors[3].appointments[0].confirmationStatus, "pending confirmation");
    assert.ok(visitors.every(day => !day.crew.includes("Late")));

    const hashA = computeDailyLogSharedContentHash("Installed blocking", ["photo-b", "photo-a"]);
    const hashB = computeDailyLogSharedContentHash("Installed blocking", ["photo-a", "photo-b"]);
    assert.equal(hashA, hashB, "shared photo order must not change the approval hash");
    assert.notEqual(hashA, computeDailyLogSharedContentHash("Installed drywall", ["photo-a", "photo-b"]));
    assert.notEqual(hashA, computeDailyLogSharedContentHash("Installed blocking", ["photo-a"]));

    assert.equal(portalVisibilityAllows(null, "showSchedule"), true);
    assert.equal(
        portalVisibilityAllows(null, "showDailyLogs"),
        false,
        "missing visibility rows must preserve the existing daily-log default",
    );
    assert.equal(
        portalVisibilityAllows(
            { isPortalEnabled: true, showSchedule: true, showDailyLogs: true },
            "showDailyLogs",
        ),
        true,
    );
    assert.equal(
        portalVisibilityAllows(
            { isPortalEnabled: false, showSchedule: true, showDailyLogs: true },
            "showSchedule",
        ),
        false,
    );

    // --- Regressions: the rail must never run backwards (Codex review, PR #271) ---
    // A "backwards" rail = any stage reading complete AFTER a stage that does not.
    // The client sees a green checkmark below an unfinished stage and reads it as
    // a bug in the software, because it is one.
    const railRunsBackwards = (stages: readonly { state: string }[]): boolean => {
        const firstOpen = stages.findIndex(stage => stage.state !== "complete");
        return firstOpen >= 0 && stages.slice(firstOpen + 1).some(stage => stage.state === "complete");
    };

    // A stage word later in the NAME wins over a higher-numbered stage. Ranking by
    // stage number read this as Finishes (on "floor"), which then marked Demo,
    // Framing, Rough-ins and Drywall as passed — telling the client four stages
    // were done on a job that had only ever reviewed a floor plan.
    const floorPlan = buildProjectTracker([
        trackerTask({ id: "fp", name: "Review floor plan", status: "In Progress", progress: 25 }),
    ]);
    assert.equal(floorPlan.stages[0].state, "current");
    assert.equal(floorPlan.stages[0].label, "Planning & Permits");
    assert.equal(railRunsBackwards(floorPlan.stages), false);

    // The task NAME outranks the cost code. Scoring both in one concatenated string
    // gave every cost-code word positional priority, so this read as Rough-ins.
    const nameBeatsCostCode = buildProjectTracker([
        trackerTask({
            id: "cc", name: "Final cleanup", costCodeName: "Electrical rough-in",
            status: "In Progress", progress: 10,
        }),
    ]);
    assert.equal(
        nameBeatsCostCode.stages.find(stage => stage.state === "current")?.label,
        "Punch list",
    );

    // Cost code still decides when the name says nothing about a stage.
    const costCodeFallback = buildProjectTracker([
        trackerTask({
            id: "cf", name: "Zone 3 work order", costCodeName: "Drywall hang",
            status: "In Progress", progress: 10,
        }),
    ]);
    assert.equal(
        costCodeFallback.stages.find(stage => stage.state === "current")?.label,
        "Drywall",
    );

    // Work finished early may not plant a checkmark ahead of the current stage.
    const earlyFraming = buildProjectTracker([
        trackerTask({ id: "d", name: "Demo work", status: "In Progress", progress: 50, startDate: date(-2) }),
        trackerTask({ id: "f", name: "Framing work", status: "Complete", progress: 100, startDate: date(2) }),
    ]);
    assert.equal(railRunsBackwards(earlyFraming.stages), false);
    const framingStage = earlyFraming.stages.find(stage => stage.label === "Framing");
    assert.equal(framingStage?.state, "upcoming");
    assert.equal(framingStage?.pct, 100, "early-finished work keeps its real pct for the roundel");

    // An explicit clientStage behind the current position may not read "upcoming"
    // while later stages read complete.
    const laggingTag = buildProjectTracker([
        trackerTask({
            id: "late", name: "A", clientStage: "Finishes",
            status: "In Progress", progress: 30, startDate: date(-2),
        }),
        trackerTask({
            id: "early", name: "B", clientStage: "Demo",
            status: "Not Started", progress: 0, startDate: date(1),
        }),
    ]);
    assert.equal(railRunsBackwards(laggingTag.stages), false);

    // An unrecognised clientStage is ignored, never trusted as a position.
    const bogusTag = buildProjectTracker([
        trackerTask({
            id: "bogus", name: "Site prep", clientStage: "'; DROP TABLE--",
            status: "In Progress", progress: 40,
        }),
    ]);
    assert.equal(bogusTag.stages[0].state, "current");
    assert.equal(railRunsBackwards(bogusTag.stages), false);

    console.log("PASS pure stage mapping, fallback, state, visitor, and hash cases");
}

function runStaticContracts(): void {
    const schemaSource = source("../prisma/schema.prisma");
    const applySource = source("./apply-portal-tracker-schema.mjs");
    const actionsSource = source("../src/lib/actions.ts");
    const trackerSource = source("../src/lib/portal-tracker.ts");
    const accessSource = source("../src/lib/portal-project-access.ts");
    const portalPageSource = source("../src/app/portal/projects/[id]/page.tsx");
    const trackerUiSource = source("../src/app/portal/projects/[id]/PortalProjectTracker.tsx");
    const updatesUiSource = source("../src/app/portal/projects/[id]/PortalUpdatesFeed.tsx");
    const dailyLogsPageSource = source("../src/app/projects/[id]/dailylogs/page.tsx");
    const dailyLogsClientSource = source("../src/app/projects/[id]/dailylogs/DailyLogsClient.tsx");
    const oldScheduleSource = source("../src/app/portal/projects/[id]/schedule/page.tsx");

    assert.match(schemaSource, /sharedToPortal\s+Boolean\s+@default\(false\)/);
    assert.match(schemaSource, /sharedContentHash\s+String\?/);
    assert.ok(
        (schemaSource.match(/sharedToPortal\s+Boolean\s+@default\(false\)/g) ?? []).length >= 2,
        "DailyLog and DailyLogPhoto must both expose sharedToPortal",
    );
    for (const column of ["sharedToPortal", "sharedContentHash"]) {
        assert.match(applySource, new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`));
    }
    assert.match(applySource, /ALTER TABLE "DailyLog" ENABLE ROW LEVEL SECURITY/);
    assert.match(applySource, /ALTER TABLE "DailyLogPhoto" ENABLE ROW LEVEL SECURITY/);
    assert.doesNotMatch(applySource, /CREATE POLICY/i);

    assert.match(accessSource, /export async function assertPortalProjectAccessCore/);
    assert.match(accessSource, /export async function assertPortalProjectAccess/);
    const scheduleActionStart = actionsSource.indexOf("export async function getPortalScheduleTasks(");
    const scheduleActionEnd = actionsSource.indexOf("export async function", scheduleActionStart + 1);
    const scheduleActionBody = actionsSource.slice(scheduleActionStart, scheduleActionEnd);
    assert.ok(scheduleActionStart >= 0);
    assert.match(scheduleActionBody, /assertPortalProjectAccess\(/);
    assert.match(scheduleActionBody, /getPortalScheduleTasksCore\(/);
    assert.doesNotMatch(scheduleActionBody, /hourlyRate|burdenRate|email|blockedReason|materialsDelivered|issues/);
    for (const safeAppointmentField of ["scheduledTime", "confirmationStatus"]) {
        assert.match(trackerSource, new RegExp(`\\b${safeAppointmentField}\\b`));
    }

    const shareActionStart = actionsSource.indexOf("export async function setDailyLogPortalShare(");
    const shareActionEnd = actionsSource.indexOf("export async function", shareActionStart + 1);
    const shareActionBody = actionsSource.slice(shareActionStart, shareActionEnd);
    assert.ok(shareActionStart >= 0, "setDailyLogPortalShare must exist");
    assert.match(shareActionBody, /\["ADMIN", "MANAGER"\]/);
    assert.match(shareActionBody, /assertDailyLogAccess\(/);
    assert.match(shareActionBody, /setDailyLogPortalShareCore\(/);

    const updateLogStart = actionsSource.indexOf("export async function updateDailyLog(");
    const updateLogEnd = actionsSource.indexOf("export async function", updateLogStart + 1);
    assert.match(actionsSource.slice(updateLogStart, updateLogEnd), /sharedContentHash/);
    const deletePhotoStart = actionsSource.indexOf("export async function deleteDailyLogPhoto(");
    const deletePhotoEnd = actionsSource.indexOf("export async function", deletePhotoStart + 1);
    assert.match(actionsSource.slice(deletePhotoStart, deletePhotoEnd), /sharedContentHash/);

    assert.match(portalPageSource, /getPortalProjectTracker\(/);
    assert.match(portalPageSource, /getPortalUpdatesFeed\(/);
    assert.match(portalPageSource, /<PortalProjectTracker/);
    assert.match(portalPageSource, /<PortalUpdatesFeed/);
    assert.doesNotMatch(portalPageSource, /dailyLogs:\s*\{/);
    assert.doesNotMatch(portalPageSource, /prisma\.dailyLog/);
    assert.doesNotMatch(portalPageSource, /log\.issues|log\.weather|log\.crewOnSite|log\.createdBy/);

    assert.match(trackerUiSource, /MotionConfig/);
    assert.match(trackerUiSource, /reducedMotion="user"/);
    assert.match(trackerUiSource, /snap-x/);
    assert.match(trackerUiSource, /--project-accent/);
    assert.match(trackerUiSource, /Full schedule/);
    assert.match(updatesUiSource, /Updates from the crew will appear here\./);
    assert.match(updatesUiSource, /role="dialog"/);
    assert.match(updatesUiSource, /grid-cols-2/);
    assert.match(updatesUiSource, /motion\./);

    assert.match(dailyLogsPageSource, /canManagePortalShare/);
    assert.match(dailyLogsClientSource, /setDailyLogPortalShare/);
    assert.match(dailyLogsClientSource, /canManagePortalShare/);
    assert.match(dailyLogsClientSource, /role="switch"/);
    assert.match(dailyLogsClientSource, /Share to portal/);
    assert.match(dailyLogsClientSource, /portalShareValid/);

    assert.match(oldScheduleSource, /getPortalScheduleTasks/);
    assert.match(oldScheduleSource, /<PortalScheduleView/);

    console.log("PASS schema, auth, allowlist, route, and render contracts");
}

async function runDatabaseCases(): Promise<void> {
    const databaseUrl = loadDatabaseUrl();
    if (!databaseUrl) {
        throw new Error("[verify-portal-tracker] DATABASE_URL is required for DB-backed cases");
    }
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    const isSupabase = hostname.includes("supabase.");
    if (isSupabase && process.env.ALLOW_PROD_VERIFY !== "1") {
        throw new Error(
            "[verify-portal-tracker] REFUSING DB FIXTURES: DATABASE_URL points at Supabase. " +
            "Set ALLOW_PROD_VERIFY=1 only when an isolated, cleanup-backed verification run is intended.",
        );
    }
    databaseTouched = true;

    const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'DailyLog' AND column_name IN ('sharedToPortal', 'sharedContentHash'))
            OR (table_name = 'DailyLogPhoto' AND column_name = 'sharedToPortal')
          )
    `;
    assert.deepEqual(
        new Set(columns.map(row => `${row.table_name}.${row.column_name}`)),
        new Set([
            "DailyLog.sharedToPortal",
            "DailyLog.sharedContentHash",
            "DailyLogPhoto.sharedToPortal",
        ]),
        "portal tracker schema is not applied; run only the release orchestrator's apply script before this DB gate",
    );

    const collected = {
        clientIds: [] as string[],
        projectIds: [] as string[],
        userIds: [] as string[],
        subcontractorIds: [] as string[],
    };

    try {
        const [ownerClient, otherClient] = await Promise.all([
            prisma.client.create({
                data: {
                    name: `${FIXTURE_PREFIX} OWNER DELETE ME`,
                    initials: "PO",
                    email: `portal-owner-${RUN_ID}@example.invalid`,
                },
            }),
            prisma.client.create({
                data: {
                    name: `${FIXTURE_PREFIX} OTHER DELETE ME`,
                    initials: "PX",
                    email: `portal-other-${RUN_ID}@example.invalid`,
                },
            }),
        ]);
        collected.clientIds.push(ownerClient.id, otherClient.id);

        const [manager, crew] = await Promise.all([
            prisma.user.create({
                data: {
                    name: `${FIXTURE_PREFIX} Manager`,
                    email: `portal-manager-${RUN_ID}@example.invalid`,
                    role: "MANAGER",
                    status: "ACTIVATED",
                },
            }),
            prisma.user.create({
                data: {
                    name: "Avery Carpenter",
                    email: `portal-crew-${RUN_ID}@example.invalid`,
                    role: "FIELD_CREW",
                    status: "ACTIVATED",
                },
            }),
        ]);
        collected.userIds.push(manager.id, crew.id);

        const subcontractor = await prisma.subcontractor.create({
            data: {
                companyName: `${FIXTURE_PREFIX} Red Point Electric`,
                email: `portal-sub-${RUN_ID}@example.invalid`,
                status: "ACTIVE",
            },
        });
        collected.subcontractorIds.push(subcontractor.id);

        const project = await prisma.project.create({
            data: {
                name: `${FIXTURE_PREFIX} PROJECT DELETE ME`,
                clientId: ownerClient.id,
                color: "#7c3aed",
                status: "In Progress",
                portalVisibility: {
                    create: {
                        isPortalEnabled: true,
                        showSchedule: true,
                        showDailyLogs: true,
                    },
                },
            },
        });
        collected.projectIds.push(project.id);

        await assertPortalProjectAccessCore({
            projectId: project.id,
            isStaff: false,
            clientId: ownerClient.id,
            visibility: "showSchedule",
        });
        await assert.rejects(
            () => assertPortalProjectAccessCore({
                projectId: project.id,
                isStaff: false,
                clientId: otherClient.id,
                visibility: "showSchedule",
            }),
            /Unauthorized/,
        );
        await prisma.portalVisibility.update({
            where: { projectId: project.id },
            data: { showSchedule: false },
        });
        await assert.rejects(
            () => assertPortalProjectAccessCore({
                projectId: project.id,
                isStaff: false,
                clientId: ownerClient.id,
                visibility: "showSchedule",
            }),
            /Unauthorized/,
        );
        await assertPortalProjectAccessCore({
            projectId: project.id,
            isStaff: true,
            clientId: null,
            visibility: "showSchedule",
        });
        await prisma.portalVisibility.update({
            where: { projectId: project.id },
            data: { showSchedule: true },
        });
        console.log("PASS DB owning-client, cross-client, visibility, and staff-preview authorization");

        await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                name: "Electrical rough-in",
                startDate: date(0),
                endDate: date(1),
                status: "In Progress",
                progress: 40,
                order: 0,
                assignments: { create: { userId: crew.id } },
                subAssignments: { create: { subcontractorId: subcontractor.id } },
            },
        });
        await prisma.scheduleTask.create({
            data: {
                projectId: project.id,
                name: "Rough-in inspection",
                startDate: date(2),
                endDate: date(2),
                status: "Not Started",
                progress: 0,
                type: "appointment",
                scheduledTime: "10:15",
                confirmationStatus: "requested",
                order: 1,
            },
        });
        const trackerPayload = await getPortalProjectTrackerCore(project.id, BASE_DATE);
        assert.equal(trackerPayload.projectColor, "#7c3aed");
        assert.equal(trackerPayload.whoIsComing[0].crew[0], "Avery");
        assert.equal(trackerPayload.whoIsComing[0].subcontractors[0], `${FIXTURE_PREFIX} Red Point Electric`);
        assert.equal(trackerPayload.whoIsComing[2].appointments[0].confirmationStatus, "pending confirmation");
        assertClientSafeKeys(trackerPayload);
        console.log("PASS DB tracker serialization and recursive allowlist");

        const log = await prisma.dailyLog.create({
            data: {
                projectId: project.id,
                createdById: manager.id,
                date: date(0),
                weather: "Confidential weather",
                crewOnSite: "Private crew list",
                workPerformed: "Installed blocking and completed inspection prep.",
                issues: "Internal issue that must never reach the client.",
                photos: {
                    create: [
                        { url: `https://example.invalid/${RUN_ID}/shared.jpg`, caption: "Blocking installed" },
                        { url: `https://example.invalid/${RUN_ID}/private.jpg`, caption: "Internal only" },
                    ],
                },
            },
            include: { photos: true },
        });
        const sharedPhoto = log.photos[0];
        const privatePhoto = log.photos[1];

        await assert.rejects(
            () => setDailyLogPortalShareCore(
                log.id,
                { shared: true, photoIds: [sharedPhoto.id] },
                { userId: crew.id, role: "FIELD_CREW", name: crew.name ?? crew.email },
            ),
            /Forbidden/,
        );

        await setDailyLogPortalShareCore(
            log.id,
            { shared: true, photoIds: [sharedPhoto.id] },
            { userId: manager.id, role: "MANAGER", name: manager.name ?? manager.email },
        );
        let feed = await getPortalUpdatesFeedCore(project.id);
        assert.equal(feed.length, 1);
        assert.deepEqual(feed[0].photos.map(photo => photo.url), [sharedPhoto.url]);
        assert.ok(!feed[0].photos.some(photo => photo.url === privatePhoto.url));
        assertClientSafeKeys(feed);

        await prisma.dailyLog.update({
            where: { id: log.id },
            data: { workPerformed: "Edited work now requires approval." },
        });
        feed = await getPortalUpdatesFeedCore(project.id);
        assert.equal(feed.length, 0, "a content-hash mismatch must hide the log");

        await setDailyLogPortalShareCore(
            log.id,
            { shared: true, photoIds: [sharedPhoto.id] },
            { userId: manager.id, role: "MANAGER", name: manager.name ?? manager.email },
        );
        feed = await getPortalUpdatesFeedCore(project.id);
        assert.equal(feed.length, 1);
        assert.equal(feed[0].workPerformed, "Edited work now requires approval.");
        assert.deepEqual(feed[0].photos.map(photo => photo.url), [sharedPhoto.url]);

        await setDailyLogPortalShareCore(
            log.id,
            { shared: false, photoIds: [] },
            { userId: manager.id, role: "MANAGER", name: manager.name ?? manager.email },
        );
        feed = await getPortalUpdatesFeedCore(project.id);
        assert.equal(feed.length, 0);
        assert.equal(
            await prisma.activityLog.count({
                where: {
                    projectId: project.id,
                    entityType: "daily_log",
                    entityId: log.id,
                },
            }),
            3,
        );
        console.log("PASS DB share, invalidation, re-approval, unshared-photo, activity, and feed cases");
    } finally {
        if (collected.projectIds.length > 0) {
            await prisma.project.deleteMany({ where: { id: { in: collected.projectIds } } });
        }
        if (collected.subcontractorIds.length > 0) {
            await prisma.subcontractor.deleteMany({ where: { id: { in: collected.subcontractorIds } } });
        }
        if (collected.userIds.length > 0) {
            await prisma.user.deleteMany({ where: { id: { in: collected.userIds } } });
        }
        if (collected.clientIds.length > 0) {
            await prisma.client.deleteMany({ where: { id: { in: collected.clientIds } } });
        }

        assert.equal(
            await prisma.project.count({ where: { name: { startsWith: FIXTURE_PREFIX } } }),
            0,
        );
        assert.equal(
            await prisma.client.count({ where: { name: { startsWith: FIXTURE_PREFIX } } }),
            0,
        );
        console.log("PASS fixture cleanup");
    }
}

async function main(): Promise<void> {
    runPureCases();
    runStaticContracts();
    await runDatabaseCases();
    console.log("portal tracker verification: PASS");
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        if (databaseTouched) {
            await prisma.$disconnect().catch(() => undefined);
        }
    });

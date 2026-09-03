import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

// Clock-in task suggestion pipeline (Stage A daily-log matcher + Stage B
// ranking in src/lib/time-suggestion.ts), exercised through the real HTTP
// surface: POST /api/mobile/login for a bearer token, then
// GET /api/mobile/time-suggestion. Serial — later tests rely on the daily
// log's aiSuggestedTaskId being reset to null by earlier tests.

const BASE_URL = "http://localhost:3000";

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const COST_CODE_DEMO_ID = "e2e-mob-cc-demo";
const COST_CODE_DRYW_ID = "e2e-mob-cc-dryw";
const MOBILE_ITEM_DEMO_ID = "e2e-mob-item-demo";
const MOBILE_ITEM_DRYW_ID = "e2e-mob-item-dryw";
const MOBILE_TASK_DRYW_ID = "e2e-mob-task-dryw";
const MOBILE_DAILYLOG_ID = "e2e-mob-dailylog";
const FIELD_CREW_EMAIL = "field-crew@test.local";
const FIELD_CREW_PIN = "246810";

// Unique per run so reruns after a failed/aborted prior run never collide on IDs.
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TSUG_TASK2_ID = `e2e-tsug-task2-${RUN}`;
const TSUG_STALE_TASK_ID = `e2e-tsug-stale-${RUN}`;
const TSUG_ITEM_NOCODE_ID = `e2e-tsug-nocode-${RUN}`;
const TSUG_ITEM_UNCODED_ID = `e2e-tsug-uncoded-item-${RUN}`;
const TSUG_UNCODED_TASK_ID = `e2e-tsug-uncoded-task-${RUN}`;
const TSUG_ITEM_MIXED_UNCODED_ID = `e2e-tsug-mixed-uncoded-item-${RUN}`;
const TSUG_MIXED_UNCODED_TASK_ID = `e2e-tsug-mixed-uncoded-task-${RUN}`;
const TSUG_LOG_ID = `e2e-tsug-log-${RUN}`;
const TSUG_PROJECT_AUTH_ID = `e2e-tsug-projauth-${RUN}`;
const TSUG_CLIENT_AUTH_ID = `e2e-tsug-cliauth-${RUN}`;
const TSUG_PROJECT_X_ID = `e2e-tsug-projx-${RUN}`;
const TSUG_CLIENT_X_ID = `e2e-tsug-clix-${RUN}`;
const TSUG_ESTIMATE_X_ID = `e2e-tsug-estx-${RUN}`;
const TSUG_ITEM_X_ID = `e2e-tsug-itemx-${RUN}`;
const DAILYLOG_MARKER = `misc-e2e-tsug-${RUN}`;

const prisma = new PrismaClient();

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const daysFromNow = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

async function mobileLogin(request: APIRequestContext, email: string, pinCode: string): Promise<string> {
    const res = await request.post("/api/mobile/login", { data: { email, pinCode } });
    expect(res.ok(), `login failed: ${await res.text()}`).toBeTruthy();
    return ((await res.json()) as { token: string }).token;
}

test.describe.serial("Mobile clock-in time suggestion", () => {
    let api: APIRequestContext;
    let fieldCrewToken: string;
    let fieldCrewId: string;
    // Every entry id this file creates via POST — the afterAll safety net
    // deletes exactly these, nothing broader.
    const createdEntryIds = new Set<string>();

    test.beforeAll(async ({ playwright }) => {
        api = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
        fieldCrewToken = await mobileLogin(api, FIELD_CREW_EMAIL, FIELD_CREW_PIN);
        const fieldCrew = await prisma.user.findUniqueOrThrow({
            where: { email: FIELD_CREW_EMAIL },
            select: { id: true },
        });
        fieldCrewId = fieldCrew.id;
    });

    test.afterAll(async () => {
        // Safety net: restore fixture state and delete every row this file may
        // have created, in case an earlier assertion failed mid-test and skipped
        // its own inline cleanup.
        await prisma.dailyLog.update({
            where: { id: MOBILE_DAILYLOG_ID },
            data: { aiSuggestedTaskId: null, aiSuggestionReason: null },
        }).catch(() => {});
        // The dispatch tests toggle the fixture task's own assignment (and its
        // doneWhen) off and back on to isolate the lower tiers — restore both
        // unconditionally in case an earlier assertion threw mid-toggle.
        await prisma.scheduleTask.update({
            where: { id: MOBILE_TASK_DRYW_ID },
            data: { doneWhen: null },
        }).catch(() => {});
        await prisma.taskAssignment.upsert({
            where: { taskId_userId: { taskId: MOBILE_TASK_DRYW_ID, userId: fieldCrewId } },
            update: {},
            create: { taskId: MOBILE_TASK_DRYW_ID, userId: fieldCrewId },
        }).catch(() => {});
        // Entries this file POSTed but failed to delete inline (assertion threw
        // before the inline cleanup). Exact IDs only — a time/user-scoped
        // deleteMany could reap another parallel spec's in-flight entries.
        if (createdEntryIds.size > 0) {
            await prisma.timeEntry.deleteMany({ where: { id: { in: [...createdEntryIds] } } }).catch(() => {});
        }
        await prisma.taskAssignment.deleteMany({ where: { taskId: { in: [TSUG_TASK2_ID, TSUG_STALE_TASK_ID, TSUG_UNCODED_TASK_ID, TSUG_MIXED_UNCODED_TASK_ID] } } });
        await prisma.scheduleTask.deleteMany({ where: { id: { in: [TSUG_TASK2_ID, TSUG_STALE_TASK_ID, TSUG_UNCODED_TASK_ID, TSUG_MIXED_UNCODED_TASK_ID] } } });
        await prisma.estimateItem.deleteMany({ where: { id: { in: [TSUG_ITEM_NOCODE_ID, TSUG_ITEM_UNCODED_ID, TSUG_ITEM_MIXED_UNCODED_ID] } } });
        await prisma.dailyLogPhoto.deleteMany({ where: { dailyLogId: TSUG_LOG_ID } });
        await prisma.dailyLog.deleteMany({ where: { id: TSUG_LOG_ID } });
        await prisma.dailyLog.deleteMany({ where: { workPerformed: DAILYLOG_MARKER } });
        await prisma.projectAccess.deleteMany({ where: { projectId: TSUG_PROJECT_AUTH_ID } });
        await prisma.project.deleteMany({ where: { id: TSUG_PROJECT_AUTH_ID } });
        await prisma.client.deleteMany({ where: { id: TSUG_CLIENT_AUTH_ID } });
        await prisma.estimateItem.deleteMany({ where: { id: TSUG_ITEM_X_ID } });
        await prisma.estimate.deleteMany({ where: { id: TSUG_ESTIMATE_X_ID } });
        await prisma.project.deleteMany({ where: { id: TSUG_PROJECT_X_ID } });
        await prisma.client.deleteMany({ where: { id: TSUG_CLIENT_X_ID } });

        await api.dispose();
        await prisma.$disconnect();
    });

    test("1. dispatch (assigned + active today) wins over everything else, including a stored AI pick", async () => {
        // The fixture (data.setup.ts) always keeps the field crew assigned to
        // MOBILE_TASK_DRYW_ID, active today — that's dispatch. A stored AI pick
        // naming the SAME task with a DIFFERENT reason proves dispatch is
        // checked first: if daily_log ran first, the response's reason/source
        // would be the AI pick's, not dispatch's.
        await prisma.dailyLog.update({
            where: { id: MOBILE_DAILYLOG_ID },
            data: { aiSuggestedTaskId: MOBILE_TASK_DRYW_ID, aiSuggestionReason: "Stored pick from AI" },
        });
        await prisma.scheduleTask.update({
            where: { id: MOBILE_TASK_DRYW_ID },
            data: { doneWhen: "Tape and mud coat 1, hall bath only" },
        });

        const res = await api.get(`/api/mobile/time-suggestion?projectId=${PROJECT_ID}`, {
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const body = await res.json();
        const { suggestion, uncostedPlannedTask } = body;

        expect(suggestion).not.toBeNull();
        expect(suggestion.source).toBe("dispatch");
        expect(suggestion.confidence).toBe("high");
        expect(suggestion.reason).toBe("Dispatched to you today"); // not "Stored pick from AI"
        expect(suggestion.scheduleTaskId).toBe(MOBILE_TASK_DRYW_ID);
        expect(suggestion.clockInEstimateItemId).toBe(MOBILE_ITEM_DRYW_ID);
        expect(suggestion.costCodeId).toBe(COST_CODE_DRYW_ID);
        expect(suggestion.plannedByOffice).toBe(true);
        expect(suggestion.note).toBe("Tape and mud coat 1, hall bath only");
        expect(uncostedPlannedTask).toBeNull();

        await prisma.dailyLog.update({
            where: { id: MOBILE_DAILYLOG_ID },
            data: { aiSuggestedTaskId: null, aiSuggestionReason: null },
        });
        await prisma.scheduleTask.update({ where: { id: MOBILE_TASK_DRYW_ID }, data: { doneWhen: null } });
        // Disable dispatch for tests 2-4 below, which exercise the lower tiers
        // in isolation — otherwise dispatch would win every time and mask them.
        // Restored before test 5 (and unconditionally in afterAll as a safety net).
        await prisma.taskAssignment.deleteMany({ where: { taskId: MOBILE_TASK_DRYW_ID, userId: fieldCrewId } });
    });

    test("2. stored AI pick wins over everything else (dispatch not active)", async () => {
        await prisma.dailyLog.update({
            where: { id: MOBILE_DAILYLOG_ID },
            data: { aiSuggestedTaskId: MOBILE_TASK_DRYW_ID, aiSuggestionReason: "Stored pick from AI" },
        });

        const res = await api.get(`/api/mobile/time-suggestion?projectId=${PROJECT_ID}`, {
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const { suggestion } = await res.json();

        expect(suggestion).not.toBeNull();
        expect(suggestion.source).toBe("daily_log");
        expect(suggestion.confidence).toBe("high");
        expect(suggestion.scheduleTaskId).toBe(MOBILE_TASK_DRYW_ID);
        expect(suggestion.clockInEstimateItemId).toBe(MOBILE_ITEM_DRYW_ID);
        expect(suggestion.costCodeId).toBe(COST_CODE_DRYW_ID);
        expect(suggestion.reason).toBe("Stored pick from AI");
        expect(suggestion.plannedByOffice).toBe(false);
        expect(suggestion.note).toBeNull(); // doneWhen unset on the fixture task

        await prisma.dailyLog.update({
            where: { id: MOBILE_DAILYLOG_ID },
            data: { aiSuggestedTaskId: null, aiSuggestionReason: null },
        });
    });

    test("3. stale stored pick (Complete task) falls through to the keyword match", async () => {
        // The stored pick names a task that has since been Completed — it is no
        // longer suggestable, so the engine must discard it and fall through to
        // the keyword match over the same log (which finds the drywall task).
        // Uses a throwaway Complete task rather than flipping the shared
        // fixture task's status, so parallel suites never see a mutated fixture.
        await prisma.scheduleTask.create({
            data: {
                id: TSUG_STALE_TASK_ID,
                projectId: PROJECT_ID,
                name: "Old finished punch work",
                type: "task",
                status: "Complete",
                startDate: daysAgo(10),
                endDate: daysAgo(5),
            },
        });
        await prisma.dailyLog.update({
            where: { id: MOBILE_DAILYLOG_ID },
            data: { aiSuggestedTaskId: TSUG_STALE_TASK_ID, aiSuggestionReason: "Stale pick" },
        });

        const res = await api.get(`/api/mobile/time-suggestion?projectId=${PROJECT_ID}`, {
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const { suggestion } = await res.json();
        expect(suggestion).not.toBeNull();
        expect(suggestion.source).toBe("daily_log");
        expect(suggestion.scheduleTaskId).toBe(MOBILE_TASK_DRYW_ID); // keyword fallback, not the stale pick

        await prisma.dailyLog.update({
            where: { id: MOBILE_DAILYLOG_ID },
            data: { aiSuggestedTaskId: null, aiSuggestionReason: null },
        });
        await prisma.scheduleTask.delete({ where: { id: TSUG_STALE_TASK_ID } });
    });

    test("4. keyword match against the latest log picks the drywall task", async () => {
        // aiSuggestedTaskId is null (reset by test 3). The fixture log's nextSteps
        // — "Start hanging drywall in the hall bath" — tokenizes to
        // {hanging, drywall, hall, bath} (weight 2), which matches the drywall
        // task's name + cost code tokens {hang, drywall, hall, bath, dryw} for a
        // score of 6 against the project's only candidate — an unambiguous, high
        // confidence keyword hit.
        const res = await api.get(`/api/mobile/time-suggestion?projectId=${PROJECT_ID}`, {
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const { suggestion } = await res.json();

        expect(suggestion).not.toBeNull();
        expect(suggestion.source).toBe("daily_log");
        expect(suggestion.scheduleTaskId).toBe(MOBILE_TASK_DRYW_ID);
        expect(suggestion.confidence).toBe("high");
    });

    test("5. dispatch tie-break: multiple active assignments resolve deterministically instead of null", async () => {
        // Restore the fixture's dispatch assignment (removed by test 1) plus a
        // second assigned+active task on the same project, so the caller has
        // two dispatch candidates today. Old behavior (pre-dispatch) required
        // exactly one active assignment or fell through as ambiguous; dispatch
        // never does — it resolves via role (lead first), then earliest
        // startDate, then name. Neither assignment is "lead", so this comes
        // down to startDate: the fixture task's daysAgo(3) is unambiguously
        // earlier than the throwaway task's daysAgo(1) below, so it must win.
        await prisma.taskAssignment.upsert({
            where: { taskId_userId: { taskId: MOBILE_TASK_DRYW_ID, userId: fieldCrewId } },
            update: {},
            create: { taskId: MOBILE_TASK_DRYW_ID, userId: fieldCrewId },
        });
        await prisma.scheduleTask.create({
            data: {
                id: TSUG_TASK2_ID,
                projectId: PROJECT_ID,
                name: "Demo phase task",
                type: "task",
                status: "In Progress",
                startDate: daysAgo(1), // later than the drywall task's daysAgo(3) — must lose the tie-break
                endDate: daysFromNow(4),
                estimateItemId: MOBILE_ITEM_DEMO_ID,
            },
        });
        await prisma.taskAssignment.create({ data: { taskId: TSUG_TASK2_ID, userId: fieldCrewId } });

        const res = await api.get(`/api/mobile/time-suggestion?projectId=${PROJECT_ID}`, {
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const { suggestion } = await res.json();
        expect(suggestion).not.toBeNull();
        expect(suggestion.source).toBe("dispatch");
        expect(suggestion.scheduleTaskId).toBe(MOBILE_TASK_DRYW_ID);
        expect(suggestion.reason).toBe("Dispatched to you today");

        await prisma.taskAssignment.deleteMany({ where: { taskId: TSUG_TASK2_ID } });
        await prisma.scheduleTask.delete({ where: { id: TSUG_TASK2_ID } });
        // Disable dispatch again for test 6, which needs the fixture task
        // NOT chargeable-dispatched so uncostedPlannedTask is exercised cleanly.
        await prisma.taskAssignment.deleteMany({ where: { taskId: MOBILE_TASK_DRYW_ID, userId: fieldCrewId } });
    });

    test("6. dispatched to a non-chargeable task surfaces uncostedPlannedTask, not a suggestion", async () => {
        // A leaf item with no cost code — resolveChargeableItems can't map it to
        // anything chargeable, so dispatch must skip it as a `suggestion` but
        // still name it via `uncostedPlannedTask`. The daily log's nextSteps
        // still names the (unassigned, but still chargeable) drywall task, so
        // the lower daily_log tier keeps finding a real suggestion alongside it.
        await prisma.estimateItem.create({
            data: {
                id: TSUG_ITEM_UNCODED_ID,
                estimateId: "e2e-mob-estimate",
                name: "Uncoded prep phase",
                parentId: null,
                quantity: 1,
                unitCost: 100,
                total: 100,
            },
        });
        await prisma.scheduleTask.create({
            data: {
                id: TSUG_UNCODED_TASK_ID,
                projectId: PROJECT_ID,
                name: "Uncoded prep task",
                type: "task",
                status: "In Progress",
                startDate: daysAgo(1),
                endDate: daysFromNow(1),
                estimateItemId: TSUG_ITEM_UNCODED_ID,
            },
        });
        await prisma.taskAssignment.create({ data: { taskId: TSUG_UNCODED_TASK_ID, userId: fieldCrewId } });

        const res = await api.get(`/api/mobile/time-suggestion?projectId=${PROJECT_ID}`, {
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const { suggestion, uncostedPlannedTask } = await res.json();

        expect(uncostedPlannedTask).toMatchObject({ id: TSUG_UNCODED_TASK_ID, name: "Uncoded prep task" });
        expect(suggestion).not.toBeNull();
        expect(suggestion.scheduleTaskId).toBe(MOBILE_TASK_DRYW_ID); // daily_log keyword fallback, not dispatch
        expect(suggestion.source).toBe("daily_log");

        await prisma.taskAssignment.deleteMany({ where: { taskId: TSUG_UNCODED_TASK_ID } });
        await prisma.scheduleTask.delete({ where: { id: TSUG_UNCODED_TASK_ID } });
        await prisma.estimateItem.delete({ where: { id: TSUG_ITEM_UNCODED_ID } });
        // Restore the fixture's own dispatch assignment for every later test in
        // this file, and for other spec files (schedule-tasks.spec.ts,
        // mobile-api.spec.ts) that expect the field crew dispatched to it.
        await prisma.taskAssignment.upsert({
            where: { taskId_userId: { taskId: MOBILE_TASK_DRYW_ID, userId: fieldCrewId } },
            update: {},
            create: { taskId: MOBILE_TASK_DRYW_ID, userId: fieldCrewId },
        });
    });

    test("6b. mixed dispatch: LEAD on an uncosted task beats a plain-assignee chargeable task", async () => {
        // MOBILE_TASK_DRYW_ID is already dispatched to the field crew as a plain
        // assignee (role default "assigned", restored at the end of test 6) —
        // that's the chargeable candidate. Add a second active dispatch, an
        // uncosted task where the caller is "lead". If ranking considered the
        // chargeable subset first (the old bug), the drywall task would win as
        // `suggestion.source === "dispatch"`. Ranked together, lead beats
        // ordinary regardless of chargeability, so the uncosted task must win
        // the tie-break — surfaced via `uncostedPlannedTask`, never `suggestion`
        // — and `suggestion` falls through to the lower tiers (daily_log here,
        // same keyword match as test 4/6).
        await prisma.estimateItem.create({
            data: {
                id: TSUG_ITEM_MIXED_UNCODED_ID,
                estimateId: "e2e-mob-estimate",
                name: "Mixed uncoded prep phase",
                parentId: null,
                quantity: 1,
                unitCost: 100,
                total: 100,
            },
        });
        await prisma.scheduleTask.create({
            data: {
                id: TSUG_MIXED_UNCODED_TASK_ID,
                projectId: PROJECT_ID,
                name: "Mixed uncoded lead task",
                type: "task",
                status: "In Progress",
                startDate: daysAgo(1),
                endDate: daysFromNow(1),
                estimateItemId: TSUG_ITEM_MIXED_UNCODED_ID,
                doneWhen: "Confirm layout with PM before starting",
            },
        });
        await prisma.taskAssignment.create({
            data: { taskId: TSUG_MIXED_UNCODED_TASK_ID, userId: fieldCrewId, role: "lead" },
        });

        const res = await api.get(`/api/mobile/time-suggestion?projectId=${PROJECT_ID}`, {
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const { suggestion, uncostedPlannedTask } = await res.json();

        expect(uncostedPlannedTask).toMatchObject({
            id: TSUG_MIXED_UNCODED_TASK_ID,
            name: "Mixed uncoded lead task",
            note: "Confirm layout with PM before starting",
        });
        // The chargeable drywall dispatch must NOT win — it lost the tie-break
        // to the lead-assigned uncosted task.
        expect(suggestion?.source).not.toBe("dispatch");
        expect(suggestion).not.toBeNull();
        expect(suggestion.source).toBe("daily_log");
        expect(suggestion.scheduleTaskId).toBe(MOBILE_TASK_DRYW_ID);

        await prisma.taskAssignment.deleteMany({ where: { taskId: TSUG_MIXED_UNCODED_TASK_ID } });
        await prisma.scheduleTask.delete({ where: { id: TSUG_MIXED_UNCODED_TASK_ID } });
        await prisma.estimateItem.delete({ where: { id: TSUG_ITEM_MIXED_UNCODED_ID } });
    });

    test("7a. no bearer token -> 401", async () => {
        const res = await api.get(`/api/mobile/time-suggestion?projectId=${PROJECT_ID}`);
        expect(res.status()).toBe(401);
    });

    test("7b. field crew on a project they are not assigned to -> 403", async () => {
        await prisma.client.create({ data: { id: TSUG_CLIENT_AUTH_ID, name: "E2E TSUG Client Auth", initials: "TA" } });
        await prisma.project.create({
            data: { id: TSUG_PROJECT_AUTH_ID, name: "E2E TSUG Project Auth", clientId: TSUG_CLIENT_AUTH_ID, status: "In Progress" },
        });

        const res = await api.get(`/api/mobile/time-suggestion?projectId=${TSUG_PROJECT_AUTH_ID}`, {
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.status()).toBe(403);

        await prisma.project.delete({ where: { id: TSUG_PROJECT_AUTH_ID } });
        await prisma.client.delete({ where: { id: TSUG_CLIENT_AUTH_ID } });
    });

    test("8. POST /api/time-entries persists the suggestion audit fields", async () => {
        const res = await api.post("/api/time-entries", {
            data: {
                projectId: PROJECT_ID,
                estimateItemId: MOBILE_ITEM_DRYW_ID,
                // The selected estimate item owns the cost code. The client must
                // submit that same code rather than a code from another phase.
                costCodeId: COST_CODE_DRYW_ID,
                suggestedScheduleTaskId: MOBILE_TASK_DRYW_ID,
                suggestedCostCodeId: COST_CODE_DRYW_ID,
                suggestionSource: "daily_log",
                suggestionOverridden: true,
            },
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const created = await res.json();
        createdEntryIds.add(created.id);

        const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id: created.id } });
        expect(entry.costCodeId).toBe(COST_CODE_DRYW_ID);
        expect(entry.suggestionOverridden).toBe(true);
        expect(entry.suggestedScheduleTaskId).toBe(MOBILE_TASK_DRYW_ID);
        expect(entry.suggestedTaskName).toBe("Hang drywall in hall bath");
        expect(entry.suggestedCostCodeId).toBe(COST_CODE_DRYW_ID);
        expect(entry.suggestionSource).toBe("daily_log");

        await prisma.timeEntry.delete({ where: { id: created.id } });
    });

    test("8b. POST /api/time-entries rejects a client cost code from another phase", async () => {
        const res = await api.post("/api/time-entries", {
            data: {
                projectId: PROJECT_ID,
                estimateItemId: MOBILE_ITEM_DRYW_ID,
                costCodeId: COST_CODE_DEMO_ID,
            },
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });

        expect(res.status(), await res.text()).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ code: "ITEM_PHASE_MISMATCH" });
    });

    test("9. legacy POST without suggestion fields still derives the cost code", async () => {
        const res = await api.post("/api/time-entries", {
            // Explicit null costCodeId — exactly what the shipped mobile client sends.
            data: { projectId: PROJECT_ID, estimateItemId: MOBILE_ITEM_DEMO_ID, costCodeId: null },
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const created = await res.json();
        createdEntryIds.add(created.id);

        const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id: created.id } });
        expect(entry.costCodeId).toBe(COST_CODE_DEMO_ID);
        expect(entry.suggestionOverridden).toBe(false);
        expect(entry.suggestedScheduleTaskId).toBeNull();
        expect(entry.suggestedTaskName).toBeNull();
        expect(entry.suggestedCostCodeId).toBeNull();
        expect(entry.suggestionSource).toBeNull();

        await prisma.timeEntry.delete({ where: { id: created.id } });
    });

    test("9b. codeless estimate item rejects a stale client-sent cost code", async () => {
        await prisma.estimateItem.create({
            data: {
                id: TSUG_ITEM_NOCODE_ID,
                estimateId: "e2e-mob-estimate",
                name: "Codeless phase",
                parentId: null,
                quantity: 1,
                unitCost: 100,
                total: 100,
            },
        });

        const res = await api.post("/api/time-entries", {
            data: { projectId: PROJECT_ID, estimateItemId: TSUG_ITEM_NOCODE_ID, costCodeId: COST_CODE_DEMO_ID },
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.status(), await res.text()).toBe(400);
        expect(await res.json()).toMatchObject({ code: "ITEM_PHASE_MISMATCH" });

        await prisma.estimateItem.delete({ where: { id: TSUG_ITEM_NOCODE_ID } });
    });

    test("10. estimate item belonging to another project is rejected with 400", async () => {
        await prisma.client.create({ data: { id: TSUG_CLIENT_X_ID, name: "E2E TSUG Client X", initials: "TX" } });
        await prisma.project.create({
            data: { id: TSUG_PROJECT_X_ID, name: "E2E TSUG Project X", clientId: TSUG_CLIENT_X_ID, status: "In Progress" },
        });
        await prisma.estimate.create({
            data: {
                id: TSUG_ESTIMATE_X_ID,
                title: "E2E TSUG Estimate X",
                code: "EST-TSUG-X",
                status: "Approved",
                projectId: TSUG_PROJECT_X_ID,
                totalAmount: 500,
                balanceDue: 500,
            },
        });
        await prisma.estimateItem.create({
            data: {
                id: TSUG_ITEM_X_ID,
                estimateId: TSUG_ESTIMATE_X_ID,
                name: "Other project item",
                parentId: null,
                quantity: 1,
                unitCost: 500,
                total: 500,
            },
        });

        const res = await api.post("/api/time-entries", {
            data: { projectId: PROJECT_ID, estimateItemId: TSUG_ITEM_X_ID },
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.status()).toBe(400);

        await prisma.estimateItem.delete({ where: { id: TSUG_ITEM_X_ID } });
        await prisma.estimate.delete({ where: { id: TSUG_ESTIMATE_X_ID } });
        await prisma.project.delete({ where: { id: TSUG_PROJECT_X_ID } });
        await prisma.client.delete({ where: { id: TSUG_CLIENT_X_ID } });
    });

    test("11. daily log form submission triggers Stage A matching end-to-end", async ({ page }) => {
        // Uses the default (admin) storageState session — the daily-log form is a
        // staff-only server action, not a mobile-token endpoint.
        // "load" + element auto-wait, not networkidle — the app shell keeps
        // background requests going (polling), so idle may never arrive.
        await page.goto(`/projects/${PROJECT_ID}/dailylogs`);
        await expect(page.getByRole("button", { name: "Add Log", exact: true })).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "Add Log", exact: true }).click();
        await page.getByPlaceholder(/shorthand notes/i).fill(DAILYLOG_MARKER);
        await page.getByPlaceholder(/plan for tomorrow/i).fill("hang drywall in hall bath");
        await page.getByRole("button", { name: "Save Log" }).click();

        await expect(page.getByText("Daily log created!")).toBeVisible({ timeout: 15_000 });

        // Stage A runs in a Next.js after() callback following the write, so it
        // lands shortly AFTER the HTTP/toast response — poll rather than assert once.
        await expect.poll(
            async () => {
                const log = await prisma.dailyLog.findFirst({
                    where: { workPerformed: DAILYLOG_MARKER },
                    select: { aiSuggestedTaskId: true },
                });
                return log?.aiSuggestedTaskId ?? null;
            },
            { timeout: 10_000 },
        ).toBe(MOBILE_TASK_DRYW_ID);

        await prisma.dailyLog.deleteMany({ where: { workPerformed: DAILYLOG_MARKER } });
    });
});

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
        await prisma.scheduleTask.update({
            where: { id: MOBILE_TASK_DRYW_ID },
            data: { status: "In Progress" },
        }).catch(() => {});
        await prisma.taskAssignment.deleteMany({ where: { taskId: TSUG_TASK2_ID } });
        await prisma.scheduleTask.deleteMany({ where: { id: TSUG_TASK2_ID } });
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

    test("1. stored AI pick wins over everything else", async () => {
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

        await prisma.dailyLog.update({
            where: { id: MOBILE_DAILYLOG_ID },
            data: { aiSuggestedTaskId: null, aiSuggestionReason: null },
        });
    });

    test("2. stale stored pick falls through when the task is Complete", async () => {
        // The stored pick names the ONLY suggestable task on this project. Marking
        // it Complete removes it from loadSuggestableTasks entirely (Complete tasks
        // are excluded outright), so the candidate set is empty and
        // suggestTaskForClockIn short-circuits to null before the daily-log lookup
        // (and thus before the keyword fallback) ever runs.
        await prisma.dailyLog.update({
            where: { id: MOBILE_DAILYLOG_ID },
            data: { aiSuggestedTaskId: MOBILE_TASK_DRYW_ID, aiSuggestionReason: "Stale pick" },
        });
        await prisma.scheduleTask.update({ where: { id: MOBILE_TASK_DRYW_ID }, data: { status: "Complete" } });

        const res = await api.get(`/api/mobile/time-suggestion?projectId=${PROJECT_ID}`, {
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const { suggestion } = await res.json();
        expect(suggestion).toBeNull();

        await prisma.scheduleTask.update({ where: { id: MOBILE_TASK_DRYW_ID }, data: { status: "In Progress" } });
        await prisma.dailyLog.update({
            where: { id: MOBILE_DAILYLOG_ID },
            data: { aiSuggestedTaskId: null, aiSuggestionReason: null },
        });
    });

    test("3. keyword match against the latest log picks the drywall task", async () => {
        // aiSuggestedTaskId is null (reset by test 2). The fixture log's nextSteps
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

    test("4. two active assigned tasks with no keyword match falls through to null", async () => {
        // Second suggestable task on the project's other free top-level item
        // (e2e-mob-item-demo has no ScheduleTask yet — MOBILE_ITEM_DRYW_ID is
        // already claimed by the fixture task via the @unique estimateItemId FK),
        // assigned to the same field crew and active today.
        await prisma.scheduleTask.create({
            data: {
                id: TSUG_TASK2_ID,
                projectId: PROJECT_ID,
                name: "Demo phase task",
                type: "task",
                status: "In Progress",
                startDate: daysAgo(3),
                endDate: daysFromNow(4),
                estimateItemId: MOBILE_ITEM_DEMO_ID,
            },
        });
        await prisma.taskAssignment.create({ data: { taskId: TSUG_TASK2_ID, userId: fieldCrewId } });

        // A newer daily log (becomes "latest") whose text shares no tokens with
        // either candidate's name/cost-code tokens, so keywordMatchTasks scores
        // everything 0 and returns null.
        await prisma.dailyLog.create({
            data: {
                id: TSUG_LOG_ID,
                projectId: PROJECT_ID,
                createdById: fieldCrewId,
                date: new Date(),
                workPerformed: "Ordered materials for next week delivery",
                nextSteps: "Confirm supplier invoice totals",
            },
        });

        const res = await api.get(`/api/mobile/time-suggestion?projectId=${PROJECT_ID}`, {
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const { suggestion } = await res.json();
        // No keyword match -> two active assigned tasks (step 3 requires exactly
        // one) -> the fixture's sole history entry has no scheduleTaskId, so step
        // 4 also yields nothing -> null.
        expect(suggestion).toBeNull();

        await prisma.dailyLog.delete({ where: { id: TSUG_LOG_ID } });
        await prisma.taskAssignment.deleteMany({ where: { taskId: TSUG_TASK2_ID } });
        await prisma.scheduleTask.delete({ where: { id: TSUG_TASK2_ID } });
    });

    test("5a. no bearer token -> 401", async () => {
        const res = await api.get(`/api/mobile/time-suggestion?projectId=${PROJECT_ID}`);
        expect(res.status()).toBe(401);
    });

    test("5b. field crew on a project they are not assigned to -> 403", async () => {
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

    test("6. POST /api/time-entries persists the suggestion audit fields", async () => {
        const res = await api.post("/api/time-entries", {
            data: {
                projectId: PROJECT_ID,
                estimateItemId: MOBILE_ITEM_DRYW_ID,
                suggestedScheduleTaskId: MOBILE_TASK_DRYW_ID,
                suggestedCostCodeId: COST_CODE_DRYW_ID,
                suggestionSource: "daily_log",
                suggestionOverridden: true,
            },
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const created = await res.json();

        const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id: created.id } });
        expect(entry.costCodeId).toBe(COST_CODE_DRYW_ID); // derived from estimateItemId, not the client-sent value
        expect(entry.suggestionOverridden).toBe(true);
        expect(entry.suggestedScheduleTaskId).toBe(MOBILE_TASK_DRYW_ID);
        expect(entry.suggestedTaskName).toBe("Hang drywall in hall bath");
        expect(entry.suggestedCostCodeId).toBe(COST_CODE_DRYW_ID);
        expect(entry.suggestionSource).toBe("daily_log");

        await prisma.timeEntry.delete({ where: { id: created.id } });
    });

    test("7. legacy POST without suggestion fields still derives the cost code", async () => {
        const res = await api.post("/api/time-entries", {
            data: { projectId: PROJECT_ID, estimateItemId: MOBILE_ITEM_DEMO_ID },
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const created = await res.json();

        const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id: created.id } });
        expect(entry.costCodeId).toBe(COST_CODE_DEMO_ID);
        expect(entry.suggestionOverridden).toBe(false);
        expect(entry.suggestedScheduleTaskId).toBeNull();
        expect(entry.suggestedTaskName).toBeNull();
        expect(entry.suggestedCostCodeId).toBeNull();
        expect(entry.suggestionSource).toBeNull();

        await prisma.timeEntry.delete({ where: { id: created.id } });
    });

    test("8. estimate item belonging to another project is rejected with 400", async () => {
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

    test("9. daily log form submission triggers Stage A matching end-to-end", async ({ page }) => {
        // Uses the default (admin) storageState session — the daily-log form is a
        // staff-only server action, not a mobile-token endpoint.
        await page.goto(`/projects/${PROJECT_ID}/dailylogs`, { waitUntil: "networkidle" });

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

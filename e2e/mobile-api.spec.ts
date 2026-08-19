import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

// Contract tests for the mobile-app API surface — request-context only, no
// browser. Covers login, /me, time-entries CRUD (auth + math), schedule/today,
// and the time-suggestion endpoint's own validation (the ranking logic itself
// is covered by time-suggestion.spec.ts).

const BASE_URL = "http://localhost:3000";

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const COST_CODE_DEMO_ID = "e2e-mob-cc-demo";
const MOBILE_ITEM_DEMO_ID = "e2e-mob-item-demo";
const MOBILE_TASK_DRYW_ID = "e2e-mob-task-dryw";
const FIELD_CREW_EMAIL = "field-crew@test.local";
const FIELD_CREW_PIN = "246810";
const MANAGER_EMAIL = "manager@test.local";
const MANAGER_PIN = "135790";

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MGR_ENTRY_ID = `e2e-tsug-mgrentry-${RUN}`;
const MGR_OWNED_ENTRY_ID = `e2e-tsug-mgrowned-${RUN}`;

const prisma = new PrismaClient();

async function mobileLogin(request: APIRequestContext, email: string, pinCode: string): Promise<string> {
    const res = await request.post("/api/mobile/login", { data: { email, pinCode } });
    expect(res.ok(), `login failed: ${await res.text()}`).toBeTruthy();
    return ((await res.json()) as { token: string }).token;
}

test.describe.serial("Mobile API contract", () => {
    let api: APIRequestContext;
    let fieldCrewToken: string;
    let managerToken: string;
    let fieldCrewId: string;
    let managerId: string;
    const createdEntryIds = new Set<string>();

    test.beforeAll(async ({ playwright }) => {
        api = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
        fieldCrewToken = await mobileLogin(api, FIELD_CREW_EMAIL, FIELD_CREW_PIN);
        managerToken = await mobileLogin(api, MANAGER_EMAIL, MANAGER_PIN);
        const [fieldCrew, manager] = await Promise.all([
            prisma.user.findUniqueOrThrow({ where: { email: FIELD_CREW_EMAIL }, select: { id: true } }),
            prisma.user.findUniqueOrThrow({ where: { email: MANAGER_EMAIL }, select: { id: true } }),
        ]);
        fieldCrewId = fieldCrew.id;
        managerId = manager.id;
    });

    test.afterAll(async () => {
        for (const id of createdEntryIds) {
            await prisma.timeEntry.deleteMany({ where: { id } });
        }
        await prisma.timeEntry.deleteMany({ where: { id: MGR_ENTRY_ID } });
        await prisma.timeEntry.deleteMany({ where: { id: MGR_OWNED_ENTRY_ID } });
        await api.dispose();
        await prisma.$disconnect();
    });

    test("POST /api/mobile/login — field crew happy path", async () => {
        const res = await api.post("/api/mobile/login", { data: { email: FIELD_CREW_EMAIL, pinCode: FIELD_CREW_PIN } });
        expect(res.ok(), await res.text()).toBeTruthy();
        const body = await res.json();
        expect(typeof body.token).toBe("string");
        expect(body.token.length).toBeGreaterThan(0);
        expect(body.user).toMatchObject({ email: FIELD_CREW_EMAIL, role: "FIELD_CREW" });
        expect(body.user.id).toBeTruthy();
    });

    test("POST /api/mobile/login — manager happy path", async () => {
        const res = await api.post("/api/mobile/login", { data: { email: MANAGER_EMAIL, pinCode: MANAGER_PIN } });
        expect(res.ok(), await res.text()).toBeTruthy();
        const body = await res.json();
        expect(typeof body.token).toBe("string");
        expect(body.user).toMatchObject({ email: MANAGER_EMAIL, role: "MANAGER" });
    });

    test("POST /api/mobile/login — wrong PIN -> 401", async () => {
        const res = await api.post("/api/mobile/login", { data: { email: FIELD_CREW_EMAIL, pinCode: "000000" } });
        expect(res.status()).toBe(401);
    });

    test("POST /api/mobile/login — unknown email -> 401", async () => {
        const res = await api.post("/api/mobile/login", { data: { email: "nobody-e2e-tsug@test.local", pinCode: "123456" } });
        expect(res.status()).toBe(401);
    });

    test("GET /api/mobile/me — field crew shape", async () => {
        const res = await api.get("/api/mobile/me", { headers: { authorization: `Bearer ${fieldCrewToken}` } });
        expect(res.ok(), await res.text()).toBeTruthy();
        const body = await res.json();
        expect(body.user).toMatchObject({ email: FIELD_CREW_EMAIL, role: "FIELD_CREW" });
        expect(Array.isArray(body.assignedProjects)).toBe(true);
        expect(body.assignedProjects.some((p: any) => p.id === PROJECT_ID)).toBe(true);
        expect(body.permissions).toBeTruthy();
    });

    test("GET /api/mobile/me — no token -> 401", async () => {
        const res = await api.get("/api/mobile/me");
        expect(res.status()).toBe(401);
    });

    test("GET /api/mobile/me — garbage token -> 401", async () => {
        const res = await api.get("/api/mobile/me", { headers: { authorization: "Bearer not-a-real-token" } });
        expect(res.status()).toBe(401);
    });

    test("GET /api/time-entries — field crew sees only their own entries", async () => {
        await prisma.timeEntry.create({
            data: { id: MGR_ENTRY_ID, userId: managerId, projectId: PROJECT_ID, startTime: new Date() },
        });

        const res = await api.get(`/api/time-entries?projectId=${PROJECT_ID}`, {
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const entries = await res.json();
        expect(entries.some((e: any) => e.id === MGR_ENTRY_ID)).toBe(false);
    });

    test("GET /api/time-entries — manager sees everyone's entries", async () => {
        const res = await api.get(`/api/time-entries?projectId=${PROJECT_ID}`, {
            headers: { authorization: `Bearer ${managerToken}` },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
        const entries = await res.json();
        expect(entries.some((e: any) => e.id === MGR_ENTRY_ID)).toBe(true);

        await prisma.timeEntry.delete({ where: { id: MGR_ENTRY_ID } });
    });

    test("POST then PUT — duration/laborCost/burdenCost math", async () => {
        const end = new Date();
        const start = new Date(end.getTime() - 2 * 60 * 60 * 1000);
        const postRes = await api.post("/api/time-entries", {
            data: { projectId: PROJECT_ID, estimateItemId: MOBILE_ITEM_DEMO_ID, startTime: start.toISOString() },
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(postRes.ok(), await postRes.text()).toBeTruthy();
        const created = await postRes.json();
        createdEntryIds.add(created.id);

        const putRes = await api.put("/api/time-entries", {
            data: { id: created.id, endTime: end.toISOString() },
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(putRes.ok(), await putRes.text()).toBeTruthy();
        const updated = await putRes.json();

        // laborCost/burdenCost are Prisma Decimal — JSON-serialized as strings.
        expect(Number(updated.durationHours)).toBeCloseTo(2, 1);
        expect(Number(updated.laborCost)).toBeCloseTo(100, 1); // field-crew hourlyRate 50 * 2h
        expect(Number(updated.burdenCost)).toBeCloseTo(20, 1); // field-crew burdenRate 10 * 2h

        await prisma.timeEntry.delete({ where: { id: created.id } });
        createdEntryIds.delete(created.id);
    });

    test("PUT — FIELD_CREW cannot edit another user's entry -> 403", async () => {
        await prisma.timeEntry.create({
            data: { id: MGR_OWNED_ENTRY_ID, userId: managerId, projectId: PROJECT_ID, startTime: new Date() },
        });

        const res = await api.put("/api/time-entries", {
            data: { id: MGR_OWNED_ENTRY_ID, endTime: new Date().toISOString() },
            headers: { authorization: `Bearer ${fieldCrewToken}` },
        });
        expect(res.status()).toBe(403);

        await prisma.timeEntry.delete({ where: { id: MGR_OWNED_ENTRY_ID } });
    });

    test("GET /api/mobile/schedule/today — field crew sees the drywall task with its cost code", async () => {
        const res = await api.get("/api/mobile/schedule/today", { headers: { authorization: `Bearer ${fieldCrewToken}` } });
        expect(res.ok(), await res.text()).toBeTruthy();
        const body = await res.json();
        const task = body.tasks.find((t: any) => t.id === MOBILE_TASK_DRYW_ID);
        expect(task).toBeTruthy();
        expect(task.costCode).toMatchObject({ code: "05-DRYW" });
    });

    test("GET /api/mobile/time-suggestion — missing projectId -> 400", async () => {
        const res = await api.get("/api/mobile/time-suggestion", { headers: { authorization: `Bearer ${fieldCrewToken}` } });
        expect(res.status()).toBe(400);
    });
});

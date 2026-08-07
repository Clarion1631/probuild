import { test as setup } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const ESTIMATE_ID = "cmml6vtx7001dpwrh8n65xzy6";
const TEST_CLIENT_ID = "test-client-do-not-delete";
const ADMIN_EMAIL = "jadkins@goldentouchremodeling.com";
const DEV_ADMIN_EMAIL = "gtrsupport@goldentouchremodeling.com";
const SENTINEL_PATH = resolve(__dirname, ".anthropic-status");

// Mobile-app + suggestion spec fixtures — stable hardcoded IDs (prefix e2e-mob-)
// attached to the PROJECT_ID test project above.
const FIELD_CREW_EMAIL = "field-crew@test.local";
const FIELD_CREW_PIN = "246810";
const MANAGER_EMAIL = "manager@test.local";
const MANAGER_PIN = "135790";
const COST_CODE_DEMO_ID = "e2e-mob-cc-demo";
const COST_CODE_DRYW_ID = "e2e-mob-cc-dryw";
const MOBILE_ESTIMATE_ID = "e2e-mob-estimate";
const MOBILE_ITEM_DEMO_ID = "e2e-mob-item-demo";
const MOBILE_ITEM_DRYW_ID = "e2e-mob-item-dryw";
const MOBILE_TASK_DRYW_ID = "e2e-mob-task-dryw";
const MOBILE_DAILYLOG_ID = "e2e-mob-dailylog";
const MOBILE_DAILYLOG_PHOTO_ID = "e2e-mob-dailylog-photo";
const MOBILE_TIME_ENTRY_HIST_ID = "e2e-mob-entry-hist";

// Substrings that identify the LIVE database. The e2e suite creates leads,
// estimates, and invoices — it must never do that against production data.
// See docs/TESTING.md (the Henderson-lead incident, June 2026).
const PROD_DB_MARKERS = ["supabase.co", "supabase.com", "ghzdbzdnwjxazvmcefbh"];

function resolveDatabaseUrl(): string {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    // Plain Playwright processes don't load .env — mirror what the dev server
    // (and Prisma Client) will resolve so the guard checks the real target.
    const envPath = resolve(__dirname, "..", ".env");
    if (existsSync(envPath)) {
        const line = readFileSync(envPath, "utf8")
            .split(/\r?\n/)
            .find((l) => /^\s*DATABASE_URL\s*=/.test(l));
        if (line) return line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
    }
    return "";
}

setup("guard prod DB + seed test data + probe anthropic", async () => {
    setup.setTimeout(60_000);

    const dbUrl = resolveDatabaseUrl();
    const dbHost = dbUrl.match(/@([^:/?]+)/)?.[1] ?? "(none)";
    console.log("[data.setup] DATABASE_URL host:", dbHost);

    if (PROD_DB_MARKERS.some((m) => dbUrl.includes(m)) && process.env.ALLOW_PROD_E2E !== "1") {
        throw new Error(
            `[data.setup] REFUSING TO RUN: DATABASE_URL points at the live database (${dbHost}).\n` +
                `E2E tests create leads/estimates/invoices and must run against a disposable DB.\n` +
                `Options:\n` +
                `  - CI: already uses a throwaway Postgres service container (see .github/workflows/ci.yml)\n` +
                `  - Local: docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=probuild postgres:16\n` +
                `           then DATABASE_URL=postgresql://postgres:probuild@localhost:5433/postgres npx prisma db push\n` +
                `           and run Playwright with that same DATABASE_URL.\n` +
                `  - Override (discouraged; teardown will clean up): set ALLOW_PROD_E2E=1\n` +
                `See docs/TESTING.md.`
        );
    }

    const prisma = new PrismaClient();
    try {
        // Admin user — required by the PLAYWRIGHT_TEST_SECRET credentials
        // provider (auth.setup.ts logs in as this email).
        const admin = await prisma.user.upsert({
            where: { email: ADMIN_EMAIL },
            update: {},
            create: {
                email: ADMIN_EMAIL,
                name: "Justin Adkins",
                role: "ADMIN",
                status: "ACTIVATED",
            },
        });
        console.log("[data.setup] admin user upserted:", { id: admin.id, email: admin.email });

        // Development mode intentionally falls back to this known ADMIN.
        // Keep it database-backed so permission and status guards exercise the
        // same path as real staff while the local UI remains usable pre-login.
        await prisma.user.upsert({
            where: { email: DEV_ADMIN_EMAIL },
            update: { role: "ADMIN", status: "ACTIVATED" },
            create: {
                email: DEV_ADMIN_EMAIL,
                name: "GTR Support",
                role: "ADMIN",
                status: "ACTIVATED",
            },
        });

        const client = await prisma.client.upsert({
            where: { id: TEST_CLIENT_ID },
            update: {},
            create: {
                id: TEST_CLIENT_ID,
                name: "Test Client — DO NOT DELETE",
                initials: "TC",
                email: "test-client@goldentouchremodeling.com",
            },
        });
        console.log("[data.setup] client upserted:", { id: client.id, name: client.name });

        const project = await prisma.project.upsert({
            where: { id: PROJECT_ID },
            update: {},
            create: {
                id: PROJECT_ID,
                name: "Test Project — DO NOT DELETE (used by e2e)",
                clientId: TEST_CLIENT_ID,
                status: "In Progress",
            },
        });
        console.log("[data.setup] project upserted:", { id: project.id, name: project.name, clientId: project.clientId });

        // Baseline estimate — several specs navigate to this ID as a fallback.
        const estimate = await prisma.estimate.upsert({
            where: { id: ESTIMATE_ID },
            update: {},
            create: {
                id: ESTIMATE_ID,
                title: "E2E Baseline Estimate — DO NOT DELETE",
                code: "EST-E2E",
                status: "Sent",
                projectId: PROJECT_ID,
                totalAmount: 0,
                balanceDue: 0,
            },
        });
        console.log("[data.setup] estimate upserted:", { id: estimate.id, title: estimate.title });

        // --- Mobile-app + suggestion spec fixtures ---
        // Field-crew + manager users, a PIN-loginable pair whose hash matches
        // /api/mobile/login's bcrypt.compare(pinCode, user.pinCode) check.
        const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
        const daysFromNow = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);
        const atHour = (date: Date, hour: number) => {
            const d = new Date(date);
            d.setHours(hour, 0, 0, 0);
            return d;
        };

        const fieldCrewPinHash = await bcrypt.hash(FIELD_CREW_PIN, 10);
        const fieldCrew = await prisma.user.upsert({
            where: { email: FIELD_CREW_EMAIL },
            update: {
                role: "FIELD_CREW",
                status: "ACTIVATED",
                pinCode: fieldCrewPinHash,
                hourlyRate: 50,
                burdenRate: 10,
            },
            create: {
                email: FIELD_CREW_EMAIL,
                name: "E2E Field Crew",
                role: "FIELD_CREW",
                status: "ACTIVATED",
                pinCode: fieldCrewPinHash,
                hourlyRate: 50,
                burdenRate: 10,
            },
        });
        console.log("[data.setup] field-crew user upserted:", { id: fieldCrew.id, email: fieldCrew.email });

        const managerPinHash = await bcrypt.hash(MANAGER_PIN, 10);
        const manager = await prisma.user.upsert({
            where: { email: MANAGER_EMAIL },
            update: {
                role: "MANAGER",
                status: "ACTIVATED",
                pinCode: managerPinHash,
                hourlyRate: 60,
            },
            create: {
                email: MANAGER_EMAIL,
                name: "E2E Manager",
                role: "MANAGER",
                status: "ACTIVATED",
                pinCode: managerPinHash,
                hourlyRate: 60,
            },
        });
        console.log("[data.setup] manager user upserted:", { id: manager.id, email: manager.email });

        // Grant project access both ways userCanAccessProject checks (ProjectAccess row
        // OR the crew relation) — seeding both keeps the fixture valid regardless of
        // which path a given spec exercises.
        await prisma.projectAccess.upsert({
            where: { userId_projectId: { userId: fieldCrew.id, projectId: PROJECT_ID } },
            update: {},
            create: { userId: fieldCrew.id, projectId: PROJECT_ID },
        });
        await prisma.project.update({
            where: { id: PROJECT_ID },
            data: { crew: { connect: { id: fieldCrew.id } } },
        });

        const costCodeDemo = await prisma.costCode.upsert({
            where: { id: COST_CODE_DEMO_ID },
            update: {},
            create: { id: COST_CODE_DEMO_ID, code: "01-DEMO", name: "Demolition" },
        });
        const costCodeDryw = await prisma.costCode.upsert({
            where: { id: COST_CODE_DRYW_ID },
            update: {},
            create: { id: COST_CODE_DRYW_ID, code: "05-DRYW", name: "Drywall" },
        });
        console.log("[data.setup] cost codes upserted:", { demo: costCodeDemo.id, dryw: costCodeDryw.id });

        const mobileEstimate = await prisma.estimate.upsert({
            where: { id: MOBILE_ESTIMATE_ID },
            update: { status: "Approved", archivedAt: null },
            create: {
                id: MOBILE_ESTIMATE_ID,
                title: "E2E Mobile Estimate — DO NOT DELETE",
                code: "EST-E2E-MOB",
                status: "Approved",
                projectId: PROJECT_ID,
                totalAmount: 2000,
                balanceDue: 2000,
                archivedAt: null,
            },
        });
        console.log("[data.setup] mobile estimate upserted:", { id: mobileEstimate.id, status: mobileEstimate.status });

        await prisma.estimateItem.upsert({
            where: { id: MOBILE_ITEM_DEMO_ID },
            update: {},
            create: {
                id: MOBILE_ITEM_DEMO_ID,
                estimateId: MOBILE_ESTIMATE_ID,
                name: "Demolition phase",
                parentId: null,
                costCodeId: COST_CODE_DEMO_ID,
                quantity: 1,
                unitCost: 1000,
                total: 1000,
            },
        });
        await prisma.estimateItem.upsert({
            where: { id: MOBILE_ITEM_DRYW_ID },
            update: {},
            create: {
                id: MOBILE_ITEM_DRYW_ID,
                estimateId: MOBILE_ESTIMATE_ID,
                name: "Drywall phase",
                parentId: null,
                costCodeId: COST_CODE_DRYW_ID,
                quantity: 1,
                unitCost: 1000,
                total: 1000,
            },
        });
        console.log("[data.setup] mobile estimate items upserted:", { demo: MOBILE_ITEM_DEMO_ID, dryw: MOBILE_ITEM_DRYW_ID });

        // Active "today" whenever the suite runs — recomputed on every run (including
        // update) so a stale first-run window doesn't age out of the active range.
        const scheduleStart = daysAgo(3);
        const scheduleEnd = daysFromNow(4);
        await prisma.scheduleTask.upsert({
            where: { id: MOBILE_TASK_DRYW_ID },
            update: { startDate: scheduleStart, endDate: scheduleEnd, status: "In Progress" },
            create: {
                id: MOBILE_TASK_DRYW_ID,
                projectId: PROJECT_ID,
                name: "Hang drywall in hall bath",
                type: "task",
                status: "In Progress",
                startDate: scheduleStart,
                endDate: scheduleEnd,
                // @unique — must stay 1:1 with MOBILE_ITEM_DRYW_ID across re-runs.
                estimateItemId: MOBILE_ITEM_DRYW_ID,
            },
        });
        await prisma.taskAssignment.upsert({
            where: { taskId_userId: { taskId: MOBILE_TASK_DRYW_ID, userId: fieldCrew.id } },
            update: {},
            create: { taskId: MOBILE_TASK_DRYW_ID, userId: fieldCrew.id },
        });
        console.log("[data.setup] schedule task + assignment upserted:", { id: MOBILE_TASK_DRYW_ID, assignee: fieldCrew.id });

        // DailyLog.date convention: every real writer stores UTC MIDNIGHT of the
        // intended company-local (America/Los_Angeles) calendar day, never a raw
        // timestamp — the suggestion engine reads the ISO date part as the day.
        // A raw timestamp here sorts above date-only rows from the same day and
        // flips "latest log" ordering depending on the wall clock (bit CI once).
        const companyDayUtcMidnight = (offsetDays: number) => {
            const parts = new Intl.DateTimeFormat("en-CA", {
                timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
            }).formatToParts(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000));
            const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
            return new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00.000Z`);
        };
        const dailyLogDate = companyDayUtcMidnight(-1);
        await prisma.dailyLog.upsert({
            where: { id: MOBILE_DAILYLOG_ID },
            update: { date: dailyLogDate },
            create: {
                id: MOBILE_DAILYLOG_ID,
                projectId: PROJECT_ID,
                createdById: fieldCrew.id,
                date: dailyLogDate,
                workPerformed: "Demo complete in hall bath, hauled debris",
                nextSteps: "Start hanging drywall in the hall bath",
            },
        });
        await prisma.dailyLogPhoto.upsert({
            where: { id: MOBILE_DAILYLOG_PHOTO_ID },
            update: {},
            create: {
                id: MOBILE_DAILYLOG_PHOTO_ID,
                dailyLogId: MOBILE_DAILYLOG_ID,
                url: "https://example.test/e2e/drywall.jpg",
                caption: "drywall stacked in hallway",
            },
        });
        console.log("[data.setup] daily log + photo upserted:", { id: MOBILE_DAILYLOG_ID, photo: MOBILE_DAILYLOG_PHOTO_ID });

        const histStart = atHour(daysAgo(1), 8);
        const histEnd = atHour(daysAgo(1), 12);
        await prisma.timeEntry.upsert({
            where: { id: MOBILE_TIME_ENTRY_HIST_ID },
            update: { startTime: histStart, endTime: histEnd },
            create: {
                id: MOBILE_TIME_ENTRY_HIST_ID,
                userId: fieldCrew.id,
                projectId: PROJECT_ID,
                costCodeId: COST_CODE_DEMO_ID,
                estimateItemId: MOBILE_ITEM_DEMO_ID,
                startTime: histStart,
                endTime: histEnd,
                durationHours: 4,
            },
        });
        console.log("[data.setup] historical time entry upserted:", { id: MOBILE_TIME_ENTRY_HIST_ID });

        const verify = await prisma.project.findUnique({ where: { id: PROJECT_ID }, select: { id: true, name: true } });
        console.log("[data.setup] verify project exists:", verify);
    } catch (e) {
        console.error("[data.setup] DB upsert failed:", (e as Error).message);
        throw e;
    } finally {
        await prisma.$disconnect();
    }

    const key = process.env.ANTHROPIC_API_KEY;
    let status: "ok" | "invalid" = "invalid";
    if (key) {
        try {
            const res = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 1,
                    messages: [{ role: "user", content: "hi" }],
                }),
            });
            if (res.ok) status = "ok";
        } catch {
            status = "invalid";
        }
    }

    mkdirSync(dirname(SENTINEL_PATH), { recursive: true });
    writeFileSync(SENTINEL_PATH, status, "utf8");
});

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

// --- Partial-scope fixtures (prefix e2e-scope-) ---
// A staff reader who can see estimates and leads but only ONE project, plus a
// SECOND project they cannot reach that carries an approved estimate. Together
// these make every scoped aggregate in the app provably partial for this user
// and provably complete for the ADMIN, which is what estimate-scope-labels.spec
// asserts in a real browser. The ADMIN session can never exercise that branch —
// accessibleProjectIds returns "ALL" for ADMIN — so this second user is the only
// way to prove the label wiring at runtime rather than by grepping the source.
const SCOPED_STAFF_EMAIL = "scoped-staff@test.local";
const OOS_PROJECT_ID = "e2e-scope-oos-project";
const OOS_PROJECT_NAME = "E2E Out-Of-Scope Project — DO NOT DELETE";
const OOS_ESTIMATE_ID = "e2e-scope-oos-estimate";
const OOS_LEAD_ID = "e2e-scope-oos-lead";
const OOS_LEAD_ESTIMATE_ID = "e2e-scope-oos-lead-estimate";

// --- Contract-auth fixtures (prefix e2e-contract-) ---
// Two more staff users, distinct from SCOPED_STAFF above, because the contract
// guard (canAccessContract) is BOTH a vertical check (the `contracts`
// permission) and the horizontal one (project/lead scope) — proving it needs a
// user that has scope but lacks the permission, and a separate user that has
// the permission but lacks scope on a specific job. See
// e2e/contract-auth-runtime.spec.ts, which exercises PR #367's
// assertContractAccess/canAccessContract/contractScopeWhere through the
// test-only dispatcher.
const FINANCE_STAFF_EMAIL = "finance-staff@test.local";
const CONTRACT_STAFF_EMAIL = "contract-staff@test.local";
const CONTRACT_INSCOPE_ID = "e2e-contract-inscope";
const CONTRACT_CONVERTED_ID = "e2e-contract-converted";
const CONTRACT_LEADONLY_ID = "e2e-contract-leadonly";
const CONTRACT_EXECUTED_PDF_ID = "e2e-contract-executed-pdf";

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

        // --- Partial-scope fixtures ---
        // EMPLOYEE, not FIELD_CREW: the pages under test need `estimates` and
        // `leadAccess`, and granting those to a role whose defaults withhold them
        // keeps the fixture explicit about WHY this user can read the pages at all.
        const scopedStaff = await prisma.user.upsert({
            where: { email: SCOPED_STAFF_EMAIL },
            update: { role: "EMPLOYEE", status: "ACTIVATED" },
            create: {
                email: SCOPED_STAFF_EMAIL,
                name: "E2E Scoped Staff",
                role: "EMPLOYEE",
                status: "ACTIVATED",
            },
        });
        const scopedPermissions = {
            estimates: true,
            leadAccess: true,
            // Off deliberately: an auto-grant would hand this user every project
            // and silently erase the partial scope the whole fixture exists for.
            autoGrantNewProjects: false,
        };
        await prisma.userPermission.upsert({
            where: { userId: scopedStaff.id },
            update: scopedPermissions,
            create: { userId: scopedStaff.id, ...scopedPermissions },
        });
        // Exactly one project. Access is granted via ProjectAccess only — the crew
        // relation is left alone so a stray crew connect cannot widen the scope.
        await prisma.projectAccess.upsert({
            where: { userId_projectId: { userId: scopedStaff.id, projectId: PROJECT_ID } },
            update: {},
            create: { userId: scopedStaff.id, projectId: PROJECT_ID },
        });
        // ...and re-narrow on re-runs, in case an earlier run or another fixture
        // granted more. Without this the spec would pass for the wrong reason
        // (or fail confusingly) against a reused database.
        await prisma.projectAccess.deleteMany({
            where: { userId: scopedStaff.id, projectId: { not: PROJECT_ID } },
        });
        const scopedCrewProjects = await prisma.project.findMany({
            where: { id: { not: PROJECT_ID }, crew: { some: { id: scopedStaff.id } } },
            select: { id: true },
        });
        for (const p of scopedCrewProjects) {
            await prisma.project.update({
                where: { id: p.id },
                data: { crew: { disconnect: { id: scopedStaff.id } } },
            });
        }
        console.log("[data.setup] scoped staff user upserted:", { id: scopedStaff.id, email: scopedStaff.email });

        // The lead must exist before the project that points at it (Project.leadId).
        // Every `update` below restates the fields the fixture is DEFINED by,
        // not just the ones that drift. On a reused database an earlier run (or
        // a spec that reparents rows) can leave a closed project, a re-owned
        // estimate, or a moved lead behind, and an empty `update` would adopt
        // that state — the specs would then pass or fail for reasons unrelated
        // to the labels under test.
        await prisma.lead.upsert({
            where: { id: OOS_LEAD_ID },
            update: { clientId: TEST_CLIENT_ID, stage: "Won" },
            create: {
                id: OOS_LEAD_ID,
                name: "E2E Out-Of-Scope Lead — DO NOT DELETE",
                clientId: TEST_CLIENT_ID,
                stage: "Won",
            },
        });
        await prisma.project.upsert({
            where: { id: OOS_PROJECT_ID },
            update: {
                name: OOS_PROJECT_NAME,
                clientId: TEST_CLIENT_ID,
                leadId: OOS_LEAD_ID,
                // Not "Archived": the /projects list hides archived rows, and a
                // hidden out-of-scope project makes the revenue sum complete.
                status: "In Progress",
            },
            create: {
                id: OOS_PROJECT_ID,
                name: OOS_PROJECT_NAME,
                clientId: TEST_CLIENT_ID,
                leadId: OOS_LEAD_ID,
                status: "In Progress",
            },
        });
        // Approved, so it lands in the /projects revenue sum for a reader who can
        // see it — that sum is the number whose label is under test.
        await prisma.estimate.upsert({
            where: { id: OOS_ESTIMATE_ID },
            update: {
                status: "Approved",
                totalAmount: 5000,
                balanceDue: 5000,
                archivedAt: null,
                // Ownership is the whole point of this row — restate it, or a
                // reparented estimate quietly stops being out of scope.
                projectId: OOS_PROJECT_ID,
                leadId: null,
            },
            create: {
                id: OOS_ESTIMATE_ID,
                title: "E2E Out-Of-Scope Estimate — DO NOT DELETE",
                code: "EST-E2E-OOS",
                status: "Approved",
                projectId: OOS_PROJECT_ID,
                totalAmount: 5000,
                balanceDue: 5000,
            },
        });
        // A lead-owned estimate on the same lead: reachable via `leadAccess`, so
        // the scoped reader sees a non-empty page whose totals are still partial.
        await prisma.estimate.upsert({
            where: { id: OOS_LEAD_ESTIMATE_ID },
            update: {
                status: "Approved",
                totalAmount: 1000,
                balanceDue: 1000,
                archivedAt: null,
                leadId: OOS_LEAD_ID,
                // Must stay lead-OWNED: given a projectId it would resolve
                // through project access instead of leadAccess and vanish for
                // the scoped reader, emptying the page it is here to populate.
                projectId: null,
            },
            create: {
                id: OOS_LEAD_ESTIMATE_ID,
                title: "E2E Out-Of-Scope Lead Estimate — DO NOT DELETE",
                code: "EST-E2E-OOS-LEAD",
                status: "Approved",
                leadId: OOS_LEAD_ID,
                totalAmount: 1000,
                balanceDue: 1000,
            },
        });
        console.log("[data.setup] partial-scope fixtures upserted:", {
            project: OOS_PROJECT_ID, lead: OOS_LEAD_ID, estimates: [OOS_ESTIMATE_ID, OOS_LEAD_ESTIMATE_ID],
        });

        // --- Contract-auth fixtures ---
        // FINANCE: holds project access (PROJECT_ID) but NOT `contracts` — FINANCE's
        // role default is `estimates` (getDefaultPermission in access-rules.ts), never
        // `contracts`. This is the user who must get an EMPTY contract list from the
        // pages and "Forbidden" from every by-id contract action, proving project
        // access alone is not the contract permission.
        const financeStaff = await prisma.user.upsert({
            where: { email: FINANCE_STAFF_EMAIL },
            update: { role: "FINANCE", status: "ACTIVATED" },
            create: {
                email: FINANCE_STAFF_EMAIL,
                name: "E2E Finance Staff",
                role: "FINANCE",
                status: "ACTIVATED",
            },
        });
        const financePermissions = {
            estimates: true,
            leadAccess: true,
            contracts: false,
            autoGrantNewProjects: false,
        };
        await prisma.userPermission.upsert({
            where: { userId: financeStaff.id },
            update: financePermissions,
            create: { userId: financeStaff.id, ...financePermissions },
        });
        await prisma.projectAccess.upsert({
            where: { userId_projectId: { userId: financeStaff.id, projectId: PROJECT_ID } },
            update: {},
            create: { userId: financeStaff.id, projectId: PROJECT_ID },
        });
        await prisma.projectAccess.deleteMany({
            where: { userId: financeStaff.id, projectId: { not: PROJECT_ID } },
        });
        const financeCrewProjects = await prisma.project.findMany({
            where: { id: { not: PROJECT_ID }, crew: { some: { id: financeStaff.id } } },
            select: { id: true },
        });
        for (const p of financeCrewProjects) {
            await prisma.project.update({
                where: { id: p.id },
                data: { crew: { disconnect: { id: financeStaff.id } } },
            });
        }
        console.log("[data.setup] finance staff user upserted:", { id: financeStaff.id, email: financeStaff.email });

        // CONTRACT_STAFF: holds `contracts` + `leadAccess`, but scope reaches only
        // PROJECT_ID — proves canAccessJobScope lets projectId win when a converted
        // contract carries BOTH ids (CONTRACT_CONVERTED_ID below): leadAccess must
        // not rescue a contract on a project this user cannot otherwise reach.
        const contractStaff = await prisma.user.upsert({
            where: { email: CONTRACT_STAFF_EMAIL },
            update: { role: "EMPLOYEE", status: "ACTIVATED" },
            create: {
                email: CONTRACT_STAFF_EMAIL,
                name: "E2E Contract Staff",
                role: "EMPLOYEE",
                status: "ACTIVATED",
            },
        });
        const contractPermissions = {
            estimates: true,
            leadAccess: true,
            contracts: true,
            autoGrantNewProjects: false,
        };
        await prisma.userPermission.upsert({
            where: { userId: contractStaff.id },
            update: contractPermissions,
            create: { userId: contractStaff.id, ...contractPermissions },
        });
        await prisma.projectAccess.upsert({
            where: { userId_projectId: { userId: contractStaff.id, projectId: PROJECT_ID } },
            update: {},
            create: { userId: contractStaff.id, projectId: PROJECT_ID },
        });
        await prisma.projectAccess.deleteMany({
            where: { userId: contractStaff.id, projectId: { not: PROJECT_ID } },
        });
        const contractCrewProjects = await prisma.project.findMany({
            where: { id: { not: PROJECT_ID }, crew: { some: { id: contractStaff.id } } },
            select: { id: true },
        });
        for (const p of contractCrewProjects) {
            await prisma.project.update({
                where: { id: p.id },
                data: { crew: { disconnect: { id: contractStaff.id } } },
            });
        }
        console.log("[data.setup] contract staff user upserted:", { id: contractStaff.id, email: contractStaff.email });

        // Three contracts covering the three scope shapes canAccessContract cares
        // about. Every field is restated in `update:` — an empty update adopts
        // whatever drift an earlier run left behind.
        await prisma.contract.upsert({
            where: { id: CONTRACT_INSCOPE_ID },
            update: {
                projectId: PROJECT_ID,
                leadId: null,
                title: "E2E In-Scope Contract — DO NOT DELETE",
                body: "E2E IN-SCOPE CONTRACT BODY — DO NOT DELETE",
                status: "Draft",
                accessToken: "e2e-contract-token-inscope",
            },
            create: {
                id: CONTRACT_INSCOPE_ID,
                projectId: PROJECT_ID,
                leadId: null,
                title: "E2E In-Scope Contract — DO NOT DELETE",
                body: "E2E IN-SCOPE CONTRACT BODY — DO NOT DELETE",
                status: "Draft",
                accessToken: "e2e-contract-token-inscope",
            },
        });
        // THIS IS THE CRITICAL ONE — carries BOTH projectId and leadId, like a
        // converted lead. leadAccess alone would admit it via the lead, but
        // canAccessJobScope lets the project id win, and contract-staff cannot
        // reach OOS_PROJECT_ID, so it must be refused.
        await prisma.contract.upsert({
            where: { id: CONTRACT_CONVERTED_ID },
            update: {
                projectId: OOS_PROJECT_ID,
                leadId: OOS_LEAD_ID,
                title: "E2E Converted Contract — DO NOT DELETE",
                body: "E2E CONVERTED CONTRACT BODY — DO NOT DELETE",
                status: "Draft",
                accessToken: "e2e-contract-token-converted",
            },
            create: {
                id: CONTRACT_CONVERTED_ID,
                projectId: OOS_PROJECT_ID,
                leadId: OOS_LEAD_ID,
                title: "E2E Converted Contract — DO NOT DELETE",
                body: "E2E CONVERTED CONTRACT BODY — DO NOT DELETE",
                status: "Draft",
                accessToken: "e2e-contract-token-converted",
            },
        });
        // The POSITIVE control, reachable by contract-staff via leadAccess. Also
        // the contract the portal tests use (lead-owned, so /portal/contracts/[id]
        // skips the getPortalVisibility(projectId) branch). Signed + approvedBy/At
        // set, with requiresCountersign explicitly false, so the portal treats it
        // as executed (isExecuted = isSigned && !awaitingCountersign) and renders
        // the archived-PDF banner. A default only applies on `create` — restated
        // here in `update` too, or a pre-existing `true` on a reused database
        // would survive and silently flip the portal's executed/awaiting state.
        await prisma.contract.upsert({
            where: { id: CONTRACT_LEADONLY_ID },
            update: {
                projectId: null,
                leadId: OOS_LEAD_ID,
                title: "E2E Lead-Only Contract — DO NOT DELETE",
                body: "E2E LEAD-ONLY CONTRACT BODY — DO NOT DELETE",
                status: "Signed",
                accessToken: "e2e-contract-token-leadonly",
                approvedBy: "Test Client",
                approvedAt: new Date(),
                requiresCountersign: false,
            },
            create: {
                id: CONTRACT_LEADONLY_ID,
                projectId: null,
                leadId: OOS_LEAD_ID,
                title: "E2E Lead-Only Contract — DO NOT DELETE",
                body: "E2E LEAD-ONLY CONTRACT BODY — DO NOT DELETE",
                status: "Signed",
                accessToken: "e2e-contract-token-leadonly",
                approvedBy: "Test Client",
                approvedAt: new Date(),
                requiresCountersign: false,
            },
        });
        console.log("[data.setup] contracts upserted:", {
            inscope: CONTRACT_INSCOPE_ID, converted: CONTRACT_CONVERTED_ID, leadonly: CONTRACT_LEADONLY_ID,
        });

        // Executed-PDF file for CONTRACT_LEADONLY_ID. Name must be the EXACT string
        // executedContractPdfFor() matches on (src/lib/contract-files-core.ts).
        await prisma.projectFile.upsert({
            where: { id: CONTRACT_EXECUTED_PDF_ID },
            update: {
                leadId: OOS_LEAD_ID,
                projectId: null,
                mimeType: "application/pdf",
                name: `Executed_Contract_${CONTRACT_LEADONLY_ID}.pdf`,
                url: "https://example.test/e2e/executed-contract.pdf",
            },
            create: {
                id: CONTRACT_EXECUTED_PDF_ID,
                leadId: OOS_LEAD_ID,
                projectId: null,
                mimeType: "application/pdf",
                name: `Executed_Contract_${CONTRACT_LEADONLY_ID}.pdf`,
                url: "https://example.test/e2e/executed-contract.pdf",
            },
        });
        console.log("[data.setup] executed contract PDF file upserted:", { id: CONTRACT_EXECUTED_PDF_ID });

        // Portal sanity check: resolveSessionClientId (src/lib/portal-auth.ts)
        // collapses to `null` — silently — if this email matches zero OR more than
        // one Client row, which would make the portal-session contract test pass
        // for the wrong reason (a null session falls through to the accessToken-only
        // path, never exercising the session branch at all).
        const portalClientMatches = await prisma.client.findMany({
            where: { email: "test-client@goldentouchremodeling.com" },
            select: { id: true },
        });
        console.log("[data.setup] portal client sanity check:", portalClientMatches);
        if (portalClientMatches.length !== 1) {
            throw new Error(
                `[data.setup] expected exactly one Client with email test-client@goldentouchremodeling.com, ` +
                    `found ${portalClientMatches.length}. resolveSessionClientId() would silently return null, ` +
                    `and the portal-session contract test would pass for the wrong reason.`
            );
        }

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

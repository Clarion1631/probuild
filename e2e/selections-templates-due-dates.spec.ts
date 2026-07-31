import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { isAdminOrManager, canAccessProject } from "../src/lib/permissions";
import { signClientPortalToken } from "../src/lib/client-portal-auth";
// Imported from the plain core modules, NOT src/lib/actions.ts — actions.ts
// is a "use server" file that transitively imports "server-only", which is
// not resolvable outside a Next.js build context (see
// e2e/selections-ai-sort.spec.ts's identical comment).
import {
    createDecisionTemplate,
    listDecisionTemplates,
    archiveDecisionTemplate,
} from "../src/lib/decision-template-crud-core";
import { applyDecisionTemplate } from "../src/lib/decision-template-apply-core";
import {
    linkDecisionToSchedule,
    setDecisionDueDateOverride,
} from "../src/lib/decision-link-actions-core";
import { computeEffectiveDueDate } from "../src/lib/decision-due-date";

const prisma = new PrismaClient();
const run = `selection-templates-${process.pid}-${Date.now()}`;
const ids = {
    client: `${run}-client`,
    project: `${run}-project`,
    otherProject: `${run}-other-project`,
    admin: `${run}-admin`,
    manager: `${run}-manager`,
    fieldCrewNoAccess: `${run}-field-crew-no-access`,
    fieldCrewWithAccess: `${run}-field-crew-with-access`,
    taskCabinets: `${run}-task-cabinets`,
} as const;

let templateId = "";
let template2Id = "";
let uiApplyTemplateId = "";
let archivedTemplateId = "";
// Direct core-module calls run in a bare Node process, not a live Next.js
// request — the real (default) revalidate would throw ("static generation
// store missing"), same as applySuggestedDecision's testDeps in
// e2e/selections-ai-sort.spec.ts. Assignable to every deps.revalidate shape
// used below (0-arg and 1-arg) since JS/TS allow calling with fewer params.
const NOOP_REVALIDATE = () => {};
const clientEmail = `${run}@example.com`;

test.describe.serial("Decision templates + schedule-driven due dates", () => {
    test.beforeAll(async () => {
        await prisma.client.create({ data: { id: ids.client, name: "Templates Client", initials: "TP", email: clientEmail } });
        await prisma.project.create({
            data: { id: ids.project, name: "Templates Project", clientId: ids.client, status: "In Progress" },
        });
        await prisma.project.create({
            data: { id: ids.otherProject, name: "Templates Other Project", clientId: ids.client, status: "In Progress" },
        });
        await prisma.portalVisibility.create({
            data: { projectId: ids.project, isPortalEnabled: true, showSelections: true },
        });
        await prisma.user.create({
            data: { id: ids.admin, email: `${run}-admin@example.com`, name: "Templates Admin", role: "ADMIN", status: "ACTIVATED" },
        });
        await prisma.user.create({
            data: { id: ids.manager, email: `${run}-manager@example.com`, name: "Templates Manager", role: "MANAGER", status: "ACTIVATED" },
        });
        await prisma.user.create({
            data: { id: ids.fieldCrewNoAccess, email: `${run}-fc-no@example.com`, name: "FC No Access", role: "FIELD_CREW", status: "ACTIVATED" },
        });
        await prisma.user.create({
            data: {
                id: ids.fieldCrewWithAccess,
                email: `${run}-fc-yes@example.com`,
                name: "FC With Access",
                role: "FIELD_CREW",
                status: "ACTIVATED",
                assignedProjects: { connect: [{ id: ids.project }] },
            },
        });
        await prisma.scheduleTask.create({
            data: {
                id: ids.taskCabinets,
                projectId: ids.project,
                name: "Cabinet Install",
                startDate: new Date("2026-09-01T00:00:00.000Z"),
                endDate: new Date("2026-09-05T00:00:00.000Z"),
            },
        });
    });

    test.afterAll(async () => {
        await prisma.decision.deleteMany({ where: { projectId: { in: [ids.project, ids.otherProject] } } });
        await prisma.scheduleTask.deleteMany({ where: { projectId: ids.project } });
        await prisma.project.deleteMany({ where: { id: { in: [ids.project, ids.otherProject] } } });
        await prisma.client.deleteMany({ where: { id: ids.client } });
        await prisma.user.deleteMany({ where: { id: { in: [ids.admin, ids.manager, ids.fieldCrewNoAccess, ids.fieldCrewWithAccess] } } });
        if (templateId) {
            await prisma.decisionTemplate.deleteMany({
                where: { id: { in: [templateId, template2Id, uiApplyTemplateId, archivedTemplateId].filter(Boolean) } },
            });
        }
        await prisma.$disconnect();
    });

    // ── Case 1: ADMIN creates a template; FIELD_CREW is denied ──────────────

    test("isAdminOrManager gates ADMIN/MANAGER in, FIELD_CREW out (direct predicate test)", async () => {
        expect(isAdminOrManager({ role: "ADMIN" })).toBe(true);
        expect(isAdminOrManager({ role: "MANAGER" })).toBe(true);
        expect(isAdminOrManager({ role: "FIELD_CREW" })).toBe(false);
    });

    test("ADMIN creates a template with 3 items (one with lead time + schedule hint)", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const template = await createDecisionTemplate(
            {
                name: `${run} Kitchen Remodel`,
                description: "Standard kitchen categories",
                items: [
                    { name: "Cabinets", area: "Kitchen", defaultLeadTimeDays: 14, scheduleHint: "Cabinet Install" },
                    { name: "Countertops", area: "Kitchen" },
                    { name: "Backsplash" },
                ],
            },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        templateId = template.id;
        expect(template.items).toHaveLength(3);
        expect(template.items[0].name).toBe("Cabinets");
        expect(template.items[0].defaultLeadTimeDays).toBe(14);
        expect(template.items[0].scheduleHint).toBe("Cabinet Install");
        expect(template.items[0].order).toBe(0);
        expect(template.items[2].order).toBe(2);
    });

    test("FIELD_CREW's createDecisionTemplate call rejects — the real production authorization rule", async () => {
        const fieldCrew = await prisma.user.findUniqueOrThrow({ where: { id: ids.fieldCrewNoAccess } });
        await expect(
            createDecisionTemplate(
                { name: "Should Not Be Created", items: [{ name: "X" }] },
                { getActor: async () => fieldCrew, revalidate: NOOP_REVALIDATE },
            ),
        ).rejects.toThrow("Forbidden");

        const count = await prisma.decisionTemplate.count({ where: { name: "Should Not Be Created" } });
        expect(count).toBe(0);
    });

    test("FIELD_CREW navigating to /templates/selections is redirected (page-level gate)", async ({ browser }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const csrfRes = await page.request.get("/api/auth/csrf");
        const { csrfToken } = await csrfRes.json();
        const fieldCrew = await prisma.user.findUniqueOrThrow({ where: { id: ids.fieldCrewNoAccess } });
        const authRes = await page.request.post("/api/auth/callback/credentials", {
            form: { csrfToken, email: fieldCrew.email!, secret: process.env.PLAYWRIGHT_TEST_SECRET || "" },
        });
        expect(authRes.ok()).toBe(true);

        await page.goto("/templates/selections");
        await expect(page).toHaveURL(/\/templates$/);

        await context.close();
    });

    test("MANAGER can also list templates (ADMIN is not the only allowed role)", async () => {
        const manager = await prisma.user.findUniqueOrThrow({ where: { id: ids.manager } });
        const templates = await listDecisionTemplates({ getActor: async () => manager, revalidate: NOOP_REVALIDATE });
        expect(templates.some((t) => t.id === templateId)).toBe(true);
    });

    // ── Case 2: apply to project → decisions created in order; re-apply skips ──

    test("applying a template creates decisions in item order with templateKey + leadTimeDays", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const result = await applyDecisionTemplate(ids.project, templateId, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });
        expect(result.created).toBe(3);
        expect(result.skipped).toEqual([]);

        const decisions = await prisma.decision.findMany({
            where: { projectId: ids.project, deletedAt: null },
            orderBy: { sortOrder: "asc" },
        });
        expect(decisions.map((d) => d.name)).toEqual(["Cabinets", "Countertops", "Backsplash"]);
        expect(decisions[0].templateKey).toBe(`decision-template:${templateId}:${(await prisma.decisionTemplateItem.findFirstOrThrow({ where: { templateId, name: "Cabinets" } })).id}`);
        expect(decisions[0].leadTimeDays).toBe(14);
        expect(decisions[1].leadTimeDays).toBeNull();
    });

    test("re-applying the same template to the same project skips every item — no duplicates", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const before = await prisma.decision.count({ where: { projectId: ids.project, deletedAt: null } });

        const result = await applyDecisionTemplate(ids.project, templateId, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });
        expect(result.created).toBe(0);
        expect(result.skipped.sort()).toEqual(["Backsplash", "Cabinets", "Countertops"]);

        const after = await prisma.decision.count({ where: { projectId: ids.project, deletedAt: null } });
        expect(after).toBe(before);
    });

    test("applyDecisionTemplate's authorization bar is ANY staff with project access — NOT ADMIN/MANAGER-only", async () => {
        const fieldCrewWithAccess = await prisma.user.findUniqueOrThrow({
            where: { id: ids.fieldCrewWithAccess },
            include: { assignedProjects: { select: { id: true } }, projectAccess: { select: { projectId: true } } },
        });
        // The bar itself: canAccessProject admits this staffer (proves the
        // apply flow's authorization is NOT the stricter isAdminOrManager
        // gate template CRUD uses).
        expect(canAccessProject(fieldCrewWithAccess, ids.project)).toBe(true);
        expect(isAdminOrManager(fieldCrewWithAccess)).toBe(false);

        const template2 = await createDecisionTemplate(
            { name: `${run} Second Template`, items: [{ name: "Flooring" }] },
            {
                getActor: async () => await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } }),
                revalidate: NOOP_REVALIDATE,
            },
        );
        template2Id = template2.id;

        const result = await applyDecisionTemplate(ids.project, template2Id, {
            getActor: async () => fieldCrewWithAccess,
            revalidate: NOOP_REVALIDATE,
        });
        expect(result.created).toBe(1);

        const decision = await prisma.decision.findFirstOrThrow({ where: { projectId: ids.project, name: "Flooring" } });
        expect(decision.templateKey).toContain(template2Id);
    });

    test("a FIELD_CREW without project access is rejected by applyDecisionTemplate", async () => {
        const fieldCrewNoAccess = await prisma.user.findUniqueOrThrow({
            where: { id: ids.fieldCrewNoAccess },
            include: { assignedProjects: { select: { id: true } }, projectAccess: { select: { projectId: true } } },
        });
        await expect(
            applyDecisionTemplate(ids.otherProject, templateId, { getActor: async () => fieldCrewNoAccess, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow("Forbidden");
    });

    // ── Case 3: link to schedule (mocked AI covered in the review-modal E2E
    // below); here we exercise the underlying link action + derivation math
    // directly, since these are what the modal's Apply calls per row. ──────

    test("linking a decision to a schedule task derives effectiveDueDate = startDate - leadTimeDays (UTC calendar math)", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await prisma.decision.findFirstOrThrow({ where: { projectId: ids.project, name: "Cabinets" } });

        await linkDecisionToSchedule(decision.id, ids.taskCabinets, 14, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });

        const updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(updated.scheduleTaskId).toBe(ids.taskCabinets);
        expect(updated.leadTimeDays).toBe(14);
        expect(updated.dueDate).toBeNull(); // linking never touches the override column

        const task = await prisma.scheduleTask.findUniqueOrThrow({ where: { id: ids.taskCabinets } });
        const effective = computeEffectiveDueDate(updated, new Map([[ids.taskCabinets, task.startDate]]));
        expect(effective?.toISOString().slice(0, 10)).toBe("2026-08-18"); // Sept 1 - 14 days

        // Shift the schedule task's startDate directly — derivation is live,
        // no stale storage: the SAME computeEffectiveDueDate call now
        // reflects the new date with zero writes to Decision.
        const shifted = new Date("2026-10-01T00:00:00.000Z");
        await prisma.scheduleTask.update({ where: { id: ids.taskCabinets }, data: { startDate: shifted } });
        const effectiveAfterShift = computeEffectiveDueDate(updated, new Map([[ids.taskCabinets, shifted]]));
        expect(effectiveAfterShift?.toISOString().slice(0, 10)).toBe("2026-09-17"); // Oct 1 - 14 days
    });

    test("linking rejects a non-integer/out-of-range leadTimeDays, and a scheduleTaskId from another project (cross-project tamper check)", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await prisma.decision.findFirstOrThrow({ where: { projectId: ids.project, name: "Countertops" } });

        await expect(
            linkDecisionToSchedule(decision.id, ids.taskCabinets, 400, { getActor: async () => admin, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow();
        await expect(
            linkDecisionToSchedule(decision.id, ids.taskCabinets, null, { getActor: async () => admin, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow();

        const otherTask = await prisma.scheduleTask.create({
            data: {
                id: `${run}-other-task`,
                projectId: ids.otherProject,
                name: "Other Project Task",
                startDate: new Date(),
                endDate: new Date(),
            },
        });
        await expect(
            linkDecisionToSchedule(decision.id, otherTask.id, 5, { getActor: async () => admin, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow();

        const unchanged = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(unchanged.scheduleTaskId).toBeNull();
    });

    test("unlinking requires scheduleTaskId: null with leadTimeDays: null together", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await prisma.decision.findFirstOrThrow({ where: { projectId: ids.project, name: "Cabinets" } });

        await expect(
            linkDecisionToSchedule(decision.id, null, 5, { getActor: async () => admin, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow();

        await linkDecisionToSchedule(decision.id, null, null, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });
        const updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(updated.scheduleTaskId).toBeNull();
        expect(updated.leadTimeDays).toBeNull();
    });

    // ── Case 4: manual override always wins, survives dangling links ───────

    test("ADMIN/MANAGER can set a manual override; it wins over derivation and survives a deleted linked task", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const manager = await prisma.user.findUniqueOrThrow({ where: { id: ids.manager } });
        const decision = await prisma.decision.findFirstOrThrow({ where: { projectId: ids.project, name: "Backsplash" } });

        const overrideDate = new Date("2026-12-25T00:00:00.000Z");
        await setDecisionDueDateOverride(decision.id, overrideDate, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });
        let updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(updated.dueDate?.toISOString()).toBe(overrideDate.toISOString());

        // A subsequent link/shift does NOT move the override.
        const task = await prisma.scheduleTask.create({
            data: { id: `${run}-backsplash-task`, projectId: ids.project, name: "Backsplash Install", startDate: new Date("2026-06-01"), endDate: new Date("2026-06-05") },
        });
        await linkDecisionToSchedule(decision.id, task.id, 3, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });
        updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        let effective = computeEffectiveDueDate(updated, new Map([[task.id, task.startDate]]));
        expect(effective?.toISOString()).toBe(overrideDate.toISOString());

        // Deleting the linked task entirely does not affect the overridden
        // date either — override survives dangling links.
        await prisma.scheduleTask.delete({ where: { id: task.id } });
        updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        effective = computeEffectiveDueDate(updated, new Map()); // dangling — no row in the batched lookup
        expect(effective?.toISOString()).toBe(overrideDate.toISOString());

        // MANAGER can also set/clear it.
        await setDecisionDueDateOverride(decision.id, null, { getActor: async () => manager, revalidate: NOOP_REVALIDATE });
        updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        expect(updated.dueDate).toBeNull();
        // Cleared override returns to derived — but the task is gone
        // (dangling scheduleTaskId), so effectiveDueDate is null, "not
        // linked", never an error.
        effective = computeEffectiveDueDate(updated, new Map());
        expect(effective).toBeNull();
    });

    test("FIELD_CREW cannot set a due-date override (direct action-level test)", async () => {
        const fieldCrew = await prisma.user.findUniqueOrThrow({ where: { id: ids.fieldCrewWithAccess } });
        const decision = await prisma.decision.findFirstOrThrow({ where: { projectId: ids.project, name: "Backsplash" } });
        await expect(
            setDecisionDueDateOverride(decision.id, new Date(), { getActor: async () => fieldCrew, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow("Forbidden");
    });

    // ── Case 5: dangling link (task row deleted) shows "not linked" ────────

    test("a dangling scheduleTaskId (linked task deleted) yields null effectiveDueDate — no error", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const decision = await prisma.decision.findFirstOrThrow({ where: { projectId: ids.project, name: "Countertops" } });
        const task = await prisma.scheduleTask.create({
            data: { id: `${run}-countertop-task`, projectId: ids.project, name: "Countertop Install", startDate: new Date("2026-09-10"), endDate: new Date("2026-09-12") },
        });
        await linkDecisionToSchedule(decision.id, task.id, 5, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });

        await prisma.scheduleTask.delete({ where: { id: task.id } });
        const updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
        // Batched lookup would come back empty for this project now — the
        // dangling id maps to nothing.
        const effective = computeEffectiveDueDate(updated, new Map());
        expect(effective).toBeNull();
    });

    // ── UI: the "Link to schedule" review modal end to end (mocked AI) ─────

    test("review modal: Link to schedule shows a mocked suggestion; Apply links the decision", async ({ page }) => {
        const uiDecision = await prisma.decision.create({
            data: { id: `${run}-ui-decision`, projectId: ids.project, name: "ZzzUiFlooring", status: "Open" },
        });
        const uiTask = await prisma.scheduleTask.create({
            data: {
                id: `${run}-ui-task`,
                projectId: ids.project,
                name: "ZzzUiFlooring Install",
                startDate: new Date("2026-11-01T00:00:00.000Z"),
                endDate: new Date("2026-11-05T00:00:00.000Z"),
            },
        });

        await page.goto(`/projects/${ids.project}/selections`);
        await Promise.all([
            page.waitForResponse((res) => res.url().includes("/api/selections/link-schedule") && res.ok()),
            page.getByTestId("link-to-schedule-button").click(),
        ]);

        const modal = page.getByTestId("link-schedule-modal");
        await expect(modal).toBeVisible();
        const select = modal.getByTestId(`link-schedule-row-select-${uiDecision.id}`);
        await expect(select).toHaveValue(uiTask.id); // mock keyword-matched "Flooring" → the flooring task

        await modal.getByTestId("link-schedule-apply").click();
        await expect(modal).not.toBeVisible();

        const linked = await prisma.decision.findUniqueOrThrow({ where: { id: uiDecision.id } });
        expect(linked.scheduleTaskId).toBe(uiTask.id);
        expect(linked.leadTimeDays).not.toBeNull();
    });

    // ── Case 6: portal shows "Decide by" with the correct date; raw
    //    dueDate/scheduleTaskId/leadTimeDays never leave the server; portal
    //    actor cannot call link/override/template actions ─────────────────

    test("portal: undecided decision shows 'Decide by' with the correct date, and the payload never carries the raw link/override fields", async ({ browser }) => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const portalDecision = await prisma.decision.create({
            data: { id: `${run}-portal-decision`, projectId: ids.project, name: "Portal Decide By Test", status: "Open" },
        });
        const overrideDate = new Date("2026-08-04T00:00:00.000Z");
        await setDecisionDueDateOverride(portalDecision.id, overrideDate, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });

        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        const token = await signClientPortalToken(ids.client, clientEmail);
        await page.goto(
            `/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(`/portal/projects/${ids.project}/selections`)}`,
        );

        await expect(page.getByText("Portal Decide By Test")).toBeVisible();
        // Scoped to THIS decision's card — other decisions on this shared
        // project fixture (from earlier tests in this serial suite) also
        // render a "Decide by" line, so an unscoped .first() would be
        // order-dependent and flaky.
        const card = page.locator(".hui-card", { hasText: "Portal Decide By Test" });
        const decideBy = card.getByTestId("portal-decide-by");
        await expect(decideBy).toContainText("Aug 4");

        const portalMarkup = await page.content();
        expect(portalMarkup).not.toContain('"dueDate"');
        expect(portalMarkup).not.toContain('"scheduleTaskId"');
        expect(portalMarkup).not.toContain('"leadTimeDays"');
        expect(portalMarkup).toContain("effectiveDueDate");

        await context.close();
    });

    test("a portal client cannot call template/link/override actions (direct authorization test, zero writes)", async () => {
        const before = await prisma.decision.findMany({ where: { projectId: ids.project, deletedAt: null }, select: { id: true, scheduleTaskId: true, dueDate: true } });

        // The portal actor is represented by `null` in every getActor seam
        // below — assertDecisionActorAccess/canAccessProject/isAdminOrManager
        // all require a real staff user object; a portal client never
        // resolves to one, so every one of these calls must reject.
        await expect(
            createDecisionTemplate({ name: "Portal Should Not Create", items: [{ name: "X" }] }, { getActor: async () => null, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow("Forbidden");
        await expect(
            applyDecisionTemplate(ids.project, templateId, { getActor: async () => null, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow("Forbidden");
        await expect(
            linkDecisionToSchedule(before[0].id, ids.taskCabinets, 5, { getActor: async () => null, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow("Forbidden");
        await expect(
            setDecisionDueDateOverride(before[0].id, new Date(), { getActor: async () => null, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow("Forbidden");

        const after = await prisma.decision.findMany({ where: { projectId: ids.project, deletedAt: null }, select: { id: true, scheduleTaskId: true, dueDate: true } });
        expect(after).toEqual(before);
    });

    // ── Codex review round 1 follow-ups ─────────────────────────────────────

    test("issue 1: applying an ARCHIVED template is rejected, not silently applied", async () => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const template = await createDecisionTemplate(
            { name: `${run} Archived Template`, items: [{ name: "Should Not Be Created" }] },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        archivedTemplateId = template.id;
        await archiveDecisionTemplate(template.id, { getActor: async () => admin, revalidate: NOOP_REVALIDATE });

        await expect(
            applyDecisionTemplate(ids.project, template.id, { getActor: async () => admin, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow("Template not found");

        const decision = await prisma.decision.findFirst({ where: { projectId: ids.project, name: "Should Not Be Created" } });
        expect(decision).toBeNull();
    });

    test("issue 11: auth runs BEFORE the decision lookup — an unauthenticated caller gets the same Forbidden for a real or a nonexistent decisionId (no existence oracle)", async () => {
        const realDecision = await prisma.decision.findFirstOrThrow({ where: { projectId: ids.project } });

        await expect(
            linkDecisionToSchedule(realDecision.id, null, null, { getActor: async () => null, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow("Forbidden");
        await expect(
            linkDecisionToSchedule("this-decision-id-does-not-exist", null, null, { getActor: async () => null, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow("Forbidden"); // NOT "Decision not found" — the lookup never runs without a real actor

        await expect(
            setDecisionDueDateOverride(realDecision.id, null, { getActor: async () => null, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow("Forbidden");
        await expect(
            setDecisionDueDateOverride("this-decision-id-does-not-exist", null, { getActor: async () => null, revalidate: NOOP_REVALIDATE }),
        ).rejects.toThrow("Forbidden");
    });

    // ── BLOCKER: applyDecisionTemplate had no UI call site at all — this is
    // the missing "Apply template" flow end to end. ─────────────────────────

    test("UI: 'Apply template' button opens a picker, applying creates decisions and shows a result toast", async ({ page }) => {
        const admin = await prisma.user.findUniqueOrThrow({ where: { id: ids.admin } });
        const template = await createDecisionTemplate(
            {
                name: `${run} UI Apply Template`,
                items: [{ name: "UI Apply Item A" }, { name: "UI Apply Item B" }],
            },
            { getActor: async () => admin, revalidate: NOOP_REVALIDATE },
        );
        uiApplyTemplateId = template.id;

        await page.goto(`/projects/${ids.project}/selections`);
        await page.getByTestId("apply-template-button").click();

        const modal = page.getByTestId("apply-template-modal");
        await expect(modal).toBeVisible();
        const option = modal.getByTestId(`apply-template-option-${template.id}`);
        await expect(option).toBeVisible();
        await expect(modal.getByTestId(`apply-template-items-${template.id}`)).toContainText("UI Apply Item A");
        await expect(modal.getByTestId(`apply-template-items-${template.id}`)).toContainText("UI Apply Item B");
        await option.click();

        await modal.getByTestId("apply-template-confirm").click();
        await expect(page.getByText("2 created")).toBeVisible();
        await expect(modal).not.toBeVisible();

        const decisionA = await prisma.decision.findFirst({ where: { projectId: ids.project, name: "UI Apply Item A", deletedAt: null } });
        const decisionB = await prisma.decision.findFirst({ where: { projectId: ids.project, name: "UI Apply Item B", deletedAt: null } });
        expect(decisionA).not.toBeNull();
        expect(decisionB).not.toBeNull();
        expect(decisionA?.templateKey).toContain(template.id);

        // Re-applying the SAME template through the UI reports the skip —
        // proves the picker's toast reflects real created/skipped counts,
        // not a hardcoded string.
        await page.getByTestId("apply-template-button").click();
        await expect(modal).toBeVisible();
        await modal.getByTestId(`apply-template-option-${template.id}`).click();
        await modal.getByTestId("apply-template-confirm").click();
        await expect(page.getByText("0 created, 2 skipped (already exist)")).toBeVisible();
    });
});

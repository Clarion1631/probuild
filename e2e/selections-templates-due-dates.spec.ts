import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { isAdminOrManager, canAccessProject } from "../src/lib/permissions";
// Imported from the plain core modules, NOT src/lib/actions.ts — actions.ts
// is a "use server" file that transitively imports "server-only", which is
// not resolvable outside a Next.js build context (see
// e2e/selections-ai-sort.spec.ts's identical comment).
import {
    createDecisionTemplate,
    listDecisionTemplates,
} from "../src/lib/decision-template-crud-core";
import { applyDecisionTemplate } from "../src/lib/decision-template-apply-core";

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
} as const;

let templateId = "";
let template2Id = "";
// Direct core-module calls run in a bare Node process, not a live Next.js
// request — the real (default) revalidate would throw ("static generation
// store missing"), same as applySuggestedDecision's testDeps in
// e2e/selections-ai-sort.spec.ts. Assignable to every deps.revalidate shape
// used below (0-arg and 1-arg) since JS/TS allow calling with fewer params.
const NOOP_REVALIDATE = () => {};

test.describe.serial("Decision templates + schedule-driven due dates", () => {
    test.beforeAll(async () => {
        await prisma.client.create({ data: { id: ids.client, name: "Templates Client", initials: "TP" } });
        await prisma.project.create({
            data: { id: ids.project, name: "Templates Project", clientId: ids.client, status: "In Progress" },
        });
        await prisma.project.create({
            data: { id: ids.otherProject, name: "Templates Other Project", clientId: ids.client, status: "In Progress" },
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
    });

    test.afterAll(async () => {
        await prisma.decision.deleteMany({ where: { projectId: { in: [ids.project, ids.otherProject] } } });
        await prisma.project.deleteMany({ where: { id: { in: [ids.project, ids.otherProject] } } });
        await prisma.client.deleteMany({ where: { id: ids.client } });
        await prisma.user.deleteMany({ where: { id: { in: [ids.admin, ids.manager, ids.fieldCrewNoAccess, ids.fieldCrewWithAccess] } } });
        if (templateId) await prisma.decisionTemplate.deleteMany({ where: { id: { in: [templateId, template2Id] } } });
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

    // Cases 3-7 (schedule linking, manual override, dangling links, portal
    // display, cross-project tamper on linking) land in the next commit —
    // "feat(selections): schedule-linked due dates" — alongside the linking
    // core/route/actions themselves.
});

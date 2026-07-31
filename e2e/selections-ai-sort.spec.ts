import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signClientPortalToken } from "../src/lib/client-portal-auth";
import { canAccessProject } from "../src/lib/permissions";
// Imported from the plain core module, NOT src/lib/actions.ts — actions.ts
// is a "use server" file that transitively imports "server-only" (via
// selection-item-note-persistence.ts), which is not resolvable outside a
// Next.js build context and breaks a direct import from a Playwright spec.
import { applySuggestedDecision, dismissSelectionSuggestion } from "../src/lib/selection-ai-sort-apply-core";

const prisma = new PrismaClient();
const run = `selection-ai-sort-${process.pid}-${Date.now()}`;
const ids = {
    client: `${run}-client`,
    project: `${run}-project`,
    otherProject: `${run}-other-project`,
    restrictedStaff: `${run}-restricted-staff`,
    decisionFixtures: `${run}-decision-fixtures`,
    decisionFlooring: `${run}-decision-flooring`,
    unsortedFaucet: `${run}-unsorted-faucet`,
    unsortedFlooring: `${run}-unsorted-flooring`,
    assignedItem: `${run}-assigned-item`,
    raceItem: `${run}-race-item`,
    portalItem: `${run}-portal-item`,
} as const;
const clientEmail = `${run}@example.com`;

test.describe.serial("AI auto-sort for unsorted selection items", () => {
    test.beforeAll(async () => {
        await prisma.client.create({
            data: { id: ids.client, name: "AI Sort Client", initials: "AS", email: clientEmail },
        });
        await prisma.project.create({
            data: { id: ids.project, name: "AI Sort Project", clientId: ids.client, status: "In Progress" },
        });
        await prisma.project.create({
            data: { id: ids.otherProject, name: "AI Sort Other Project", clientId: ids.client, status: "In Progress" },
        });
        await prisma.portalVisibility.create({
            data: { projectId: ids.project, isPortalEnabled: true, showSelections: true },
        });
        await prisma.user.create({
            data: {
                id: ids.restrictedStaff,
                email: `${run}-restricted@example.com`,
                name: "Restricted AI Sort Staff",
                role: "FIELD_CREW",
                status: "ACTIVATED",
            },
        });
        await prisma.decision.create({
            data: { id: ids.decisionFixtures, projectId: ids.project, name: "Fixtures" },
        });
        await prisma.decision.create({
            data: { id: ids.decisionFlooring, projectId: ids.project, name: "Flooring" },
        });
        await prisma.selectionProposal.create({
            data: { id: ids.unsortedFaucet, projectId: ids.project, name: "Kitchen Fixtures Faucet", status: "Idea" },
        });
        await prisma.selectionProposal.create({
            data: { id: ids.unsortedFlooring, projectId: ids.project, name: "Oak Flooring Plank", status: "Idea" },
        });
        // Already filed into a decision — the AI route must never touch it
        // (Unsorted only; manual filing may be a deliberate override).
        await prisma.selectionProposal.create({
            data: {
                id: ids.assignedItem,
                projectId: ids.project,
                decisionId: ids.decisionFixtures,
                name: "Already Filed Fixtures Item",
                status: "Idea",
            },
        });
        await prisma.selectionProposal.create({
            data: { id: ids.raceItem, projectId: ids.project, name: "Race Condition Fixtures Item", status: "Idea" },
        });
        await prisma.selectionProposal.create({
            data: { id: ids.portalItem, projectId: ids.project, name: "Portal Isolation Fixtures Item", status: "Idea" },
        });
    });

    test.afterAll(async () => {
        await prisma.project.deleteMany({ where: { id: { in: [ids.project, ids.otherProject] } } });
        await prisma.client.deleteMany({ where: { id: ids.client } });
        await prisma.user.deleteMany({ where: { id: ids.restrictedStaff } });
        await prisma.$disconnect();
    });

    test("a portal client POSTing ai-sort gets 403 and writes zero suggestions", async ({ browser }) => {
        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        const token = await signClientPortalToken(ids.client, clientEmail);
        await page.goto(
            `/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(
                `/portal/projects/${ids.project}/selections`,
            )}`,
        );

        const response = await page.request.post("/api/selections/ai-sort", {
            data: { projectId: ids.project },
        });
        expect(response.status()).toBe(403);

        const item = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.unsortedFaucet } });
        expect(item.suggestedDecisionId).toBeNull();
        expect(item.suggestedAt).toBeNull();

        await context.close();
    });

    test("staff without project access is scope-checked via canAccessProject and gets 403", async ({ browser }) => {
        const restrictedStaff = await prisma.user.findUniqueOrThrow({
            where: { id: ids.restrictedStaff },
            include: { projectAccess: { select: { projectId: true } }, assignedProjects: { select: { id: true } } },
        });
        expect(canAccessProject(restrictedStaff, ids.project)).toBe(false);

        const context = await browser.newContext();
        const page = await context.newPage();
        const csrfRes = await page.request.get("/api/auth/csrf");
        const { csrfToken } = await csrfRes.json();
        const authRes = await page.request.post("/api/auth/callback/credentials", {
            form: { csrfToken, email: restrictedStaff.email!, secret: process.env.PLAYWRIGHT_TEST_SECRET || "" },
        });
        expect(authRes.ok()).toBe(true);

        const response = await page.request.post("/api/selections/ai-sort", {
            data: { projectId: ids.project },
        });
        expect(response.status()).toBe(403);

        const item = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.unsortedFaucet } });
        expect(item.suggestedDecisionId).toBeNull();

        await context.close();
    });

    test("staff request runs the mock, persists suggestions, skips an already-filed item", async ({ page }) => {
        const response = await page.request.post("/api/selections/ai-sort", {
            data: { projectId: ids.project },
        });
        expect(response.ok()).toBe(true);
        const payload = await response.json();
        const byItemId = new Map(payload.suggestions.map((s: { itemId: string }) => [s.itemId, s]));

        // Only unsorted items are ever included — the already-filed item
        // never appears in the response or gets touched in the DB.
        expect(byItemId.has(ids.assignedItem)).toBe(false);
        expect(byItemId.has(ids.unsortedFaucet)).toBe(true);
        expect(byItemId.has(ids.unsortedFlooring)).toBe(true);

        const faucetSuggestion = byItemId.get(ids.unsortedFaucet) as { decisionId: string | null; decisionName: string | null; confidence: string };
        expect(faucetSuggestion.decisionId).toBe(ids.decisionFixtures);
        expect(faucetSuggestion.decisionName).toBe("Fixtures");
        expect(["high", "medium", "low"]).toContain(faucetSuggestion.confidence);

        const storedFaucet = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.unsortedFaucet } });
        expect(storedFaucet.suggestedDecisionId).toBe(ids.decisionFixtures);
        expect(storedFaucet.suggestedAt).not.toBeNull();

        const storedAssigned = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.assignedItem } });
        expect(storedAssigned.suggestedDecisionId).toBeNull();
    });

    // Direct calls below inject a no-op assertAccess/revalidate — the real
    // ones require a live Next.js request scope (getServerSession/
    // revalidatePath), which a bare test process calling the function
    // directly doesn't have. The auth CHECK itself is proven separately, via
    // real HTTP requests, in the two "gets 403" tests above.
    const testDeps = { assertAccess: async () => {}, revalidate: () => {} };

    test("applySuggestedDecision moves the item and clears the suggestion", async () => {
        const before = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.unsortedFaucet } });
        expect(before.suggestedDecisionId).toBe(ids.decisionFixtures);

        const result = await applySuggestedDecision(ids.unsortedFaucet, ids.decisionFixtures, testDeps);
        expect(result.applied).toBe(true);

        const after = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.unsortedFaucet } });
        expect(after.decisionId).toBe(ids.decisionFixtures);
        expect(after.suggestedDecisionId).toBeNull();
        expect(after.suggestedAt).toBeNull();
    });

    test("applySuggestedDecision rejects a decisionId from a different project (tampered call)", async () => {
        const foreignDecisionId = `${run}-foreign-decision`;
        await prisma.decision.create({ data: { id: foreignDecisionId, projectId: ids.otherProject, name: "Foreign Decision" } });

        await expect(applySuggestedDecision(ids.unsortedFlooring, foreignDecisionId, testDeps)).rejects.toThrow(
            "doesn't belong to this project",
        );
        const item = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.unsortedFlooring } });
        expect(item.decisionId).toBeNull();

        await prisma.decision.delete({ where: { id: foreignDecisionId } });
    });

    test("a concurrent assignment between suggest and apply is reported skipped, original filing preserved (CAS)", async () => {
        // Seed a persisted suggestion the same way the route would.
        await prisma.selectionProposal.update({
            where: { id: ids.raceItem },
            data: { suggestedDecisionId: ids.decisionFixtures, suggestedAt: new Date() },
        });

        // Simulate a concurrent manual filing into a DIFFERENT decision,
        // happening between the suggestion being computed and Apply being
        // clicked.
        await prisma.selectionProposal.update({
            where: { id: ids.raceItem },
            data: { decisionId: ids.decisionFlooring },
        });

        const result = await applySuggestedDecision(ids.raceItem, ids.decisionFixtures, testDeps);
        expect(result.applied).toBe(false);

        const after = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.raceItem } });
        expect(after.decisionId).toBe(ids.decisionFlooring);
    });

    test("dismissSelectionSuggestion clears the suggestion without moving the item", async () => {
        await prisma.selectionProposal.update({
            where: { id: ids.unsortedFlooring },
            data: { suggestedDecisionId: ids.decisionFlooring, suggestedAt: new Date() },
        });

        const result = await dismissSelectionSuggestion(ids.unsortedFlooring, testDeps);
        expect(result.success).toBe(true);

        const after = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.unsortedFlooring } });
        expect(after.decisionId).toBeNull();
        expect(after.suggestedDecisionId).toBeNull();
        expect(after.suggestedAt).toBeNull();
    });

    test("portal reads strip suggestedDecisionId/suggestedAt from the rendered page (negative payload assertion)", async ({ browser }) => {
        // getProjectDecisionsForPortal/getSelectionProposalsForPortal live in
        // src/lib/actions.ts ("use server") and can't be imported directly
        // from this spec (see the header comment) — code-level stripping is
        // asserted statically by scripts/verify-selection-ai-sort.ts instead.
        // This test proves the real, end-to-end result: the fields never
        // reach the serialized page a client actually receives.
        await prisma.selectionProposal.update({
            where: { id: ids.portalItem },
            data: { suggestedDecisionId: ids.decisionFixtures, suggestedAt: new Date() },
        });

        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        const token = await signClientPortalToken(ids.client, clientEmail);
        await page.goto(
            `/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(
                `/portal/projects/${ids.project}/selections`,
            )}`,
        );
        await expect(page.getByTestId(`selection-item-${ids.portalItem}`)).toBeVisible();
        const html = await page.content();
        expect(html).not.toContain("suggestedDecisionId");
        expect(html).not.toContain("suggestedAt");

        await context.close();
    });
});

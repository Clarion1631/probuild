import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signClientPortalToken } from "../src/lib/client-portal-auth";
import { canAccessProject } from "../src/lib/permissions";
// Imported from the plain core module, NOT src/lib/actions.ts — actions.ts
// is a "use server" file that transitively imports "server-only" (via
// selection-item-note-persistence.ts), which is not resolvable outside a
// Next.js build context and breaks a direct import from a Playwright spec.
import { applySuggestedDecision, dismissSelectionSuggestion } from "../src/lib/selection-ai-sort-apply-core";
// Test-only marker recognized by the deterministic mock — forces a batch to
// return a deliberately invalid (duplicate itemId) response. Lets these
// specs exercise the real strict-cardinality retry-then-fail path, and
// batch isolation across multiple batches, end to end with no real AI.
import { FORCE_INVALID_BATCH_MARKER } from "../src/lib/selection-ai-sort-mock";

const prisma = new PrismaClient();
const run = `selection-ai-sort-${process.pid}-${Date.now()}`;
const BATCH_GOOD_ITEM_COUNT = 25; // matches BATCH_SIZE in selection-ai-sort-core.ts
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
    uiFaucetItem: `${run}-ui-faucet-item`,
    uiFlooringItem: `${run}-ui-flooring-item`,
    uiReviewItem: `${run}-ui-review-item`,
    uiChipItem: `${run}-ui-chip-item`,
    uiDismissItem: `${run}-ui-dismiss-item`,
    a11yItem: `${run}-a11y-item`,
    // Batch isolation / strict-contract fixtures — dedicated projects so
    // their item counts (25 + 1, and a lone poison) aren't disturbed by
    // items created/consumed elsewhere in this serial suite.
    batchProject: `${run}-batch-project`,
    batchPoisonItem: `${run}-batch-poison-item`,
    soloPoisonProject: `${run}-solo-poison-project`,
    soloPoisonItem: `${run}-solo-poison-item`,
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

        // Batch isolation: 25 "good" items (always classify fine — a real
        // batch's worth) + 1 "poison" item carrying the marker that forces
        // its hosting batch to return an invalid (duplicate itemId)
        // response. Whichever batch(es) these land in, the run must still
        // persist/return every batch that succeeded.
        await prisma.project.create({
            data: { id: ids.batchProject, name: "AI Sort Batch Isolation Project", clientId: ids.client, status: "In Progress" },
        });
        await prisma.selectionProposal.createMany({
            data: Array.from({ length: BATCH_GOOD_ITEM_COUNT }, (_, i) => ({
                id: `${run}-batch-good-${i}`,
                projectId: ids.batchProject,
                name: `Batch Good Item ${i}`,
                status: "Idea",
            })),
        });
        await prisma.selectionProposal.create({
            data: {
                id: ids.batchPoisonItem,
                projectId: ids.batchProject,
                name: `Poison Item ${FORCE_INVALID_BATCH_MARKER}`,
                status: "Idea",
            },
        });

        // All-batches-fail: a project whose ONLY unsorted item is the
        // poison item — the run has nothing that succeeded at all, so this
        // must be the one case that surfaces as a 502.
        await prisma.project.create({
            data: { id: ids.soloPoisonProject, name: "AI Sort All-Batches-Fail Project", clientId: ids.client, status: "In Progress" },
        });
        await prisma.selectionProposal.create({
            data: {
                id: ids.soloPoisonItem,
                projectId: ids.soloPoisonProject,
                name: `Solo Poison Item ${FORCE_INVALID_BATCH_MARKER}`,
                status: "Idea",
            },
        });
    });

    test.afterAll(async () => {
        await prisma.project.deleteMany({
            where: { id: { in: [ids.project, ids.otherProject, ids.batchProject, ids.soloPoisonProject] } },
        });
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

    test("a batch that fails strict cardinality is isolated — other batches still persist; partial success returned as 200", async ({ page }) => {
        const response = await page.request.post("/api/selections/ai-sort", {
            data: { projectId: ids.batchProject },
        });
        expect(response.status()).toBe(200);
        const payload = await response.json();

        // Order-independent invariants (Prisma's findMany doesn't guarantee
        // which batch the poison item lands in): every one of the 26 seeded
        // items is accounted for exactly once, the poison item is never
        // among the successes, and at least one other batch succeeded —
        // proving one batch's failure neither aborts nor discards the rest.
        expect(payload.suggestions.length + payload.failedItemIds.length).toBe(BATCH_GOOD_ITEM_COUNT + 1);
        expect(payload.failedItemIds).toContain(ids.batchPoisonItem);
        expect(payload.suggestions.some((s: { itemId: string }) => s.itemId === ids.batchPoisonItem)).toBe(false);
        expect(payload.suggestions.length).toBeGreaterThan(0);

        const poison = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.batchPoisonItem } });
        expect(poison.suggestedDecisionId).toBeNull();
        expect(poison.suggestedAt).toBeNull();

        // Persisted rows match exactly what the response reported as
        // successful — nothing extra written, nothing successful dropped.
        const persistedCount = await prisma.selectionProposal.count({
            where: { projectId: ids.batchProject, suggestedAt: { not: null } },
        });
        expect(persistedCount).toBe(payload.suggestions.length);
    });

    test("when the only batch fails every attempt, the route returns 502 (never a silent null match)", async ({ page }) => {
        const response = await page.request.post("/api/selections/ai-sort", {
            data: { projectId: ids.soloPoisonProject },
        });
        expect(response.status()).toBe(502);

        const item = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.soloPoisonItem } });
        expect(item.suggestedDecisionId).toBeNull();
        expect(item.suggestedAt).toBeNull();
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

    // ── UI: Sort with AI button, review modal, chips ────────────────────────
    // ids.unsortedFlooring and ids.portalItem are still unsorted leftovers
    // from earlier tests in this serial suite — soft-delete them so they
    // don't show up as extra rows/cards in the UI assertions below (matches
    // real behavior: a deleted item is excluded from every unsorted query).

    test("Sort with AI + Apply moves matching items into the right decisions and clears the chip", async ({ page }) => {
        await prisma.selectionProposal.updateMany({
            where: { id: { in: [ids.unsortedFlooring, ids.portalItem] } },
            data: { deletedAt: new Date() },
        });
        await prisma.selectionProposal.create({
            data: { id: ids.uiFaucetItem, projectId: ids.project, name: "Primary Bath Fixtures Faucet", status: "Idea" },
        });
        await prisma.selectionProposal.create({
            data: { id: ids.uiFlooringItem, projectId: ids.project, name: "Entry Flooring Plank", status: "Idea" },
        });

        await page.goto(`/projects/${ids.project}/selections`);
        await Promise.all([
            page.waitForResponse((res) => res.url().includes("/api/selections/ai-sort") && res.ok()),
            page.getByTestId("sort-with-ai-button").click(),
        ]);

        const modal = page.getByTestId("ai-sort-modal");
        await expect(modal).toBeVisible();
        await expect(modal.getByTestId(`ai-sort-row-select-${ids.uiFaucetItem}`)).toHaveValue(ids.decisionFixtures);
        await expect(modal.getByTestId(`ai-sort-row-select-${ids.uiFlooringItem}`)).toHaveValue(ids.decisionFlooring);

        await modal.getByTestId("ai-sort-apply").click();
        await expect(modal).not.toBeVisible();

        await expect
            .poll(async () => {
                const item = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.uiFaucetItem } });
                return item.decisionId;
            })
            .toBe(ids.decisionFixtures);
        const faucet = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.uiFaucetItem } });
        expect(faucet.suggestedDecisionId).toBeNull();
        const flooring = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.uiFlooringItem } });
        expect(flooring.decisionId).toBe(ids.decisionFlooring);
        expect(flooring.suggestedDecisionId).toBeNull();

        // Revalidated UI shows them filed under their decisions, not Unsorted.
        await page.reload();
        await expect(page.getByTestId(`selection-item-${ids.uiFaucetItem}`)).toBeVisible();
        await expect(page.getByTestId(`selection-item-${ids.uiFlooringItem}`)).toBeVisible();
    });

    test("review-before-apply: deselecting to Leave unsorted excludes that row from Apply", async ({ page }) => {
        await prisma.selectionProposal.create({
            data: { id: ids.uiReviewItem, projectId: ids.project, name: "Deck Fixtures Sconce", status: "Idea" },
        });

        await page.goto(`/projects/${ids.project}/selections`);
        await Promise.all([
            page.waitForResponse((res) => res.url().includes("/api/selections/ai-sort") && res.ok()),
            page.getByTestId("sort-with-ai-button").click(),
        ]);

        const modal = page.getByTestId("ai-sort-modal");
        await expect(modal).toBeVisible();
        const select = modal.getByTestId(`ai-sort-row-select-${ids.uiReviewItem}`);
        await expect(select).toHaveValue(ids.decisionFixtures);
        await select.selectOption("");

        await modal.getByTestId("ai-sort-apply").click();
        await expect(modal).not.toBeVisible();

        const item = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.uiReviewItem } });
        expect(item.decisionId).toBeNull();
    });

    test("chip flow: Cancel keeps the persisted suggestion as a chip; ✓ applies, ✕ dismisses", async ({ page }) => {
        await prisma.selectionProposal.create({
            data: { id: ids.uiChipItem, projectId: ids.project, name: "Foyer Fixtures Mirror", status: "Idea" },
        });
        await prisma.selectionProposal.create({
            data: { id: ids.uiDismissItem, projectId: ids.project, name: "Foyer Fixtures Lantern", status: "Idea" },
        });

        await page.goto(`/projects/${ids.project}/selections`);
        await Promise.all([
            page.waitForResponse((res) => res.url().includes("/api/selections/ai-sort") && res.ok()),
            page.getByTestId("sort-with-ai-button").click(),
        ]);
        const modal = page.getByTestId("ai-sort-modal");
        await expect(modal).toBeVisible();
        // Cancel — no ASSIGNMENT writes; the suggestions the route already
        // persisted remain as chips, which is the intended behavior.
        await modal.getByTestId("ai-sort-cancel").click();
        await expect(modal).not.toBeVisible();

        const chipCard = page.getByTestId(`selection-item-${ids.uiChipItem}`);
        await expect(chipCard.getByTestId(`selection-suggestion-chip-${ids.uiChipItem}`)).toContainText("AI: Fixtures");
        const dismissCard = page.getByTestId(`selection-item-${ids.uiDismissItem}`);
        await expect(dismissCard.getByTestId(`selection-suggestion-chip-${ids.uiDismissItem}`)).toContainText("AI: Fixtures");

        // ✓ applies via the CAS action.
        await chipCard.getByTestId(`selection-suggestion-apply-${ids.uiChipItem}`).click();
        await expect
            .poll(async () => {
                const item = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.uiChipItem } });
                return item.decisionId;
            })
            .toBe(ids.decisionFixtures);
        const appliedItem = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.uiChipItem } });
        expect(appliedItem.suggestedDecisionId).toBeNull();

        // ✕ dismisses — suggestion cleared, item stays unsorted.
        await dismissCard.getByTestId(`selection-suggestion-dismiss-${ids.uiDismissItem}`).click();
        await expect
            .poll(async () => {
                const item = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.uiDismissItem } });
                return item.suggestedDecisionId;
            })
            .toBeNull();
        const dismissedItem = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.uiDismissItem } });
        expect(dismissedItem.decisionId).toBeNull();

        await page.reload();
        await expect(page.getByTestId(`selection-item-${ids.uiDismissItem}`).getByTestId(`selection-suggestion-chip-${ids.uiDismissItem}`)).toHaveCount(0);
    });

    test("review modal accessibility: role=dialog is present, Sort with AI stays disabled while open, Escape closes without applying", async ({ page }) => {
        await prisma.selectionProposal.create({
            data: { id: ids.a11yItem, projectId: ids.project, name: "Landing Fixtures Sconce", status: "Idea" },
        });

        await page.goto(`/projects/${ids.project}/selections`);
        await Promise.all([
            page.waitForResponse((res) => res.url().includes("/api/selections/ai-sort") && res.ok()),
            page.getByTestId("sort-with-ai-button").click(),
        ]);

        const modal = page.getByTestId("ai-sort-modal");
        await expect(modal).toBeVisible();
        // Radix Dialog.Content applies role="dialog"/aria-modal="true"
        // automatically — this is the same element as ai-sort-modal.
        await expect(page.getByRole("dialog")).toBeVisible();
        // A second "Sort with AI" run mid-review must not silently replace
        // the rows being reviewed.
        await expect(page.getByTestId("sort-with-ai-button")).toBeDisabled();

        await page.keyboard.press("Escape");
        await expect(modal).not.toBeVisible();

        const item = await prisma.selectionProposal.findUniqueOrThrow({ where: { id: ids.a11yItem } });
        expect(item.decisionId).toBeNull();
    });
});

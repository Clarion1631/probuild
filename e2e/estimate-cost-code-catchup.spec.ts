import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * Real-browser coverage for the auto-assigned-cost-code catch-up (see
 * `reconcileAutoAssignedCostCodes` / `getEstimateItemCostCodes` in
 * src/app/projects/[id]/estimates/[estimateId]/EstimateEditor.tsx and src/lib/actions.ts).
 *
 * The regression this guards: `autoAssignPhasesForEstimate` runs post-response via Next's
 * `after()` on every `saveEstimate` and fills `EstimateItem.costCodeId` on rows that are still
 * NULL. It deliberately does NOT bump `Estimate.itemsRevision` — that revision guards the item
 * collection's compare-and-set, and bumping it on every auto-assign would wedge every open editor
 * into a permanent "changed by someone else" conflict on its very next save. The cost of that
 * choice is that an already-open editor never learns the code was assigned: its in-memory row
 * still says `costCodeId: null`, and its NEXT save writes that null straight back over the
 * server's work, silently reverting it. The fix has the editor poll `getEstimateItemCostCodes`
 * on a backoff after any save that carried uncoded rows, and merge codes it finds fill-only
 * (never overwriting a row the user has since coded by hand).
 *
 * We cannot drive this with the real AI classifier — it needs ANTHROPIC_API_KEY, which CI does
 * not have, and its output isn't deterministic. So step 4 below writes `costCodeId` directly via
 * Prisma at exactly the point `after()` would have: a plain UPDATE that never touches
 * `itemsRevision`. That is a faithful stand-in because the fix's whole job is to observe a code
 * that appeared in the DB without a revision bump — it doesn't care how it got there.
 *
 * Corollary: the real auto-assigner must be OFF while this runs, or it fires on save 1 and races
 * the simulated write below for the same `costCodeId: null` rows — item1 then lands on a real cost
 * code instead of the fixture one and the assertions fail. CI *does* supply ANTHROPIC_API_KEY, so
 * an absent key is not the guarantee; `AUTO_ASSIGN_PHASES_AI_MOCK: "1"` in the playwright job of
 * .github/workflows/ci.yml is. Set it locally too when running this spec by hand.
 */

const IDS = {
    client: "ecc-e2e-client",
    project: "ecc-e2e-project",
    estimate: "ecc-e2e-estimate",
    item1: "ecc-e2e-item-1",
    item2: "ecc-e2e-item-2",
    costCode1: "ecc-e2e-cc-1",
    costCode2: "ecc-e2e-cc-2",
};

const ITEM1_NAME = "ECC Catchup Item One";
const ITEM2_NAME = "ECC Catchup Item Two";
const TITLE_SAVE_1 = "ECC Catchup Title — Save 1";
const TITLE_SAVE_2 = "ECC Catchup Title — Save 2";

const prisma = new PrismaClient();

test.describe("Estimate editor: auto-assigned cost code catch-up (real DB + browser)", () => {
    test.beforeAll(async () => {
        await prisma.client.upsert({
            where: { id: IDS.client },
            update: {},
            create: { id: IDS.client, name: "Cost Code Catchup Drill Client", initials: "CC" },
        });
        await prisma.project.upsert({
            where: { id: IDS.project },
            update: {},
            create: { id: IDS.project, name: "Cost Code Catchup Drill Project", clientId: IDS.client },
        });
        // Two distinct active codes: costCode1 stands in for the code auto-assign would pick;
        // costCode2 stands in for a code the user picks by hand mid-poll, to prove fill-only.
        await prisma.costCode.upsert({
            where: { id: IDS.costCode1 },
            update: { isActive: true },
            create: { id: IDS.costCode1, code: "ECC-E2E-1", name: "Catchup Drill Code One" },
        });
        await prisma.costCode.upsert({
            where: { id: IDS.costCode2 },
            update: { isActive: true },
            create: { id: IDS.costCode2, code: "ECC-E2E-2", name: "Catchup Drill Code Two" },
        });
        await prisma.estimate.upsert({
            where: { id: IDS.estimate },
            update: { itemsRevision: 0, title: "ECC Catchup Title — Initial" },
            create: {
                id: IDS.estimate,
                title: "ECC Catchup Title — Initial",
                code: "EST-ECCTEST",
                projectId: IDS.project,
                status: "Draft",
                totalAmount: 200,
                balanceDue: 200,
                itemsRevision: 0,
            },
        });
        // Both non-section, both uncoded — exactly what autoAssignPhasesForEstimate targets.
        await prisma.estimateItem.upsert({
            where: { id: IDS.item1 },
            update: { costCodeId: null, name: ITEM1_NAME },
            create: {
                id: IDS.item1,
                estimateId: IDS.estimate,
                name: ITEM1_NAME,
                type: "Material",
                quantity: 1,
                unitCost: 100,
                total: 100,
                order: 0,
            },
        });
        await prisma.estimateItem.upsert({
            where: { id: IDS.item2 },
            update: { costCodeId: null, name: ITEM2_NAME },
            create: {
                id: IDS.item2,
                estimateId: IDS.estimate,
                name: ITEM2_NAME,
                type: "Material",
                quantity: 1,
                unitCost: 100,
                total: 100,
                order: 1,
            },
        });
    });

    test.afterAll(async () => {
        try {
            await prisma.estimateItem.deleteMany({ where: { estimateId: IDS.estimate } });
            await prisma.estimate.deleteMany({ where: { id: IDS.estimate } });
            await prisma.project.deleteMany({ where: { id: IDS.project } });
            await prisma.client.deleteMany({ where: { id: IDS.client } });
            await prisma.costCode.deleteMany({ where: { id: { in: [IDS.costCode1, IDS.costCode2] } } });
        } finally {
            await prisma.$disconnect();
        }
    });

    test("a cost code assigned server-side between two saves survives the second save", async ({ page }) => {
        // The reconcile poll runs on a [3s, 8s, 15s, 30s] backoff; this drill needs headroom
        // for at least the first two attempts plus two real saves, well past the 30s default.
        test.setTimeout(120_000);

        await page.goto(`/projects/${IDS.project}/estimates/${IDS.estimate}`, { waitUntil: "networkidle" });

        const titleInput = page.getByPlaceholder("Estimate Title");
        await expect(titleInput).toBeVisible();

        const saveButton = page.getByRole("button", { name: "Save", exact: true });

        // ── Save 1: a trivial edit, with both items still uncoded. This is the save whose
        // uncodedItemIds snapshot kicks off the reconcile poll for item1 AND item2. ──
        await titleInput.fill(TITLE_SAVE_1);
        await saveButton.click();

        // Assert against the DB that the save actually landed, rather than sleeping blindly.
        await expect
            .poll(async () => {
                const estimate = await prisma.estimate.findUniqueOrThrow({
                    where: { id: IDS.estimate },
                    select: { title: true },
                });
                return estimate.title;
            }, { timeout: 15_000 })
            .toBe(TITLE_SAVE_1);

        // Rows found by their input's live value (getByDisplayValue reads the DOM property, not
        // the initial-render attribute, so it stays correct as the controlled value changes).
        const item1Row = page.locator("div.group", { has: page.getByDisplayValue(ITEM1_NAME) });
        const item2Row = page.locator("div.group", { has: page.getByDisplayValue(ITEM2_NAME) });
        // The cost-code <select> is the first of the two hover-revealed selects in the row
        // (see EstimateEditor.tsx around `value={item.costCodeId || ""}`); the second is item type.
        const item1CostCodeSelect = item1Row.locator("select").first();
        const item2CostCodeSelect = item2Row.locator("select").first();

        await expect(item1CostCodeSelect).toHaveValue("");
        await expect(item2CostCodeSelect).toHaveValue("");

        // ── Fill-only check: hand-pick a code on item2 locally (unsaved) BEFORE the poll's
        // first attempt lands, so its local costCodeId is no longer null when the merge runs. ──
        await item2CostCodeSelect.selectOption(IDS.costCode2);
        await expect(item2CostCodeSelect).toHaveValue(IDS.costCode2);

        // ── Step 4: simulate autoAssignPhasesForEstimate's after()-scheduled write. Both items
        // get coded to costCode1 directly in the DB, deliberately WITHOUT bumping
        // Estimate.itemsRevision — that omission is the entire point of this drill: nothing but
        // the catch-up poll can tell the open editor this happened. ──
        await prisma.estimateItem.update({ where: { id: IDS.item1 }, data: { costCodeId: IDS.costCode1 } });
        await prisma.estimateItem.update({ where: { id: IDS.item2 }, data: { costCodeId: IDS.costCode1 } });

        // ── Wait for the catch-up poll to merge. item1 (still null locally) must get filled with
        // costCode1. item2 (hand-set to costCode2 locally) must NOT be clobbered — proving the
        // merge is fill-only, not a blind overwrite. Poll attempts land at 3s, 11s, 26s, 56s after
        // save 1; give this plenty of runway past the first couple of attempts. ──
        await expect(item1CostCodeSelect).toHaveValue(IDS.costCode1, { timeout: 45_000 });
        await expect(item2CostCodeSelect).toHaveValue(IDS.costCode2);

        // ── Save 2: the regression. Before the fix, item1's in-memory row still said
        // costCodeId: null at this point and this save would write that null back over the
        // server's assignment. With the fix, the merge above already updated local state, so
        // this save persists costCode1 instead of reverting it. ──
        await titleInput.fill(TITLE_SAVE_2);
        await saveButton.click();

        await expect
            .poll(async () => {
                const estimate = await prisma.estimate.findUniqueOrThrow({
                    where: { id: IDS.estimate },
                    select: { title: true },
                });
                return estimate.title;
            }, { timeout: 15_000 })
            .toBe(TITLE_SAVE_2);

        const item1AfterSave2 = await prisma.estimateItem.findUniqueOrThrow({
            where: { id: IDS.item1 },
            select: { costCodeId: true },
        });
        // Before the fix this would be null — the second save's stale local row winning.
        expect(item1AfterSave2.costCodeId).toBe(IDS.costCode1);

        // Bonus confirmation that the fill-only merge's result, not some other path, is what
        // got persisted: item2 kept the user's hand-picked code, not the auto-assigned one.
        const item2AfterSave2 = await prisma.estimateItem.findUniqueOrThrow({
            where: { id: IDS.item2 },
            select: { costCodeId: true },
        });
        expect(item2AfterSave2.costCodeId).toBe(IDS.costCode2);
    });
});

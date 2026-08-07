import { test, expect } from "@playwright/test";
import { PrismaClient, type TimeEntry } from "@prisma/client";
import {
    COST_CODE_DEMO_ID,
    COST_CODE_DRYW_ID,
    FIELD_CREW_EMAIL,
    FIELD_CREW_PIN,
    MOBILE_ITEM_DEMO_ID,
    MOBILE_ITEM_DRYW_ID,
    PROJECT_ID,
    PROJECT_NAME,
    loginWithPin,
} from "./helpers";

// Covers components/TimeClock.tsx's clock-in picker (phase-grouped by cost code),
// the /api/mobile/time-suggestion chip (keyword-matched from the seeded daily log's
// nextSteps — no AI call at request time, see src/lib/time-suggestion.ts), the
// suggestion-mismatch confirm dialog, and the clock-in/out audit trail
// (costCodeId, suggestionOverridden) written by POST /api/time-entries.

const prisma = new PrismaClient();

test.describe.serial("Time clock", () => {
    // Geolocation isn't required for clock-in on this fixture (the seeded project has no
    // locationLat/Lng, so TimeClock's geofence soft-check never fires) — granted anyway so
    // the cold-start location warm-up (lib/location.ts) resolves quickly instead of hitting
    // its 5s timeout/deny path.
    test.use({
        permissions: ["geolocation"],
        geolocation: { latitude: 46.0645, longitude: -118.343 },
    });

    const createdEntryIds: string[] = [];

    test.afterAll(async () => {
        if (createdEntryIds.length > 0) {
            await prisma.timeEntry.deleteMany({ where: { id: { in: createdEntryIds } } });
        }
        await prisma.$disconnect();
    });

    test("suggested drywall clock-in, then an overridden demo clock-in", async ({ page }) => {
        const fieldCrew = await prisma.user.findUniqueOrThrow({
            where: { email: FIELD_CREW_EMAIL },
            select: { id: true },
        });

        // The Line Item selector button's own text isn't stable — it starts as the
        // "Select a line item…" placeholder, but flips to the suggestion's label the moment
        // the auto-preselect effect runs (see TimeClock.tsx), which can beat a click on that
        // placeholder text. The button is reliably the LAST child of the "Line Item" label's
        // container (label, then an optional suggestion chip, then the button), so open it via
        // that structural position instead of its current label text.
        const openItemPicker = () =>
            page.getByText("Line Item", { exact: true }).locator("xpath=../*[last()]").click();

        await loginWithPin(page, FIELD_CREW_EMAIL, FIELD_CREW_PIN);

        // ---- select the project ----
        await page.getByText("Select a project…").click();
        await expect(page.getByText("Select Project")).toBeVisible({ timeout: 10000 });
        await page.getByText(PROJECT_NAME, { exact: true }).click();

        // ---- suggestion chip from the seeded daily log ----
        await expect(page.getByText("Suggested: Hang drywall in hall bath")).toBeVisible({
            timeout: 15000,
        });

        // ---- item picker: phase-grouped, 01-DEMO header before 05-DRYW header ----
        await openItemPicker();
        await expect(page.getByText("Select Line Item")).toBeVisible({ timeout: 10000 });
        await expect(page.getByText("Demolition phase")).toBeVisible();
        await expect(page.getByText("Drywall phase")).toBeVisible();

        const demoHeader = page.getByText("01-DEMO — Demolition", { exact: true });
        // "05-DRYW — Drywall" also renders as the (now-preselected) Line Item selector
        // button text behind the modal overlay — .last() targets the modal's own portal
        // content, which mounts after (and so sorts after in DOM order) the screen behind it.
        const drywHeader = page.getByText("05-DRYW — Drywall", { exact: true }).last();
        await expect(demoHeader).toBeVisible();
        await expect(drywHeader).toBeVisible();
        // The modal slides/fades in, so its rows are still moving for a couple of frames
        // after they first become visible — two sequential boundingBox() calls can straddle
        // that animation and briefly read an inverted order. Fetch both in one round trip
        // (Promise.all, not two awaits) and poll until the animation settles on the final,
        // correct order instead of asserting on a single (possibly mid-animation) snapshot.
        await expect
            .poll(async () => {
                const [demoBox, drywBox] = await Promise.all([
                    demoHeader.boundingBox(),
                    drywHeader.boundingBox(),
                ]);
                if (!demoBox || !drywBox) return null;
                return demoBox.y - drywBox.y;
            })
            .toBeLessThan(0);

        // Drywall item is already preselected by the suggestion — close without picking.
        await page.getByText("Close", { exact: true }).click();

        // ---- clock in: matches the suggestion, no mismatch dialog ----
        await page.getByText("Clock In", { exact: true }).click();
        await expect(page.getByText("CLOCKED IN")).toBeVisible({ timeout: 15000 });

        // performClockIn (TimeClock.tsx) flips to CLOCKED IN optimistically — with a
        // client-only provisional entry — the instant the tap is handled, before the
        // create POST it kicks off has resolved. So "CLOCKED IN" visible does not mean the
        // row is in the DB yet; poll for it instead of querying once immediately after.
        let active: TimeEntry | null = null;
        await expect
            .poll(
                async () => {
                    active = await prisma.timeEntry.findFirst({
                        where: { userId: fieldCrew.id, projectId: PROJECT_ID, endTime: null },
                        orderBy: { createdAt: "desc" },
                    });
                    return active;
                },
                { timeout: 15000 }
            )
            .not.toBeNull();
        createdEntryIds.push(active!.id);
        expect(active!.estimateItemId).toBe(MOBILE_ITEM_DRYW_ID);
        expect(active!.costCodeId).toBe(COST_CODE_DRYW_ID);
        expect(active!.suggestionOverridden).toBe(false);

        // ---- clock out ----
        await page.getByText("Clock Out", { exact: true }).click();
        await expect(page.getByText("OFF CLOCK")).toBeVisible({ timeout: 15000 });

        // Same optimistic-UI shape as clock-in (handleClockOut sets activeEntry null before
        // the clock-out PATCH resolves) — poll until the row is actually closed server-side.
        let closed: TimeEntry | null = null;
        await expect
            .poll(
                async () => {
                    closed = await prisma.timeEntry.findUniqueOrThrow({ where: { id: active!.id } });
                    return closed.endTime;
                },
                { timeout: 15000 }
            )
            .not.toBeNull();
        expect(closed!.durationHours).not.toBeNull();
        expect(closed!.laborCost).not.toBeNull();

        // ---- second clock-in: manually pick the DEMO item instead of the suggestion ----
        // Clock-out resets selectedItemId to "" without re-running the auto-preselect
        // effect (its deps — suggestion/items/itemManuallyPicked — didn't change), so the
        // Line Item selector shows its placeholder again and needs a fresh pick.
        await openItemPicker();
        await expect(page.getByText("Select Line Item")).toBeVisible({ timeout: 10000 });
        await page.getByText("Demolition phase", { exact: true }).click();

        await page.getByText("Clock In", { exact: true }).click();

        // Mismatch dialog: selected item (DEMO) disagrees with today's suggestion (DRYW).
        await expect(page.getByText("Are you sure this is the correct task?")).toBeVisible({
            timeout: 10000,
        });
        await expect(
            page.getByText("Today's plan is Hang drywall in hall bath (05-DRYW — Drywall).")
        ).toBeVisible();
        await page.getByText("Keep my choice", { exact: true }).click();

        await expect(page.getByText("CLOCKED IN")).toBeVisible({ timeout: 15000 });

        // Same optimistic-UI race as the first clock-in above — poll rather than query once.
        let overridden: TimeEntry | null = null;
        await expect
            .poll(
                async () => {
                    overridden = await prisma.timeEntry.findFirst({
                        where: { userId: fieldCrew.id, projectId: PROJECT_ID, endTime: null },
                        orderBy: { createdAt: "desc" },
                    });
                    return overridden;
                },
                { timeout: 15000 }
            )
            .not.toBeNull();
        expect(overridden!.id).not.toBe(active!.id);
        createdEntryIds.push(overridden!.id);
        expect(overridden!.estimateItemId).toBe(MOBILE_ITEM_DEMO_ID);
        expect(overridden!.costCodeId).toBe(COST_CODE_DEMO_ID);
        expect(overridden!.suggestionOverridden).toBe(true);

        // Leave the crew off the clock for whatever runs next.
        await page.getByText("Clock Out", { exact: true }).click();
        await expect(page.getByText("OFF CLOCK")).toBeVisible({ timeout: 15000 });
    });
});

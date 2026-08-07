import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { FIELD_CREW_EMAIL, FIELD_CREW_PIN, PROJECT_NAME, loginWithPin } from "./helpers";

// (tabs)/expenses.tsx — a create-only form (no expense list on this screen; see the
// report note in the spec inventory). Photo attach goes through expo-image-picker's web
// shim (ExponentImagePicker.web.js), which appends a real, hidden <input type="file"
// data-testid="file-input"> to <body> and dispatches a synthetic click on it to open the
// native file chooser. Setting files directly on that located input (bypassing the native
// chooser) was tried first and reliably timed out — Playwright never saw the element
// resolve, most likely because the synthetic (non-trusted) click doesn't open a chooser
// Playwright can special-case, and the element is torn down before a plain locator finds
// it. `page.waitForEvent("filechooser")` is Playwright's documented, CDP-level mechanism for
// exactly this shape (any input[type=file] activation, real or scripted) and is what
// resolved it reliably. The receipt upload itself is a direct browser PUT to a Supabase
// "signed" URL; under E2E_STORAGE_MOCK=1 the server hands back a URL pointing at a
// non-serving mock host (see supabase-storage-mock.ts's own doc comment: this case — the
// browser fetching/PUTing a storage URL directly — is explicitly NOT covered by that mock),
// so the PUT itself is intercepted here via page.route.

const prisma = new PrismaClient();

// 1x1 white pixel JPEG — enough for the browser's <img> decode step in the web image
// picker's metadata read (ExponentImagePicker.web.js's getImageMetadata).
const TINY_JPEG_BASE64 =
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

test.describe.serial("Expenses", () => {
    const createdExpenseIds: string[] = [];

    test.afterAll(async () => {
        if (createdExpenseIds.length > 0) {
            await prisma.expense.deleteMany({ where: { id: { in: createdExpenseIds } } });
        }
        await prisma.$disconnect();
    });

    test("fill vendor/amount, attach a receipt, and save", async ({ page }) => {
        await loginWithPin(page, FIELD_CREW_EMAIL, FIELD_CREW_PIN);
        await page.getByText("Expenses", { exact: true }).click();
        await expect(page.getByText("Photo a receipt or check")).toBeVisible({ timeout: 15000 });

        // Only one active project is assigned to this fixture user, so it's the default
        // selection already — assert it rather than driving the picker for a single option.
        await expect(page.getByText(PROJECT_NAME, { exact: true })).toBeVisible();

        // Mock the direct-to-storage PUT (see file header comment).
        await page.route("**/storage/v1/object/upload/sign/**", async (route) => {
            const corsHeaders = {
                "access-control-allow-origin": "*",
                "access-control-allow-methods": "PUT, OPTIONS",
                "access-control-allow-headers": "*",
            };
            if (route.request().method() === "OPTIONS") {
                await route.fulfill({ status: 204, headers: corsHeaders });
            } else {
                await route.fulfill({
                    status: 200,
                    headers: { ...corsHeaders, "content-type": "application/json" },
                    body: "{}",
                });
            }
        });

        const vendor = `E2E Vendor ${Date.now()}`;
        await page.getByPlaceholder("Home Depot, Hoppe, etc.").fill(vendor);
        await page.getByPlaceholder("0.00").fill("42.50");

        const [fileChooser] = await Promise.all([
            page.waitForEvent("filechooser"),
            page.getByText("🖼️ Gallery").click(),
        ]);
        await fileChooser.setFiles({
            name: "receipt.jpg",
            mimeType: "image/jpeg",
            buffer: Buffer.from(TINY_JPEG_BASE64, "base64"),
        });
        await expect(page.getByText("X Remove")).toBeVisible({ timeout: 10000 });

        await page.getByText("Save Expense", { exact: true }).click();
        await expect(page.getByText("Saved")).toBeVisible({ timeout: 15000 });
        await page.getByText("OK", { exact: true }).click();

        const expense = await prisma.expense.findFirst({
            where: { vendor },
            orderBy: { createdAt: "desc" },
        });
        expect(expense).not.toBeNull();
        createdExpenseIds.push(expense!.id);
        expect(Number(expense!.amount)).toBeCloseTo(42.5, 2);
        expect(expense!.receiptUrl).toBeTruthy();
    });
});

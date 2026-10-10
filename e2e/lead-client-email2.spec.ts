import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * Lead Client Details: clearing "Email 2 (spouse / partner)" must stick.
 *
 * The bug: clearing Email 2 and saving brought the old address back after a
 * reload, because "" was turned into `undefined` on the way to Prisma and the
 * column was skipped. tests/client-additional-email-clear-db.test.ts pins both
 * write paths against real SQL; this drives the actual sidebar.
 *
 * The display row itself always renders; an empty Email 2 reads "Not set".
 *
 * Runs against the throwaway Postgres (data.setup.ts refuses the live DB).
 */

const PFX = "e2e-email2";
const prisma = new PrismaClient();

const IDS = { client: `${PFX}-client`, lead: `${PFX}-lead` };
const EMAIL2 = "partner-e2e@example.test";

function clientDetails(page: Page) {
    return page.locator("div.p-5").filter({ has: page.getByRole("heading", { name: "Client Details", exact: true }) });
}

async function saveEmail2(page: Page, value: string) {
    const details = clientDetails(page);
    await details.getByRole("button", { name: "Edit", exact: true }).click();
    await details.getByPlaceholder("Optional").fill(value);
    await details.getByRole("button", { name: "Save", exact: true }).click();
    // The editor closes only after updateClient resolves.
    await expect(details.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
}

const storedEmail2 = () =>
    prisma.client.findUniqueOrThrow({ where: { id: IDS.client }, select: { additionalEmail: true } }).then((c) => c.additionalEmail);

test.describe.serial("Lead Client Details: Email 2 can be cleared", () => {
    test.beforeAll(async () => {
        await prisma.client.upsert({
            where: { id: IDS.client },
            update: { email: "primary-e2e@example.test", additionalEmail: null },
            create: { id: IDS.client, name: "Email2 Drill Client", initials: "ED", email: "primary-e2e@example.test" },
        });
        await prisma.lead.upsert({
            where: { id: IDS.lead },
            update: {},
            create: { id: IDS.lead, name: "Email2 Drill Lead", clientId: IDS.client },
        });
    });

    test.afterAll(async () => {
        // Best effort: a leftover row in the throwaway DB must not fail a passing run.
        const drop = (run: () => Promise<unknown>) => run().catch(() => {});
        try {
            await drop(() => prisma.lead.deleteMany({ where: { id: { startsWith: PFX } } }));
            await drop(() => prisma.client.deleteMany({ where: { id: { startsWith: PFX } } }));
        } finally {
            await prisma.$disconnect();
        }
    });

    test("set Email 2, clear it, reload: it stays empty", async ({ page }) => {
        await page.goto(`/leads/${IDS.lead}`, { waitUntil: "networkidle" });
        const details = clientDetails(page);
        const email2Row = details.getByText("Email 2", { exact: true }).locator("xpath=..");

        await saveEmail2(page, EMAIL2);
        await expect.poll(storedEmail2).toBe(EMAIL2);
        await page.reload({ waitUntil: "networkidle" });
        await expect(email2Row).toContainText(EMAIL2);

        await saveEmail2(page, "");
        await expect.poll(storedEmail2).toBeNull();
        await page.reload({ waitUntil: "networkidle" });

        await expect(email2Row).toContainText("Not set");
        await expect(details).not.toContainText(EMAIL2);
        await details.getByRole("button", { name: "Edit", exact: true }).click();
        await expect(details.getByPlaceholder("Optional")).toHaveValue("");
        await details.getByRole("button", { name: "Cancel", exact: true }).click();
    });
});

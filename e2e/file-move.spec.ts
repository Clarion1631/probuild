import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Moving files into the standard project folders (01 Plans & Specs … 08 Closeout).
//
// The risky part is NOT the move itself — it is that the Files tab already had a
// dropzone accepting OS file drops for upload, and folder tiles are now drop
// targets too. Two drop handlers on nested elements will fight unless each one
// only claims the drag kind it owns. That discrimination is asserted directly
// here (see "declines an OS file drag"), because a regression there breaks
// uploading, which is louder than a broken move.

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const RUN = `movetest-${Date.now().toString(36)}`;
const FOLDER_NAME = `ZZ E2E Move Target ${RUN}`;
const FILE_NAMES = [`${RUN}-a.pdf`, `${RUN}-b.pdf`, `${RUN}-c.pdf`];

let folderId = "";
const fileIds: string[] = [];

async function seed(request: APIRequestContext) {
    const folderRes = await request.post(`/api/files/folders?projectId=${PROJECT_ID}`, {
        data: { name: FOLDER_NAME, projectId: PROJECT_ID, visibility: "team" },
    });
    expect(folderRes.ok(), `folder seed failed: ${await folderRes.text()}`).toBeTruthy();
    folderId = (await folderRes.json()).id;

    // Register file rows directly: this suite exercises MOVE, not upload, so it
    // does not need real bytes in storage.
    const filesRes = await request.post("/api/files/register", {
        data: {
            files: FILE_NAMES.map(name => ({
                name,
                url: `https://example.invalid/${name}`,
                projectId: PROJECT_ID,
                size: 1024,
                mimeType: "application/pdf",
            })),
        },
    });
    expect(filesRes.ok(), `file seed failed: ${await filesRes.text()}`).toBeTruthy();
    const created = await filesRes.json();
    for (const f of created.files ?? created) fileIds.push(f.id);
    expect(fileIds).toHaveLength(FILE_NAMES.length);
}

async function openFiles(page: Page) {
    await page.goto(`/projects/${PROJECT_ID}/files`, { waitUntil: "load" });
    await expect(page.getByRole("heading", { name: /Files/i }).first()).toBeVisible();
    // Wait for the list to actually populate before interacting.
    await expect(page.getByLabel(`Select ${FILE_NAMES[0]}`)).toBeVisible({ timeout: 15_000 });
}

/**
 * Dispatch a real DragEvent carrying a real DataTransfer. Playwright's dragTo()
 * does not populate dataTransfer, which is the entire thing under test here.
 */
async function dispatchDrag(
    page: Page,
    selectorText: string,
    type: "dragover" | "drop",
    payload: { internal: string[] } | { osFile: true },
): Promise<boolean> {
    return page.evaluate(
        ({ selectorText, type, payload }) => {
            const target = [...document.querySelectorAll<HTMLElement>("div,button,a")]
                .find(el => el.textContent?.trim().startsWith(selectorText) && el.children.length < 8);
            if (!target) throw new Error(`drop target not found: ${selectorText}`);
            const dt = new DataTransfer();
            if ("osFile" in payload) {
                dt.items.add(new File(["x"], "from-desktop.pdf", { type: "application/pdf" }));
            } else {
                dt.setData("application/x-probuild-file", JSON.stringify(payload.internal));
            }
            const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
            target.dispatchEvent(ev);
            // preventDefault() is how a handler says "this drag is mine".
            return ev.defaultPrevented;
        },
        { selectorText, type, payload },
    );
}

test.describe("Project files — move into folders", () => {
    test.beforeAll(async ({ playwright, baseURL, storageState }) => {
        const request = await playwright.request.newContext({ baseURL, storageState });
        await seed(request);
        await request.dispose();
    });

    test.afterAll(async ({ playwright, baseURL, storageState }) => {
        const request = await playwright.request.newContext({ baseURL, storageState });
        for (const id of fileIds) await request.delete(`/api/files?fileId=${id}`);
        if (folderId) await request.delete(`/api/files?folderId=${folderId}`);
        await request.dispose();
    });

    test("bulk-moves selected files into a folder without drag", async ({ page }) => {
        await openFiles(page);

        // The no-drag path: this is what works on a tablet and by keyboard.
        await page.getByLabel(`Select ${FILE_NAMES[0]}`).check();
        await page.getByLabel(`Select ${FILE_NAMES[1]}`).check();
        await expect(page.getByText("2 selected")).toBeVisible();

        await page.getByRole("button", { name: "Move to folder" }).click();
        await page.getByRole("menuitem", { name: FOLDER_NAME }).click();

        // Both leave the root listing...
        await expect(page.getByLabel(`Select ${FILE_NAMES[0]}`)).toHaveCount(0, { timeout: 15_000 });
        await expect(page.getByLabel(`Select ${FILE_NAMES[1]}`)).toHaveCount(0);
        // ...and the third is untouched, proving the move was scoped to the selection.
        await expect(page.getByLabel(`Select ${FILE_NAMES[2]}`)).toBeVisible();

        // ...and land inside the folder.
        await page.getByText(FOLDER_NAME).first().click();
        await expect(page.getByLabel(`Select ${FILE_NAMES[0]}`)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByLabel(`Select ${FILE_NAMES[1]}`)).toBeVisible();
    });

    test("accepts an internal file drag onto a folder tile", async ({ page }) => {
        await openFiles(page);

        const claimed = await dispatchDrag(page, FOLDER_NAME, "dragover", { internal: [fileIds[2]] });
        expect(claimed, "folder tile must claim an internal file drag").toBe(true);

        await dispatchDrag(page, FOLDER_NAME, "drop", { internal: [fileIds[2]] });

        await expect(page.getByLabel(`Select ${FILE_NAMES[2]}`)).toHaveCount(0, { timeout: 15_000 });
        await page.getByText(FOLDER_NAME).first().click();
        await expect(page.getByLabel(`Select ${FILE_NAMES[2]}`)).toBeVisible({ timeout: 15_000 });
    });

    test("declines an OS file drag so upload still works", async ({ page }) => {
        await openFiles(page);

        // A drag carrying real files belongs to the upload dropzone. If the folder
        // tile claimed it, dropping a file from the desktop onto a folder would be
        // swallowed as a move-of-nothing and the upload would silently vanish.
        const claimed = await dispatchDrag(page, FOLDER_NAME, "dragover", { osFile: true });
        expect(claimed, "folder tile must NOT claim an OS file drag").toBe(false);
    });
});

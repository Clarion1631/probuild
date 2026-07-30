import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Moving files into the standard project folders (01 Plans & Specs … 08 Closeout).
//
// The risky part is NOT the move itself — it is that the Files tab already had a
// dropzone accepting OS file drops for upload, and folder tiles are now drop
// targets too. Two drop handlers on nested elements will fight unless each one
// only claims the drag kind it owns. That discrimination is asserted directly
// here (see "declines an OS file drag"), because a regression there breaks
// uploading, which is louder than a broken move.
//
// Every test seeds its OWN files and tears them down: the whole point of these
// tests is that files change folders, so sharing fixtures across tests makes
// later tests depend on earlier ones having run (and having passed).

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const RUN = `movetest-${Date.now().toString(36)}`;
const FOLDER_NAME = `ZZ E2E Move Target ${RUN}`;

let folderId = "";
const createdFileIds = new Set<string>();

async function ctx(playwright: any, baseURL: string | undefined, storageState: any): Promise<APIRequestContext> {
    return playwright.request.newContext({ baseURL, storageState });
}

async function seedFiles(request: APIRequestContext, names: string[]): Promise<string[]> {
    const res = await request.post("/api/files/register", {
        data: {
            files: names.map(name => ({
                name,
                url: `https://example.invalid/${name}`,
                projectId: PROJECT_ID,
                size: 1024,
                mimeType: "application/pdf",
            })),
        },
    });
    expect(res.ok(), `file seed failed: ${await res.text()}`).toBeTruthy();
    const ids: string[] = (await res.json()).files.map((f: { id: string }) => f.id);
    ids.forEach(id => createdFileIds.add(id));
    return ids;
}

async function openFiles(page: Page, waitForFileName: string) {
    await page.goto(`/projects/${PROJECT_ID}/files`, { waitUntil: "load" });
    await expect(page.getByLabel(`Select ${waitForFileName}`)).toBeVisible({ timeout: 20_000 });
    // The folder must be rendered before any drag can target it.
    await expect(page.locator(`[data-folder-id="${folderId}"]`)).toBeVisible();
}

/**
 * Dispatch a real DragEvent carrying a real DataTransfer at a folder tile.
 * Playwright's dragTo() does not populate dataTransfer, which is the entire
 * thing under test here. Targets by data-folder-id so this never depends on
 * folder label text or DOM shape.
 */
async function dragAtFolder(
    page: Page,
    type: "dragover" | "drop",
    payload: { internal: string[] } | { osFile: true },
): Promise<boolean> {
    return page.evaluate(
        ({ folderId, type, payload }) => {
            const target = document.querySelector<HTMLElement>(`[data-folder-id="${folderId}"]`);
            if (!target) throw new Error(`folder tile ${folderId} not in DOM`);
            const dt = new DataTransfer();
            if ("osFile" in payload) {
                dt.items.add(new File(["x"], "from-desktop.pdf", { type: "application/pdf" }));
            } else {
                dt.setData("application/x-probuild-file", JSON.stringify(payload.internal));
            }
            const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
            target.dispatchEvent(ev);
            // preventDefault() is how a drop handler says "this drag is mine".
            return ev.defaultPrevented;
        },
        { folderId, type, payload },
    );
}

test.describe("Project files — move into folders", () => {
    test.beforeAll(async ({ playwright, baseURL, storageState }) => {
        const request = await ctx(playwright, baseURL, storageState);
        const res = await request.post(`/api/files/folders?projectId=${PROJECT_ID}`, {
            data: { name: FOLDER_NAME, projectId: PROJECT_ID, visibility: "team" },
        });
        expect(res.ok(), `folder seed failed: ${await res.text()}`).toBeTruthy();
        folderId = (await res.json()).id;
        await request.dispose();
    });

    test.afterAll(async ({ playwright, baseURL, storageState }) => {
        const request = await ctx(playwright, baseURL, storageState);
        for (const id of createdFileIds) await request.delete(`/api/files?fileId=${id}`);
        if (folderId) await request.delete(`/api/files?folderId=${folderId}`);
        await request.dispose();
    });

    test("bulk-moves selected files into a folder without drag", async ({ page, playwright, baseURL, storageState }) => {
        const request = await ctx(playwright, baseURL, storageState);
        const names = [`${RUN}-bulk-a.pdf`, `${RUN}-bulk-b.pdf`, `${RUN}-bulk-keep.pdf`];
        await seedFiles(request, names);
        await request.dispose();

        await openFiles(page, names[0]);

        // The no-drag path: this is what works on a tablet and by keyboard.
        await page.getByLabel(`Select ${names[0]}`).check();
        await page.getByLabel(`Select ${names[1]}`).check();
        await expect(page.getByText("2 selected")).toBeVisible();

        await page.getByRole("button", { name: "Move to folder" }).click();
        await page.getByRole("menuitem", { name: FOLDER_NAME }).click();

        // Both leave the root listing...
        await expect(page.getByLabel(`Select ${names[0]}`)).toHaveCount(0, { timeout: 20_000 });
        await expect(page.getByLabel(`Select ${names[1]}`)).toHaveCount(0);
        // ...and the unselected one stays, proving the move was scoped to the selection.
        await expect(page.getByLabel(`Select ${names[2]}`)).toBeVisible();

        // ...and land inside the folder.
        await page.locator(`[data-folder-id="${folderId}"]`).click();
        await expect(page.getByLabel(`Select ${names[0]}`)).toBeVisible({ timeout: 20_000 });
        await expect(page.getByLabel(`Select ${names[1]}`)).toBeVisible();
    });

    test("accepts an internal file drag onto a folder tile", async ({ page, playwright, baseURL, storageState }) => {
        const request = await ctx(playwright, baseURL, storageState);
        const name = `${RUN}-drag.pdf`;
        const [fileId] = await seedFiles(request, [name]);
        await request.dispose();

        await openFiles(page, name);

        const claimed = await dragAtFolder(page, "dragover", { internal: [fileId] });
        expect(claimed, "folder tile must claim an internal file drag").toBe(true);
        // The ring is the counterpart of the OS-drag assertion below: this drag
        // lights the tile up, an OS drag must not.
        await expect(page.locator(`[data-folder-id="${folderId}"]`)).toHaveClass(/ring-indigo-400/);

        await dragAtFolder(page, "drop", { internal: [fileId] });

        await expect(page.getByLabel(`Select ${name}`)).toHaveCount(0, { timeout: 20_000 });
        await page.locator(`[data-folder-id="${folderId}"]`).click();
        await expect(page.getByLabel(`Select ${name}`)).toBeVisible({ timeout: 20_000 });
    });

    test("refuses a move that would silently un-share a client-visible file", async ({ playwright, baseURL, storageState }) => {
        const request = await ctx(playwright, baseURL, storageState);
        // A client-visible file at the project root. FOLDER_NAME is a team folder,
        // so moving it there would drop the file out of the portal entirely: the
        // portal only lists folders whose whole ancestor chain is "shared".
        const res = await request.post("/api/files/register", {
            data: {
                files: [{
                    name: `${RUN}-shared.pdf`,
                    url: `https://example.invalid/${RUN}-shared.pdf`,
                    projectId: PROJECT_ID,
                    size: 1024,
                    mimeType: "application/pdf",
                    visibility: "shared",
                }],
            },
        });
        expect(res.ok()).toBeTruthy();
        const fileId: string = (await res.json()).files[0].id;
        createdFileIds.add(fileId);

        // Side-effect un-sharing is refused...
        const blocked = await request.patch("/api/files", { data: { fileId, folderId } });
        expect(blocked.status(), "moving a client-visible file into a team folder must be refused").toBe(409);
        expect(await blocked.text()).toContain("would remove their access");

        // ...and the file genuinely did not move.
        const still = await request.get(`/api/files?projectId=${PROJECT_ID}`);
        const rootNames: string[] = ((await still.json()).files ?? []).map((f: { name: string }) => f.name);
        expect(rootNames).toContain(`${RUN}-shared.pdf`);

        // Passing a visibility is NOT enough on its own. The file keeps visibility
        // "shared" while landing somewhere the portal cannot traverse, so the client
        // still loses access — the guard must not be satisfied by a field that does
        // not change the outcome.
        const stillBlocked = await request.patch("/api/files", {
            data: { fileId, folderId, visibility: "shared" },
        });
        expect(stillBlocked.status(), "visibility alone must not bypass the guard").toBe(409);

        // Only an explicit intent flag gets it through.
        const allowed = await request.patch("/api/files", {
            data: { fileId, folderId, allowClientVisibilityLoss: true },
        });
        expect(allowed.ok(), `deliberate move must be allowed: ${await allowed.text()}`).toBeTruthy();
        await request.dispose();
    });

    test("refuses a visibility-only change that un-shares a client-visible file", async ({ playwright, baseURL, storageState }) => {
        const request = await ctx(playwright, baseURL, storageState);
        const res = await request.post("/api/files/register", {
            data: {
                files: [{
                    name: `${RUN}-visonly.pdf`,
                    url: `https://example.invalid/${RUN}-visonly.pdf`,
                    projectId: PROJECT_ID,
                    size: 1024,
                    mimeType: "application/pdf",
                    visibility: "shared",
                }],
            },
        });
        expect(res.ok()).toBeTruthy();
        const fileId: string = (await res.json()).files[0].id;
        createdFileIds.add(fileId);

        // No folderId at all. The guard used to be gated on folderId being present,
        // so this PATCH walked straight past it and hid the file from the client.
        const blocked = await request.patch("/api/files", { data: { fileId, visibility: "team" } });
        expect(blocked.status(), "a visibility-only un-share must be refused").toBe(409);
        expect(await blocked.text()).toContain("would remove their access");

        const allowed = await request.patch("/api/files", {
            data: { fileId, visibility: "team", allowClientVisibilityLoss: true },
        });
        expect(allowed.ok(), `deliberate un-share must be allowed: ${await allowed.text()}`).toBeTruthy();
        await request.dispose();
    });

    test("refuses un-sharing a folder that the client can currently see files in", async ({ playwright, baseURL, storageState }) => {
        const request = await ctx(playwright, baseURL, storageState);

        // A shared folder holding a client-visible file. Flipping the FOLDER to team
        // hides the file even though the file itself stays "shared", because the
        // portal requires the whole ancestor chain to be shared — and the folder
        // endpoint had no guard at all, so this was the way around the file one.
        const mk = await request.post("/api/files/folders", {
            data: { name: `${RUN}-shared-folder`, projectId: PROJECT_ID, visibility: "shared" },
        });
        expect(mk.ok(), `folder seed failed: ${await mk.text()}`).toBeTruthy();
        const sharedFolderId: string = (await mk.json()).id;

        const res = await request.post("/api/files/register", {
            data: {
                files: [{
                    name: `${RUN}-infolder.pdf`,
                    url: `https://example.invalid/${RUN}-infolder.pdf`,
                    projectId: PROJECT_ID,
                    folderId: sharedFolderId,
                    size: 1024,
                    mimeType: "application/pdf",
                    visibility: "shared",
                }],
            },
        });
        expect(res.ok()).toBeTruthy();
        createdFileIds.add((await res.json()).files[0].id);

        const blocked = await request.patch("/api/files/folders", {
            data: { id: sharedFolderId, visibility: "team" },
        });
        expect(blocked.status(), "un-sharing a folder with client-visible files must be refused").toBe(409);
        expect(await blocked.text()).toContain("would remove their access");

        const allowed = await request.patch("/api/files/folders", {
            data: { id: sharedFolderId, visibility: "team", allowClientVisibilityLoss: true },
        });
        expect(allowed.ok(), `deliberate folder un-share must be allowed: ${await allowed.text()}`).toBeTruthy();

        // Renaming must stay unaffected — the guard only fires on a visibility drop.
        const renamed = await request.patch("/api/files/folders", {
            data: { id: sharedFolderId, name: `${RUN}-renamed-folder` },
        });
        expect(renamed.ok(), `rename must not trip the guard: ${await renamed.text()}`).toBeTruthy();

        await request.delete(`/api/files?folderId=${sharedFolderId}`).catch(() => {});
        await request.dispose();
    });

    test("declines an OS file drag so upload still works", async ({ page, playwright, baseURL, storageState }) => {
        const request = await ctx(playwright, baseURL, storageState);
        const name = `${RUN}-osdrag.pdf`;
        await seedFiles(request, [name]);
        await request.dispose();

        await openFiles(page, name);

        // A drag carrying real files belongs to the upload dropzone. If the folder
        // tile claimed it, dropping a file from the desktop onto a folder would be
        // swallowed as a move-of-nothing and the upload would silently vanish.
        //
        // NOT asserted via defaultPrevented: the event bubbles, so the container
        // dropzone legitimately claims OS drags and sets defaultPrevented on the
        // same event. That flag cannot tell us WHICH element claimed it. The
        // folder tile's own drop-target ring can.
        await dragAtFolder(page, "dragover", { osFile: true });
        await expect(
            page.locator(`[data-folder-id="${folderId}"]`),
            "folder tile must not light up as a drop target for an OS file drag",
        ).not.toHaveClass(/ring-indigo-400/);

        // And the file is still where it was — the decline is a no-op, not a move.
        await expect(page.getByLabel(`Select ${name}`)).toBeVisible();
    });
});

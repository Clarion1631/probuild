import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { MANAGER_EMAIL, MANAGER_PIN, loginWithPin, runId } from "./helpers";

// app/leads/*.tsx — ADMIN/MANAGER only (canWorkLeads() in
// src/app/api/mobile/leads/route.ts). Lead creation is hermetically safe to exercise for
// real: the Drive-folder step is best-effort and gated behind isDriveConnected(), which
// resolves false (no network call) when no Google refresh token is configured — exactly the
// case in this throwaway DB, so POST /api/mobile/leads succeeds without ever touching
// Google. No `location` is filled in below to also skip the geocode call
// (geocodeJobSiteAddress short-circuits on an empty address anyway, but this keeps the
// request path obviously side-effect-free).

const prisma = new PrismaClient();

test.describe.serial("Leads", () => {
    const id = runId();
    const clientName = `E2E Mobile Web ${id}`;
    let createdLeadId: string | null = null;
    let createdClientId: string | null = null;

    test.afterAll(async () => {
        // Lead first — LeadNote cascades off it, and Client can't be deleted while a Lead
        // still references it (Lead.clientId has no onDelete: Cascade on that side).
        if (createdLeadId) {
            await prisma.lead.deleteMany({ where: { id: createdLeadId } });
        }
        if (createdClientId) {
            await prisma.client.deleteMany({ where: { id: createdClientId } });
        }
        await prisma.$disconnect();
    });

    test("manager creates a lead, sees it in the list, and adds a note", async ({ page }) => {
        await loginWithPin(page, MANAGER_EMAIL, MANAGER_PIN);
        await page.getByText("Manager", { exact: true }).click();
        await page.getByText("Leads", { exact: true }).click();

        // exact: true — the empty-leads-list hint paragraph literally contains the
        // substring "New lead" ('Tap "New lead" when you meet a prospect...'), and this is
        // the very first lead created, so the list starts empty.
        await expect(page.getByText("New lead", { exact: true })).toBeVisible({ timeout: 15000 });
        await page.getByText("New lead", { exact: true }).click();

        await expect(page.getByPlaceholder("Jane Homeowner")).toBeVisible({ timeout: 10000 });
        await page.getByPlaceholder("Jane Homeowner").fill(clientName);
        await page.getByText("Create lead", { exact: true }).click();

        // Lands on the lead detail page (router.replace) — the client card shows the
        // exact name typed above (leadName gets a " - <projectType>" suffix server-side
        // when a project type is picked; none was picked here, so lead.name === clientName).
        await expect(page.getByText(clientName, { exact: true })).toBeVisible({ timeout: 15000 });

        const lead = await prisma.lead.findFirst({ where: { name: clientName } });
        expect(lead).not.toBeNull();
        createdLeadId = lead!.id;
        createdClientId = lead!.clientId;

        const noteText = `E2E note ${id}`;
        const noteInput = page.getByPlaceholder("Add a note...");
        await noteInput.fill(noteText);
        // No accessible name/testID on the send button (an icon-only TouchableOpacity) —
        // it's the composer row's only other child, immediately after the note input.
        await noteInput.locator("xpath=following-sibling::*[1]").click();
        // The composer is a <textarea>, and Playwright's getByText also matches an
        // input/textarea's current value — so a bare getByText(noteText) is already
        // satisfied by the freshly-typed composer text, before addNote() even resolves
        // (false positive: it'd pass even if the send silently failed). addNote() only
        // clears the composer (setNoteText("")) after its POST succeeds, so wait for that
        // first — from then on the only element left matching noteText is the real note
        // row rendered from the reloaded lead.
        await expect(noteInput).toHaveValue("");
        await expect(page.getByText(noteText)).toBeVisible({ timeout: 15000 });

        const note = await prisma.leadNote.findFirst({ where: { leadId: lead!.id, content: noteText } });
        expect(note).not.toBeNull();

        // "New lead" was pushed then replaced by the detail screen, so back lands on the
        // Leads list (not the form) without a full page reload.
        await page.goBack();
        // The list row renders lead.name and lead.client.name as separate Text nodes — with
        // no projectType picked, lead.name === clientName too, so both nodes hold the exact
        // same string. .first() picks either; we only need to confirm the row exists.
        await expect(page.getByText(clientName, { exact: true }).first()).toBeVisible({
            timeout: 15000,
        });
    });
});

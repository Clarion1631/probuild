import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signClientPortalToken } from "../src/lib/client-portal-auth";
import { canAccessProject } from "../src/lib/permissions";
import { persistSelectionItemNote } from "../src/lib/selection-item-note-persistence-core";

const prisma = new PrismaClient();
const run = `selection-notes-${process.pid}-${Date.now()}`;
const ids = {
  client: `${run}-client`,
  otherClient: `${run}-other-client`,
  project: `${run}-project`,
  otherProject: `${run}-other-project`,
  decision: `${run}-decision`,
  candidate: `${run}-candidate`,
  otherCandidate: `${run}-other-candidate`,
  restrictedStaff: `${run}-restricted-staff`,
} as const;
const clientEmail = `${run}@example.com`;
const distinctivePrice = "9876.54";
const longNote =
  "Use this in the primary bathroom on the vanity wall. The warm brass finish should match the mirror, cabinet pulls, sconces, faucet, and towel hardware.";

test.describe.serial("selection item notes", () => {
  test.beforeAll(async () => {
    await prisma.client.create({
      data: {
        id: ids.client,
        name: "Selection Notes Client",
        initials: "SN",
        email: clientEmail,
      },
    });
    await prisma.client.create({
      data: {
        id: ids.otherClient,
        name: "Other Selection Notes Client",
        initials: "OS",
        email: `other-${clientEmail}`,
      },
    });
    await prisma.project.create({
      data: {
        id: ids.project,
        name: "Selection Notes Project",
        clientId: ids.client,
        status: "In Progress",
      },
    });
    await prisma.project.create({
      data: {
        id: ids.otherProject,
        name: "Other Selection Notes Project",
        clientId: ids.otherClient,
        status: "In Progress",
      },
    });
    await prisma.portalVisibility.create({
      data: {
        projectId: ids.project,
        isPortalEnabled: true,
        showSelections: true,
      },
    });
    await prisma.portalVisibility.create({
      data: {
        projectId: ids.otherProject,
        isPortalEnabled: true,
        showSelections: true,
      },
    });
    await prisma.decision.create({
      data: {
        id: ids.decision,
        projectId: ids.project,
        name: "Vanity Light",
      },
    });
    await prisma.selectionProposal.create({
      data: {
        id: ids.candidate,
        projectId: ids.project,
        decisionId: ids.decision,
        name: "Warm Brass Sconce",
        clientNote: longNote,
        price: distinctivePrice,
        status: "Idea",
      },
    });
    await prisma.selectionProposal.create({
      data: {
        id: ids.otherCandidate,
        projectId: ids.otherProject,
        name: "Foreign Selection Note Fixture",
        clientNote: "Foreign note must remain unchanged",
        status: "Idea",
      },
    });
    await prisma.user.create({
      data: {
        id: ids.restrictedStaff,
        email: `${run}-restricted@example.com`,
        name: "Restricted Selection Notes Staff",
        role: "FIELD_CREW",
        status: "ACTIVATED",
      },
    });
  });

  test.afterAll(async () => {
    await prisma.project.deleteMany({
      where: { id: { in: [ids.project, ids.otherProject] } },
    });
    await prisma.client.deleteMany({
      where: { id: { in: [ids.client, ids.otherClient] } },
    });
    await prisma.user.deleteMany({ where: { id: ids.restrictedStaff } });
    await prisma.$disconnect();
  });

  test("client expands, edits, clears, and persists an item note", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const token = await signClientPortalToken(ids.client, clientEmail);
    await page.goto(
      `/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(
        `/portal/projects/${ids.project}/selections`,
      )}`,
    );

    const card = page.getByTestId(`selection-item-${ids.candidate}`);
    const portalMarkup = await page.content();
    expect(portalMarkup).not.toContain(distinctivePrice);
    expect(portalMarkup).not.toContain("$9,876.54");
    const preview = card.getByTestId("selection-note-preview");
    await expect(preview).toHaveClass(/line-clamp-2/);
    await card.getByTestId("selection-note-toggle").click();
    await expect(preview).not.toHaveClass(/line-clamp-2/);
    await expect(card.getByRole("button", { name: "Show less" })).toBeVisible();

    await card.getByTestId("selection-note-edit").click();
    const editor = card.getByLabel("Selection item note");
    await expect(editor).toHaveAttribute("maxlength", "2000");
    await expect(card.getByText(`${longNote.length}/2000`)).toBeVisible();

    await editor.fill("Cancel this draft");
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(card.getByText(longNote)).toBeVisible();
    expect(
      await prisma.selectionProposal.findUniqueOrThrow({
        where: { id: ids.candidate },
        select: { clientNote: true },
      }),
    ).toEqual({ clientNote: longNote });

    await card.getByTestId("selection-note-edit").click();
    await editor.fill("Keep this exact draft after a failed save");
    await context.setOffline(true);
    await card.getByRole("button", { name: "Save note" }).click();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue("Keep this exact draft after a failed save");
    await context.setOffline(false);

    await editor.fill("  Install on the left vanity wall.  ");
    await card.getByRole("button", { name: "Save note" }).click();
    await expect(card.getByText("Install on the left vanity wall.")).toBeVisible();
    await expect
      .poll(async () => {
        const item = await prisma.selectionProposal.findUnique({
          where: { id: ids.candidate },
          select: { clientNote: true },
        });
        return item?.clientNote;
      })
      .toBe("Install on the left vanity wall.");

    await card.getByTestId("selection-note-edit").click();
    await editor.fill(" ");
    await card.getByRole("button", { name: "Save note" }).click();
    await expect(card.getByRole("button", { name: "Add note" })).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByTestId(`selection-item-${ids.candidate}`)
        .getByRole("button", { name: "Add note" }),
    ).toBeVisible();
    await context.close();
  });

  test("staff adds a noted candidate, edits it, and sees it after approval", async ({
    page,
    browser,
  }) => {
    await page.goto(`/projects/${ids.project}/selections`);
    await page.getByRole("button", { name: "Add a candidate" }).click();
    await page.getByLabel("Name").fill("Team Suggested Sconce");
    await page.getByLabel("Note").fill("Team note visible to the client");
    await page.getByRole("button", { name: "Add candidate" }).click();
    await expect(
      page.getByRole("heading", { name: "Add a candidate" }),
    ).toBeHidden();

    await expect
      .poll(async () => {
        return prisma.selectionProposal.findFirst({
          where: {
            projectId: ids.project,
            name: "Team Suggested Sconce",
          },
          select: { id: true, clientNote: true },
        });
      })
      .not.toBeNull();
    const teamCandidate = await prisma.selectionProposal.findFirstOrThrow({
      where: {
        projectId: ids.project,
        name: "Team Suggested Sconce",
      },
    });
    expect(teamCandidate.clientNote).toBe("Team note visible to the client");

    const clientContext = await browser.newContext();
    const clientPage = await clientContext.newPage();
    const token = await signClientPortalToken(ids.client, clientEmail);
    await clientPage.goto(
      `/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(
        `/portal/projects/${ids.project}/selections`,
      )}`,
    );
    const clientCard = clientPage.getByTestId(
      `selection-item-${teamCandidate.id}`,
    );
    await expect(
      clientCard.getByText("Team note visible to the client"),
    ).toBeVisible();
    await clientCard.getByRole("button", { name: "This is the one" }).click();
    await expect
      .poll(async () => {
        return prisma.decision.findUnique({
          where: { id: ids.decision },
          select: { chosenItemId: true, status: true },
        });
      })
      .toEqual({
        chosenItemId: teamCandidate.id,
        status: "Decided",
      });
    await clientContext.close();

    await page.reload();
    const approvedRow = page.getByTestId(
      `approved-item-${teamCandidate.id}`,
    );
    await expect(
      approvedRow.getByText("Team note visible to the client"),
    ).toBeVisible();
    await approvedRow.getByRole("button", { name: "Edit note" }).click();
    await approvedRow
      .getByLabel("Selection item note")
      .fill("Ready for purchasing");
    await approvedRow.getByRole("button", { name: "Save note" }).click();
    await expect(approvedRow.getByText("Ready for purchasing")).toBeVisible();
  });

  test("foreign portal and restricted staff actors cannot change another project's note", async () => {
    const persistenceDependencies = (
      assertAccess: Parameters<
        typeof persistSelectionItemNote
      >[2]["assertAccess"],
    ) => ({
      findItem: (id: string) =>
        prisma.selectionProposal.findUnique({
          where: { id },
          select: { id: true, projectId: true, deletedAt: true },
        }),
      assertAccess,
      updateNote: async (id: string, clientNote: string | null) => {
        await prisma.selectionProposal.update({
          where: { id },
          data: { clientNote },
        });
      },
      revalidate: () => {},
    });

    await expect(
      persistSelectionItemNote(
        ids.otherCandidate,
        "Foreign portal overwrite",
        persistenceDependencies(async (projectId) => {
          const project = await prisma.project.findUniqueOrThrow({
            where: { id: projectId },
            select: { clientId: true },
          });
          if (project.clientId !== ids.client) throw new Error("Unauthorized");
        }),
      ),
    ).rejects.toThrow("Unauthorized");

    const restrictedStaff = await prisma.user.findUniqueOrThrow({
      where: { id: ids.restrictedStaff },
      include: {
        projectAccess: { select: { projectId: true } },
        assignedProjects: { select: { id: true } },
      },
    });
    expect(canAccessProject(restrictedStaff, ids.otherProject)).toBe(false);
    await expect(
      persistSelectionItemNote(
        ids.otherCandidate,
        "Restricted staff overwrite",
        persistenceDependencies(async (projectId) => {
          if (!canAccessProject(restrictedStaff, projectId)) {
            throw new Error("Forbidden");
          }
        }),
      ),
    ).rejects.toThrow("Forbidden");

    await expect(
      persistSelectionItemNote(
        ids.otherCandidate,
        "x".repeat(2001),
        persistenceDependencies(async () => {}),
      ),
    ).rejects.toThrow("2,000 characters or fewer");

    expect(
      await prisma.selectionProposal.findUniqueOrThrow({
        where: { id: ids.otherCandidate },
        select: { clientNote: true },
      }),
    ).toEqual({ clientNote: "Foreign note must remain unchanged" });
  });
});

import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signClientPortalToken } from "../src/lib/client-portal-auth";
import { canAccessProject } from "../src/lib/permissions";
import { postSelectionItemComment } from "../src/lib/selection-item-thread-core";

const prisma = new PrismaClient();
const run = `selection-threads-${process.pid}-${Date.now()}`;
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

test.describe.serial("selection item discussion threads", () => {
  test.beforeAll(async () => {
    await prisma.client.create({
      data: { id: ids.client, name: "Thread Client", initials: "TC", email: clientEmail },
    });
    await prisma.client.create({
      data: { id: ids.otherClient, name: "Other Thread Client", initials: "OT", email: `other-${clientEmail}` },
    });
    await prisma.project.create({
      data: { id: ids.project, name: "Thread Project", clientId: ids.client, status: "In Progress" },
    });
    await prisma.project.create({
      data: { id: ids.otherProject, name: "Other Thread Project", clientId: ids.otherClient, status: "In Progress" },
    });
    await prisma.portalVisibility.create({
      data: { projectId: ids.project, isPortalEnabled: true, showSelections: true },
    });
    await prisma.portalVisibility.create({
      data: { projectId: ids.otherProject, isPortalEnabled: true, showSelections: true },
    });
    await prisma.decision.create({
      data: { id: ids.decision, projectId: ids.project, name: "Vanity Light" },
    });
    await prisma.selectionProposal.create({
      data: {
        id: ids.candidate,
        projectId: ids.project,
        decisionId: ids.decision,
        name: "Warm Brass Sconce",
        status: "Idea",
      },
    });
    await prisma.selectionProposal.create({
      data: {
        id: ids.otherCandidate,
        projectId: ids.otherProject,
        name: "Foreign Thread Fixture",
        status: "Idea",
      },
    });
    await prisma.user.create({
      data: {
        id: ids.restrictedStaff,
        email: `${run}-restricted@example.com`,
        name: "Restricted Thread Staff",
        role: "FIELD_CREW",
        status: "ACTIVATED",
      },
    });
  });

  test.afterAll(async () => {
    await prisma.project.deleteMany({ where: { id: { in: [ids.project, ids.otherProject] } } });
    await prisma.client.deleteMany({ where: { id: { in: [ids.client, ids.otherClient] } } });
    await prisma.user.deleteMany({ where: { id: ids.restrictedStaff } });
    await prisma.$disconnect();
  });

  test("foreign portal and restricted staff actors cannot post in another project's thread", async () => {
    const dependencies = (assertAccess: Parameters<typeof postSelectionItemComment>[3]["assertAccess"]) => ({
      findItem: (id: string) =>
        prisma.selectionProposal.findUnique({
          where: { id },
          select: { id: true, projectId: true, deletedAt: true, name: true },
        }),
      assertAccess,
      uploadAttachments: async () => {
        throw new Error("uploadAttachments must never run when access is denied");
      },
      createComment: async () => {
        throw new Error("createComment must never run when access is denied");
      },
      notify: async () => {},
      revalidate: () => {},
    });

    await expect(
      postSelectionItemComment(ids.otherCandidate, "Foreign portal comment", [], dependencies(async (projectId) => {
        const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { clientId: true } });
        if (project.clientId !== ids.client) throw new Error("Unauthorized");
        return { isStaff: false, clientId: ids.client, userId: null, actorName: "Thread Client" };
      })),
    ).rejects.toThrow("Unauthorized");

    const restrictedStaff = await prisma.user.findUniqueOrThrow({
      where: { id: ids.restrictedStaff },
      include: { projectAccess: { select: { projectId: true } }, assignedProjects: { select: { id: true } } },
    });
    expect(canAccessProject(restrictedStaff, ids.otherProject)).toBe(false);
    await expect(
      postSelectionItemComment(ids.otherCandidate, "Restricted staff comment", [], dependencies(async (projectId) => {
        if (!canAccessProject(restrictedStaff, projectId)) throw new Error("Forbidden");
        return { isStaff: true, clientId: null, userId: restrictedStaff.id, actorName: restrictedStaff.name! };
      })),
    ).rejects.toThrow("Forbidden");

    expect(await prisma.selectionItemComment.count({ where: { proposalId: ids.otherCandidate } })).toBe(0);
  });

  test("empty body with no attachment is rejected; over-length body is rejected", async () => {
    const authorizedDependencies = {
      findItem: (id: string) =>
        prisma.selectionProposal.findUnique({
          where: { id },
          select: { id: true, projectId: true, deletedAt: true, name: true },
        }),
      assertAccess: async () => ({ isStaff: true, clientId: null, userId: null, actorName: "Team" }),
      uploadAttachments: async () => [],
      createComment: async () => {
        throw new Error("createComment must never run for invalid input");
      },
      notify: async () => {},
      revalidate: () => {},
    };

    await expect(
      postSelectionItemComment(ids.candidate, "   ", [], authorizedDependencies),
    ).rejects.toThrow("Write something or attach a file.");

    await expect(
      postSelectionItemComment(ids.candidate, "x".repeat(4001), [], authorizedDependencies),
    ).rejects.toThrow("4,000 characters or fewer");

    expect(await prisma.selectionItemComment.count({ where: { proposalId: ids.candidate } })).toBe(0);
  });

  test("client posts a comment through the real API route; DB row is unread for the team", async ({ browser }) => {
    // browser.newContext() inherits the "chromium" project's storageState
    // (the real staff login auth.setup.ts writes) unless explicitly cleared —
    // without this, the "client" context would carry a real ADMIN
    // next-auth session cookie and assertDecisionActorAccess would attribute
    // the post to staff instead of the portal client.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    const token = await signClientPortalToken(ids.client, clientEmail);
    await page.goto(
      `/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(
        `/portal/projects/${ids.project}/selections`,
      )}`,
    );

    const response = await page.request.post("/api/selections/item-comments", {
      multipart: {
        itemId: ids.candidate,
        body: "We'd like to see this in a warmer finish.",
      },
    });
    expect(response.ok()).toBe(true);
    const payload = await response.json();
    expect(payload.comment.authorType).toBe("CLIENT");
    expect(payload.comment.readByTeamAt).toBeNull();

    const stored = await prisma.selectionItemComment.findUniqueOrThrow({ where: { id: payload.comment.id } });
    expect(stored.authorType).toBe("CLIENT");
    expect(stored.authorClientId).toBe(ids.client);
    expect(stored.body).toBe("We'd like to see this in a warmer finish.");
    expect(stored.readByTeamAt).toBeNull();
    expect(stored.readByClientAt).not.toBeNull();

    await context.close();
  });
});

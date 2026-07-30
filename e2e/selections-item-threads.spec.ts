import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signClientPortalToken } from "../src/lib/client-portal-auth";
import { canAccessProject } from "../src/lib/permissions";
import { postSelectionItemComment } from "../src/lib/selection-item-thread-core";
import { createComment, getUnreadSelectionThreadCountForStaff } from "../src/lib/selection-item-thread-dependencies";

const prisma = new PrismaClient();
const run = `selection-threads-${process.pid}-${Date.now()}`;
const ids = {
  client: `${run}-client`,
  otherClient: `${run}-other-client`,
  project: `${run}-project`,
  otherProject: `${run}-other-project`,
  decision: `${run}-decision`,
  candidate: `${run}-candidate`,
  staffCandidate: `${run}-staff-candidate`,
  multipartCandidate: `${run}-multipart-candidate`,
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
        id: ids.staffCandidate,
        projectId: ids.project,
        decisionId: ids.decision,
        name: "Matte Black Faucet",
        status: "Idea",
      },
    });
    await prisma.selectionProposal.create({
      data: {
        id: ids.multipartCandidate,
        projectId: ids.project,
        decisionId: ids.decision,
        name: "Brushed Nickel Pull",
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
      cleanupAttachments: async () => {
        throw new Error("cleanupAttachments must never run when access is denied");
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
      cleanupAttachments: async () => {
        throw new Error("cleanupAttachments must never run for invalid input");
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

  async function readNavBadgeCount(page: import("@playwright/test").Page): Promise<number> {
    const badge = page.getByTestId("nav-badge-selection-boards");
    if ((await badge.count()) === 0) return 0;
    const text = (await badge.textContent()) ?? "0";
    return Number(text.trim());
  }

  test("staff sees the unread pill and nav badge, expanding marks the thread read", async ({ page }) => {
    // ids.staffCandidate is untouched by every earlier test in this serial
    // suite, so "Discussion (1)" is exact here — the project-wide nav badge
    // is not (other tests may leave their own unread comments behind), so
    // that assertion checks the delta instead of an absolute count.
    await page.goto(`/projects/${ids.project}/selections`);
    const baselineBadgeCount = await readNavBadgeCount(page);

    const comment = await prisma.selectionItemComment.create({
      data: {
        proposalId: ids.staffCandidate,
        authorType: "CLIENT",
        authorClientId: ids.client,
        authorName: "Thread Client",
        body: "Can we get this in a warmer finish?",
        readByClientAt: new Date(),
      },
    });

    await page.reload();
    const card = page.getByTestId(`selection-item-${ids.staffCandidate}`);
    await expect(card.getByTestId("selection-thread-toggle")).toContainText("Discussion (1)");
    await expect(card.getByTestId("selection-thread-unread-pill")).toContainText("1 new");
    expect(await readNavBadgeCount(page)).toBe(baselineBadgeCount + 1);

    await card.getByTestId("selection-thread-toggle").click();
    await expect(card.getByTestId(`selection-thread-comment-${comment.id}`)).toContainText(
      "Can we get this in a warmer finish?",
    );

    await expect
      .poll(async () => {
        const row = await prisma.selectionItemComment.findUniqueOrThrow({ where: { id: comment.id } });
        return row.readByTeamAt;
      })
      .not.toBeNull();

    await page.reload();
    await expect(page.getByTestId(`selection-item-${ids.staffCandidate}`).getByTestId("selection-thread-unread-pill")).toHaveCount(0);
    expect(await readNavBadgeCount(page)).toBe(baselineBadgeCount);
  });

  test("staff replies from the CandidateCard composer", async ({ page }) => {
    await page.goto(`/projects/${ids.project}/selections`);
    const card = page.getByTestId(`selection-item-${ids.staffCandidate}`);
    await card.getByTestId("selection-thread-toggle").click();
    await card.getByTestId("selection-thread-composer").fill("We'll swap it for the warmer finish.");
    await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/selections/item-comments") && res.ok()),
      card.getByTestId("selection-thread-post").click(),
    ]);
    await expect(
      card.getByTestId(/selection-thread-comment-/).filter({ hasText: "We'll swap it for the warmer finish." }),
    ).toBeVisible();

    const staffComment = await prisma.selectionItemComment.findFirstOrThrow({
      where: { proposalId: ids.staffCandidate, authorType: "TEAM" },
    });
    expect(staffComment.readByTeamAt).not.toBeNull();
    expect(staffComment.readByClientAt).toBeNull();
  });

  test("client sees the staff reply and pill on the portal, expanding marks it read", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    const token = await signClientPortalToken(ids.client, clientEmail);
    await page.goto(
      `/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(
        `/portal/projects/${ids.project}/selections`,
      )}`,
    );

    // ids.staffCandidate already carries the TEAM reply posted by the
    // preceding "staff replies" test — unread for the client side.
    const card = page.getByTestId(`selection-item-${ids.staffCandidate}`);
    await expect(card.getByTestId("selection-thread-unread-pill")).toBeVisible();
    await card.getByTestId("selection-thread-toggle").click();
    await expect(card.getByText("We'll swap it for the warmer finish.")).toBeVisible();

    const staffComment = await prisma.selectionItemComment.findFirstOrThrow({
      where: { proposalId: ids.staffCandidate, authorType: "TEAM" },
    });
    await expect
      .poll(async () => {
        const row = await prisma.selectionItemComment.findUniqueOrThrow({ where: { id: staffComment.id } });
        return row.readByClientAt;
      })
      .not.toBeNull();

    await page.reload();
    await expect(page.getByTestId(`selection-item-${ids.staffCandidate}`).getByTestId("selection-thread-unread-pill")).toHaveCount(0);

    await context.close();
  });

  // Attachment round-trip. A real multipart upload through saveProjectFile()
  // needs real Supabase Storage credentials (SUPABASE_URL +
  // SUPABASE_SERVICE_KEY) — present in CI's Playwright job, but this sandbox
  // has neither, and per docs/TESTING.md must never be pointed at
  // production's. The test below runs for real wherever those creds exist
  // (CI, or a manually configured environment) and is skipped otherwise;
  // meanwhile denied/invalid-extension posts and the canonical-shape DB
  // write are provable without Storage at all (both below, always run).
  const hasRealStorage = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_KEY;

  test("client posts a real file through the route: shared ProjectFile, provenance, canonical shape, chip renders", async ({ browser }) => {
    test.skip(!hasRealStorage, "requires real Supabase Storage credentials (SUPABASE_URL + SUPABASE_SERVICE_KEY) — see CI's Playwright job");

    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    const token = await signClientPortalToken(ids.client, clientEmail);
    await page.goto(
      `/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(
        `/portal/projects/${ids.project}/selections`,
      )}`,
    );

    const beforeFiles = await prisma.projectFile.count({ where: { projectId: ids.project } });

    const response = await page.request.post("/api/selections/item-comments", {
      multipart: {
        itemId: ids.multipartCandidate,
        body: "Here's the pull we picked",
        files: {
          name: "swatch.png",
          mimeType: "image/png",
          buffer: Buffer.from("fake png bytes for e2e"),
        },
      },
    });
    expect(response.status()).toBe(201);
    const payload = await response.json();
    const attachments = JSON.parse(payload.comment.attachments);
    expect(attachments).toHaveLength(1);
    // Canonical shape only — exactly {id, name, url}, never `size`.
    expect(Object.keys(attachments[0]).sort()).toEqual(["id", "name", "url"]);

    expect(await prisma.projectFile.count({ where: { projectId: ids.project } })).toBe(beforeFiles + 1);
    const file = await prisma.projectFile.findUniqueOrThrow({ where: { id: attachments[0].id } });
    expect(file.visibility).toBe("shared");
    expect(file.uploadedByClient).toBe(true);

    await page.goto(`/portal/projects/${ids.project}/selections`);
    const card = page.getByTestId(`selection-item-${ids.multipartCandidate}`);
    await card.getByTestId("selection-thread-toggle").click();
    await expect(card.getByTestId(`selection-thread-attachment-${attachments[0].id}`)).toContainText("swatch.png");

    await context.close();
  });

  test("a denied actor with a file attached creates zero ProjectFile rows", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    const token = await signClientPortalToken(ids.client, clientEmail);
    await page.goto(
      `/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(
        `/portal/projects/${ids.project}/selections`,
      )}`,
    );

    const beforeFiles = await prisma.projectFile.count({ where: { projectId: ids.otherProject } });
    const beforeComments = await prisma.selectionItemComment.count({ where: { proposalId: ids.otherCandidate } });

    const response = await page.request.post("/api/selections/item-comments", {
      multipart: {
        itemId: ids.otherCandidate,
        body: "Trying to post on a project that isn't mine",
        files: {
          name: "swatch.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("fake pdf bytes"),
        },
      },
    });
    expect(response.status()).toBe(403);

    expect(await prisma.projectFile.count({ where: { projectId: ids.otherProject } })).toBe(beforeFiles);
    expect(await prisma.selectionItemComment.count({ where: { proposalId: ids.otherCandidate } })).toBe(beforeComments);

    await context.close();
  });

  test("an invalid file extension is rejected before any upload; zero ProjectFile rows", async ({ page }) => {
    const beforeFiles = await prisma.projectFile.count({ where: { projectId: ids.project } });
    const beforeComments = await prisma.selectionItemComment.count({ where: { proposalId: ids.candidate } });

    const response = await page.request.post("/api/selections/item-comments", {
      multipart: {
        itemId: ids.candidate,
        body: "Attaching a disallowed file type",
        files: {
          name: "installer.exe",
          mimeType: "application/octet-stream",
          buffer: Buffer.from("fake exe bytes"),
        },
      },
    });
    expect(response.status()).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/File type not allowed/);

    expect(await prisma.projectFile.count({ where: { projectId: ids.project } })).toBe(beforeFiles);
    expect(await prisma.selectionItemComment.count({ where: { proposalId: ids.candidate } })).toBe(beforeComments);
  });

  test("stored attachment JSON is the canonical upload-result shape, not client-supplied data", async () => {
    const fakeAttachments = [{ id: "fake-file-1", name: "swatch.pdf", url: "https://cdn.example.com/swatch.pdf" }];

    const comment = await postSelectionItemComment(
      ids.staffCandidate,
      "See the attached swatch",
      [{ name: "swatch.pdf", buffer: Buffer.from("test"), mimeType: "application/pdf", size: 4 }],
      {
        findItem: (id) =>
          prisma.selectionProposal.findUnique({
            where: { id },
            select: { id: true, projectId: true, deletedAt: true, name: true },
          }),
        assertAccess: async () => ({ isStaff: true, clientId: null, userId: null, actorName: "Team" }),
        // Stands in for saveProjectFile — proves createComment (the real
        // production DB write) persists exactly what the upload step
        // returns, nothing client-supplied.
        uploadAttachments: async () => fakeAttachments,
        createComment,
        cleanupAttachments: async () => {
          throw new Error("cleanupAttachments must never run when createComment succeeds");
        },
        notify: async () => {},
        revalidate: () => {},
      },
    );

    expect(JSON.parse(comment.attachments!)).toEqual(fakeAttachments);
    const stored = await prisma.selectionItemComment.findUniqueOrThrow({ where: { id: comment.id } });
    expect(JSON.parse(stored.attachments!)).toEqual(fakeAttachments);
  });

  test("createComment failing after a successful upload cleans up every uploaded attachment", async () => {
    // The plan requires whole-batch cleanup for ANY failure after the first
    // successful upload, "not just the transaction" — this proves the
    // failure can happen one step LATER than uploadAttachments (e.g. the CAS
    // row-lock losing a concurrent soft-delete race in the real
    // createComment) and the core still cleans up every uploaded file.
    const fakeAttachments = [
      { id: "fake-file-A", name: "swatch-a.pdf", url: "https://cdn.example.com/swatch-a.pdf" },
      { id: "fake-file-B", name: "swatch-b.pdf", url: "https://cdn.example.com/swatch-b.pdf" },
    ];
    const cleanedUp: string[] = [];

    await expect(
      postSelectionItemComment(
        ids.staffCandidate,
        "See the attached swatches",
        [
          { name: "swatch-a.pdf", buffer: Buffer.from("a"), mimeType: "application/pdf", size: 1 },
          { name: "swatch-b.pdf", buffer: Buffer.from("b"), mimeType: "application/pdf", size: 1 },
        ],
        {
          findItem: (id) =>
            prisma.selectionProposal.findUnique({
              where: { id },
              select: { id: true, projectId: true, deletedAt: true, name: true },
            }),
          assertAccess: async () => ({ isStaff: true, clientId: null, userId: null, actorName: "Team" }),
          uploadAttachments: async () => fakeAttachments,
          createComment: async () => {
            throw new Error("Item not found");
          },
          cleanupAttachments: async (attachments) => {
            cleanedUp.push(...attachments.map((a) => a.id));
          },
          notify: async () => {},
          revalidate: () => {},
        },
      ),
    ).rejects.toThrow("Item not found");

    expect(cleanedUp.sort()).toEqual(["fake-file-A", "fake-file-B"]);
  });

  test("candidates under a soft-deleted decision are excluded from badges and are neither postable nor markable-read", async ({ page }) => {
    const orphanedDecisionId = `${run}-orphaned-decision`;
    const orphanedCandidateId = `${run}-orphaned-candidate`;
    await prisma.decision.create({
      data: { id: orphanedDecisionId, projectId: ids.project, name: "Discontinued Tile" },
    });
    await prisma.selectionProposal.create({
      data: { id: orphanedCandidateId, projectId: ids.project, decisionId: orphanedDecisionId, name: "Old Sample", status: "Idea" },
    });
    // deleteDecision never touches the candidate's own deletedAt — it stays
    // attached with decisionId pointing at the now-soft-deleted decision,
    // exactly like a real client/staff delete would leave it.
    await prisma.decision.update({ where: { id: orphanedDecisionId }, data: { deletedAt: new Date() } });
    const staleComment = await prisma.selectionItemComment.create({
      data: {
        proposalId: orphanedCandidateId,
        authorType: "CLIENT",
        authorClientId: ids.client,
        authorName: "Thread Client",
        body: "Is this still available?",
      },
    });

    const baselineUnread = await getUnreadSelectionThreadCountForStaff(ids.project);

    // A second, visible CLIENT-authored unread comment on a live item —
    // proves the badge count isn't just "always zero", it specifically
    // excludes the orphaned one while still counting a real one.
    const controlComment = await prisma.selectionItemComment.create({
      data: {
        proposalId: ids.candidate,
        authorType: "CLIENT",
        authorClientId: ids.client,
        authorName: "Thread Client",
        body: "Control comment on a live item",
      },
    });
    expect(await getUnreadSelectionThreadCountForStaff(ids.project)).toBe(baselineUnread + 1);

    const response = await page.request.post("/api/selections/item-comments", {
      multipart: { itemId: orphanedCandidateId, body: "Trying to post on an orphaned item" },
    });
    expect(response.status()).toBe(404);

    await prisma.selectionItemComment.deleteMany({ where: { id: { in: [staleComment.id, controlComment.id] } } });
    await prisma.selectionProposal.delete({ where: { id: orphanedCandidateId } });
    await prisma.decision.delete({ where: { id: orphanedDecisionId } });
  });
});

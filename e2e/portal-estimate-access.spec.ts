import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signClientPortalToken } from "../src/lib/client-portal-auth";

/**
 * Portal estimate access control — request-level, from a REAL client session.
 *
 * Born from the 2026-08-13 milestone-lockdown review: getEstimateForPortal
 * authorized any estimate owned by the portal client and checked nothing about
 * whether the contractor had ever shared it. Combined with the detail route
 * resolving sequential estimate `number`s, a client could walk to a never-sent
 * Draft and read internal pricing before it was offered to them.
 *
 * These tests must run as a client, not staff. A staff session takes the
 * isStaff branch of getEstimateForPortal and never touches the gate at all —
 * an ADMIN-session test here would pass no matter how broken the gate is. So
 * every test drives a context with NO storageState and logs in the way a real
 * client does: through /api/portal/verify, which validates the signed token and
 * drops the client_portal_token cookie.
 *
 * Runs against the throwaway CI Postgres (data.setup.ts guards prod). Fixture
 * clients deliberately carry unique emails so resolveSessionClientId — which
 * refuses ambiguous email matches — resolves exactly one row.
 */

const IDS = {
    clientA: "pea-e2e-client-a",
    clientB: "pea-e2e-client-b",
    leadA: "pea-e2e-lead-a",
    leadB: "pea-e2e-lead-b",
    projectA: "pea-e2e-project-a",
    draftUnsent: "pea-e2e-est-draft-unsent",
    sent: "pea-e2e-est-sent",
    unsentDefaultStatus: "pea-e2e-est-unsent-default-status",
    privateSent: "pea-e2e-est-private-sent",
    archivedUnsent: "pea-e2e-est-archived-unsent",
    invoicedUnsent: "pea-e2e-est-invoiced-unsent",
    invoiceForUnsent: "pea-e2e-inv-for-unsent",
    otherClient: "pea-e2e-est-other-client",
};

const EMAIL_A = "pea-e2e-client-a@example.invalid";
const EMAIL_B = "pea-e2e-client-b@example.invalid";

// High, unlikely-to-collide sequential numbers so the /portal/estimates/<number>
// enumeration route resolves to these fixtures and nothing else.
const NUMBERS = {
    draftUnsent: 990001,
    sent: 990002,
    unsentDefaultStatus: 990003,
    otherClient: 990004,
    privateSent: 990005,
    archivedUnsent: 990006,
    invoicedUnsent: 990007,
};

const prisma = new PrismaClient();

/** Log a browser context in as a portal client the way an emailed link does. */
async function signInAsClient(context: BrowserContext, clientId: string, email: string) {
    const token = await signClientPortalToken(clientId, email.toLowerCase());
    const page = await context.newPage();
    await page.goto(`/api/portal/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent("/portal")}`);
    await page.close();
}

// Fixtures live at FILE scope, not inside the first describe. They were briefly
// owned by that block, whose afterAll deleted every row and disconnected Prisma
// before the second describe's beforeAll ran — so the dispatcher tests below ran
// against missing rows, and the "does set viewedAt" control passed vacuously
// because `expect(undefined?.viewedAt).not.toBeNull()` is true for a row that
// isn't there. One owner for the whole file removes that ordering coupling.
test.beforeAll(async () => {
    {
        await prisma.client.upsert({
            where: { id: IDS.clientA },
            update: { email: EMAIL_A },
            create: { id: IDS.clientA, name: "Portal Access Client A", initials: "PA", email: EMAIL_A },
        });
        await prisma.client.upsert({
            where: { id: IDS.clientB },
            update: { email: EMAIL_B },
            create: { id: IDS.clientB, name: "Portal Access Client B", initials: "PB", email: EMAIL_B },
        });
        await prisma.lead.upsert({
            where: { id: IDS.leadA },
            update: {},
            create: { id: IDS.leadA, name: "Portal Access Drill A", clientId: IDS.clientA },
        });
        await prisma.lead.upsert({
            where: { id: IDS.leadB },
            update: {},
            create: { id: IDS.leadB, name: "Portal Access Drill B", clientId: IDS.clientB },
        });

        const baseEstimate = { taxExempt: true, totalAmount: 1000, balanceDue: 1000 };

        // The vulnerable shape: client's own estimate, never sent, still Draft.
        await prisma.estimate.upsert({
            where: { id: IDS.draftUnsent },
            // viewedAt reset so a retry after an incomplete teardown stays isolated.
            update: { status: "Draft", sentAt: null, approvedAt: null, viewedAt: null, privacy: "Shared" },
            create: {
                ...baseEstimate,
                id: IDS.draftUnsent, title: "Unsent Draft", code: "EST-PEA-DRAFT",
                number: NUMBERS.draftUnsent, leadId: IDS.leadA, status: "Draft", sentAt: null,
            },
        });
        // The normal shape: sent to the client.
        await prisma.estimate.upsert({
            where: { id: IDS.sent },
            update: { status: "Sent", sentAt: new Date() },
            create: {
                ...baseEstimate,
                id: IDS.sent, title: "Sent Estimate", code: "EST-PEA-SENT",
                number: NUMBERS.sent, leadId: IDS.leadA, status: "Sent", sentAt: new Date(),
            },
        });
        // The shape a negative `status != "Draft"` check misses: Estimate.status
        // column-defaults to "Sent", so an estimate created and never sent already
        // claims to be Sent. Prod carried 13 of these. Must be blocked.
        await prisma.estimate.upsert({
            where: { id: IDS.unsentDefaultStatus },
            update: { status: "Sent", sentAt: null, approvedAt: null },
            create: {
                ...baseEstimate,
                id: IDS.unsentDefaultStatus, title: "Never Sent, Default Status", code: "EST-PEA-DEFAULT",
                number: NUMBERS.unsentDefaultStatus, leadId: IDS.leadA, status: "Sent",
                sentAt: null, approvedAt: null,
            },
        });
        // Private overrides every other signal, including a real send.
        await prisma.estimate.upsert({
            where: { id: IDS.privateSent },
            update: { privacy: "Private", status: "Sent", sentAt: new Date() },
            create: {
                ...baseEstimate,
                id: IDS.privateSent, title: "Private But Sent", code: "EST-PEA-PRIVATE",
                number: NUMBERS.privateSent, leadId: IDS.leadA, status: "Sent",
                sentAt: new Date(), privacy: "Private",
            },
        });
        // Archived is not evidence of sharing.
        await prisma.estimate.upsert({
            where: { id: IDS.archivedUnsent },
            update: { status: "Archived", sentAt: null, approvedAt: null },
            create: {
                ...baseEstimate,
                id: IDS.archivedUnsent, title: "Archived Never Sent", code: "EST-PEA-ARCHIVED",
                number: NUMBERS.archivedUnsent, leadId: IDS.leadA, status: "Archived",
                sentAt: null, approvedAt: null,
            },
        });
        // An invoice existing means the client is already past this estimate, even
        // with no sentAt — signing auto-creates the invoice.
        await prisma.estimate.upsert({
            where: { id: IDS.invoicedUnsent },
            update: { status: "Draft", sentAt: null, approvedAt: null },
            create: {
                ...baseEstimate,
                id: IDS.invoicedUnsent, title: "Has Invoice, No sentAt", code: "EST-PEA-INVOICED",
                number: NUMBERS.invoicedUnsent, leadId: IDS.leadA, status: "Draft",
                sentAt: null, approvedAt: null,
            },
        });
        // Invoice.projectId and .clientId are both REQUIRED relations, so the
        // invoice needs a project even though the estimate it proves out is
        // lead-based. The estimate stays on the lead: the gate reads the
        // `invoices` relation by estimateId, not by any shared project.
        await prisma.project.upsert({
            where: { id: IDS.projectA },
            update: {},
            create: { id: IDS.projectA, name: "Portal Access Project A", clientId: IDS.clientA },
        });
        await prisma.invoice.upsert({
            where: { id: IDS.invoiceForUnsent },
            update: {},
            create: {
                id: IDS.invoiceForUnsent, code: "INV-PEA-1", estimateId: IDS.invoicedUnsent,
                projectId: IDS.projectA, clientId: IDS.clientA,
                status: "Issued", totalAmount: 1000, balanceDue: 1000,
            },
        });
        // Another client's estimate — the pre-existing IDOR guard, kept covered.
        await prisma.estimate.upsert({
            where: { id: IDS.otherClient },
            update: { status: "Sent", sentAt: new Date() },
            create: {
                ...baseEstimate,
                id: IDS.otherClient, title: "Other Client Estimate", code: "EST-PEA-OTHER",
                number: NUMBERS.otherClient, leadId: IDS.leadB, status: "Sent", sentAt: new Date(),
            },
        });
    }
});

test.afterAll(async () => {
    const estimateIds = [
        IDS.draftUnsent, IDS.sent, IDS.unsentDefaultStatus, IDS.privateSent,
        IDS.archivedUnsent, IDS.invoicedUnsent, IDS.otherClient,
    ];
    try {
        await prisma.activityLog.deleteMany({
            where: { OR: [{ entityId: { in: estimateIds } }, { leadId: { in: [IDS.leadA, IDS.leadB] } }] },
        });
        await prisma.invoice.deleteMany({ where: { OR: [{ estimateId: { in: estimateIds } }, { projectId: IDS.projectA }] } });
        await prisma.estimate.deleteMany({ where: { id: { in: estimateIds } } });
        await prisma.project.deleteMany({ where: { id: IDS.projectA } });
        await prisma.lead.deleteMany({ where: { id: { in: [IDS.leadA, IDS.leadB] } } });
        await prisma.client.deleteMany({ where: { id: { in: [IDS.clientA, IDS.clientB] } } });
    } finally {
        await prisma.$disconnect();
    }
});

test.describe.serial("Portal estimate access: only shared estimates reach the client", () => {
    // No storageState — these contexts must NOT carry the ADMIN session.
    test.use({ storageState: { cookies: [], origins: [] } });

    test("a never-sent Draft is not reachable by its owning client", async ({ context, page }) => {
        await signInAsClient(context, IDS.clientA, EMAIL_A);

        const response = await page.goto(`/portal/estimates/${IDS.draftUnsent}`);
        expect(response?.status()).toBe(404);
        // The leak this guards is the pricing, so assert the number is absent too —
        // a 404 status with a rendered body would still have shipped the data.
        await expect(page.locator("body")).not.toContainText("EST-PEA-DRAFT");
    });

    test("an estimate that was never sent but carries the default 'Sent' status is blocked", async ({ context, page }) => {
        // The regression a negative `status != "Draft"` check let through.
        await signInAsClient(context, IDS.clientA, EMAIL_A);

        const response = await page.goto(`/portal/estimates/${IDS.unsentDefaultStatus}`);
        expect(response?.status()).toBe(404);
        await expect(page.locator("body")).not.toContainText("EST-PEA-DEFAULT");
    });

    test("a Private estimate is blocked even though it was really sent", async ({ context, page }) => {
        await signInAsClient(context, IDS.clientA, EMAIL_A);

        const response = await page.goto(`/portal/estimates/${IDS.privateSent}`);
        expect(response?.status()).toBe(404);
        await expect(page.locator("body")).not.toContainText("EST-PEA-PRIVATE");
    });

    test("an Archived, never-sent estimate is blocked", async ({ context, page }) => {
        await signInAsClient(context, IDS.clientA, EMAIL_A);

        const response = await page.goto(`/portal/estimates/${IDS.archivedUnsent}`);
        expect(response?.status()).toBe(404);
        await expect(page.locator("body")).not.toContainText("EST-PEA-ARCHIVED");
    });

    test("an estimate with an invoice is reachable even with no sentAt", async ({ context, page }) => {
        // Signing auto-creates the invoice, so its existence proves the client is
        // already past this estimate. Gating on sentAt alone would lock them out.
        await signInAsClient(context, IDS.clientA, EMAIL_A);

        const response = await page.goto(`/portal/estimates/${IDS.invoicedUnsent}`);
        expect(response?.status()).toBe(200);
        await expect(page.locator("body")).toContainText("EST-PEA-INVOICED");
    });

    test("a sent estimate is still reachable by its owning client", async ({ context, page }) => {
        await signInAsClient(context, IDS.clientA, EMAIL_A);

        const response = await page.goto(`/portal/estimates/${IDS.sent}`);
        expect(response?.status()).toBe(200);
        await expect(page.locator("body")).toContainText("EST-PEA-SENT");
    });

    test("another client's sent estimate stays blocked", async ({ context, page }) => {
        await signInAsClient(context, IDS.clientA, EMAIL_A);

        const response = await page.goto(`/portal/estimates/${IDS.otherClient}`);
        expect(response?.status()).toBe(404);
        await expect(page.locator("body")).not.toContainText("EST-PEA-OTHER");
    });

    test("the sequential number route does not hand out another client's estimate id", async ({ context, page }) => {
        await signInAsClient(context, IDS.clientA, EMAIL_A);

        const response = await page.goto(`/portal/estimates/${NUMBERS.otherClient}`);
        expect(response?.status()).toBe(404);
        // The redirect is the oracle: landing on the CUID means the number lookup
        // resolved an estimate this client does not own.
        expect(page.url()).not.toContain(IDS.otherClient);
    });

    test("the sequential number route does not resolve the client's OWN unsent Draft", async ({ context, page }) => {
        // Pins the VISIBILITY half of the numeric gate. The cross-client case
        // above is caught by the ownership half alone, so dropping
        // portalVisibleEstimateWhere() from the numeric lookup would go unnoticed
        // without this: the client owns this row, it is simply not shared.
        await signInAsClient(context, IDS.clientA, EMAIL_A);

        const response = await page.goto(`/portal/estimates/${NUMBERS.draftUnsent}`);
        expect(response?.status()).toBe(404);
        expect(page.url()).not.toContain(IDS.draftUnsent);
    });

    test("the sequential number route still resolves the client's own sent estimate", async ({ context, page }) => {
        await signInAsClient(context, IDS.clientA, EMAIL_A);

        const response = await page.goto(`/portal/estimates/${NUMBERS.sent}`);
        expect(response?.status()).toBe(200);
        expect(page.url()).toContain(IDS.sent);
    });

    test("a signed-out visitor gets nothing", async ({ page }) => {
        const response = await page.goto(`/portal/estimates/${IDS.sent}`);
        expect(response?.status()).toBe(404);
        await expect(page.locator("body")).not.toContainText("EST-PEA-SENT");
    });
});

/**
 * markEstimateViewed's own gate — request-level, via the test-only dispatcher.
 *
 * The suite above proves /portal/estimates/[id] 404s for an unsent Draft, but
 * that page never reaches PortalEstimateClient (the component that calls
 * markEstimateViewed) when it 404s — so nothing in this file, before this
 * block, ever actually invoked the action. A regression that deleted
 * markEstimateViewed's own gate entirely (leaving the page-level 404 as the
 * only defense) would pass every test above and go undetected by any caller
 * that reached the action a different way. This block calls the action
 * directly, through src/app/api/test-only/portal-estimate-actions/route.ts,
 * exactly the way e2e/contract-auth-runtime.spec.ts proves out the contract
 * family's guards.
 */
async function callDispatcher(
    request: APIRequestContext,
    action: string,
    args: any[]
): Promise<{ ok: boolean; data?: any; error?: string; raw: string }> {
    const res = await request.post("/api/test-only/portal-estimate-actions", {
        headers: { "content-type": "application/json", "x-e2e-secret": process.env.PLAYWRIGHT_TEST_SECRET || "" },
        data: { action, args },
    });
    expect(
        res.status(),
        `dispatcher returned ${res.status()} for action "${action}". A 404 means the route's gate is off — most likely E2E_TEST_ROUTES=1 is missing from the SERVER's environment (playwright.config.ts sets it on the webServer it starts, but reuseExistingServer will happily attach to a hand-started dev server that lacks it). Every downstream assertion in this block would be vacuous, so this fails loudly instead.`
    ).toBe(200);
    const raw = await res.text();
    return { ...JSON.parse(raw), raw };
}

test.describe.serial("markEstimateViewed / getEstimateForPortal: the action's own gate", () => {
    // No storageState — this context must NOT carry the ADMIN session, and
    // signInAsClient below drops the real client_portal_token cookie itself.
    test.use({ storageState: { cookies: [], origins: [] } });

    test.beforeAll(async () => {
        // Reset regardless of what the suite above left behind, so ordering
        // between the two describe blocks can never make these pass or fail
        // spuriously — draftUnsent must never carry a viewedAt to begin with,
        // and sent must start unviewed so the positive control actually proves
        // something.
        await prisma.estimate.updateMany({
            where: { id: { in: [IDS.draftUnsent, IDS.sent] } },
            data: { viewedAt: null },
        });
    });

    test("markEstimateViewed on an unsent Draft leaves viewedAt NULL — the action refuses on its own", async ({ context }) => {
        await signInAsClient(context, IDS.clientA, EMAIL_A);
        await callDispatcher(context.request, "markEstimateViewed", [IDS.draftUnsent]);

        const row = await prisma.estimate.findUnique({ where: { id: IDS.draftUnsent }, select: { viewedAt: true } });
        expect(row?.viewedAt).toBeNull();
    });

    // Positive control: proves the assertion above isn't passing for the
    // trivial reason that the dispatcher, or markEstimateViewed itself, never
    // sets viewedAt for anyone. Same caller, same client ownership, a properly
    // shared estimate — this MUST flip.
    test("positive control: markEstimateViewed on a sent estimate does set viewedAt", async ({ context }) => {
        await signInAsClient(context, IDS.clientA, EMAIL_A);
        await callDispatcher(context.request, "markEstimateViewed", [IDS.sent]);

        const row = await prisma.estimate.findUnique({ where: { id: IDS.sent }, select: { viewedAt: true } });
        // Assert the row EXISTS first. `expect(undefined?.viewedAt).not.toBeNull()`
        // is true, so without this the control would pass loudest exactly when the
        // fixtures were missing — the one case it is here to rule out.
        expect(row, "fixture row is missing — the control below would pass vacuously").toBeTruthy();
        expect(row?.viewedAt).not.toBeNull();
    });

    test("markEstimateViewed cannot be aimed at another client's estimate", async ({ context }) => {
        // Pins the OWNERSHIP half of the action's own gate, independently of the
        // page-level probe: client A calling the action directly on client B's row.
        await signInAsClient(context, IDS.clientA, EMAIL_A);
        await callDispatcher(context.request, "markEstimateViewed", [IDS.otherClient]);

        const row = await prisma.estimate.findUnique({ where: { id: IDS.otherClient }, select: { viewedAt: true } });
        expect(row).toBeTruthy();
        expect(row?.viewedAt).toBeNull();
    });

    test("getEstimateForPortal refuses another client's estimate", async ({ context }) => {
        // The page test for this case is satisfied by the page's own probe, so it
        // would still pass if getEstimateForPortal's ownership check were removed.
        // This one calls the action directly, so it cannot be.
        await signInAsClient(context, IDS.clientA, EMAIL_A);
        const result = await callDispatcher(context.request, "getEstimateForPortal", [IDS.otherClient]);

        expect(result.ok).toBe(true);
        expect(result.data).toBeNull();
        expect(result.raw).not.toContain("EST-PEA-OTHER");
    });

    test("getEstimateForPortal returns null for the unsent Draft", async ({ context }) => {
        await signInAsClient(context, IDS.clientA, EMAIL_A);
        const result = await callDispatcher(context.request, "getEstimateForPortal", [IDS.draftUnsent]);

        expect(result.ok).toBe(true);
        expect(result.data).toBeNull();
        expect(result.raw).not.toContain("EST-PEA-DRAFT");
    });

    test("getEstimateForPortal returns the estimate once it has been shared", async ({ context }) => {
        await signInAsClient(context, IDS.clientA, EMAIL_A);
        const result = await callDispatcher(context.request, "getEstimateForPortal", [IDS.sent]);

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ id: IDS.sent, code: "EST-PEA-SENT", status: "Sent" });
    });
});

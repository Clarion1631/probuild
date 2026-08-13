import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signClientPortalToken } from "../src/lib/client-portal-auth";

/**
 * Behavioral (request-level) coverage for the contract server-action auth
 * family: assertContractAccess / canAccessContract / contractScopeWhere
 * (PR #367). e2e/financial-action-auth.spec.ts proves the guard TOKENS appear
 * in the right order by reading actions.ts as text — that passes just as
 * happily against a refactor that keeps the token shapes while changing the
 * semantics. This spec proves the guards actually BEHAVE: it invokes the real
 * exported actions, as a specific caller, through the test-only dispatcher
 * route (src/app/api/test-only/contract-actions/route.ts), and asserts on the
 * outcome.
 *
 * Fixtures (users, permissions, contracts, the executed-PDF file) are seeded
 * by e2e/data.setup.ts — see its "Contract-auth fixtures" section. IDs are
 * re-declared here as literals (matching e2e/estimate-scope-labels.spec.ts's
 * convention for OOS_PROJECT_ID/OOS_LEAD_ID) rather than imported, because
 * data.setup.ts is a Playwright setup file, not a module other specs import.
 */

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const OOS_PROJECT_ID = "e2e-scope-oos-project";
const OOS_LEAD_ID = "e2e-scope-oos-lead";
const TEST_CLIENT_ID = "test-client-do-not-delete";
const TEST_CLIENT_EMAIL = "test-client@goldentouchremodeling.com";

const CONTRACT_INSCOPE_ID = "e2e-contract-inscope";
const CONTRACT_INSCOPE_TOKEN = "e2e-contract-token-inscope";
const CONTRACT_INSCOPE_BODY = "E2E IN-SCOPE CONTRACT BODY — DO NOT DELETE";

const CONTRACT_CONVERTED_ID = "e2e-contract-converted";
const CONTRACT_CONVERTED_TOKEN = "e2e-contract-token-converted";
const CONTRACT_CONVERTED_BODY = "E2E CONVERTED CONTRACT BODY — DO NOT DELETE";

const CONTRACT_LEADONLY_ID = "e2e-contract-leadonly";
const CONTRACT_LEADONLY_TITLE = "E2E Lead-Only Contract — DO NOT DELETE";
const CONTRACT_LEADONLY_TOKEN = "e2e-contract-token-leadonly";
const CONTRACT_LEADONLY_BODY = "E2E LEAD-ONLY CONTRACT BODY — DO NOT DELETE";

const SCRATCH_CONTRACT_ID = "e2e-contract-scratch";

async function callAction(
    request: APIRequestContext,
    action: string,
    args: any[]
): Promise<{ ok: boolean; data?: any; error?: string; raw: string }> {
    const res = await request.post("/api/test-only/contract-actions", {
        headers: { "content-type": "application/json", "x-e2e-secret": process.env.PLAYWRIGHT_TEST_SECRET || "" },
        data: { action, args },
    });
    expect(
        res.status(),
        `dispatcher returned ${res.status()} for action "${action}" — a 404 here means PLAYWRIGHT_TEST_SECRET/VERCEL_ENV gate is off and every downstream assertion in this file is vacuous`
    ).toBe(200);
    const raw = await res.text();
    return { ...JSON.parse(raw), raw };
}

test.describe("unauthenticated caller", () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    test.skip(
        !process.env.CI,
        "src/proxy.ts returns NextResponse.next() for everything in development, and currentStaffUserOrNull falls back to a known ADMIN (canUseDevAuthFallback) — so an anonymous caller looks like an admin locally. Only the CI production build (npm run start) is a real anonymous caller."
    );

    for (const [action, args] of [
        ["getContracts", []],
        ["getContract", [CONTRACT_INSCOPE_ID]],
        ["updateContract", [CONTRACT_INSCOPE_ID, { title: "hacked" }]],
        ["deleteContract", [CONTRACT_INSCOPE_ID]],
        [
            "getExecutedContractPdf",
            [{ id: CONTRACT_LEADONLY_ID, title: CONTRACT_LEADONLY_TITLE, projectId: null, leadId: OOS_LEAD_ID }],
        ],
        ["getContractSigningHistory", [CONTRACT_INSCOPE_ID]],
        ["getContractSendDefaults", [CONTRACT_INSCOPE_ID]],
    ] as const) {
        test(`${action} refuses an anonymous caller`, async ({ request }) => {
            const result = await callAction(request, action, args as any[]);
            expect(result.ok).toBe(false);
            expect(result.error).toBe("Unauthorized");
            expect(result.raw).not.toContain(CONTRACT_INSCOPE_TOKEN);
            expect(result.raw).not.toContain(CONTRACT_CONVERTED_TOKEN);
            expect(result.raw).not.toContain(CONTRACT_LEADONLY_TOKEN);
            expect(result.raw).not.toContain(CONTRACT_INSCOPE_BODY);
            expect(result.raw).not.toContain(CONTRACT_CONVERTED_BODY);
            expect(result.raw).not.toContain(CONTRACT_LEADONLY_BODY);
        });
    }

    // getLead is not part of the assertContractAccess family — it never throws
    // for anonymous callers — but its embedded `contracts` relation was the
    // Codex round-1 blocker that motivated this whole spec: an anonymous caller
    // handed a lead id used to receive every contract field on that lead,
    // accessToken included, through an action with no permission gate at all.
    // contractScopeWhere(null) must resolve that relation to an empty list.
    test("getLead never throws, but its embedded contracts relation stays empty", async ({ request }) => {
        const result = await callAction(request, "getLead", [OOS_LEAD_ID]);
        expect(result.ok).toBe(true);
        expect(result.data.contracts).toEqual([]);
        expect(result.raw).not.toContain(CONTRACT_CONVERTED_TOKEN);
        expect(result.raw).not.toContain(CONTRACT_LEADONLY_TOKEN);
        expect(result.raw).not.toContain(CONTRACT_CONVERTED_BODY);
        expect(result.raw).not.toContain(CONTRACT_LEADONLY_BODY);
    });
});

// Runs in CI AND locally — a real session cookie means the dev ADMIN fallback
// does not apply.
test.describe("staff with project access but no `contracts` permission (FINANCE)", () => {
    test.use({ storageState: "e2e/.auth/finance-user.json" });

    test("project contracts page renders the empty state, not the in-scope contract", async ({ page }) => {
        const response = await page.goto(`/projects/${PROJECT_ID}/contracts`);
        expect(response?.ok()).toBeTruthy();
        await expect(page).not.toHaveURL(/.*login.*/);
        const body = await page.textContent("body");
        expect(body).not.toContain("E2E In-Scope Contract");
        expect(body).not.toContain(CONTRACT_INSCOPE_BODY);
        expect(body).not.toContain(CONTRACT_INSCOPE_TOKEN);
        await expect(page.getByText("No contracts yet")).toBeVisible();
    });

    test("lead contracts page renders the empty state too", async ({ page }) => {
        const response = await page.goto(`/leads/${OOS_LEAD_ID}/contracts`);
        expect(response?.ok()).toBeTruthy();
        await expect(page).not.toHaveURL(/.*login.*/);
        const body = await page.textContent("body");
        expect(body).not.toContain(CONTRACT_LEADONLY_TITLE);
        expect(body).not.toContain(CONTRACT_LEADONLY_BODY);
        expect(body).not.toContain(CONTRACT_LEADONLY_TOKEN);
        await expect(page.getByText("No contracts yet")).toBeVisible();
    });

    // getContracts REFUSES rather than returning []. Its gate is
    // assertStaffPermission("contracts"), which throws before
    // contractScopeWhere is ever consulted — so the action and the pages answer
    // "no contracts" by two different mechanisms, and only the pages (which
    // query Prisma directly through contractScopeWhere, never through this
    // action) degrade to an empty list. Asserting `ok: true, data: []` here
    // fails against the real system; that is what the first live run showed.
    test("getContracts refuses outright — it never degrades to an empty list", async ({ request }) => {
        const result = await callAction(request, "getContracts", []);
        expect(result.ok).toBe(false);
        expect(result.error).toBe("Forbidden");
        expect(result.raw).not.toContain(CONTRACT_INSCOPE_TOKEN);
        expect(result.raw).not.toContain(CONTRACT_INSCOPE_BODY);
    });

    // Project access is not the contract permission — this is the exact
    // over-grant contractScopeWhere's vertical check exists to stop. Every
    // by-id action must refuse this user on CONTRACT_INSCOPE_ID even though
    // they can otherwise read and write PROJECT_ID.
    for (const [action, args] of [
        ["getContract", [CONTRACT_INSCOPE_ID]],
        ["updateContract", [CONTRACT_INSCOPE_ID, { title: "hacked" }]],
        ["deleteContract", [CONTRACT_INSCOPE_ID]],
        [
            "getExecutedContractPdf",
            [{ id: CONTRACT_INSCOPE_ID, title: "irrelevant", projectId: PROJECT_ID, leadId: null }],
        ],
        ["getContractSigningHistory", [CONTRACT_INSCOPE_ID]],
        ["getContractSendDefaults", [CONTRACT_INSCOPE_ID]],
    ] as const) {
        test(`${action} refuses FINANCE on an in-scope project's contract`, async ({ request }) => {
            const result = await callAction(request, action, args as any[]);
            expect(result.ok).toBe(false);
            expect(result.error).toBe("Forbidden");
        });
    }
});

test.describe("staff with `contracts` + `leadAccess` but no access to the converted contract's project", () => {
    test.use({ storageState: "e2e/.auth/contract-user.json" });

    test("positive control: getContract on the lead-only contract succeeds", async ({ request }) => {
        const result = await callAction(request, "getContract", [CONTRACT_LEADONLY_ID]);
        expect(result.ok).toBe(true);
        expect(result.data.id).toBe(CONTRACT_LEADONLY_ID);
    });

    test("positive control: getContracts lists the lead-only contract", async ({ request }) => {
        const result = await callAction(request, "getContracts", []);
        expect(result.ok).toBe(true);
        expect((result.data as any[]).some((c) => c.id === CONTRACT_LEADONLY_ID)).toBe(true);
    });

    test("positive control: signing history / send defaults / executed PDF succeed on the lead-only contract", async ({
        request,
    }) => {
        const history = await callAction(request, "getContractSigningHistory", [CONTRACT_LEADONLY_ID]);
        expect(history.ok).toBe(true);

        const sendDefaults = await callAction(request, "getContractSendDefaults", [CONTRACT_LEADONLY_ID]);
        expect(sendDefaults.ok).toBe(true);

        const pdf = await callAction(request, "getExecutedContractPdf", [
            { id: CONTRACT_LEADONLY_ID, title: CONTRACT_LEADONLY_TITLE, projectId: null, leadId: OOS_LEAD_ID },
        ]);
        expect(pdf.ok).toBe(true);
    });

    // It carries BOTH ids and canAccessJobScope lets projectId win, so
    // leadAccess must NOT rescue it.
    for (const [action, args] of [
        ["getContract", [CONTRACT_CONVERTED_ID]],
        ["updateContract", [CONTRACT_CONVERTED_ID, { title: "hacked" }]],
        ["deleteContract", [CONTRACT_CONVERTED_ID]],
        [
            "getExecutedContractPdf",
            [{ id: CONTRACT_CONVERTED_ID, title: "irrelevant", projectId: OOS_PROJECT_ID, leadId: OOS_LEAD_ID }],
        ],
        ["getContractSigningHistory", [CONTRACT_CONVERTED_ID]],
        ["getContractSendDefaults", [CONTRACT_CONVERTED_ID]],
    ] as const) {
        test(`${action} refuses on the converted (project-wins) contract`, async ({ request }) => {
            const result = await callAction(request, action, args as any[]);
            expect(result.ok).toBe(false);
            expect(result.error).toBe("Forbidden");
        });
    }

    // The list must agree with the detail action, in BOTH directions — a filter
    // that simply returned nothing would satisfy an exclusion-only assertion.
    // This user reaches PROJECT_ID, so the in-scope contract is legitimately
    // theirs and MUST appear; the converted one is on a project they cannot
    // reach and must not, even though its leadId would otherwise admit it.
    test("getContracts list admits what the by-id action admits and excludes the converted contract", async ({
        request,
    }) => {
        const result = await callAction(request, "getContracts", []);
        expect(result.ok).toBe(true);
        const ids = (result.data as any[]).map((c) => c.id);
        expect(ids).toContain(CONTRACT_LEADONLY_ID);
        expect(ids).toContain(CONTRACT_INSCOPE_ID);
        expect(ids).not.toContain(CONTRACT_CONVERTED_ID);
        expect(result.raw).not.toContain(CONTRACT_CONVERTED_TOKEN);
        expect(result.raw).not.toContain(CONTRACT_CONVERTED_BODY);
    });

    test.describe.serial("scratch contract write control", () => {
        const prisma = new PrismaClient();

        test.beforeAll(async () => {
            await prisma.contract.upsert({
                where: { id: SCRATCH_CONTRACT_ID },
                update: {
                    leadId: OOS_LEAD_ID,
                    projectId: null,
                    title: "E2E Scratch Contract",
                    body: "scratch body",
                    status: "Draft",
                    accessToken: "e2e-contract-token-scratch",
                },
                create: {
                    id: SCRATCH_CONTRACT_ID,
                    leadId: OOS_LEAD_ID,
                    projectId: null,
                    title: "E2E Scratch Contract",
                    body: "scratch body",
                    status: "Draft",
                    accessToken: "e2e-contract-token-scratch",
                },
            });
        });

        test.afterAll(async () => {
            try {
                await prisma.contract.deleteMany({ where: { id: SCRATCH_CONTRACT_ID } });
            } finally {
                await prisma.$disconnect();
            }
        });

        test("updateContract actually persists the write, not just returns ok", async ({ request }) => {
            const result = await callAction(request, "updateContract", [
                SCRATCH_CONTRACT_ID,
                { title: "updated by e2e" },
            ]);
            expect(result.ok).toBe(true);

            const row = await prisma.contract.findUnique({
                where: { id: SCRATCH_CONTRACT_ID },
                select: { title: true },
            });
            expect(row?.title).toBe("updated by e2e");
        });
    });
});

test.describe("client portal path still works", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("accessToken path renders the lead-only contract and its executed-PDF link", async ({ page }) => {
        const response = await page.goto(`/portal/contracts/${CONTRACT_LEADONLY_ID}?token=${CONTRACT_LEADONLY_TOKEN}`);
        expect(response?.status()).not.toBe(404);
        await expect(page).not.toHaveURL(/.*login.*/);
        await expect(page.getByText(CONTRACT_LEADONLY_TITLE)).toBeVisible();
        await expect(page.getByText(CONTRACT_LEADONLY_BODY)).toBeVisible();
        await expect(page.locator('a[href*="example.test/e2e/executed-contract.pdf"]')).toBeVisible();
    });

    test("portal-session path (no token) renders the same contract", async ({ page }) => {
        const token = await signClientPortalToken(TEST_CLIENT_ID, TEST_CLIENT_EMAIL);
        // page.request shares the page's own browser context, so the Set-Cookie
        // response from /api/portal/verify lands where page.goto can use it —
        // an APIRequestContext obtained a different way would not share cookies
        // with this page.
        const verifyRes = await page.request.get(`/api/portal/verify?token=${encodeURIComponent(token)}&next=/portal`);
        expect(verifyRes.ok()).toBeTruthy();

        const response = await page.goto(`/portal/contracts/${CONTRACT_LEADONLY_ID}`);
        expect(response?.status()).not.toBe(404);
        await expect(page).not.toHaveURL(/.*login.*/);
        await expect(page.getByText(CONTRACT_LEADONLY_TITLE)).toBeVisible();
        await expect(page.getByText(CONTRACT_LEADONLY_BODY)).toBeVisible();
        await expect(page.locator('a[href*="example.test/e2e/executed-contract.pdf"]')).toBeVisible();
    });

    test("negative control: a wrong token with no portal session 404s", async ({ browser }) => {
        // A fresh, isolated context: no portal cookie, no shared state with the
        // tests above.
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
            const response = await page.goto(`/portal/contracts/${CONTRACT_LEADONLY_ID}?token=not-a-real-token`);
            // No custom not-found.tsx exists under src/app/portal, so Next's
            // default not-found page renders — asserting on the HTTP status is
            // more robust than matching that page's copy.
            expect(response?.status()).toBe(404);
        } finally {
            await context.close();
        }
    });
});

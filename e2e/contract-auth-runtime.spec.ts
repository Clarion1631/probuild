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
const SCRATCH_CONTRACT_DEL_ID = "e2e-contract-scratch-del";

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
        `dispatcher returned ${res.status()} for action "${action}". A 404 means the route's gate is off — most likely E2E_TEST_ROUTES=1 is missing from the SERVER's environment (playwright.config.ts sets it on the webServer it starts, but reuseExistingServer will happily attach to a hand-started dev server that lacks it). Every downstream assertion in this file would be vacuous, so this fails loudly instead.`
    ).toBe(200);
    const raw = await res.text();
    return { ...JSON.parse(raw), raw };
}

// The dispatcher's own gate. Codex's round-2 point: nothing in this file failed
// if a gate clause were deleted, so the route's protection was itself untested.
// The three ENVIRONMENT clauses cannot be exercised from here — they are read by
// the already-running server and a test cannot change them mid-run — but the
// credential clause can, and it is the one an outside caller would actually
// have to defeat. A bare 404 (not 401/403) is the contract: an unauthorized
// caller must not even learn the route exists.
test.describe("the dispatcher's own gate", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    for (const [label, headers] of [
        ["a wrong secret", { "x-e2e-secret": "not-the-secret" }],
        ["no secret at all", {}],
    ] as const) {
        test(`${label} gets a bare 404, not an action result`, async ({ request }) => {
            const res = await request.post("/api/test-only/contract-actions", {
                headers: { "content-type": "application/json", ...headers },
                data: { action: "getContracts", args: [] },
            });
            expect(res.status()).toBe(404);
            const body = await res.text();
            expect(body).not.toContain(CONTRACT_INSCOPE_TOKEN);
            expect(body).not.toContain(CONTRACT_LEADONLY_TOKEN);
            expect(body).not.toContain(CONTRACT_CONVERTED_TOKEN);
        });
    }

    test("an unknown action name never dispatches", async ({ request }) => {
        const res = await request.post("/api/test-only/contract-actions", {
            headers: {
                "content-type": "application/json",
                "x-e2e-secret": process.env.PLAYWRIGHT_TEST_SECRET || "",
            },
            // `constructor` would resolve on a plain object without the
            // hasOwnProperty check the route uses.
            data: { action: "constructor", args: [] },
        });
        expect(res.status()).toBe(400);
        expect(await res.text()).toContain("Unknown action");
    });
});

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

    // contractOwnerOrThrow exists specifically so ownership is read from the DB
    // by contract id, NOT from the caller-supplied descriptor — but nothing
    // else in this file pins that, because every other call passes truthful
    // ownership. Here the descriptor LIES: it claims CONTRACT_CONVERTED_ID
    // (which actually lives on OOS_PROJECT_ID, unreachable to this user) is
    // lead-only on OOS_LEAD_ID, which this user CAN reach via leadAccess. If
    // getExecutedContractPdf ever regressed to trusting the supplied
    // projectId/leadId instead of re-reading them from the DB row, this is the
    // only test in the file that would catch it — every other test here passes
    // truthful descriptors and would keep passing under that regression.
    test("forged descriptor cannot smuggle access to a contract this user cannot reach", async ({ request }) => {
        const result = await callAction(request, "getExecutedContractPdf", [
            { id: CONTRACT_CONVERTED_ID, title: "irrelevant", projectId: null, leadId: OOS_LEAD_ID },
        ]);
        expect(result.ok).toBe(false);
        expect(result.error).toBe("Forbidden");
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
        // A guard that denies everyone would ALSO fail this assertion — but a
        // lookup that resolves to `null` on every call (never actually reading
        // the seeded ProjectFile) would still pass `ok: true`. Assert the real
        // file came back, not just that the call didn't throw.
        expect(pdf.data).not.toBeNull();
        expect(pdf.raw).toContain("example.test/e2e/executed-contract.pdf");
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

    // Without this, the unauthenticated block's "getLead never throws, but its
    // embedded contracts relation stays empty" assertion is vacuous — an empty
    // array is exactly what a `contracts: []` relation that NEVER resolves
    // would also return. This user holds leadAccess + the `contracts`
    // permission and reaches OOS_LEAD_ID, so the relation must actually
    // populate for them, which is what makes the anonymous-caller empty-array
    // assertion mean something.
    test("positive control: getLead's contracts relation resolves for an authorized reader", async ({ request }) => {
        const result = await callAction(request, "getLead", [OOS_LEAD_ID]);
        expect(result.ok).toBe(true);
        const ids = (result.data.contracts as any[]).map((c) => c.id);
        expect(ids).toContain(CONTRACT_LEADONLY_ID);
    });

    test("project contracts page shows the in-scope contract, not the empty state", async ({ page }) => {
        const response = await page.goto(`/projects/${PROJECT_ID}/contracts`);
        expect(response?.ok()).toBeTruthy();
        await expect(page).not.toHaveURL(/.*login.*/);
        await expect(page.getByText("E2E In-Scope Contract", { exact: false })).toBeVisible();
        await expect(page.getByText("No contracts yet")).not.toBeVisible();
    });

    test("lead contracts page shows the lead-only contract, not the empty state, and hides the converted contract", async ({ page }) => {
        const response = await page.goto(`/leads/${OOS_LEAD_ID}/contracts`);
        expect(response?.ok()).toBeTruthy();
        await expect(page).not.toHaveURL(/.*login.*/);
        await expect(page.getByText(CONTRACT_LEADONLY_TITLE)).toBeVisible();
        await expect(page.getByText("No contracts yet")).not.toBeVisible();
        // The converted contract carries this same leadId, but canAccessJobScope
        // lets its projectId (OOS_PROJECT_ID, unreachable to this user) win —
        // the lead page's union is bidirectional, so without this assertion a
        // regression that let leadId alone admit it would go unnoticed.
        await expect(page.getByText("E2E Converted Contract")).not.toBeVisible();
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
            // A SEPARATE row for the delete control, so the two write tests never
            // interfere with each other's fixture.
            await prisma.contract.upsert({
                where: { id: SCRATCH_CONTRACT_DEL_ID },
                update: {
                    leadId: OOS_LEAD_ID,
                    projectId: null,
                    title: "E2E Scratch Contract (delete control)",
                    body: "scratch body",
                    status: "Draft",
                    accessToken: "e2e-contract-token-scratch-del",
                },
                create: {
                    id: SCRATCH_CONTRACT_DEL_ID,
                    leadId: OOS_LEAD_ID,
                    projectId: null,
                    title: "E2E Scratch Contract (delete control)",
                    body: "scratch body",
                    status: "Draft",
                    accessToken: "e2e-contract-token-scratch-del",
                },
            });
        });

        test.afterAll(async () => {
            try {
                // Idempotent regardless of whether the delete test already removed
                // SCRATCH_CONTRACT_DEL_ID — deleteMany on a missing id is a no-op.
                await prisma.contract.deleteMany({ where: { id: { in: [SCRATCH_CONTRACT_ID, SCRATCH_CONTRACT_DEL_ID] } } });
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

        // Runs after the update test above, on a SEPARATE id, so the two write
        // controls never interfere. A guard that denies every delete would fail
        // this test's `ok: true` assertion, and a guard that reports success
        // without actually deleting would fail the follow-up findUnique check —
        // without this, no test in the file proves an AUTHORIZED delete actually
        // removes the row.
        test("deleteContract actually removes the row, not just returns ok", async ({ request }) => {
            const result = await callAction(request, "deleteContract", [SCRATCH_CONTRACT_DEL_ID]);
            expect(result.ok).toBe(true);

            const row = await prisma.contract.findUnique({
                where: { id: SCRATCH_CONTRACT_DEL_ID },
            });
            expect(row).toBeNull();
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

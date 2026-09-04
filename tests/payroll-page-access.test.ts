/**
 * WHO MAY SEE THE PAYROLL REVIEW PAGE (round 17, P0).
 *
 * /manager/payroll-export reimplemented the old gate by hand:
 *
 *     if (viewer && viewer.role !== "ADMIN" && !hasPermission(viewer, "financialReports"))
 *
 * so it kept the exact hole round 15 closed on every other surface. An
 * ACTIVATED portal CLIENT holding `financialReports` — an assignable
 * permission — passed the proxy and rendered the whole company's payroll:
 * every name, every rate, every total, with the download button beside it.
 *
 * The `viewer &&` made it worse than a copy: a null viewer skipped the check
 * entirely and landed on a NODE_ENV test.
 *
 * The page now composes `canActOnFinancials`, the same predicate the export
 * endpoint, the roster endpoint, the payroll actions and the integration
 * settings ask. These cases INVOKE the page component and look at what it
 * returns.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-payroll-page-access";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";

type Viewer = { id: string; role: string; status: string; permissions: Record<string, boolean> | null } | null;

let viewer: Viewer = null;
/** Set once the page gets PAST the gate and starts loading the period. */
let reachedTheData = false;
let PayrollExportPage: (props: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>;

const DENIED = "Access Denied. Payroll access required.";

before(async () => {
    const moduleInternals = Module as unknown as {
        _load(request: string, parent: unknown, isMain: boolean): unknown;
    };
    const originalLoad = moduleInternals._load;
    moduleInternals._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request === "@/lib/auth") {
            return { getSessionOrDev: async () => (viewer ? { user: { email: "viewer@example.test" } } : null) };
        }
        if (request === "@/lib/permissions" || request === "./permissions") {
            const real = originalLoad.call(this, "@/lib/access-rules", parent, isMain) as Record<string, unknown>;
            // The REAL hasPermission — the gate has to be exercised, not stubbed.
            return { ...real, canUseDevAuthFallback: async () => false, getCurrentUserWithPermissions: async () => viewer };
        }
        if (request === "@/lib/company-timezone") {
            return {
                resolveCompanyTimeZone: async () => {
                    // PAST the gate. Nothing before this touches company data.
                    reachedTheData = true;
                    throw new Error("STOP: the page reached the data");
                },
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    // src/lib/prisma.ts exports a Proxy that resolves globalThis.prisma, so this
    // substitution works no matter how the page reaches it and no real client is
    // ever built.
    (globalThis as unknown as { prisma: unknown }).prisma = {
        user: { findUnique: async () => viewer },
    };

    const mod = (await import("../src/app/manager/payroll-export/page")) as { default?: unknown };
    if (typeof mod.default !== "function") {
        throw new Error(`the module patch did not apply — default is ${typeof mod.default}`);
    }
    PayrollExportPage = mod.default as typeof PayrollExportPage;
});

/** Render far enough to see either the refusal or the first data read. */
async function visit(): Promise<{ denied: boolean; reachedTheData: boolean }> {
    reachedTheData = false;
    try {
        const element = (await PayrollExportPage({ searchParams: Promise.resolve({}) })) as {
            props?: { children?: unknown };
        };
        const children = element?.props?.children;
        return { denied: children === DENIED, reachedTheData };
    } catch (error) {
        if (String((error as Error).message).startsWith("STOP:")) {
            return { denied: false, reachedTheData };
        }
        throw error;
    }
}

test("an activated CLIENT with financialReports is REFUSED — it used to render payroll", async () => {
    viewer = { id: "u-client", role: "CLIENT", status: "ACTIVATED", permissions: { financialReports: true } };
    const result = await visit();
    assert.equal(result.denied, true, "a customer must not see the company's pay rates");
    assert.equal(result.reachedTheData, false, "and must not reach the payroll query at all");
});

test("a PENDING staff member with financialReports is refused too", async () => {
    // The same class, one round later: an invited-but-not-activated account, or
    // one an admin reset to PENDING to revoke access, kept every capability.
    viewer = { id: "u-finance", role: "FINANCE", status: "PENDING", permissions: { financialReports: true } };
    const result = await visit();
    assert.equal(result.denied, true);
    assert.equal(result.reachedTheData, false);
});

test("a FIELD_CREW member without the permission is refused — unchanged", async () => {
    viewer = { id: "u-crew", role: "FIELD_CREW", status: "ACTIVATED", permissions: null };
    assert.equal((await visit()).denied, true);
});

test("no session redirects to /login, and never reaches the data", async () => {
    // A sessionless request is turned away one step earlier, by the redirect at
    // the top of the page. What matters here is the same thing as everywhere
    // else: it does not reach the payroll query. (The old shape ALSO guarded
    // its real check on `viewer &&`, so a viewer that existed but was not
    // loadable skipped the check and was judged by NODE_ENV; the positive
    // `if (!allowed)` has no such branch.)
    viewer = null;
    reachedTheData = false;
    await assert.rejects(
        () => PayrollExportPage({ searchParams: Promise.resolve({}) }),
        /NEXT_REDIRECT/
    );
    assert.equal(reachedTheData, false);
});

test("ADMIN and an activated FINANCE member get through — the CONTROL", async () => {
    // Without this every refusal above would pass on a page that denies
    // everybody.
    for (const allowed of [
        { id: "u-admin", role: "ADMIN", status: "ACTIVATED", permissions: null },
        { id: "u-finance", role: "FINANCE", status: "ACTIVATED", permissions: { financialReports: true } },
    ] satisfies Viewer[]) {
        viewer = allowed;
        const result = await visit();
        assert.equal(result.denied, false, allowed.role);
        assert.equal(result.reachedTheData, true, `${allowed.role} must reach the payroll query`);
    }
});

test("the page is in the authorization manifest, and hand-rolls nothing", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "manager", "payroll-export", "page.tsx"),
        "utf8"
    );
    assert.match(source, /canActOnFinancials\(viewer\)/, "the page must compose the shared predicate");
    assert.ok(
        !/hasPermission\([^)]*"financialReports"\)/.test(source),
        "no second copy of the rule may survive here"
    );
    // The refusal is positive: allowed, or the dev fallback, or denied. Two
    // negative branches with a `viewer &&` in front of the first is what let a
    // null viewer through to an environment check.
    assert.match(source, /const allowed = canActOnFinancials\(viewer\);/);
    assert.match(source, /if \(!allowed\)/);
});

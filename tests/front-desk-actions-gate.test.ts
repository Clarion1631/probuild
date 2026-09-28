/**
 * Front Desk v1 acceptance test 38: "The settings page and every front-desk
 * action refuse non-ADMIN users" (first half), plus "Saving a token runs the
 * three read-only checks first, stores only ciphertext (the DB value never
 * contains the token), and never sends the token to the client or a log"
 * (second half). Mirrors the Module.prototype.require patch
 * tests/speed-to-lead-actions-gate.test.ts uses — `@/lib/permissions` is
 * mocked so the rejection path (no session, or a non-ADMIN session) is
 * proven without a database, since `assertFrontDeskAdmin` throws before
 * front-desk-actions.ts ever touches Prisma or Calendly. The ADMIN success
 * path additionally mocks `@/lib/prisma` (capture the write), `@/lib/front-desk/calendly`
 * (the 3 read-only checks) and `next/cache` — but NOT `@/lib/crypto`, which
 * runs for real so the captured DB value can be proven to be genuine
 * ciphertext, not the plaintext token.
 */
import { test, before, after as afterHook } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { decryptObject } from "../src/lib/crypto";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";
process.env.NEXTAUTH_SECRET ??= "test-secret-for-front-desk-actions-gate-tests";

let mockUser: { role: string; email: string } | null = null;

interface CalendlyGetResultStub<T> {
    kind: "ok" | "http" | "timeout" | "network";
    data?: T;
    status?: number;
}
let mockUsersMeResult: CalendlyGetResultStub<{ resource: { uri: string; current_organization: string } }> = {
    kind: "ok",
    data: { resource: { uri: "https://api.calendly.com/users/richard-test", current_organization: "https://api.calendly.com/organizations/org-test" } },
};
const mockOrgResult: CalendlyGetResultStub<{ resource: { plan?: string; stage?: string } }> = { kind: "ok", data: { resource: { plan: "standard", stage: "paid" } } };
const mockEventTypesResult: CalendlyGetResultStub<{ collection: unknown[] }> = { kind: "ok", data: { collection: [] } };
const calendlyCallLog: string[] = [];
let capturedCompanySettingsUpdate: { data?: Record<string, unknown> } | null = null;
const consoleLogged: string[] = [];

let saveCalendlyTokenAction: (token: string) => Promise<{ ok: boolean; error?: string }>;
let clearCalendlyTokenAction: () => Promise<void>;
let setFrontDeskEventTypesAction: (live: string, test: string) => Promise<void>;
let setFrontDeskTakingTransfersAction: (taking: boolean) => Promise<void>;
let originalRequire: typeof Module.prototype.require;

before(async () => {
    originalRequire = Module.prototype.require;
    const patched = new Set<string>();
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/permissions") {
            patched.add(id);
            return {
                assertActiveStaff: async () => {
                    if (!mockUser) throw new Error("Unauthorized");
                    return mockUser;
                },
            };
        }
        if (id === "next-auth/next") { patched.add(id); return { getServerSession: async () => (mockUser ? { user: { email: mockUser.email } } : null) }; }
        if (id === "@/lib/auth") { patched.add(id); return { authOptions: {} }; }
        if (id === "next/cache") { patched.add(id); return { revalidatePath: () => {} }; }
        if (id === "@/lib/speed-to-lead/audit") { patched.add(id); return { logLeadEvent: async () => {} }; }
        if (id === "@/lib/front-desk/calendly") {
            patched.add(id);
            return {
                getUsersMe: async () => { calendlyCallLog.push("users/me"); return mockUsersMeResult; },
                getOrganization: async () => { calendlyCallLog.push("organizations"); return mockOrgResult; },
                getEventTypes: async () => { calendlyCallLog.push("event_types"); return mockEventTypesResult; },
            };
        }
        if (id === "@/lib/prisma") {
            patched.add(id);
            return {
                prisma: {
                    companySettings: {
                        update: async (args: { data?: Record<string, unknown> }) => {
                            capturedCompanySettingsUpdate = args;
                            return {};
                        },
                    },
                },
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: Record<string, unknown>;
    try {
        mod = await import("../src/lib/front-desk-actions");
    } finally {
        Module.prototype.require = originalRequire;
    }
    for (const id of ["@/lib/permissions", "next-auth/next", "@/lib/auth", "next/cache", "@/lib/speed-to-lead/audit", "@/lib/front-desk/calendly", "@/lib/prisma"]) {
        if (!patched.has(id)) throw new Error(`the mock of "${id}" never applied — the action would hit real config`);
    }
    saveCalendlyTokenAction = mod.saveCalendlyTokenAction as typeof saveCalendlyTokenAction;
    clearCalendlyTokenAction = mod.clearCalendlyTokenAction as typeof clearCalendlyTokenAction;
    setFrontDeskEventTypesAction = mod.setFrontDeskEventTypesAction as typeof setFrontDeskEventTypesAction;
    setFrontDeskTakingTransfersAction = mod.setFrontDeskTakingTransfersAction as typeof setFrontDeskTakingTransfersAction;
    assert.equal(typeof saveCalendlyTokenAction, "function");
});

afterHook(() => {
    Module.prototype.require = originalRequire;
});

test("clearCalendlyTokenAction refuses a signed-out caller", async () => {
    mockUser = null;
    await assert.rejects(() => clearCalendlyTokenAction(), /Unauthorized/);
});

test("clearCalendlyTokenAction refuses a non-ADMIN staff session", async () => {
    mockUser = { role: "MANAGER", email: "manager@example.com" };
    await assert.rejects(() => clearCalendlyTokenAction(), /Unauthorized/);
});

test("setFrontDeskTakingTransfersAction refuses a non-ADMIN caller", async () => {
    mockUser = { role: "FIELD_CREW", email: "crew@example.com" };
    await assert.rejects(() => setFrontDeskTakingTransfersAction(true), /Unauthorized/);
});

test("setFrontDeskEventTypesAction refuses a signed-out caller", async () => {
    mockUser = null;
    await assert.rejects(() => setFrontDeskEventTypesAction("a", "b"), /Unauthorized/);
});

test("saveCalendlyTokenAction refuses a non-ADMIN caller before ever validating the token", async () => {
    mockUser = { role: "FINANCE", email: "finance@example.com" };
    await assert.rejects(() => saveCalendlyTokenAction("not-even-checked"), /Unauthorized/);
});

// ── Test 38 (second half): the ADMIN success path — 3 read-only checks
// before persisting, ciphertext-only storage, nothing logged or returned. ──

test("saveCalendlyTokenAction (ADMIN): runs all 3 read-only Calendly checks, in order, before ever writing to the DB", async () => {
    mockUser = { role: "ADMIN", email: "justin@example.com" };
    calendlyCallLog.length = 0;
    capturedCompanySettingsUpdate = null;
    const result = await saveCalendlyTokenAction("a".repeat(40));
    assert.equal(result.ok, true);
    assert.deepEqual(calendlyCallLog, ["users/me", "organizations", "event_types"], "all three checks run, in the documented order");
    assert.ok(capturedCompanySettingsUpdate, "the DB write only happens after all three checks pass");
});

test("saveCalendlyTokenAction (ADMIN): the DB value is genuine ciphertext — decrypting it recovers the token, but the captured write never contains the plaintext anywhere", async () => {
    mockUser = { role: "ADMIN", email: "justin@example.com" };
    capturedCompanySettingsUpdate = null;
    const plainToken = `real-token-value-${"x".repeat(20)}`;
    const result = await saveCalendlyTokenAction(plainToken);
    assert.equal(result.ok, true);

    const data = (capturedCompanySettingsUpdate as { data?: Record<string, unknown> } | null)?.data ?? {};
    const serializedWrite = JSON.stringify(data);
    assert.doesNotMatch(serializedWrite, new RegExp(plainToken), "the plaintext token must never appear anywhere in the DB write");

    const ciphertext = data.frontDeskCalendlyTokenEnc as string;
    assert.ok(ciphertext && ciphertext !== plainToken);
    const decrypted = decryptObject(ciphertext) as { token: string };
    assert.equal(decrypted.token, plainToken, "the ciphertext must round-trip back to the real token — proves it is real encryption, not a placeholder");
});

test("saveCalendlyTokenAction (ADMIN): the token is never returned to the caller and never reaches console.*", async () => {
    mockUser = { role: "ADMIN", email: "justin@example.com" };
    consoleLogged.length = 0;
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;
    const spy = (...args: unknown[]) => { consoleLogged.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
    console.log = spy; console.error = spy; console.warn = spy; console.info = spy;
    const plainToken = `console-spy-token-${"y".repeat(20)}`;
    let result: { ok: boolean; error?: string };
    try {
        result = await saveCalendlyTokenAction(plainToken);
    } finally {
        console.log = originalLog; console.error = originalError; console.warn = originalWarn; console.info = originalInfo;
    }
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(plainToken), false, "the action's own return value never carries the token");
    for (const line of consoleLogged) {
        assert.doesNotMatch(line, new RegExp(plainToken), `console output must never contain the token: ${line}`);
    }
});

test("saveCalendlyTokenAction (ADMIN): rejects a malformed token before ever calling Calendly", async () => {
    mockUser = { role: "ADMIN", email: "justin@example.com" };
    calendlyCallLog.length = 0;
    const result = await saveCalendlyTokenAction("not a valid token!!");
    assert.equal(result.ok, false);
    assert.deepEqual(calendlyCallLog, [], "a malformed token must never reach Calendly");
});

test("saveCalendlyTokenAction (ADMIN): a rejected /users/me check stops before any DB write", async () => {
    mockUser = { role: "ADMIN", email: "justin@example.com" };
    capturedCompanySettingsUpdate = null;
    const original = mockUsersMeResult;
    mockUsersMeResult = { kind: "http", status: 401 };
    try {
        const result = await saveCalendlyTokenAction("b".repeat(40));
        assert.equal(result.ok, false);
        assert.equal(capturedCompanySettingsUpdate, null, "no DB write when the first check fails");
    } finally {
        mockUsersMeResult = original;
    }
});

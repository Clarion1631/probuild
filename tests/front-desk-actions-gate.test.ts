/**
 * Front Desk v1 acceptance test 38 (first half): "The settings page and
 * every front-desk action refuse non-ADMIN users." Mirrors the
 * Module.prototype.require patch tests/speed-to-lead-actions-gate.test.ts
 * uses — `@/lib/permissions` is mocked so the rejection path (no session, or
 * a non-ADMIN session) is proven without a database, since
 * `assertFrontDeskAdmin` throws before front-desk-actions.ts ever touches
 * Prisma or Calendly.
 */
import { test, before, after as afterHook } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";

let mockUser: { role: string; email: string } | null = null;

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
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: Record<string, unknown>;
    try {
        mod = await import("../src/lib/front-desk-actions");
    } finally {
        Module.prototype.require = originalRequire;
    }
    for (const id of ["@/lib/permissions", "next-auth/next", "@/lib/auth"]) {
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

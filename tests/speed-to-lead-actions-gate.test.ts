/**
 * Round-2 gap (acceptance test 9's last, previously-unverified claim): "Junk
 * and Promote are Justin-only". tests/server-action-gates.test.ts's AST scan
 * (round 49) proves every export in speed-to-lead-actions.ts calls SOME gate;
 * this file proves that gate — requireApproverEmail() — actually rejects a
 * signed-out caller and a signed-in NON-approver, for both markLeadJunkAction
 * and promoteLeadToRealAction, without a database: requireApproverEmail()
 * throws before either action ever touches Prisma, so the rejection path
 * needs no DB and no mock of one.
 *
 * `getServerSession` (next-auth/next) is mocked to a controllable value via
 * the same Module.prototype.require patch tests/users-route-pin-leak.test.ts
 * uses — @/lib/auth is mocked alongside it so importing the real NextAuth
 * config (Google provider, secrets) never happens.
 */
import { test, before, after as afterHook } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

process.env.SPEED_TO_LEAD_APPROVER_EMAIL = "justin@goldentouchremodeling.com";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";

let sessionEmail: string | null = null;

let markLeadJunkAction: (leadId: string) => Promise<void>;
let promoteLeadToRealAction: (leadId: string) => Promise<void>;
let setSpeedToLeadPausedAction: (paused: boolean) => Promise<void>;
let originalRequire: typeof Module.prototype.require;

before(async () => {
    originalRequire = Module.prototype.require;
    const patched = new Set<string>();
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "next-auth/next") { patched.add(id); return { getServerSession: async () => (sessionEmail ? { user: { email: sessionEmail } } : null) }; }
        if (id === "@/lib/auth") { patched.add(id); return { authOptions: {} }; }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: Record<string, unknown>;
    try {
        mod = await import("../src/lib/speed-to-lead-actions");
    } finally {
        Module.prototype.require = originalRequire;
    }
    for (const id of ["next-auth/next", "@/lib/auth"]) {
        if (!patched.has(id)) throw new Error(`the mock of "${id}" never applied — the action would hit real NextAuth config`);
    }
    markLeadJunkAction = mod.markLeadJunkAction as typeof markLeadJunkAction;
    promoteLeadToRealAction = mod.promoteLeadToRealAction as typeof promoteLeadToRealAction;
    setSpeedToLeadPausedAction = mod.setSpeedToLeadPausedAction as typeof setSpeedToLeadPausedAction;
    assert.equal(typeof markLeadJunkAction, "function");
    assert.equal(typeof promoteLeadToRealAction, "function");
});

afterHook(() => {
    Module.prototype.require = originalRequire;
});

test("markLeadJunkAction rejects a signed-out caller", async () => {
    sessionEmail = null;
    await assert.rejects(() => markLeadJunkAction("some-lead-id"), /Unauthorized/);
});

test("markLeadJunkAction rejects a signed-in NON-approver — 'active staff' is not enough, only Justin", async () => {
    sessionEmail = "richard@goldentouchremodeling.com";
    await assert.rejects(() => markLeadJunkAction("some-lead-id"), /Unauthorized/);
});

test("promoteLeadToRealAction rejects a signed-out caller", async () => {
    sessionEmail = null;
    await assert.rejects(() => promoteLeadToRealAction("some-lead-id"), /Unauthorized/);
});

test("promoteLeadToRealAction rejects a signed-in NON-approver", async () => {
    sessionEmail = "cj@goldentouchremodeling.com";
    await assert.rejects(() => promoteLeadToRealAction("some-lead-id"), /Unauthorized/);
});

test("setSpeedToLeadPausedAction (the kill switch) is also Justin-only", async () => {
    sessionEmail = null;
    await assert.rejects(() => setSpeedToLeadPausedAction(true), /Unauthorized/);
    sessionEmail = "richard@goldentouchremodeling.com";
    await assert.rejects(() => setSpeedToLeadPausedAction(true), /Unauthorized/);
});

// Case-insensitivity of the approver match itself (Justin's own address in a
// different case must still pass) is already pinned, hermetically, by
// tests/speed-to-lead-mode.test.ts's "isApprover matches case-insensitively"
// — requireApproverEmail() calls that exact function, so it is not repeated
// here. Deliberately not adding a "the approver gets through" case in THIS
// file: this file is DB-free by design (only the rejection path is reachable
// without touching Prisma), and letting an approver through would require
// either a real database or mocking one, neither of which this file's own
// no-DB premise wants.

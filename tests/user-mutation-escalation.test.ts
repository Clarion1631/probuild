/**
 * A MANAGER CANNOT PROMOTE THEMSELVES.
 *
 * The hole (round 9, finding 1). PUT /api/users/[id] gated on
 * `["MANAGER","ADMIN"].includes(currentUser.role)` and then wrote whatever the
 * body asked for: an arbitrary `role`, an arbitrary `status`, and an arbitrary
 * permission upsert. PATCH and POST /api/users did the same with `role`. So any
 * manager could make themselves ADMIN, grant themselves every permission, or
 * disable and demote the real admins — which nullifies every authorization
 * boundary above it, including the payroll one this branch is built on.
 *
 * The mobile manager endpoint already had the right rules and was the only
 * surface that did. They now live in src/lib/user-mutation-guard.ts and all four
 * writers call them.
 *
 * The verdict function is exercised exhaustively as a pure unit below, and then
 * driven through the REAL PUT handler so the assertions are about HTTP statuses
 * a client actually receives, not about a return value. Only the NextAuth
 * session and the database are intercepted — the route, the guard and the
 * permission sanitising are the genuine article.
 *
 * The interception is a scoped `Module.prototype.require` patch rather than
 * node:test's `mock.module()`, which corrupts the require chain on the Node 20
 * CI pins (see tests/users-create-payroll-body.test.ts).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    ASSIGNABLE_PERMISSIONS,
    PRIVILEGED_PERMISSIONS,
    checkUserCreate,
    checkUserMutation,
} from "../src/lib/user-mutation-guard";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-user-mutation-escalation";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";

const MANAGER = { id: "u-manager", role: "MANAGER" };
const ADMIN = { id: "u-admin", role: "ADMIN" };
const CREW = { id: "u-crew", role: "FIELD_CREW" };

// ---------------------------------------------------------------------------
// The rules, as a pure function
// ---------------------------------------------------------------------------

test("a MANAGER cannot change any role, including their own", () => {
    for (const target of [MANAGER, CREW]) {
        const verdict = checkUserMutation({ actor: MANAGER, target, changes: { role: "ADMIN" } });
        assert.deepEqual(verdict, {
            ok: false,
            status: 403,
            error: "Only an admin can change a team member's role.",
        });
    }
    // Not just the ADMIN role — a manager reshuffling roles at all is the same
    // authority, and "they can only demote" is not a rule worth relying on.
    assert.equal(checkUserMutation({ actor: MANAGER, target: CREW, changes: { role: "FINANCE" } }).ok, false);
});

test("a MANAGER cannot touch an ADMIN account at all", () => {
    const verdict = checkUserMutation({ actor: MANAGER, target: ADMIN, changes: { status: "DISABLED" } });
    assert.deepEqual(verdict, {
        ok: false,
        status: 403,
        error: "Only an admin can modify an admin account.",
    });
    // ...and the check is on the STORED role, so it does not matter what the
    // request claims the target is.
    assert.equal(checkUserMutation({ actor: MANAGER, target: ADMIN, changes: {} }).ok, false);
});

test("a MANAGER cannot change their own status or their own permissions", () => {
    assert.deepEqual(checkUserMutation({ actor: MANAGER, target: MANAGER, changes: { status: "ACTIVATED" } }), {
        ok: false,
        status: 403,
        error: "You cannot change your own status.",
    });
    assert.deepEqual(
        checkUserMutation({ actor: MANAGER, target: MANAGER, changes: { permissions: { schedules: true } } }),
        { ok: false, status: 403, error: "You cannot change your own permissions." }
    );
});

test("a MANAGER cannot grant or revoke a PRIVILEGED permission, on anyone", () => {
    for (const key of PRIVILEGED_PERMISSIONS) {
        const verdict = checkUserMutation({ actor: MANAGER, target: CREW, changes: { permissions: { [key]: true } } });
        assert.equal(verdict.ok, false, key);
        assert.equal((verdict as { status: number }).status, 403);
        assert.match((verdict as { error: string }).error, new RegExp(key));
        // Revoking is the same authority as granting.
        assert.equal(
            checkUserMutation({ actor: MANAGER, target: CREW, changes: { permissions: { [key]: false } } }).ok,
            false
        );
    }
});

test("a MANAGER CAN still do ordinary manager work — the guard is not a blanket refusal", () => {
    // THE CONTROL. Without it every assertion above would pass on a rule that
    // simply refuses managers everything, which would be a different bug.
    assert.deepEqual(checkUserMutation({ actor: MANAGER, target: CREW, changes: { status: "DISABLED" } }), { ok: true });
    assert.deepEqual(
        checkUserMutation({ actor: MANAGER, target: CREW, changes: { permissions: { schedules: true, files: false } } }),
        { ok: true }
    );
});

test("an ADMIN may do all of it", () => {
    assert.deepEqual(checkUserMutation({ actor: ADMIN, target: MANAGER, changes: { role: "ADMIN" } }), { ok: true });
    assert.deepEqual(checkUserMutation({ actor: ADMIN, target: ADMIN, changes: { status: "DISABLED" } }), { ok: true });
    assert.deepEqual(
        checkUserMutation({ actor: ADMIN, target: MANAGER, changes: { permissions: { financialReports: true } } }),
        { ok: true }
    );
});

test("a bogus enum is a 400, before any authority question is asked", () => {
    // Shape before authority: a caller is told their value is wrong rather than
    // that they are forbidden from sending nonsense.
    assert.deepEqual(checkUserMutation({ actor: ADMIN, target: CREW, changes: { role: "SUPERUSER" } }), {
        ok: false,
        status: 400,
        error: "Invalid role: SUPERUSER",
    });
    assert.deepEqual(checkUserMutation({ actor: ADMIN, target: CREW, changes: { status: "AWOL" } }), {
        ok: false,
        status: 400,
        error: "Invalid status: AWOL",
    });
    assert.deepEqual(
        checkUserMutation({ actor: ADMIN, target: CREW, changes: { permissions: { bogusPermission: true } } }),
        { ok: false, status: 400, error: "Unknown permission: bogusPermission" }
    );
    // CLIENT is a real role but not an assignable one: portal accounts are made
    // by the invite flow, never chosen in the team editor.
    assert.equal(checkUserMutation({ actor: ADMIN, target: CREW, changes: { role: "CLIENT" } }).ok, false);
});

test("creating an admin is admin-only, and the role enum is validated", () => {
    assert.deepEqual(checkUserCreate({ actor: MANAGER, role: "ADMIN" }), {
        ok: false,
        status: 403,
        error: "Only an admin can create an admin account.",
    });
    assert.deepEqual(checkUserCreate({ actor: MANAGER, role: "FIELD_CREW" }), { ok: true });
    assert.deepEqual(checkUserCreate({ actor: ADMIN, role: "ADMIN" }), { ok: true });
    assert.deepEqual(checkUserCreate({ actor: MANAGER, role: "SUPERUSER" }), {
        ok: false,
        status: 400,
        error: "Invalid role: SUPERUSER",
    });
    // No role at all is the default hire, and allowed.
    assert.deepEqual(checkUserCreate({ actor: MANAGER, role: undefined }), { ok: true });
});

test("the privileged set is a SUBSET of the assignable one, and names the three that confer authority", () => {
    for (const key of PRIVILEGED_PERMISSIONS) {
        assert.ok(
            (ASSIGNABLE_PERMISSIONS as readonly string[]).includes(key),
            `${key} must be a permission the editor can actually write`
        );
    }
    assert.deepEqual([...PRIVILEGED_PERMISSIONS].sort(), [
        "companySettings",
        "financialReports",
        "manageTeamMembers",
    ]);
    // ...and it is a strict subset: a manager delegating `schedules` is doing
    // their job, not escalating.
    assert.ok(ASSIGNABLE_PERMISSIONS.length > PRIVILEGED_PERMISSIONS.length);
});

// ---------------------------------------------------------------------------
// The same rules, through the REAL route
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const USERS: Record<string, Row> = {};
let permissionWrites: Row[] = [];
let userWrites: Row[] = [];

function resetDb() {
    permissionWrites = [];
    userWrites = [];
    USERS["u-manager"] = { id: "u-manager", email: "manager@example.test", role: "MANAGER", permissions: {} };
    USERS["u-admin"] = { id: "u-admin", email: "admin@example.test", role: "ADMIN", permissions: {} };
    USERS["u-crew"] = { id: "u-crew", email: "crew@example.test", role: "FIELD_CREW", permissions: {} };
    (globalThis as Record<string, unknown>).prisma = {
        user: {
            findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
                if (where.email) return Object.values(USERS).find((u) => u.email === where.email) ?? null;
                return USERS[where.id as string] ?? null;
            },
            update: async ({ where, data }: { where: { id: string }; data: Row }) => {
                userWrites.push({ id: where.id, ...data });
                Object.assign(USERS[where.id], data);
                return USERS[where.id];
            },
        },
        userPermission: {
            upsert: async ({ create, update }: { create: Row; update: Row }) => {
                permissionWrites.push({ ...create, ...update });
                return update;
            },
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
            fn({
                user: {
                    update: async (args: { where: { id: string }; data: Row }) => {
                        userWrites.push({ id: args.where.id, ...args.data });
                        Object.assign(USERS[args.where.id], args.data);
                        return USERS[args.where.id];
                    },
                },
                userPermission: {
                    upsert: async ({ create, update }: { create: Row; update: Row }) => {
                        permissionWrites.push({ ...create, ...update });
                        return update;
                    },
                },
                $executeRawUnsafe: async () => 0,
                // withGuardedUserMutation re-reads the target's role under this
                // query (FOR UPDATE) INSIDE the transaction — the fake has to
                // answer from the same USERS store the pre-tx findUnique above
                // reads, or every guarded write would see a phantom row.
                $queryRawUnsafe: async (_query: string, ...values: unknown[]) => {
                    const id = values[0] as string;
                    const row = USERS[id];
                    return row ? [{ role: row.role }] : [];
                },
            }),
    };
}

const SESSION_SPECIFIER = "next-auth/next";
const AUTH_SPECIFIER = "@/lib/auth";
let sessionEmail = "manager@example.test";
let PUT: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

before(async () => {
    resetDb();
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string
    ) {
        if (id === SESSION_SPECIFIER) return { getServerSession: async () => ({ user: { email: sessionEmail } }) };
        if (id === AUTH_SPECIFIER) return { authOptions: {} };
        if (id === "next/server") {
            // NextResponse and NextRequest are the real thing; only `after` is
            // replaced. It throws outside a Next request scope, and the
            // fire-and-forget work it schedules (crew auto-assign) is not what
            // these cases are about.
            // eslint-disable-next-line prefer-rest-params
            const real = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
            return { ...real, after: () => {} };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let routeModule: { PUT?: unknown };
    try {
        routeModule = await import("../src/app/api/users/[id]/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof routeModule.PUT !== "function") {
        throw new Error(`the require() patch did not apply — PUT is ${typeof routeModule.PUT}`);
    }
    PUT = routeModule.PUT as typeof PUT;
});

function request(targetId: string, body: Record<string, unknown>) {
    return [
        new Request(`https://example.test/api/users/${targetId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: targetId }) },
    ] as const;
}

test("PUT: a manager granting THEMSELVES financialReports is 403, and nothing is written", async () => {
    resetDb();
    sessionEmail = "manager@example.test";
    const res = await PUT(...request("u-manager", { permissions: { financialReports: true } }));
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /your own permissions/);
    assert.deepEqual(permissionWrites, [], "a refusal is not a partial write");
});

test("PUT: a manager granting a CREW MEMBER financialReports is also 403", async () => {
    // The escalation does not have to be aimed at yourself: handing the payroll
    // gate to an account you control is the same thing one step removed.
    resetDb();
    sessionEmail = "manager@example.test";
    const res = await PUT(...request("u-crew", { permissions: { financialReports: true } }));
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /financialReports/);
    assert.deepEqual(permissionWrites, []);
});

test("PUT: a manager promoting themselves to ADMIN is 403", async () => {
    resetDb();
    sessionEmail = "manager@example.test";
    const res = await PUT(...request("u-manager", { userInfo: { role: "ADMIN" } }));
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /change a team member's role/);
    assert.deepEqual(userWrites, []);
    assert.equal(USERS["u-manager"].role, "MANAGER", "still a manager");
});

test("PUT: a manager disabling an ADMIN is 403", async () => {
    resetDb();
    sessionEmail = "manager@example.test";
    const res = await PUT(...request("u-admin", { userInfo: { status: "DISABLED" } }));
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /modify an admin account/);
    assert.deepEqual(userWrites, []);
});

test("PUT: an ADMIN doing all three succeeds — the guard is about authority, not the operation", async () => {
    // THE CONTROL for every 403 above.
    resetDb();
    sessionEmail = "admin@example.test";

    const promote = await PUT(...request("u-manager", { userInfo: { role: "ADMIN" } }));
    assert.equal(promote.status, 200);
    assert.equal(USERS["u-manager"].role, "ADMIN");

    resetDb();
    sessionEmail = "admin@example.test";
    const grant = await PUT(...request("u-crew", { permissions: { financialReports: true } }));
    assert.equal(grant.status, 200);
    assert.deepEqual(permissionWrites, [{ userId: "u-crew", financialReports: true }]);

    resetDb();
    sessionEmail = "admin@example.test";
    const disable = await PUT(...request("u-admin", { userInfo: { status: "DISABLED" } }));
    assert.equal(disable.status, 200);
    assert.equal(USERS["u-admin"].status, "DISABLED");
});

test("PUT: a bogus role is 400, not 403 and not a silent drop", async () => {
    resetDb();
    sessionEmail = "admin@example.test";
    const res = await PUT(...request("u-crew", { userInfo: { role: "SUPERUSER" } }));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /Invalid role: SUPERUSER/);
    assert.deepEqual(userWrites, []);
});

test("PUT: a manager may still disable a crew member — ordinary work is unaffected", async () => {
    resetDb();
    sessionEmail = "manager@example.test";
    const res = await PUT(...request("u-crew", { userInfo: { status: "DISABLED" } }));
    assert.equal(res.status, 200);
    assert.equal(USERS["u-crew"].status, "DISABLED");
});

test("every user-mutating writer routes through the shared guard", () => {
    // The pure tests above prove the RULES; this proves they are the ones every
    // surface asks. A route that grows its own copy is how the four disagreed in
    // the first place.
    //
    // Since round 12 (finding 2), the existing-row writers no longer call
    // checkUserMutation directly — they call withGuardedUserMutation, which is
    // the only thing allowed to call checkUserMutation, and only against a row
    // it has just locked FOR UPDATE inside the same transaction. A route that
    // called checkUserMutation on its own again would be the exact hole this
    // closed: authorizing on a read the write transaction never held.
    const SRC = path.join(__dirname, "..", "src");
    for (const [file, expected] of [
        ["app/api/users/[id]/route.ts", "withGuardedUserMutation("],
        ["app/api/users/route.ts", "checkUserCreate("],
        ["app/api/users/route.ts", "withGuardedUserMutation("],
        ["app/api/manager/employees/[id]/route.ts", "withGuardedUserMutation("],
    ] as const) {
        const source = readFileSync(path.join(SRC, file), "utf8");
        assert.ok(source.includes(expected), `${file} must call ${expected}`);
    }
    // And no route re-implements the authority check itself — that call lives
    // exactly once, inside withGuardedUserMutation.
    for (const file of [
        "app/api/users/[id]/route.ts",
        "app/api/users/route.ts",
        "app/api/manager/employees/[id]/route.ts",
    ] as const) {
        const source = readFileSync(path.join(SRC, file), "utf8");
        assert.ok(
            !/\bcheckUserMutation\(/.test(source),
            `${file} must not call checkUserMutation directly — that authorizes on a read outside the write transaction`
        );
    }
    // And the old hand-rolled copies are gone, so there is nothing left to drift.
    const manager = readFileSync(path.join(SRC, "app/api/manager/employees/[id]/route.ts"), "utf8");
    assert.ok(!/VALID_ROLES/.test(manager), "the local enum set was replaced by the shared one");
    const users = readFileSync(path.join(SRC, "app/api/users/[id]/route.ts"), "utf8");
    assert.ok(!/ALLOWED_PERMISSION_FIELDS/.test(users), "the local permission list was replaced by the shared one");
});

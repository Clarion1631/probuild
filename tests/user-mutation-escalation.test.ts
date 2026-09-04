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
                // withGuardedUserMutation re-reads BOTH the target and the ACTOR
                // under these queries (FOR UPDATE / FOR SHARE) INSIDE the
                // transaction — the fake has to answer from the same USERS store
                // the pre-tx findUnique above reads, or every guarded write would
                // see a phantom row.
                //
                // It returns id, role AND status, because the guard now decides
                // "is this actor still usable" and "is the actor the target"
                // from what it read under the lock (round 14, finding 3). A fake
                // that answered `{ role }` only made `actor.id` undefined, and
                // the self-edit rules silently stopped matching.
                $queryRawUnsafe: async (query: string, ...values: unknown[]) => {
                    const id = values[0] as string;
                    if (/UserPermission/.test(query)) {
                        const row = USERS[id];
                        return row?.permissions ? [row.permissions] : [];
                    }
                    const row = USERS[id];
                    return row ? [{ id: row.id, role: row.role, status: row.status ?? "ACTIVATED" }] : [];
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

// ---------------------------------------------------------------------------
// A RATE-ONLY save is a save (round 13, finding 2)
// ---------------------------------------------------------------------------

test("PUT: a rate-only body WRITES — it used to be a silent 200 that changed nothing", async () => {
    // THE BUG. The condition guarding the whole transaction asked only about
    // `data` (name/role/status/pinCode) and the permission patch. A body of
    // `{ userInfo: { hourlyRate } }` produces an EMPTY `data` and no
    // permissions, so the transaction never opened: the route fell straight
    // through to "fetch updated user" and answered 200 with the OLD rate. The
    // Team page showed a successful save and payroll kept paying the old
    // number.
    resetDb();
    sessionEmail = "admin@example.test";
    const res = await PUT(...request("u-crew", { userInfo: { hourlyRate: "31.50" } }));
    assert.equal(res.status, 200);

    const rateWrite = userWrites.find((write) => "hourlyRate" in write);
    assert.ok(rateWrite, "the rate never reached a writer — this is the no-op bug");
    assert.equal(String(rateWrite!.hourlyRate), "31.5");
    // Through the ONE rate path, so its side effects come with it.
    assert.ok("lastRateSyncAt" in rateWrite!, "the confirmation stamp is part of a rate write");
    assert.deepEqual(rateWrite!.payrollRevision, { increment: 1 });
});

test("PUT: a payType-only body writes too, and an EMPTY body still writes nothing", async () => {
    resetDb();
    sessionEmail = "admin@example.test";
    const payType = await PUT(...request("u-crew", { userInfo: { payType: "HOURLY" } }));
    assert.equal(payType.status, 200);
    assert.ok(
        userWrites.some((write) => write.payType === "HOURLY"),
        "payType is half the Gusto roster predicate — a save that drops it is not a save"
    );

    // THE CONTROL. Widening the condition must not turn every PUT into a write:
    // a body with nothing mutable in it still opens no transaction.
    resetDb();
    const empty = await PUT(...request("u-crew", { userInfo: {} }));
    assert.equal(empty.status, 200);
    assert.deepEqual(userWrites, [], "an empty save is still a no-op");
    assert.deepEqual(permissionWrites, []);
});

test("PUT: a showOnDispatch-only body writes — it was a silent 200 too", async () => {
    // `showOnDispatch` is written INSIDE the guarded closure, because it is
    // derived from the LOCKED target role (a FINANCE account may never be
    // offered as dispatch crew). But a body carrying only that field produced an
    // empty `data`, no permissions and no rate fields — so the transaction never
    // opened and the route answered 200 having changed nothing (round 17, P2):
    // the same silent no-op the rate-only body had in round 13.
    resetDb();
    sessionEmail = "admin@example.test";
    const res = await PUT(...request("u-crew", { userInfo: { showOnDispatch: true } }));
    assert.equal(res.status, 200);
    const write = userWrites.find((entry) => "showOnDispatch" in entry);
    assert.ok(write, "the flag never reached a writer — this is the no-op");
    assert.equal(write!.showOnDispatch, true);
});

test("PUT: showOnDispatch is FORCED false for a FINANCE target, under the lock", async () => {
    // The reason it lives inside the closure: the decision reads the role this
    // transaction locked, not the one the request claimed.
    resetDb();
    sessionEmail = "admin@example.test";
    USERS["u-crew"].role = "FINANCE";
    const res = await PUT(...request("u-crew", { userInfo: { showOnDispatch: true } }));
    assert.equal(res.status, 200);
    const write = userWrites.find((entry) => "showOnDispatch" in entry);
    assert.ok(write);
    assert.equal(write!.showOnDispatch, false, "a FINANCE account is never dispatch crew");
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
        // CREATION goes through the guard too now (round 14, finding 3): it used
        // to call checkUserCreate directly, against the actor read the route
        // took before it opened a transaction, and insert afterwards.
        ["app/api/users/route.ts", "withGuardedUserCreate("],
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
        // Creation too. It called checkUserCreate against the route's own
        // pre-transaction actor read and inserted afterwards, so a manager
        // demoted or disabled in that gap still minted an account (round 14,
        // finding 3).
        assert.ok(
            !/\bcheckUserCreate\(/.test(source),
            `${file} must not call checkUserCreate directly — withGuardedUserCreate runs it against the LOCKED actor`
        );
    }
    // And the old hand-rolled copies are gone, so there is nothing left to drift.
    const manager = readFileSync(path.join(SRC, "app/api/manager/employees/[id]/route.ts"), "utf8");
    assert.ok(!/VALID_ROLES/.test(manager), "the local enum set was replaced by the shared one");
    const users = readFileSync(path.join(SRC, "app/api/users/[id]/route.ts"), "utf8");
    assert.ok(!/ALLOWED_PERMISSION_FIELDS/.test(users), "the local permission list was replaced by the shared one");
});

test("every guarded route hands the guard its RATE payload, and hands the SAME one to the writer", () => {
    // The guard decides the LOCK ORDER — payroll advisory lock before the target
    // row — and it can only decide it from what it is told. A route that passes
    // `data` but not `rateChange` puts the rate writer's own
    // acquirePayrollWriteLock AFTER a row lock this transaction is already
    // holding, which is a deadlock against period creation (round 13,
    // finding 1). tests/payroll-lock-order-db.test.ts proves that on real
    // connections; this proves no route can quietly stop reporting.
    const SRC = path.join(__dirname, "..", "src");
    for (const file of [
        "app/api/users/[id]/route.ts",
        "app/api/users/route.ts",
        "app/api/manager/employees/[id]/route.ts",
    ] as const) {
        const source = readFileSync(path.join(SRC, file), "utf8");
        const call = source.slice(source.indexOf("withGuardedUserMutation("));
        const input = call.slice(0, call.indexOf("async ("));
        assert.match(input, /\brateChange,/, `${file} must tell the guard about the rate payload`);

        // ONE object, built once and used twice. A route that built a second
        // literal for applyRateChangeInTx could answer "does this write rates"
        // differently in the two places, which is the same bug with an extra
        // step.
        assert.match(
            source,
            /applyRateChangeInTx\((\s|\/\/[^\n]*\n)*tx( as never)?,[\s\S]{0,120}?rateChange\s*\)/,
            `${file} must hand the writer the SAME rateChange it handed the guard`
        );
        assert.ok(
            !/applyRateChangeInTx\([\s\S]{0,200}?\{\s*(hourlyRate|burdenRate|payType)\s*:/.test(source),
            `${file} must not build a second rate literal at the call site`
        );
    }
});

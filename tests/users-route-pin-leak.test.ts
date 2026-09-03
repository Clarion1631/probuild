/**
 * Route-level tests for the User-returning handlers in /api/users and
 * /api/users/[id]: none of them may put `User.pinCode` (the bcrypt hash of the
 * time-clock PIN) on the wire. GET /api/users always stripped it and exposed a
 * `hasPin` boolean; POST, and the [id] GET and PUT, returned the raw row. All
 * of them now go through `toSafeUser()` (src/lib/user-safe.ts).
 *
 * Prisma, next-auth, Resend and next/server's after() are faked with the scoped CJS require() patch
 * used across this repo (see tests/takeoff-convert-tax.test.ts for why
 * `mock.module()` is unusable here — CI pins Node 20).
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { toSafeUser } from "../src/lib/user-safe";

type Row = Record<string, any>;

const ADMIN: Row = { id: "admin1", name: "Admin", email: "admin@example.test", role: "ADMIN", status: "ACTIVATED", pinCode: null };
const state: { users: Row[]; session: Row | null } = { users: [], session: null };

function withShape(u: Row, args: Row) {
    if (args.select) {
        const out: Row = {};
        for (const key of Object.keys(args.select)) {
            out[key] = key === "projectAccess" || key === "assignedProjects" ? [] : u[key];
        }
        return out;
    }
    const row: Row = { ...u };
    if (args.include?.permissions) row.permissions = { userId: u.id, autoGrantNewProjects: true };
    if (args.include?.projectAccess) row.projectAccess = [];
    if (args.include?.assignedProjects) row.assignedProjects = [];
    return row;
}

const fakePrisma = {
    user: {
        findUnique: async (args: Row) => {
            const u = args.where.email
                ? state.users.find((x) => x.email === args.where.email)
                : state.users.find((x) => x.id === args.where.id);
            return u ? withShape(u, args) : null;
        },
        findMany: async (args: Row) => state.users.map((u) => withShape(u, args)),
        update: async (args: Row) => {
            const u = state.users.find((x) => x.id === args.where.id);
            if (!u) throw new Error("update: no such user");
            Object.assign(u, args.data);
            return withShape(u, args);
        },
        create: async (args: Row) => {
            const row = { id: `u${state.users.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...args.data };
            state.users.push(row);
            return { ...row };
        },
    },
    userPermission: {
        create: async (args: Row) => ({ userId: args.data.userId, autoGrantNewProjects: false }),
    },
    project: { findMany: async () => [] },
    projectAccess: { createMany: async () => ({ count: 0 }) },
};

let GET_LIST: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let PATCH: (req: Request) => Promise<Response>;
let GET_ONE: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let PUT_ONE: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

before(async () => {
    delete process.env.RESEND_API_KEY;
    const originalRequire = Module.prototype.require;
    const patched = new Set<string>();
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/prisma") { patched.add(id); return { prisma: fakePrisma }; }
        if (id === "@/lib/auth") { patched.add(id); return { authOptions: {} }; }
        if (id === "next-auth/next") { patched.add(id); return { getServerSession: async () => state.session }; }
        if (id === "resend") { patched.add(id); return { Resend: class { emails = { send: async () => ({}) }; } }; }
        if (id === "next/server") {
            // PATCH schedules the crew auto-assign via next's after(), which throws
            // outside a request scope. Keep the real NextResponse; only stub after().
            patched.add(id);
            // eslint-disable-next-line prefer-rest-params
            return { ...(originalRequire.apply(this, arguments as unknown as [string]) as Row), after: () => {} };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let list: Row;
    let one: Row;
    try {
        list = await import("../src/app/api/users/route");
        one = await import("../src/app/api/users/[id]/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    for (const id of ["@/lib/prisma", "@/lib/auth", "next-auth/next", "resend", "next/server"]) {
        if (!patched.has(id)) throw new Error(`users-route-pin-leak.test.ts: the mock of "${id}" never applied — the route would hit the real module`);
    }
    GET_LIST = list.GET;
    POST = list.POST;
    PATCH = list.PATCH;
    GET_ONE = one.GET;
    PUT_ONE = one.PUT;
    assert.equal(typeof GET_LIST, "function", "GET /api/users did not load");
    assert.equal(typeof POST, "function", "POST /api/users did not load");
    assert.equal(typeof PATCH, "function", "PATCH /api/users did not load");
    assert.equal(typeof GET_ONE, "function", "GET /api/users/[id] did not load");
    assert.equal(typeof PUT_ONE, "function", "PUT /api/users/[id] did not load");
});

beforeEach(() => {
    state.users = [{ ...ADMIN }];
    state.session = { user: { email: ADMIN.email } };
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Every string leaf in the JSON body — a hash hidden under a nested key is still a leak. */
function stringLeaves(v: unknown, out: string[] = []): string[] {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => stringLeaves(x, out));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => stringLeaves(x, out));
    return out;
}

async function createUser(pinCode: string | undefined) {
    const res = await POST(new Request("https://example.test/api/users", {
        method: "POST",
        body: JSON.stringify({ name: "New Crew", email: "New@Example.test", role: "FIELD_CREW", pinCode }),
    }));
    return { res, body: await res.json() as Row };
}

test("toSafeUser drops pinCode and reports hasPin", () => {
    assert.deepEqual(toSafeUser({ id: "a", pinCode: "$2a$10$hash" }), { id: "a", hasPin: true });
    assert.deepEqual(toSafeUser({ id: "b", pinCode: null }), { id: "b", hasPin: false });
});

test("POST /api/users 201 body has no pinCode key and hasPin=true when a PIN was set", async () => {
    const { res, body } = await createUser("1234");
    assert.equal(res.status, 201);

    const stored = state.users.find((u) => u.email === "new@example.test");
    assert.ok(stored?.pinCode?.startsWith("$2"), "fixture check: the created row must actually hold a bcrypt hash");

    assert.equal("pinCode" in body, false, `pinCode leaked: ${JSON.stringify(body)}`);
    assert.equal(body.hasPin, true);
    assert.equal(body.id, stored!.id);
    assert.equal(body.email, "new@example.test");
    assert.ok(!stringLeaves(body).includes(stored!.pinCode), "the hash value appeared somewhere in the body");
});

test("POST /api/users 201 body has hasPin=false and no pinCode key when no PIN was set", async () => {
    const { res, body } = await createUser(undefined);
    assert.equal(res.status, 201);
    assert.equal("pinCode" in body, false);
    assert.equal(body.hasPin, false);
});

test("GET /api/users/[id] wraps the user with the same safe shape", async () => {
    const { body: created } = await createUser("1234");
    const res = await GET_ONE(new Request(`https://example.test/api/users/${created.id}`), ctx(created.id));
    assert.equal(res.status, 200);
    const body = await res.json() as Row;
    assert.equal("pinCode" in body.user, false, `pinCode leaked: ${JSON.stringify(body.user)}`);
    assert.equal(body.user.hasPin, true);
    assert.ok(Array.isArray(body.allProjects));
});

test("PUT /api/users/[id] returns the same safe shape", async () => {
    const { body: created } = await createUser("1234");
    const res = await PUT_ONE(new Request(`https://example.test/api/users/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({}),
    }), ctx(created.id));
    assert.equal(res.status, 200);
    const body = await res.json() as Row;
    assert.equal("pinCode" in body, false, `pinCode leaked: ${JSON.stringify(body)}`);
    assert.equal(body.hasPin, true);
});

test("GET /api/users list keeps the safe shape for every row", async () => {
    await createUser("1234");
    const res = await GET_LIST(new Request("https://example.test/api/users"));
    assert.equal(res.status, 200);
    const body = await res.json() as Row[];
    assert.equal(body.length, 2);
    for (const row of body) assert.equal("pinCode" in row, false, `pinCode leaked: ${JSON.stringify(row)}`);
    assert.deepEqual(body.map((r) => r.hasPin).sort(), [false, true]);
});

test("PATCH /api/users returns the safe shape after setting a PIN", async () => {
    const { body: created } = await createUser(undefined);
    const res = await PATCH(new Request("https://example.test/api/users", {
        method: "PATCH",
        body: JSON.stringify({ id: created.id, pinCode: "9999" }),
    }));
    assert.equal(res.status, 200);
    const body = await res.json() as Row;
    assert.equal("pinCode" in body, false, `pinCode leaked: ${JSON.stringify(body)}`);
    assert.equal(body.hasPin, true);
    assert.ok(!stringLeaves(body).some((v) => v.startsWith("$2")), "a bcrypt hash appeared in the body");
});

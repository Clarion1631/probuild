/**
 * POST /api/gusto/employee-mappings, driven as real requests.
 *
 * THE BUG (round 13, finding 3). The validator hand-rolled its own object check
 * and then copied every key into a `{}` literal:
 *
 *     const mappings: Record<string, string> = {};
 *     for (const [userId, gustoId] of entries) mappings[userId] = gustoId;
 *
 * A body of `{"employeeMappings": {"__proto__": "attacker-id"}}` arrives with
 * `__proto__` as an OWN property (JSON.parse does not treat it specially), so
 * that assignment hits the inherited SETTER rather than creating a property.
 * `Object.keys(mappings)` is then empty: the duplicate scan finds nothing, the
 * "are these real user ids" lookup is skipped because there are no ids, and the
 * route saves `employeeMappings: {}` — WIPING the map that decides whose hours
 * are filed under which Gusto employee — while answering `{ success: true }`.
 *
 * Source assertions could not catch that: the old code looked perfectly
 * reasonable. These are requests, and what they assert is what was WRITTEN.
 *
 * No static import of the route or of src/lib/gusto-access: loading either here
 * would pull in the real ./permissions and ./prisma before before() installs
 * its require patch, and the cached copies would then be the ones the route
 * used (the same trap tests/integration-access.test.ts documents).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-gusto-mapping-route";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";

type Viewer = { id: string; role: string; permissions: Record<string, boolean> | null } | null;

let viewer: Viewer = null;
/** Every patch handed to saveGustoSettings. A wipe shows up here as `{}`. */
let saved: Array<{ employeeMappings?: Record<string, string> }> = [];
/** The user ids the validator asked the database about. */
let lookedUp: string[][] = [];
let POST: (req: Request) => Promise<Response>;

/** The team the fake database knows about. */
const KNOWN: Record<string, string> = {
    "u-alice": "FIELD_CREW",
    "u-bob": "MANAGER",
    // A portal CUSTOMER. A real row, so an existence check passed it (round 14,
    // finding 2) and a customer could be mapped to a Gusto employee.
    "u-customer": "CLIENT",
};

before(async () => {
    // Module._load, NOT Module.prototype.require.
    //
    // validateEmployeeMappings reaches its database through
    // `await import("./prisma")` INSIDE the function, at request time. A
    // Module.prototype.require patch does not see that call — the request came
    // back 500 from a real Prisma connection attempt with the patch installed —
    // whereas _load is the single funnel every module resolution goes through.
    // And it stays installed for the WHOLE file rather than being restored
    // after the import, because the call that matters happens later.
    const moduleInternals = Module as unknown as {
        _load(request: string, parent: unknown, isMain: boolean): unknown;
    };
    const originalLoad = moduleInternals._load;
    moduleInternals._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request === "@/lib/permissions" || request === "./permissions") {
            const real = originalLoad.call(this, "@/lib/access-rules", parent, isMain) as Record<string, unknown>;
            // The REAL hasPermission — the gate is exercised, not stubbed.
            return { ...real, getCurrentUserWithPermissions: async () => viewer };
        }
        if (request === "@/lib/integration-store" || request === "./integration-store") {
            return {
                saveGustoSettings: async (patch: { employeeMappings?: Record<string, string> }) => {
                    saved.push(patch);
                },
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    const routeModule = (await import("../src/app/api/gusto/employee-mappings/route")) as { POST?: unknown };
    if (typeof routeModule.POST !== "function") {
        throw new Error(`the module patch did not apply — POST is ${typeof routeModule.POST}`);
    }
    POST = routeModule.POST as typeof POST;

    // THE DATABASE. validateEmployeeMappings reaches it with
    // `await import("./prisma")` INSIDE the function body, and neither a
    // Module.prototype.require patch nor a Module._load patch intercepts that
    // call — both were tried and the request came back 500 from a real
    // connection attempt each time.
    //
    // src/lib/prisma.ts exports a Proxy whose every property read resolves
    // `globalThis.prisma`, creating it on first use. Setting that global first
    // is therefore the one substitution that works no matter which module
    // record the dynamic import lands on, and no real client is ever built.
    (globalThis as unknown as { prisma: unknown }).prisma = {
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
                lookedUp.push(where.id.in);
                // The ROLE comes back with the row. An existence-only stub could
                // not tell a customer from an employee, which is exactly what
                // the validator could not do either (round 14, finding 2).
                return where.id.in.filter((id) => id in KNOWN).map((id) => ({ id, role: KNOWN[id] }));
            },
        },
    };
});

/** A body built from JSON TEXT, so `__proto__` arrives as an own property. */
function request(json: string) {
    return new Request("https://example.test/api/gusto/employee-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: json,
    });
}

const admin: Viewer = { id: "u-admin", role: "ADMIN", permissions: null };

test("a __proto__ key is 400 and NOTHING is saved — it used to wipe the map", async () => {
    viewer = admin;
    for (const key of ["__proto__", "constructor", "prototype"]) {
        saved = [];
        const res = await POST(request(`{"employeeMappings": {"${key}": "attacker-gusto-id"}}`));
        assert.equal(res.status, 400, key);
        // THE point. Before the fix this was `[{ employeeMappings: {} }]` with a
        // 200 beside it: every real mapping replaced by nothing.
        assert.deepEqual(saved, [], `${key} must never reach saveGustoSettings`);
    }
});

test("a __proto__ key mixed in with REAL mappings is refused too", async () => {
    // The dangerous shape in practice: a body that looks like an ordinary save
    // and quietly carries one extra key. Before the fix the real entries were
    // kept and only the prototype assignment vanished — but the wipe above is
    // what made it a P1, and both are the same missing check.
    viewer = admin;
    saved = [];
    const res = await POST(request(`{"employeeMappings": {"u-alice": "GUSTO-1", "__proto__": "x"}}`));
    assert.equal(res.status, 400);
    assert.deepEqual(saved, []);
});

test("Object.prototype is not polluted by any of it", () => {
    // Belt and braces: the refusal is the guarantee, but if a `__proto__` value
    // ever did land, everything in the process inherits it.
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test("an ordinary map still saves — the control", async () => {
    // Without this every refusal above would pass just as well on a route that
    // says no to everything.
    viewer = admin;
    saved = [];
    lookedUp = [];
    const res = await POST(request(`{"employeeMappings": {"u-alice": "GUSTO-1", "u-bob": ""}}`));
    assert.equal(res.status, 200);
    assert.equal(saved.length, 1);
    assert.deepEqual(Object.entries(saved[0].employeeMappings as Record<string, string>), [
        ["u-alice", "GUSTO-1"],
        ["u-bob", ""],
    ]);
    // The saved map carries no prototype either — a null-prototype object is
    // what the validator now builds.
    assert.equal(Object.getPrototypeOf(saved[0].employeeMappings), null);
    // And the keys really were checked against the roster.
    assert.deepEqual(lookedUp, [["u-alice", "u-bob"]]);
});

test("a CUSTOMER cannot be mapped to a Gusto employee — existence was not enough", async () => {
    // THE HOLE (round 14, finding 2). `u-customer` is a real row: a portal
    // CLIENT account, made by the invite flow when a homeowner signs in to see
    // their own project. The validator only asked whether the id EXISTED, so
    // that row passed and a customer was written into the map deciding whose
    // hours are filed under which Gusto employee. Round 8 closed the same hole
    // in the rates panel, the CSV importer, the rate writer and the export
    // roster; this was the fifth surface.
    viewer = admin;
    saved = [];
    const res = await POST(request(`{"employeeMappings": {"u-customer": "GUSTO-9"}}`));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    // A SPECIFIC message: "that id does not exist" and "that account is a
    // customer" are different problems with different fixes.
    assert.match(body.error, /not employees/);
    assert.match(body.error, /u-customer/);
    assert.deepEqual(saved, [], "a refusal is not a partial write");

    // Mixed in with real staff, the whole save is refused rather than the
    // customer being quietly dropped — a silently shortened map is a mapping
    // somebody thinks they saved.
    saved = [];
    const mixed = await POST(request(`{"employeeMappings": {"u-alice": "GUSTO-1", "u-customer": "GUSTO-2"}}`));
    assert.equal(mixed.status, 400);
    assert.deepEqual(saved, []);
});

test("the Gusto settings page offers only staff in its picker", () => {
    // The route is the guarantee; this is the surface that feeds it. A page
    // still listing customers invites the refusal above on every save.
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "settings", "integrations", "gusto", "page.tsx"),
        "utf8"
    );
    assert.match(source, /payrollEligibleUserWhere\(\)/, "the page must compose the shared predicate");
    // Composed INTO the user query, not merely imported.
    assert.match(source, /where: \{[\s\S]{0,160}?\.\.\.payrollEligibleUserWhere\(\)/);
    // And it is the shared one, not a local role list.
    assert.ok(!/role:\s*\{\s*in:\s*\[/.test(source), "no hand-rolled role list — that is how five surfaces disagreed");
});

test("an unknown user id is 400, and a FIELD_CREW caller never gets that far", async () => {
    viewer = admin;
    saved = [];
    const unknown = await POST(request(`{"employeeMappings": {"u-nobody": "GUSTO-9"}}`));
    assert.equal(unknown.status, 400);
    assert.deepEqual(saved, []);

    // The round-10 gate, still holding: the map decides whose hours are filed
    // under which Gusto employee, so it is not a crew screen.
    viewer = { id: "u-crew", role: "FIELD_CREW", permissions: null };
    saved = [];
    lookedUp = [];
    const forbidden = await POST(request(`{"employeeMappings": {"u-alice": "GUSTO-1"}}`));
    assert.equal(forbidden.status, 403);
    assert.deepEqual(saved, []);
    assert.deepEqual(lookedUp, [], "a refused caller does not even reach the roster lookup");
});

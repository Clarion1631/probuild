/**
 * WHO MAY REWIRE AN INTEGRATION.
 *
 * The hole (round 10, finding 2). /api/quickbooks/gl-mappings had no role check
 * of any kind. The proxy proves a signed-in staff session and nothing more, so
 * ANY active account — FIELD_CREW included — could POST a whole new
 * cost-code -> GL-account map and silently re-file every synced invoice line
 * into an account of their choosing. /api/quickbooks/auth, /callback and /sync
 * were open the same way: start an OAuth flow, complete a callback that writes
 * the company access tokens, or push documents into the books.
 *
 * And the body check was `typeof glMappings !== "object"`, which is:
 *   - FALSE for `null`  — so a null reached saveQBSettings and wiped the map;
 *   - FALSE for arrays  — so an array was stored where an object belongs;
 *   - FALSE for a body carrying `__proto__` as an own property.
 *
 * The gate is now the same expression the Gusto half already used (ADMIN or
 * financialReports), shared from src/lib/integration-access.ts so the two
 * cannot drift, and the body must be a bounded plain object.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

// NOT a static import. Loading src/lib/integration-access here would pull in the
// real ./permissions before before() installs its require patch, and the route
// under test would then reuse that cached module — the gate would be the real
// one, calling Next's headers() outside a request scope.
type Validate = typeof import("../src/lib/integration-access");
const guard = async (): Promise<Validate> => import("../src/lib/integration-access");

process.env.NEXTAUTH_SECRET ??= "test-secret-for-integration-access";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";

// ---------------------------------------------------------------------------
// The body validator
// ---------------------------------------------------------------------------

test("null, arrays and non-objects are refused — the shapes `typeof` called an object", async () => {
    const { validateStringMap } = await guard();
    for (const bad of [null, [], ["a"], 42, "nope", true, undefined]) {
        const result = validateStringMap(bad, "glMappings");
        assert.equal(result.ok, false, JSON.stringify(bad ?? null));
        assert.match((result as { error: string }).error, /glMappings must be/);
    }
    // The control: `typeof` really did wave the first two through, which is why
    // a null could wipe the map.
    assert.equal(typeof null, "object");
    assert.equal(typeof [], "object");
});

test("a prototype-polluted body is refused, and so is a non-plain object", async () => {
    const { validateStringMap } = await guard();
    // JSON.parse produces `__proto__` as an OWN property, so this arrives as an
    // ordinary key rather than as an assignment to the prototype — and would
    // have been merged straight into the encrypted settings document.
    const polluted = JSON.parse('{"__proto__": "x", "cc-1": "4000 Cost of Goods"}');
    const result = validateStringMap(polluted, "glMappings");
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /__proto__/);

    // A prototype-less object is not an attack, but it is not a shape this
    // document should carry either.
    assert.equal(validateStringMap(Object.create(null), "glMappings").ok, false);
    class Mapping {}
    assert.equal(validateStringMap(new Mapping(), "glMappings").ok, false);
});

test("keys and values are bounded, and non-string values are refused", async () => {
    const { validateStringMap, DEFAULT_STRING_MAP_LIMITS } = await guard();
    const limits = DEFAULT_STRING_MAP_LIMITS;
    const tooMany = Object.fromEntries(
        Array.from({ length: limits.maxKeys + 1 }, (_, i) => [`cc-${i}`, "4000"])
    );
    assert.match((validateStringMap(tooMany, "glMappings") as { error: string }).error, /too many entries/);
    assert.equal(validateStringMap({ ["k".repeat(limits.maxKeyLength + 1)]: "4000" }, "glMappings").ok, false);
    assert.equal(validateStringMap({ "cc-1": "v".repeat(limits.maxValueLength + 1) }, "glMappings").ok, false);
    assert.equal(validateStringMap({ "cc-1": 4000 }, "glMappings").ok, false);
    assert.equal(validateStringMap({ "": "4000" }, "glMappings").ok, false);
});

test("a real map is accepted, and comes back as a plain copy", async () => {
    const { validateStringMap } = await guard();
    // THE CONTROL. Without it every refusal above could be a validator that
    // simply says no to everything.
    const result = validateStringMap({ "cc-1": "4000 Cost of Goods", "cc-2": "" }, "glMappings");
    assert.equal(result.ok, true);
    assert.deepEqual((result as { map: Record<string, string> }).map, {
        "cc-1": "4000 Cost of Goods",
        "cc-2": "",
    });
    assert.deepEqual(validateStringMap({}, "glMappings"), { ok: true, map: {} });
});

// ---------------------------------------------------------------------------
// The gate, through the real route
// ---------------------------------------------------------------------------

type Viewer = { id: string; role: string; permissions: Record<string, boolean> | null } | null;

let viewer: Viewer = null;
let saved: unknown[] = [];
let POST: (req: Request) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string
    ) {
        // BOTH specifiers: the route imports the gate from
        // "@/lib/integration-access", which imports "./permissions"
        // relatively — patching only the aliased form missed it entirely
        // and the real module then called Next's headers() outside a
        // request scope.
        if (id === "@/lib/permissions" || id === "./permissions") {
            // eslint-disable-next-line prefer-rest-params
            const real = originalRequire.apply(this, ["@/lib/access-rules"] as unknown as [string]) as Record<
                string,
                unknown
            >;
            // The REAL hasPermission — the gate has to be exercised, not stubbed.
            return { ...real, getCurrentUserWithPermissions: async () => viewer };
        }
        if (id === "@/lib/integration-store") {
            return {
                saveQBSettings: async (patch: unknown) => {
                    saved.push(patch);
                },
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let routeModule: { POST?: unknown };
    try {
        routeModule = await import("../src/app/api/quickbooks/gl-mappings/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof routeModule.POST !== "function") {
        throw new Error(`the require() patch did not apply — POST is ${typeof routeModule.POST}`);
    }
    POST = routeModule.POST as typeof POST;
});

function request(body: unknown) {
    return new Request("https://example.test/api/quickbooks/gl-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

test("a FIELD_CREW member is 403, and nothing is written", async () => {
    saved = [];
    viewer = { id: "u-crew", role: "FIELD_CREW", permissions: null };
    const res = await POST(request({ glMappings: { "cc-1": "4000" } }));
    assert.equal(res.status, 403);
    assert.deepEqual(saved, [], "a refusal is not a partial write");
});

test("no session at all is 401", async () => {
    saved = [];
    viewer = null;
    const res = await POST(request({ glMappings: {} }));
    assert.equal(res.status, 401);
    assert.deepEqual(saved, []);
});

test("an ADMIN with a valid map is 200 and the map is saved", async () => {
    // THE CONTROL for both refusals above.
    saved = [];
    viewer = { id: "u-admin", role: "ADMIN", permissions: null };
    const res = await POST(request({ glMappings: { "cc-1": "4000 Cost of Goods" } }));
    assert.equal(res.status, 200);
    assert.deepEqual(saved, [{ glMappings: { "cc-1": "4000 Cost of Goods" } }]);
});

test("a FINANCE member with financialReports is allowed — the gate is the permission, not the role name", async () => {
    saved = [];
    viewer = { id: "u-finance", role: "FINANCE", permissions: { financialReports: true } };
    const res = await POST(request({ glMappings: { "cc-1": "4000" } }));
    assert.equal(res.status, 200);
    assert.equal(saved.length, 1);

    // ...and the same person WITHOUT it is refused, so the permission is
    // actually being read rather than the role being waved through.
    saved = [];
    viewer = { id: "u-finance", role: "FINANCE", permissions: { financialReports: false } };
    assert.equal((await POST(request({ glMappings: {} }))).status, 403);
    assert.deepEqual(saved, []);
});

test("an authorized caller sending null, an array or __proto__ gets 400, not a write", async () => {
    viewer = { id: "u-admin", role: "ADMIN", permissions: null };
    for (const bad of [null, ["a"], JSON.parse('{"__proto__": "x"}')]) {
        saved = [];
        const res = await POST(request({ glMappings: bad }));
        assert.equal(res.status, 400, JSON.stringify(bad));
        assert.deepEqual(saved, [], "a 400 must never reach saveQBSettings");
    }
});

test("every integration-settings route asks the shared gate", () => {
    // The routes were found by grepping for the settings writers; this is what
    // keeps a new one from shipping without the question being asked.
    const SRC = path.join(__dirname, "..", "src");
    for (const file of [
        "app/api/quickbooks/gl-mappings/route.ts",
        "app/api/quickbooks/auth/route.ts",
        "app/api/quickbooks/callback/route.ts",
        "app/api/quickbooks/sync/route.ts",
    ]) {
        const source = readFileSync(path.join(SRC, file), "utf8");
        assert.match(source, /requireIntegrationAccess\(\)/, `${file} must ask the shared gate`);
    }
    // The Gusto half delegates to the same function rather than keeping a copy.
    const gusto = readFileSync(path.join(SRC, "lib", "gusto-access.ts"), "utf8");
    assert.match(gusto, /return requireIntegrationAccess\(\);/);
});

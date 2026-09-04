/**
 * Saving Gusto / QuickBooks settings: failures must be LOUD, and two savers
 * must not clobber each other.
 *
 * Both integrations share ONE encrypted row, so every save rewrites the whole
 * document including the other integration's fields. Two bugs lived in that:
 *
 *  1. `saveGustoSettings` caught and discarded every database error. The mapping
 *     endpoint went on to answer `{ success: true }` and the OAuth callback
 *     redirected to `?success=1`, so a write that never landed looked saved. The
 *     map in question decides whose hours are filed under which Gusto employee,
 *     and the payroll export consumes it. The same suppression sat on the READ
 *     path, where it was worse still: an unreachable database returned `{}`,
 *     which reads as "nothing is connected" — the Gusto export would have built
 *     a CSV with every gustoEmployeeId blank, hashed it, and been ready to
 *     freeze a pay period around it.
 *
 *  2. Read-then-upsert with no lock loses one of two concurrent writes: both
 *     read the same blob, both merge their own patch into it, and the second
 *     upsert overwrites the first with a document derived from a stale read. A
 *     Gusto OAuth callback next to a QuickBooks token refresh could silently
 *     disconnect QuickBooks.
 *
 * The prisma singleton in src/lib/prisma.ts is a lazy Proxy over
 * `globalThis.prisma`, so pre-populating that global substitutes the client
 * with no module mocking and no PrismaClient ever being constructed. The one
 * thing that DOES need interception is the route's auth gate, and only the gate:
 * the route below runs the REAL saveGustoSettings against a failing client, so
 * what is being tested is the actual propagation, not a stub of it.
 *
 * That PostgreSQL really serialises two savers is a separate, two-real-connection
 * proof in tests/payroll-settings-lock-db.test.ts.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import Module from "node:module";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-integration-store-writes";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";

const SOURCE = readFileSync(path.join(__dirname, "..", "src", "lib", "integration-store.ts"), "utf8");

type Recorded = string[];

/** Fake tx client with just the surface updateIntegrationSettings uses. */
function fakeTx(recorded: Recorded, stored: { settings: string | null }) {
    return {
        $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
            recorded.push(`exec:${sql.replace(/\s+/g, " ").trim()}|${args.join(",")}`);
            return 1;
        },
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
            recorded.push(`query:${sql.replace(/\s+/g, " ").trim()}|${args.join(",")}`);
            return [];
        },
        integration: {
            findUnique: async () => {
                recorded.push("read");
                return stored.settings === null ? null : { id: "system_settings", settings: stored.settings };
            },
            upsert: async (args: { create: { settings: string }; update: { settings: string } }) => {
                recorded.push("upsert");
                stored.settings = args.update.settings;
                return { id: "system_settings", settings: stored.settings };
            },
        },
    };
}

function installWorkingClient(recorded: Recorded, stored: { settings: string | null }) {
    (globalThis as Record<string, unknown>).prisma = {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx(recorded, stored)),
    };
}

function installFailingClient(message: string) {
    (globalThis as Record<string, unknown>).prisma = {
        $transaction: async () => {
            throw new Error(message);
        },
        integration: {
            findUnique: async () => {
                throw new Error(message);
            },
        },
    };
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test("nothing on the write path swallows an error any more", () => {
    // The old `catch (err) { console.error(...) }` around the upsert, and the
    // one around the read, are both gone. `decryptOrReset` keeps its catch on
    // purpose — an undecryptable blob (rotated key) is a different question from
    // an unreachable database, and treating it as fatal would brick every save.
    const catches = [...SOURCE.matchAll(/catch\s*\(/g)].length;
    assert.equal(catches, 1, "decryptOrReset's catch is the only one that belongs in this file");
    assert.ok(SOURCE.includes("function decryptOrReset"), "and it is the one on decryptOrReset");

    // The dead `writeSettings` helper — unexported, unreferenced, and the
    // literal error-suppressing writer this finding is about — is gone rather
    // than left as a template for the next caller.
    assert.ok(!SOURCE.includes("writeSettings"), "the suppressing writer must not survive as dead code");
});

test("both savers go through the one serialized read-modify-write", () => {
    for (const saver of ["saveQBSettings", "saveGustoSettings"]) {
        const body = SOURCE.slice(SOURCE.indexOf(`export async function ${saver}`));
        assert.match(
            body.slice(0, 400),
            /updateIntegrationSettings\(/,
            `${saver} must not hand-roll its own read-then-upsert`
        );
    }
    // The lock is taken BEFORE the read, or the read it protects is outside the
    // critical section and the merge is computed from a stale blob. Anchored on
    // the STATEMENTS, not on bare substrings — the doc comments above name both
    // lock kinds and would otherwise satisfy an index comparison on their own.
    const lock = SOURCE.indexOf("SELECT pg_advisory_xact_lock(hashtext($1))");
    const forUpdate = SOURCE.indexOf('SELECT "id" FROM "Integration" WHERE "id" = $1 FOR UPDATE');
    const read = SOURCE.indexOf("const settings = await readSettings(tx);");
    assert.ok(lock > 0, "the advisory lock statement must exist");
    assert.ok(forUpdate > lock, "the row lock comes after the advisory lock");
    assert.ok(read > forUpdate, "and the read comes after both");
    // Which of the two is load-bearing, measured rather than assumed: deleting
    // the advisory lock breaks "a save WAITS for the integration advisory lock"
    // in tests/payroll-settings-lock-db.test.ts; deleting the FOR UPDATE breaks
    // nothing there, because the upsert already conflicts with the export's FOR
    // SHARE. The row lock is defence in depth against a writer that bypasses
    // this function — pinned here so it cannot be dropped as "unused".
});

// ---------------------------------------------------------------------------
// Behaviour: the store
// ---------------------------------------------------------------------------

test("a save takes the advisory lock and the row lock before it reads, then writes", async () => {
    const { saveGustoSettings } = await import("../src/lib/integration-store");
    const recorded: Recorded = [];
    const stored = { settings: null as string | null };
    installWorkingClient(recorded, stored);

    await saveGustoSettings({ connected: true, employeeMappings: { "u-1": "GUSTO-1" } });

    assert.deepEqual(
        recorded,
        [
            "exec:SELECT pg_advisory_xact_lock(hashtext($1))|integration:system_settings",
            'query:SELECT "id" FROM "Integration" WHERE "id" = $1 FOR UPDATE|system_settings',
            "read",
            "upsert",
        ],
        "lock (covers the row's absence), row lock, read, write — in that order"
    );
    assert.ok(stored.settings, "and the blob was persisted");
});

test("a Gusto save preserves QuickBooks' fields, and the reverse", async () => {
    const { saveGustoSettings, saveQBSettings, getIntegrationSettings } = await import(
        "../src/lib/integration-store"
    );
    const recorded: Recorded = [];
    const stored = { settings: null as string | null };
    installWorkingClient(recorded, stored);

    await saveQBSettings({ connected: true, realmId: "realm-9" });
    await saveGustoSettings({ connected: true, companyId: "co-7" });

    // Read back through the same fake client, so this is the persisted document.
    (globalThis as Record<string, unknown>).prisma = {
        integration: { findUnique: async () => ({ id: "system_settings", settings: stored.settings }) },
    };
    const settings = await getIntegrationSettings();
    assert.equal(settings.quickbooks?.realmId, "realm-9", "the Gusto save must not drop QuickBooks");
    assert.equal(settings.gusto?.companyId, "co-7");
});

test("a database failure REJECTS instead of reporting a save that never happened", async () => {
    const { saveGustoSettings, saveQBSettings, getGustoSettings, getQBSettings } = await import(
        "../src/lib/integration-store"
    );
    installFailingClient("terminating connection due to administrator command");

    await assert.rejects(() => saveGustoSettings({ employeeMappings: { "u-1": "G-1" } }), /terminating connection/);
    await assert.rejects(() => saveQBSettings({ realmId: "realm-9" }), /terminating connection/);

    // And the READ path: an unreachable database must not be reported as
    // "nothing is connected" — that is the answer that would have let the
    // payroll export hash a CSV with every Gusto id blank.
    await assert.rejects(() => getGustoSettings(), /terminating connection/);
    await assert.rejects(() => getQBSettings(), /terminating connection/);
});

// ---------------------------------------------------------------------------
// Behaviour: the endpoint
// ---------------------------------------------------------------------------

// The literal specifier the route uses for its own import. Keyed on that exact
// string, not on any path this test computes — see
// tests/takeoff-convert-tax.test.ts's header for why (node:test's
// `mock.module()` corrupts the require chain on the Node 20 that CI pins).
const GUSTO_ACCESS_SPECIFIER = "@/lib/gusto-access";

let POST: (req: Request) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    let patchHit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string
    ) {
        // eslint-disable-next-line prefer-rest-params
        const real = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
        if (id !== GUSTO_ACCESS_SPECIFIER) return real;
        patchHit = true;
        // ONLY the session gate is replaced. validateEmployeeMappings stays
        // real, and so does everything downstream of it — the point of this
        // test is that the REAL saveGustoSettings failing produces a 500.
        return { ...real, requireGustoAccess: async () => ({ viewer: { id: "u-admin", role: "ADMIN" } }) };
    } as typeof Module.prototype.require;

    let routeModule: { POST?: unknown };
    try {
        routeModule = await import("../src/app/api/gusto/employee-mappings/route");
    } finally {
        Module.prototype.require = originalRequire;
    }

    if (typeof routeModule.POST !== "function") {
        throw new Error(
            `integration-store-writes.test.ts: the mock of "${GUSTO_ACCESS_SPECIFIER}" did not apply — ` +
                `POST is ${typeof routeModule.POST}, and the require() patch ` +
                `${patchHit ? "WAS" : "was NOT"} hit. If the route's own import specifier resolves to ` +
                `something other than that literal string on this Node/tsx combination, update ` +
                `GUSTO_ACCESS_SPECIFIER to match.`
        );
    }
    POST = routeModule.POST as typeof POST;
});

function mappingRequest(mappings: Record<string, string>) {
    return new Request("https://example.test/api/gusto/employee-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // An EMPTY map is validated without a database round trip (see
        // tests/gusto-access.test.ts), so the only thing that can fail below is
        // the save itself — which is what this is measuring.
        body: JSON.stringify({ employeeMappings: mappings }),
    });
}

test("the mapping endpoint answers 500 — never `success` — when the save cannot persist", async () => {
    installFailingClient("terminating connection due to administrator command");

    const res = await POST(mappingRequest({}));
    assert.equal(res.status, 500, "a failed save must not be reported as a successful one");
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.success, undefined, "no false success anywhere in the body");
    assert.match(String(body.error), /Could not save/);
    // The raw driver message is internal detail, not something the caller acts on.
    assert.ok(!String(body.error).includes("terminating connection"), "the database error text is not echoed");
});

test("and 200 when it does persist — so the 500 above comes from the failure, not the harness", async () => {
    const recorded: Recorded = [];
    installWorkingClient(recorded, { settings: null });

    const res = await POST(mappingRequest({}));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.ok(recorded.includes("upsert"), "the control really did write");
});

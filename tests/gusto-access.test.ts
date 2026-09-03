/**
 * Who may touch the Gusto integration (review round 10, item 1 — a P0).
 *
 * /api/gusto/employee-mappings, /api/gusto/auth and /api/gusto/callback shipped
 * with NO role check. The proxy's session gate was the only thing in front of
 * them, so any signed-in account — FIELD_CREW included — could rewrite the map
 * deciding whose hours are filed under which Gusto employee (which the payroll
 * export now consumes), or run an OAuth flow whose callback writes access
 * tokens into the integration settings.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { findDuplicateGustoId, validateEmployeeMappings } from "../src/lib/gusto-access";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-gusto-access-tests";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const ROUTES = ["employee-mappings", "auth", "callback"];

test("every Gusto route is gated on ADMIN or financialReports", () => {
    for (const route of ROUTES) {
        const source = readFileSync(
            path.join(__dirname, "..", "src", "app", "api", "gusto", route, "route.ts"),
            "utf8"
        );
        assert.match(source, /requireGustoAccess\(\)/, `${route} must be gated`);
        // The gate has to actually short-circuit, not just be called.
        assert.match(source, /if \("response" in gate\) return gate\.response;/, route);
    }
});

test("the gate is EXACTLY the payroll gate used everywhere else in this phase", () => {
    // Round 10: the expression moved to src/lib/integration-access.ts and the
    // Gusto module now DELEGATES to it, because the QuickBooks half of the
    // integration settings had no gate at all and giving it a second copy of
    // this rule is how the two would come to disagree about who may act.
    const gusto = readFileSync(path.join(__dirname, "..", "src", "lib", "gusto-access.ts"), "utf8");
    assert.match(gusto, /return requireIntegrationAccess\(\);/);
    assert.match(gusto, /return canAccessIntegrations\(\);/);
    assert.ok(
        !/hasPermission\(user, "financialReports"\)/.test(gusto),
        "no second copy of the rule may survive here"
    );

    // ...and the shared one composes the ONE financial predicate.
    //
    // It used to spell out `role !== "ADMIN" && !hasPermission(...)`, which
    // authorized any role carrying the permission — including a portal CLIENT
    // an admin had ticked it on (round 15, finding 1). The staff half now lives
    // in src/lib/financial-access.ts with every other gate on this surface.
    const shared = readFileSync(path.join(__dirname, "..", "src", "lib", "integration-access.ts"), "utf8");
    assert.match(shared, /canActOnFinancials\(user\)/);
    assert.ok(
        !/hasPermission\(user, "financialReports"\)/.test(shared),
        "the permission-only expression must not survive here either"
    );
    assert.match(shared, /status: 401/);
    assert.match(shared, /status: 403/);
});

test("the settings page is gated too, not just the routes", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "settings", "integrations", "gusto", "page.tsx"),
        "utf8"
    );
    assert.match(source, /canAccessGusto\(\)/);
    assert.match(source, /Access Denied/);
});

test("mapping payloads that are not an object are refused", async () => {
    for (const bad of [null, undefined, "nope", 42, [], true]) {
        const result = await validateEmployeeMappings(bad);
        assert.equal(result.ok, false, JSON.stringify(bad));
    }
});

test("Gusto employee ids are bounded and shape-checked", async () => {
    // Values are opaque to us, but they still end up in a CSV column and an
    // integration record — unbounded free text does not belong in either.
    const tooLong = await validateEmployeeMappings({ u1: "x".repeat(65) });
    assert.equal(tooLong.ok, false);
    const weird = await validateEmployeeMappings({ u1: "has space" });
    assert.equal(weird.ok, false);
    const notString = await validateEmployeeMappings({ u1: 12345 });
    assert.equal(notString.ok, false);

    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 501; i += 1) tooMany[`u${i}`] = "g";
    assert.equal((await validateEmployeeMappings(tooMany)).ok, false);
});

test("an empty map needs no database round trip and is accepted", async () => {
    // Clearing every mapping is legitimate, and must not require a user lookup.
    const result = await validateEmployeeMappings({});
    assert.equal(result.ok, true);
    const mappings = (result as { mappings: Record<string, string> }).mappings;
    assert.deepEqual(Object.keys(mappings), []);
    // NULL prototype — see the __proto__ case below. deepEqual is
    // prototype-aware, so this cannot be written as `{ ok: true, mappings: {} }`.
    assert.equal(Object.getPrototypeOf(mappings), null);
});

test("a __proto__ key is REFUSED — it used to wipe every mapping", async () => {
    // THE BUG (round 13, finding 3). `mappings[userId] = gustoId` on a `{}`
    // literal with userId === "__proto__" hits the inherited SETTER instead of
    // creating a property. Object.keys is then empty, the duplicate scan sees
    // nothing, the "are these real user ids" lookup is skipped because there are
    // no ids, and the route saves `employeeMappings: {}` — clearing the map that
    // decides whose hours are filed under which Gusto employee, and answering
    // `{ success: true }` while doing it.
    //
    // JSON.parse, not an object literal: a literal `{ __proto__: ... }` sets the
    // prototype at parse time, which is a different thing entirely and would not
    // reproduce the bug.
    for (const key of ["__proto__", "constructor", "prototype"]) {
        const payload = JSON.parse(`{"${key}": "attacker-gusto-id"}`);
        const result = await validateEmployeeMappings(payload);
        assert.equal(result.ok, false, key);
        assert.ok((result as { error: string }).error.includes(key), key);
    }

    // A payload that is an object but NOT a plain one is refused too, so a
    // crafted prototype cannot ride in on the container itself.
    const exotic = Object.create({ inherited: "x" });
    exotic["u1"] = "GUSTO-1";
    assert.equal((await validateEmployeeMappings(exotic)).ok, false);
});

test("a well-formed map gets PAST the shape check — the control", async () => {
    // Without this the refusals above could be a validator that says no to
    // everything. Two members mapped to the same Gusto id is caught by the
    // DUPLICATE scan, which runs only after every key and value has been
    // accepted — so reaching that message proves ordinary keys still pass. (It
    // also needs no database, unlike the real-user-ids lookup after it.)
    const result = await validateEmployeeMappings({ u1: "GUSTO-1", u2: "GUSTO-1" });
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /same Gusto employee/);
});

test("mapping keys are validated against real users", () => {
    // A key that is not a user id is either a typo that silently does nothing,
    // or an attempt to plant a mapping for an id that does not exist yet.
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "gusto-access.ts"), "utf8");
    const fn = source.slice(source.indexOf("export async function validateEmployeeMappings"));
    assert.match(fn, /prisma\.user\.findMany\(\{ where: \{ id: \{ in: ids \} \}/);
    assert.match(fn, /These are not team members/);
});

test("two team members cannot be mapped to the SAME Gusto employee", async () => {
    // One person's hours would be filed under another's: the export would emit
    // two summary rows for one Gusto employee, and Gusto takes the last one.
    const dupe = await validateEmployeeMappings({ u1: "GUSTO-1", u2: "GUSTO-1" });
    assert.equal(dupe.ok, false);
    assert.match((dupe as { error: string }).error, /same Gusto employee/);

    // Distinct ids are fine, and CLEARING a mapping (empty value) is not a
    // collision no matter how many are cleared at once. Checked on the pure
    // scan so it needs no database.
    assert.equal(findDuplicateGustoId({ u1: "", u2: "", u3: "GUSTO-2" }), null);
    assert.equal(findDuplicateGustoId({ u1: "GUSTO-1", u2: "GUSTO-2" }), null);
    assert.equal(findDuplicateGustoId({ u1: "GUSTO-1", u2: "GUSTO-1" }), "GUSTO-1");
});

test("the mapping route runs the validator before it saves anything", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "gusto", "employee-mappings", "route.ts"),
        "utf8"
    );
    assert.match(source, /const validated = await validateEmployeeMappings\(employeeMappings\);/);
    assert.match(source, /if \(!validated\.ok\)/);
    // Saves the VALIDATED map, not the raw body.
    assert.match(source, /saveGustoSettings\(\{ employeeMappings: validated\.mappings \}\)/);
    assert.ok(
        source.indexOf("validateEmployeeMappings(") < source.indexOf("saveGustoSettings("),
        "validate before saving"
    );
});

/**
 * Unit tests for toMobileCrew()/firstName(), the pure helpers shaping
 * TaskAssignment rows into the mobile crew list shared by
 * GET /api/mobile/schedule/today and GET /api/mobile/tasks/:id.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { toMobileCrew, firstName } from "../src/lib/mobile-task-crew";

test("lead sorts before assigned regardless of input order", () => {
    const crew = toMobileCrew([
        { role: "assigned", user: { id: "u1", name: "Alice Jones" } },
        { role: "lead", user: { id: "u2", name: "Zed Smith" } },
    ]);
    assert.deepEqual(crew, [
        { id: "u2", name: "Zed", role: "lead" },
        { id: "u1", name: "Alice", role: "assigned" },
    ]);
});

test("within the same role, sorts alphabetically by first name", () => {
    const crew = toMobileCrew([
        { role: "assigned", user: { id: "u1", name: "Zed Smith" } },
        { role: "assigned", user: { id: "u2", name: "Alice Jones" } },
    ]);
    assert.deepEqual(crew.map(c => c.name), ["Alice", "Zed"]);
});

test("firstName extracts the first token of a multi-word name", () => {
    assert.equal(firstName("Justin Adkins"), "Justin");
    assert.equal(firstName("  Mary   Anne Smith"), "Mary");
});

test("firstName passes through a single-token name unchanged", () => {
    assert.equal(firstName("Cher"), "Cher");
});

test("firstName falls back to 'Crew' for null, undefined, and empty/whitespace names", () => {
    assert.equal(firstName(null), "Crew");
    assert.equal(firstName(undefined), "Crew");
    assert.equal(firstName(""), "Crew");
    assert.equal(firstName("   "), "Crew");
});

test("toMobileCrew applies firstName + fallback per member", () => {
    const crew = toMobileCrew([
        { role: "lead", user: { id: "u1", name: null } },
        { role: "assigned", user: { id: "u2", name: "Bob" } },
    ]);
    assert.deepEqual(crew, [
        { id: "u1", name: "Crew", role: "lead" },
        { id: "u2", name: "Bob", role: "assigned" },
    ]);
});

test("toMobileCrew treats any non-'lead' role string as 'assigned'", () => {
    const crew = toMobileCrew([{ role: "something-else", user: { id: "u1", name: "Pat" } }]);
    assert.equal(crew[0].role, "assigned");
});

test("toMobileCrew drops assignments with no joined user", () => {
    const crew = toMobileCrew([
        { role: "assigned", user: null },
        { role: "lead", user: { id: "u1", name: "Pat" } },
    ]);
    assert.deepEqual(crew, [{ id: "u1", name: "Pat", role: "lead" }]);
});

test("toMobileCrew returns an empty array for no assignments", () => {
    assert.deepEqual(toMobileCrew([]), []);
});

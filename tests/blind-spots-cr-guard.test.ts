import assert from "node:assert/strict";
import test from "node:test";
import { findCarriageReturns } from "../scripts/blind-spots-cr-guard.mjs";

const clean = {
    partialIndexes: [{ name: "idx_a", def: "CREATE UNIQUE INDEX idx_a ON t (x) WHERE y" }],
    checkConstraints: [{ name: "chk_a", table: "t", def: "CHECK ((a > 0))" }],
    rlsTables: [{ name: "t", forced: false }],
    policies: [],
    functions: [{ name: "f()", def: "CREATE FUNCTION f()\n RETURNS trigger\n AS $$\nBEGIN\nEND\n$$" }],
    triggers: [{ table: "t", name: "trg_a", def: "CREATE TRIGGER trg_a BEFORE INSERT ON t" }],
};

test("clean snapshot passes", () => {
    assert.deepEqual(findCarriageReturns(clean), []);
});

test("carriage return inside a function body names the function", () => {
    const poisoned = {
        ...clean,
        functions: [{ name: "f()", def: clean.functions[0].def.replaceAll("\n", "\r\n") }],
    };
    assert.deepEqual(findCarriageReturns(poisoned), ["functions f()"]);
});

test("offending trigger and constraint are labelled with their table", () => {
    const poisoned = {
        ...clean,
        checkConstraints: [{ name: "chk_a", table: "t", def: "CHECK ((a > 0))\r" }],
        triggers: [{ table: "t", name: "trg_a", def: "CREATE TRIGGER trg_a\r\n BEFORE INSERT ON t" }],
    };
    assert.deepEqual(findCarriageReturns(poisoned), ["checkConstraints t.chk_a", "triggers t.trg_a"]);
});

test("snapshot round-tripped through JSON keeps the carriage return, so the guard must run before the write", () => {
    const poisoned = { ...clean, functions: [{ name: "f()", def: "BEGIN\r\nEND" }] };
    const roundTripped = JSON.parse(JSON.stringify(poisoned));
    assert.deepEqual(findCarriageReturns(roundTripped), ["functions f()"]);
});

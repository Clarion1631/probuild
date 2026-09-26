import test from "node:test";
import assert from "node:assert/strict";
import { addBusinessDays } from "../src/lib/speed-to-lead/followups";

test("addBusinessDays skips a weekend entirely", () => {
    // Friday 2026-01-02 + 1 business day -> Monday 2026-01-05
    const friday = new Date("2026-01-02T12:00:00.000Z");
    const result = addBusinessDays(friday, 1);
    assert.equal(result.toISOString().slice(0, 10), "2026-01-05");
});

test("addBusinessDays: a plain weekday run adds calendar days 1:1", () => {
    const monday = new Date("2026-01-05T12:00:00.000Z");
    const result = addBusinessDays(monday, 3);
    // Mon -> Tue, Wed, Thu
    assert.equal(result.toISOString().slice(0, 10), "2026-01-08");
});

test("addBusinessDays: +3 business days from a Thursday lands the following Tuesday", () => {
    const thursday = new Date("2026-01-01T12:00:00.000Z");
    const result = addBusinessDays(thursday, 3);
    assert.equal(result.toISOString().slice(0, 10), "2026-01-06");
});

test("addBusinessDays never counts the starting day itself", () => {
    const monday = new Date("2026-01-05T12:00:00.000Z");
    const result = addBusinessDays(monday, 1);
    assert.equal(result.toISOString().slice(0, 10), "2026-01-06");
});

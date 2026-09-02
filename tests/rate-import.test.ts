/**
 * Gusto rate import diff + payroll period defaults (Phase 5 spec G1, and the
 * config defaults standing in for section 7's open HUMAN DECISION items).
 *
 * Pure modules only — src/lib/rate-import.ts and src/lib/payroll-config.ts have
 * no prisma and no session, which is the whole reason the preview a human
 * approves and the rows that get written run through the same code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    diffRates,
    parseCsvGrid,
    parseGustoRateCsv,
    parseRateValue,
    MAX_IMPORTABLE_HOURLY_RATE,
    type ImportableUser,
} from "../src/lib/rate-import";
import {
    DEFAULT_SALARIED_EMAILS,
    isSalariedEmail,
    lastFullPayPeriod,
    payrollPeriodDays,
} from "../src/lib/payroll-config";

const users: ImportableUser[] = [
    { id: "u1", name: "Tim Brennan", email: "tim@example.com", hourlyRate: 25 },
    { id: "u2", name: "Garrett Lane", email: "garrett@example.com", hourlyRate: 25 },
    { id: "u3", name: "Pat Twin", email: "pat1@example.com", hourlyRate: 20 },
    { id: "u4", name: "Pat Twin", email: "pat2@example.com", hourlyRate: 20 },
];

test("csv reader handles quotes, doubled quotes, embedded commas and CRLF", () => {
    const grid = parseCsvGrid('a,b\r\n"x, y","he said ""hi"""\r\n');
    assert.deepEqual(grid, [
        ["a", "b"],
        ["x, y", 'he said "hi"'],
    ]);
});

test("rate values tolerate $ and thousands separators", () => {
    assert.equal(parseRateValue("$28.50"), 28.5);
    assert.equal(parseRateValue(" 1,200 "), 1200);
    assert.equal(parseRateValue(""), null);
    assert.equal(parseRateValue("n/a"), null);
});

test("a first/last name pair beats a single display-name column", () => {
    const parsed = parseGustoRateCsv(
        ["Name,First name,Last name,Work email,Compensation rate", "Timmy,Tim,Brennan,TIM@example.com,$28.00"].join("\n")
    );
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.rows, [{ lineNumber: 2, name: "Tim Brennan", email: "tim@example.com", hourlyRate: 28 }]);
});

test("unreadable, negative and implausible rates are reported, not silently dropped", () => {
    const parsed = parseGustoRateCsv(
        [
            "Employee name,Email,Compensation rate",
            "Tim Brennan,tim@example.com,not-a-number",
            "Garrett Lane,garrett@example.com,-5",
            "Big Typo,big@example.com,5500",
            "Fine Person,fine@example.com,30",
        ].join("\n")
    );
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].hourlyRate, 30);
    assert.equal(parsed.errors.length, 3);
    assert.match(parsed.errors[2], new RegExp(String(MAX_IMPORTABLE_HOURLY_RATE)));
});

test("a file with no rate column is refused outright", () => {
    const parsed = parseGustoRateCsv("Employee name,Email\nTim Brennan,tim@example.com");
    assert.deepEqual(parsed.rows, []);
    assert.match(parsed.errors[0], /rate column/i);
});

test("the diff matches on email first and reports old vs new", () => {
    const parsed = parseGustoRateCsv(
        ["Employee name,Email,Compensation rate", "Anything At All,TIM@example.com,32.50"].join("\n")
    );
    const [row] = diffRates(parsed.rows, users);
    assert.equal(row.userId, "u1");
    assert.equal(row.matchedBy, "email");
    assert.equal(row.oldHourly, 25);
    assert.equal(row.newHourly, 32.5);
    assert.equal(row.changed, true);
});

test("an exact full name is the fallback, and an unchanged rate is flagged as unchanged", () => {
    const parsed = parseGustoRateCsv(
        ["Employee name,Email,Compensation rate", "garrett lane,,25"].join("\n")
    );
    const [row] = diffRates(parsed.rows, users);
    assert.equal(row.userId, "u2");
    assert.equal(row.matchedBy, "name");
    assert.equal(row.changed, false, "same number is not a change");
});

test("an ambiguous name is left UNMATCHED rather than written to the wrong person", () => {
    const parsed = parseGustoRateCsv(["Employee name,Email,Compensation rate", "Pat Twin,,44"].join("\n"));
    const [row] = diffRates(parsed.rows, users);
    assert.equal(row.userId, null);
    assert.equal(row.matched, false);
    assert.match(row.note ?? "", /share this name/);
});

test("an unknown person is unmatched, and the same person twice is refused", () => {
    const parsed = parseGustoRateCsv(
        [
            "Employee name,Email,Compensation rate",
            "Nobody Here,nobody@example.com,31",
            "Tim Brennan,tim@example.com,31",
            "Tim Again,tim@example.com,99",
        ].join("\n")
    );
    const rows = diffRates(parsed.rows, users);
    assert.equal(rows[0].matched, false);
    assert.match(rows[0].note ?? "", /No team member/);
    assert.equal(rows[1].userId, "u1");
    assert.equal(rows[2].matched, false, "the second row for the same person must not win silently");
    assert.match(rows[2].note ?? "", /more than once/);
});

// ── Config defaults (labelled in payroll-config.ts as pending Justin) ───────

test("CJ and Richard are the default salaried list, matched case-insensitively", () => {
    assert.deepEqual(DEFAULT_SALARIED_EMAILS, [
        "cj@goldentouchremodeling.com",
        "rlord@goldentouchremodeling.com",
    ]);
    assert.equal(isSalariedEmail("CJ@GoldenTouchRemodeling.com"), true);
    assert.equal(isSalariedEmail("tim@example.com"), false);
    assert.equal(isSalariedEmail(null), false);
    // An env value REPLACES the default list rather than extending it.
    assert.equal(isSalariedEmail("cj@goldentouchremodeling.com", ["someone@else.com"]), false);
});

test("the default period is a full fortnight ending before today", () => {
    assert.equal(payrollPeriodDays("biweekly"), 14);
    assert.equal(payrollPeriodDays("weekly"), 7);

    // 2026-08-31 is a Monday and a grid boundary (2026-01-05 + 34 weeks).
    const monday = lastFullPayPeriod("2026-09-02", { length: "biweekly", weekStart: "monday" });
    assert.deepEqual(monday, { startKey: "2026-08-17", endKey: "2026-08-31" });

    // The day the new period opens still shows the one that just closed.
    assert.deepEqual(lastFullPayPeriod("2026-08-31", { length: "biweekly", weekStart: "monday" }), {
        startKey: "2026-08-17",
        endKey: "2026-08-31",
    });

    assert.deepEqual(lastFullPayPeriod("2026-09-02", { length: "weekly", weekStart: "monday" }), {
        startKey: "2026-08-24",
        endKey: "2026-08-31",
    });

    // A Sunday-start grid puts the boundary on Sunday, not Monday.
    assert.deepEqual(lastFullPayPeriod("2026-09-02", { length: "weekly", weekStart: "sunday" }), {
        startKey: "2026-08-23",
        endKey: "2026-08-30",
    });
});

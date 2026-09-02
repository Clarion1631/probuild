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
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    diffRates,
    parseCsvGrid,
    parseGustoRateCsv,
    hasDuplicateTargets,
    parseRateValue,
    rowFingerprint,
    previewFingerprint,
    MAX_IMPORTABLE_HOURLY_RATE,
    type ImportableUser,
} from "../src/lib/rate-import";
import {
    DEFAULT_SALARIED_EMAILS,
    isDayKey,
    isSalariedEmail,
    lastFullPayPeriod,
    MAX_PAYROLL_RANGE_DAYS,
    payrollLockEnvelope,
    payrollPeriodDays,
    validatePayrollRange,
} from "../src/lib/payroll-config";

const users: ImportableUser[] = [
    { id: "u1", name: "Tim Brennan", email: "tim@example.com", hourlyRate: "25.00" },
    { id: "u2", name: "Garrett Lane", email: "garrett@example.com", hourlyRate: "25.00" },
    { id: "u3", name: "Pat Twin", email: "pat1@example.com", hourlyRate: "20.00" },
    { id: "u4", name: "Pat Twin", email: "pat2@example.com", hourlyRate: "20.00" },
];

test("csv reader handles quotes, doubled quotes, embedded commas and CRLF", () => {
    const grid = parseCsvGrid('a,b\r\n"x, y","he said ""hi"""\r\n');
    assert.deepEqual(grid, [
        ["a", "b"],
        ["x, y", 'he said "hi"'],
    ]);
});

test("rates are exact decimal TEXT, never a float", () => {
    // Money never goes through a JS number here: the text is handed to
    // Prisma.Decimal at write time.
    assert.equal(parseRateValue("$28.50"), "28.50");
    assert.equal(parseRateValue(" 30 "), "30.00");
    assert.equal(parseRateValue("28.5"), "28.50");
    assert.equal(parseRateValue(""), null);
    assert.equal(parseRateValue("n/a"), null);
});

test("commas, exponents and sub-cent precision are all REFUSED, not massaged", () => {
    // Stripping the comma turned the European "28,50" into 2850 — a 100x pay
    // rate that would have imported silently.
    assert.equal(parseRateValue("28,50"), null);
    assert.equal(parseRateValue(" 1,200 "), null);
    // Number("1e2") is 100. Nobody types that into a payroll system.
    assert.equal(parseRateValue("1e2"), null);
    assert.equal(parseRateValue("2.8e1"), null);
    // A half-cent is a decision for a human, not a rounding rule in an importer.
    assert.equal(parseRateValue("28.005"), null);
    assert.equal(parseRateValue("28.999"), null);
    assert.equal(parseRateValue("Infinity"), null);
    assert.equal(parseRateValue("0x1c"), null);
});

test("a first/last name pair beats a single display-name column", () => {
    const parsed = parseGustoRateCsv(
        ["Name,First name,Last name,Work email,Compensation rate", "Timmy,Tim,Brennan,TIM@example.com,$28.00"].join("\n")
    );
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.rows, [
        { lineNumber: 2, name: "Tim Brennan", email: "tim@example.com", hourlyRate: "28.00", payType: null },
    ]);
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
    assert.equal(parsed.rows[0].hourlyRate, "30.00");
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
    assert.equal(row.oldHourly, "25.00");
    assert.equal(row.newHourly, "32.50");
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

test("a compensation-type column sets payType, and anything unrecognised is left unset", () => {
    const parsed = parseGustoRateCsv(
        [
            "Employee name,Email,Compensation rate,Compensation type",
            "Tim Brennan,tim@example.com,28,Hourly",
            "Garrett Lane,garrett@example.com,30,Salaried",
            "Pat One,pat1@example.com,20,Piece rate",
        ].join("\n")
    );
    assert.deepEqual(parsed.rows.map((row) => row.payType), ["HOURLY", "SALARY", null]);
});

test("a DISABLED account is never written to", () => {
    const withDisabled = [...users, { id: "u5", name: "Gone Person", email: "gone@example.com", hourlyRate: "20.00", status: "DISABLED" }];
    const parsed = parseGustoRateCsv(
        ["Employee name,Email,Compensation rate", "Gone Person,gone@example.com,44"].join("\n")
    );
    const [row] = diffRates(parsed.rows, withDisabled);
    assert.equal(row.matched, false);
    assert.equal(row.userId, null);
    assert.match(row.note ?? "", /disabled/i);
});

test("each row carries its OWN fingerprint, so a SUBSET can be applied", () => {
    // A whole-file hash forced all-or-nothing: tick three of ten rows and the
    // recomputed hash never matched, rejecting a legitimate partial import.
    const parsed = parseGustoRateCsv(
        [
            "Employee name,Email,Compensation rate",
            "Tim Brennan,tim@example.com,32.50",
            "Garrett Lane,garrett@example.com,29.00",
        ].join("\n")
    );
    const rows = diffRates(parsed.rows, users);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.rowHash));

    // Each row's hash depends only on ITS OWN user/old/new values, so taking one
    // row and leaving the other does not disturb it.
    const [tim, garrett] = rows;
    assert.notEqual(tim.rowHash, garrett.rowHash);
    const timAlone = diffRates(
        parseGustoRateCsv(["Employee name,Email,Compensation rate", "Tim Brennan,tim@example.com,32.50"].join("\n")).rows,
        users
    );
    assert.equal(timAlone[0].rowHash, tim.rowHash, "a row's hash must not depend on its neighbours");

    // But it DOES depend on the old rate: a concurrent edit changes it.
    const moved = users.map((u) => (u.id === "u1" ? { ...u, hourlyRate: "27.00" } : u));
    assert.notEqual(diffRates(parsed.rows, moved)[0].rowHash, tim.rowHash);
});

test("a file listing the same person twice poisons the WHOLE preview", () => {
    // Two rates for one person: nobody can say which the office meant, and
    // importing the others while dropping this one leaves a half-applied
    // payroll change nobody reviewed.
    const parsed = parseGustoRateCsv(
        [
            "Employee name,Email,Compensation rate",
            "Tim Brennan,tim@example.com,31",
            "Tim Brennan,tim@example.com,44",
            "Garrett Lane,garrett@example.com,29",
        ].join("\n")
    );
    assert.equal(hasDuplicateTargets(parsed.rows, users), true);

    const clean = parseGustoRateCsv(
        ["Employee name,Email,Compensation rate", "Tim Brennan,tim@example.com,31"].join("\n")
    );
    assert.equal(hasDuplicateTargets(clean.rows, users), false);
});

test("the row claim includes the OLD PAY TYPE, so a concurrent correction invalidates it", () => {
    // A null -> SALARY correction changes no RATE. Without the old pay type in
    // the claim, a stale HOURLY preview would have sailed through the rate CAS
    // and silently reverted it.
    const parsed = parseGustoRateCsv(
        ["Employee name,Email,Compensation rate", "Tim Brennan,tim@example.com,32.50"].join("\n")
    );
    const before = diffRates(parsed.rows, users)[0];
    assert.equal(before.oldPayType, null);

    const corrected = users.map((u) => (u.id === "u1" ? { ...u, payType: "SALARY" } : u));
    const after = diffRates(parsed.rows, corrected)[0];
    assert.equal(after.oldPayType, "SALARY");
    assert.notEqual(after.rowHash, before.rowHash, "the same approval must not survive the correction");
});

test("row claims are SIGNED — an unsigned fingerprint is not evidence", () => {
    // Plain concatenation is reproducible by any caller, so on its own it lets a
    // client fabricate an approval it was never shown. The server signs it.
    const parsed = parseGustoRateCsv(
        ["Employee name,Email,Compensation rate", "Tim Brennan,tim@example.com,32.50"].join("\n")
    );
    const signed = diffRates(parsed.rows, users, (input) => `sig(${rowFingerprint(input)})`)[0];
    assert.match(signed.rowHash ?? "", /^sig\(/);
    // And the payload it signs pins every value the human approved.
    const payload = rowFingerprint({
        userId: "u1",
        oldHourly: "25.00",
        oldPayType: null,
        oldLastRateSyncAt: null,
        csvHash: "",
        newHourly: "32.50",
        payType: null,
    });
    assert.equal(signed.rowHash, `sig(${payload})`);
    assert.notEqual(
        payload,
        rowFingerprint({
            userId: "u1",
            oldHourly: "25.00",
            oldPayType: "SALARY",
            oldLastRateSyncAt: null,
            csvHash: "",
            newHourly: "32.50",
            payType: null,
        })
    );
});

test("the preview fingerprint covers the OLD rate, so a stale approval is refused", () => {
    const parsed = parseGustoRateCsv(
        ["Employee name,Email,Compensation rate", "Tim Brennan,tim@example.com,32.50"].join("\n")
    );
    const shown = diffRates(parsed.rows, users);
    const hash = previewFingerprint(shown);

    // Same approval, replayed after somebody else changed Tim's rate on the
    // team page. Without the old value in the fingerprint this replay would
    // silently overwrite their edit.
    const moved = users.map((u) => (u.id === "u1" ? { ...u, hourlyRate: "27.00" } : u));
    assert.notEqual(previewFingerprint(diffRates(parsed.rows, moved)), hash);

    // Nothing moved: the same preview fingerprints identically, so a legitimate
    // save still goes through.
    assert.equal(previewFingerprint(diffRates(parsed.rows, users)), hash);

    // Unmatched rows carry no write, so they cannot change the fingerprint.
    const withNoise = parseGustoRateCsv(
        ["Employee name,Email,Compensation rate", "Tim Brennan,tim@example.com,32.50", "Nobody,nobody@example.com,10"].join("\n")
    );
    assert.equal(previewFingerprint(diffRates(withNoise.rows, users)), hash);
});

// ── Config defaults (labelled in payroll-config.ts as pending Justin) ───────

test("there is NO default salaried list — unset env means nobody is exempt", () => {
    // Reversed in review round 21. The list used to default to two named
    // employees, which is the code deciding on nobody's authority that two
    // specific humans are salaried. That guess fails OPEN in the direction that
    // loses money for the worker: if either had actually been hourly, their
    // hours would have been silently dropped from the summary csv.
    assert.deepEqual(DEFAULT_SALARIED_EMAILS, []);
    assert.equal(isSalariedEmail("CJ@GoldenTouchRemodeling.com"), false);
    assert.equal(isSalariedEmail("tim@example.com"), false);
    assert.equal(isSalariedEmail(null), false);
    // An explicit list still works, and still matches case-insensitively.
    assert.equal(isSalariedEmail("CJ@GoldenTouchRemodeling.com", ["cj@goldentouchremodeling.com"]), true);
    // And it REPLACES rather than extends — there is nothing left to extend.
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

// ── The shared range validator (endpoint + lock action + page all use it) ──

test("payroll ranges are validated in ONE place, strictly", () => {
    assert.equal(validatePayrollRange("2026-08-17", "2026-08-31").ok, true);

    // Shape.
    assert.equal(validatePayrollRange("2026-8-17", "2026-08-31").ok, false);
    assert.equal(validatePayrollRange("not-a-date", "2026-08-31").ok, false);
    assert.equal(validatePayrollRange(undefined, "2026-08-31").ok, false);
    // A REAL calendar day: Date would silently roll 2026-02-31 to 2026-03-03.
    assert.equal(isDayKey("2026-02-31"), false);
    assert.equal(validatePayrollRange("2026-02-31", "2026-03-31").ok, false);

    // Direction and length.
    assert.equal(validatePayrollRange("2026-08-31", "2026-08-17").ok, false);
    assert.equal(validatePayrollRange("2026-08-17", "2026-08-17").ok, false, "an empty range is not a period");

    // The 62-day cap, exactly on the boundary and one past it.
    const atCap = validatePayrollRange("2026-01-01", "2026-03-04");
    assert.equal(atCap.ok, true);
    assert.equal(atCap.ok && atCap.days, MAX_PAYROLL_RANGE_DAYS);
    const tooLong = validatePayrollRange("2026-01-01", "2026-03-05");
    assert.equal(tooLong.ok, false);
    assert.match((tooLong as { error: string }).error, new RegExp(String(MAX_PAYROLL_RANGE_DAYS)));
});

test("the influence window reaches BACKWARD to the week start, and never past the period", () => {
    const TZ = "America/Los_Angeles";
    // Wed 2026-08-19 through Thu 2026-08-27 (exclusive) — both ends mid-week.
    const envelope = payrollLockEnvelope(
        new Date("2026-08-19T07:00:00.000Z"),
        new Date("2026-08-27T07:00:00.000Z"),
        TZ
    );
    // Back to Mon 08-17: those hours decide how much of the period is overtime.
    assert.equal(envelope.start.toISOString(), "2026-08-17T07:00:00.000Z");
    // NOT forward. Overtime is allocated chronologically, so hours after the
    // period land later in the walk and cannot change anything inside it.
    // Reaching forward froze days no locked number depends on, and made two
    // adjacent periods overlap at the seam.
    assert.equal(envelope.end.toISOString(), "2026-08-27T07:00:00.000Z");

    // A period that already starts on a Monday is left alone at both ends.
    const exact = payrollLockEnvelope(
        new Date("2026-08-17T07:00:00.000Z"),
        new Date("2026-08-31T07:00:00.000Z"),
        TZ
    );
    assert.equal(exact.start.toISOString(), "2026-08-17T07:00:00.000Z");
    assert.equal(exact.end.toISOString(), "2026-08-31T07:00:00.000Z");
});

test("PAYROLL_WEEK_START never widens the influence window", () => {
    const TZ = "America/Los_Angeles";
    // A Sunday-start pay period, Sun 2026-08-16 .. Sun 2026-08-30. An earlier
    // version also aligned the envelope to the configured week start, which
    // froze roughly two extra weeks — entries the export never queried, that the
    // readiness check never saw and the hash never covered, locked anyway.
    //
    // The envelope must be exactly the workweeks the EXPORT queries: the Monday
    // week containing the first instant, through the Monday after the week
    // containing the last.
    const envelope = payrollLockEnvelope(
        new Date("2026-08-16T07:00:00.000Z"),
        new Date("2026-08-30T07:00:00.000Z"),
        TZ
    );
    assert.equal(envelope.start.toISOString(), "2026-08-10T07:00:00.000Z");
    assert.equal(envelope.end.toISOString(), "2026-08-30T07:00:00.000Z", "never past periodEnd");

    // Same answer whatever PAYROLL_WEEK_START says, because it is not consulted.
    const previous = process.env.PAYROLL_WEEK_START;
    try {
        process.env.PAYROLL_WEEK_START = "sunday";
        const withSunday = payrollLockEnvelope(
            new Date("2026-08-16T07:00:00.000Z"),
            new Date("2026-08-30T07:00:00.000Z"),
            TZ
        );
        assert.deepEqual(
            [withSunday.start.toISOString(), withSunday.end.toISOString()],
            [envelope.start.toISOString(), envelope.end.toISOString()]
        );
    } finally {
        if (previous === undefined) delete process.env.PAYROLL_WEEK_START;
        else process.env.PAYROLL_WEEK_START = previous;
    }
});

test("a file with SOME unreadable rows blocks the whole import", () => {
    // The good rows parse and the bad ones are reported, so the preview looks
    // usable. Importing just the good half leaves a half-applied pay change
    // nobody reviewed — and the errors were on the screen Save was clicked from.
    const parsed = parseGustoRateCsv(
        [
            "Employee name,Email,Compensation rate",
            "Tim Brennan,tim@example.com,31.00",
            "Garrett Lane,garrett@example.com,28.005",
            "Pat One,pat1@example.com,29.00",
        ].join(String.fromCharCode(10))
    );
    assert.equal(parsed.rows.length, 2, "the readable rows still parse");
    assert.equal(parsed.errors.length, 1, "and the unreadable one is reported");

    // The server re-parses rather than trusting the browser's "no errors".
    const actions = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const fn = actions.slice(actions.indexOf("export async function applyGustoRateImport"));
    const body = fn.slice(0, fn.indexOf(String.fromCharCode(10) + "/**"));
    assert.match(body, /parseGustoRateCsv\(csvText\)/);
    assert.match(body, /reparsed\.errors\.length > 0/);

    // And the button is disabled, so it is refused before it is attempted.
    const ui = readFileSync(
        path.join(__dirname, "..", "src", "app", "company", "team-members", "RatesImport.tsx"),
        "utf8"
    );
    assert.match(ui, /disabled=\{busy \|\| errors\.length > 0\}/);
});

test("a pay-type change is shown old -> new and is never pre-ticked", () => {
    // Hourly vs salary decides whether Gusto pays somebody a salary AND their
    // exported hours. That is not a decision a CSV gets to make quietly.
    const ui = readFileSync(
        path.join(__dirname, "..", "src", "app", "company", "team-members", "RatesImport.tsx"),
        "utf8"
    );
    assert.match(ui, /const changesPayType = !!row\.payType && row\.payType !== \(row\.oldPayType \?\? null\);/);
    assert.match(ui, /if \(changesPayType\) continue;/);
    // And the row says what it would change it FROM.
    assert.match(ui, /pay type \{row\.oldPayType \? row\.oldPayType\.toLowerCase\(\) : "not set"\}/);
    assert.match(ui, /tick those yourself/);
});

test("salaried rows carry a pay type, not an annual figure read as an hourly rate", () => {
    // Gusto's compensation figure for a salaried person is ANNUAL: CJ 92,000,
    // Richard 80,000. Read as hourly they fail the plausibility ceiling, and
    // the parse errors then blocked the WHOLE import — so one salaried person
    // in the file stopped every hourly rate in it from being saved.
    const parsed = parseGustoRateCsv(
        [
            "Employee name,Email,Compensation rate,Compensation type",
            "CJ Manager,cj@example.com,92000,Salary",
            "Richard Lord,rlord@example.com,80000,Salary",
            "Tim Brennan,tim@example.com,28.50,Hourly",
        ].join(String.fromCharCode(10))
    );
    assert.deepEqual(parsed.errors, [], "a salaried row is not a parse failure");
    assert.deepEqual(
        parsed.rows.map((row) => [row.name, row.hourlyRate, row.payType]),
        [
            ["CJ Manager", null, "SALARY"],
            ["Richard Lord", null, "SALARY"],
            ["Tim Brennan", "28.50", "HOURLY"],
        ]
    );

    // And the diff writes a pay type for them without touching their rate.
    const withSalaried = [
        { id: "s1", name: "CJ Manager", email: "cj@example.com", hourlyRate: "0.00", payType: null },
        { id: "u1", name: "Tim Brennan", email: "tim@example.com", hourlyRate: "25.00" },
    ];
    const rows = diffRates(parsed.rows, withSalaried);
    const cj = rows.find((row) => row.userId === "s1");
    assert.equal(cj?.newHourly, null, "no hourly rate is invented for a salaried person");
    assert.equal(cj?.payType, "SALARY");
    assert.equal(cj?.changed, true, "their pay type still needs writing");
    // The hourly row is unaffected by the salaried ones sharing the file.
    assert.equal(rows.find((row) => row.userId === "u1")?.newHourly, "28.50");
});

test("a ragged row is refused rather than shifting every value one column left", () => {
    // "28,50" is not a decimal comma to a CSV reader — it is two columns. The
    // row then has four fields against a three-field header, and every value
    // after it lands in the wrong column: somebody's NAME in the rate column.
    const parsed = parseGustoRateCsv(
        [
            "Employee name,Email,Compensation rate",
            "Tim Brennan,tim@example.com,28.50",
            "Garrett Lane,garrett@example.com,28,50",
        ].join(String.fromCharCode(10))
    );
    assert.deepEqual(parsed.rows, [], "nothing is imported from a file that cannot be read exactly");
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0], /columns/);
});

test("a quoted thousands separator stays ONE field and is still refused as a rate", () => {
    // "$1,200" quoted is a single field — legitimate CSV — but not a plausible
    // hourly rate, so it is reported as an unreadable row rather than imported.
    const parsed = parseGustoRateCsv(
        [
            "Employee name,Email,Compensation rate",
            'Tim Brennan,tim@example.com,"$1,200"',
        ].join(String.fromCharCode(10))
    );
    assert.deepEqual(parsed.rows, []);
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0], /could not read the rate/);
});

test("an unterminated quote is an error, not a file silently collapsed to one row", () => {
    // The lenient reader swallowed the rest of the file into one field: a
    // hundred-row import became one row and ninety-nine vanished with no error.
    const parsed = parseGustoRateCsv(
        [
            "Employee name,Email,Compensation rate",
            'Tim Brennan,"tim@example.com,28.50',
            "Garrett Lane,garrett@example.com,29.00",
        ].join(String.fromCharCode(10))
    );
    assert.deepEqual(parsed.rows, []);
    assert.match(parsed.errors[0], /unclosed|inside a quoted value/);
});

test("a stray quote mid-field is an error", () => {
    const parsed = parseGustoRateCsv(
        ["Employee name,Email,Compensation rate", 'Tim Bre"nnan,tim@example.com,28.50'].join(String.fromCharCode(10))
    );
    assert.deepEqual(parsed.rows, []);
    assert.match(parsed.errors[0], /quote/);
});

test("properly quoted fields still parse, including embedded commas and quotes", () => {
    const parsed = parseGustoRateCsv(
        [
            "Employee name,Email,Compensation rate",
            '"Brennan, Tim",tim@example.com,28.50',
            '"He said ""hi""",garrett@example.com,29.00',
        ].join(String.fromCharCode(10))
    );
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(
        parsed.rows.map((row) => [row.name, row.hourlyRate]),
        [
            ["Brennan, Tim", "28.50"],
            ['He said "hi"', "29.00"],
        ]
    );
});


// ---------------------------------------------------------------------------
// Review round 15, item 5: the row token is bound to the FILE and to the
// member's last-sync stamp.
// ---------------------------------------------------------------------------

const A_TO_B_CSV = ["Employee name,Email,Compensation rate", "Tim Brennan,tim@example.com,32.50"].join("\n");

test("A -> B -> A: a spent approval does not verify again once the rate is set back by hand", () => {
    // Tim is on 25.00 and has never been imported, so his stamp is null.
    const before: ImportableUser[] = [
        { id: "u1", name: "Tim Brennan", email: "tim@example.com", hourlyRate: "25.00", status: "ACTIVE", payType: "HOURLY", lastRateSyncAt: null },
    ];
    const approved = diffRates(parseGustoRateCsv(A_TO_B_CSV).rows, before, rowFingerprint, "file-hash")[0];
    assert.equal(approved.rowHash, rowFingerprint({
        userId: "u1", oldHourly: "25.00", oldPayType: "HOURLY",
        oldLastRateSyncAt: null, csvHash: "file-hash",
        // The file has no pay-type column, so the row writes a rate only.
        newHourly: "32.50", payType: null,
    }));

    // The import runs: 25.00 -> 32.50, and the stamp is set. Then somebody puts
    // the rate back to 25.00 by hand on the team page. Rate and pay type are
    // now EXACTLY what the old approval was signed over.
    const backToA: ImportableUser[] = [
        { id: "u1", name: "Tim Brennan", email: "tim@example.com", hourlyRate: "25.00", status: "ACTIVE", payType: "HOURLY", lastRateSyncAt: "2026-09-02T00:00:00.000Z" },
    ];
    const reSigned = diffRates(parseGustoRateCsv(A_TO_B_CSV).rows, backToA, rowFingerprint, "file-hash")[0];

    // Without the stamp the old token would verify and silently re-apply a
    // decision that was already made, and already undone.
    assert.notEqual(reSigned.rowHash, approved.rowHash, "the spent approval must not verify against the restored rate");
});

test("an absent stamp is bound as the literal \"null\", never as an empty field", () => {
    const never = rowFingerprint({
        userId: "u1", oldHourly: "25.00", oldPayType: "HOURLY",
        oldLastRateSyncAt: null, csvHash: "h", newHourly: "32.50", payType: null,
    });
    assert.match(never, /:null:h$/);
    // and it is a DIFFERENT claim from any real stamp
    assert.notEqual(never, rowFingerprint({
        userId: "u1", oldHourly: "25.00", oldPayType: "HOURLY",
        oldLastRateSyncAt: "2026-09-02T00:00:00.000Z", csvHash: "h", newHourly: "32.50", payType: null,
    }));
});

test("a row token is bound to the FILE it was previewed from", () => {
    const same = parseGustoRateCsv(A_TO_B_CSV).rows;
    const fromFileA = diffRates(same, users, rowFingerprint, "sha-of-file-a")[0];
    const fromFileB = diffRates(same, users, rowFingerprint, "sha-of-file-b")[0];
    // Identical rows, identical members, different source file: a token lifted
    // out of one preview cannot be posted alongside another file.
    assert.notEqual(fromFileA.rowHash, fromFileB.rowHash);
});

test("apply REQUIRES the csv and re-parses it — the check cannot be skipped by omitting it", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/actions.ts"), "utf8");
    const apply = source.slice(source.indexOf("export async function applyGustoRateImport"));
    const body = apply.slice(0, apply.indexOf("\nexport "));
    // Required, not optional — `csvText?: string` let a caller skip the whole
    // file check by simply not sending it.
    assert.match(body, /csvText: string/);
    assert.doesNotMatch(body, /csvText\?: string/);
    assert.match(body, /typeof csvText !== "string" \|\| !csvText\.trim\(\)/);
    assert.match(body, /parseGustoRateCsv\(csvText\)/);
    assert.match(body, /reparsed\.errors\.length > 0/);
    // The hash comes from the file the SERVER parsed, and is what the tokens
    // are re-signed with.
    assert.match(body, /const csvHash = hashImportCsv\(csvText\)/);
    assert.match(body, /csvHash,/);
    // The stamp is in the signature AND in the compare-and-set.
    assert.match(body, /oldLastRateSyncAt: live\.lastRateSyncAt/);
    assert.match(body, /lastRateSyncAt: live\.lastRateSyncAt,/);
});

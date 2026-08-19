import assert from "node:assert/strict";
import test from "node:test";
import {
    normalizeCheckNumber,
    toCents,
    toIsoDate,
    entryToRows,
    ACCOUNT,
    SOURCE,
} from "../scripts/post-bank-images.mjs";

// Fixtures are REAL rows from Justin's filtered deposit view (2026-08-19)
// and the two checks pulled from the bank the same session.

const depositEntry = (over = {}) => ({
    bankReference: "26229015021344",
    date: "08/17/2026",
    amount: "15,723.38",
    kind: "DEPOSIT",
    checkNumber: null,
    capturedAt: "2026-08-19T03:00:00-07:00",
    files: [
        { fileName: "2026-08-17_DEPOSIT_15723.38_26229015021344_front.jpg", side: "front", byteSize: 98465 },
        { fileName: "2026-08-17_DEPOSIT_15723.38_26229015021344_back.jpg", side: "back", byteSize: 32623 },
    ],
    ...over,
});

const checkEntry = (over = {}) => ({
    bankReference: "26225018006376",
    date: "08/13/2026",
    amount: "6,037.15",
    kind: "CHECK",
    checkNumber: "1027",
    capturedAt: "2026-08-19T03:00:00-07:00",
    files: [
        { fileName: "2026-08-13_CHECK_6037.15_26225018006376_front.jpg", side: "front", byteSize: 163300 },
        { fileName: "2026-08-13_CHECK_6037.15_26225018006376_back.jpg", side: "back", byteSize: 110930 },
    ],
    ...over,
});

test("money is integer cents, magnitude only", async t => {
    await t.test("formatted string", () => assert.equal(toCents("15,723.38"), 1572338));
    await t.test("dollar sign", () => assert.equal(toCents("$6,037.15"), 603715));
    await t.test("already cents", () => assert.equal(toCents(1572338), 1572338));
    await t.test("negative becomes magnitude", () => assert.equal(toCents("-6,000.00"), 600000));
    await t.test("garbage is refused, not coerced", () => {
        for (const bad of ["abc", "", "1.234", "..5", "1,2,3.4.5"]) {
            assert.equal(toCents(bad), null, `${bad} must be refused`);
        }
    });
    await t.test("no float drift", () => {
        // 0.1 + 0.2 territory — the classic money bug.
        assert.equal(toCents("1234.30"), 123430);
        assert.equal(toCents("0.07"), 7);
    });
});

test("check numbers collapse to one identity", async t => {
    await t.test("leading zeros stripped", () => assert.equal(normalizeCheckNumber("01027"), "1027"));
    await t.test("plain", () => assert.equal(normalizeCheckNumber("1027"), "1027"));
    await t.test("with noise", () => assert.equal(normalizeCheckNumber("#1027 "), "1027"));
    await t.test("null stays null", () => assert.equal(normalizeCheckNumber(null), null));
    await t.test("non-numeric is null", () => assert.equal(normalizeCheckNumber("CHECK"), null));
    await t.test("all zeros is null, not '0'", () => assert.equal(normalizeCheckNumber("0000"), null));
});

test("dates are validated against the real calendar", async t => {
    await t.test("US format converts", () => assert.equal(toIsoDate("08/17/2026"), "2026-08-17"));
    await t.test("already ISO passes", () => assert.equal(toIsoDate("2026-08-17"), "2026-08-17"));
    await t.test("impossible date refused", () => assert.equal(toIsoDate("02/30/2026"), null));
    await t.test("month 13 refused", () => assert.equal(toIsoDate("13/01/2026"), null));
    await t.test("garbage refused", () => assert.equal(toIsoDate("not a date"), null));
});

test("a deposit becomes DEPOSIT_SLIP + DEPOSIT_PHOTO with NO check number", () => {
    const { rows, problems } = entryToRows(depositEntry());
    assert.equal(problems.length, 0);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.kind), ["DEPOSIT_SLIP", "DEPOSIT_PHOTO"]);
    // The DB CHECK constraint requires deposit kinds to have a null number.
    for (const r of rows) assert.equal(r.normalizedCheckNumber, null);
    assert.equal(rows[0].amountCents, 1572338);
    assert.equal(rows[0].account, ACCOUNT);
    assert.equal(rows[0].source, SOURCE);
});

test("a check becomes CHECK_FRONT + CHECK_BACK and KEEPS its number", () => {
    const { rows, problems } = entryToRows(checkEntry());
    assert.equal(problems.length, 0);
    assert.deepEqual(rows.map(r => r.kind), ["CHECK_FRONT", "CHECK_BACK"]);
    // The CHECK constraint requires check kinds to carry a number.
    for (const r of rows) assert.equal(r.normalizedCheckNumber, "1027");
});

test("each SIDE gets its own identity so both can be stored", () => {
    const { rows } = entryToRows(depositEntry());
    const ids = rows.map(r => r.sourceExternalId);
    assert.deepEqual(ids, ["26229015021344:front", "26229015021344:back"]);
    assert.equal(new Set(ids).size, 2, "sides must not collide on the unique key");
});

test("the same deposit always yields the same identity (idempotency)", () => {
    const a = entryToRows(depositEntry()).rows.map(r => r.sourceExternalId);
    const b = entryToRows(depositEntry({ capturedAt: "2027-01-01T00:00:00Z" })).rows.map(r => r.sourceExternalId);
    assert.deepEqual(a, b, "re-pulling later must not mint new rows");
});

test("bad entries are REPORTED, never guessed", async t => {
    await t.test("no bank reference", () => {
        const { rows, problems } = entryToRows({ files: [{ fileName: "x.jpg", side: "front" }] });
        assert.equal(rows.length, 0);
        assert.match(problems[0], /bankReference/);
    });
    await t.test("no files", () => {
        const { problems } = entryToRows(depositEntry({ files: [] }));
        assert.ok(problems.some(p => /no files/.test(p)));
    });
    await t.test("unreadable amount is flagged", () => {
        const { problems } = entryToRows(depositEntry({ amount: "lots", amountCents: undefined }));
        assert.ok(problems.some(p => /unreadable amount/.test(p)));
    });
    await t.test("unreadable date is flagged", () => {
        const { problems } = entryToRows(depositEntry({ date: "02/30/2026" }));
        assert.ok(problems.some(p => /unreadable date/.test(p)));
    });
});

test("a deposit with no amount still loads — the image is the evidence", () => {
    // A teller receipt may not OCR cleanly; the image is still worth storing.
    const { rows, problems } = entryToRows(depositEntry({ amount: undefined, amountCents: undefined }));
    assert.equal(problems.length, 0);
    assert.equal(rows[0].amountCents, null);
});

test("a third image gets a distinct identity, not a collision", () => {
    const e = depositEntry();
    e.files.push({ fileName: "third.jpg", side: "img3", byteSize: 1000 });
    const { rows } = entryToRows(e);
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map(r => r.sourceExternalId)).size, 3);
});

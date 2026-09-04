/**
 * Dedup-key fixtures, taken from REAL filenames in the August 2026 archive
 * (I:\My Drive\Expenses\Processed Receipts\2026\August). The v1 Apps Script
 * built those names from the same cleaned fields the v2 reader produces, so
 * each name is a recorded (project, date, vendor, ref, total) tuple — which
 * makes them the only fixtures that can prove the port AGREES with the
 * pipeline that is still in production.
 *
 * A key that changes here is a shadow-week mismatch, not a refactor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    canonicalVendor,
    cleanMoney,
    dedupKeys,
    isValidDate,
    normalizeDateStr,
    refLooksReal,
    sanitize,
} from "../src/lib/receipt-intake/keys";

/** One archive filename, split back into the fields v1 wrote into it. */
interface Fixture {
    file: string;
    vendor: string;
    date: string;
    invoice: string;
    total: string;
    strong: string | null;
    weak: string;
}

const FIXTURES: Fixture[] = [
    {
        file: "Berg_ADU_2026-08-03_Lowes_82766_$364.98",
        vendor: "Lowes", date: "2026-08-03", invoice: "82766", total: "364.98",
        strong: "2026-08-03|82766",
        weak: "lowes|2026-08-03|364.98|amt",
    },
    {
        // The alias list collapses this vendor onto the row above's token, which
        // is the whole point: ONE store, several spellings across its own formats.
        file: "Berg_ADU_2026-08-03_Lowes_Home_Improvement_99908_$277.19",
        vendor: "Lowes Home Improvement", date: "2026-08-03", invoice: "99908", total: "277.19",
        strong: "2026-08-03|99908",
        weak: "lowes|2026-08-03|277.19|amt",
    },
    {
        // Ref "12" is under three characters: too short to identify anything, so
        // the strong key is WITHHELD and the weak net handles it.
        file: "Berg_ADU_2026-08-04_WINLOCK_HARDWARE_12_$14.50",
        vendor: "WINLOCK HARDWARE", date: "2026-08-04", invoice: "12", total: "14.50",
        strong: null,
        weak: "winlockhardware|2026-08-04|14.50|amt",
    },
    {
        file: "Berg_ADU_2026-08-04_WINLOCK_HARDWARE_4_$16.17",
        vendor: "WINLOCK HARDWARE", date: "2026-08-04", invoice: "4", total: "16.17",
        strong: null,
        weak: "winlockhardware|2026-08-04|16.17|amt",
    },
    {
        // A non-alias vendor keeps its own collapsed token.
        file: "Berg_ADU_2026-08-07_CRC_-_WEST_VAN_260807091421373F2A9_$91.50",
        vendor: "CRC - WEST VAN", date: "2026-08-07", invoice: "260807091421373F2A9", total: "91.50",
        strong: "2026-08-07|260807091421373f2a9",
        weak: "crcwestvan|2026-08-07|91.50|amt",
    },
    {
        file: "Berg_ADU_2026-08-09_Amazon.com_113-9992333-7801840_$248.27",
        vendor: "Amazon.com", date: "2026-08-09", invoice: "113-9992333-7801840", total: "248.27",
        strong: "2026-08-09|113-9992333-7801840",
        weak: "amazon|2026-08-09|248.27|amt",
    },
    {
        // "NoInv" is the AI saying it found no number — a placeholder, never an identity.
        file: "Berg_ADU_2026-08-10_Grover_Electric_Plumbing_Supply_NoInv_$22.57",
        vendor: "Grover Electric Plumbing Supply", date: "2026-08-10", invoice: "", total: "22.57",
        strong: null,
        weak: "groverelectricplumbingsupply|2026-08-10|22.57|amt",
    },
    {
        file: "Berg_ADU_2026-08-14_LOWES_HOME_CENTERS_LLC_58302_$304.23",
        vendor: "LOWES HOME CENTERS LLC", date: "2026-08-14", invoice: "58302", total: "304.23",
        strong: "2026-08-14|58302",
        weak: "lowes|2026-08-14|304.23|amt",
    },
];

test("August archive fixtures produce the v1 dedup keys", () => {
    for (const f of FIXTURES) {
        const keys = dedupKeys({
            docType: "receipt",
            vendor: f.vendor,
            date: f.date,
            invoice: f.invoice,
            checkNumber: "",
            totalAmount: f.total,
            fallbackDateStr: "2099-01-01", // must never be reached: every fixture has a real date
        });
        assert.equal(keys.strong, f.strong, `${f.file} strong`);
        assert.equal(keys.weak, f.weak, `${f.file} weak`);
        assert.equal(keys.dateStr, f.date, `${f.file} date`);
        assert.equal(keys.amount, f.total, `${f.file} amount`);
    }
});

test("an unreadable date falls back to the intake row's own date", () => {
    const keys = dedupKeys({
        docType: "receipt",
        vendor: "Lowes",
        date: "", // the model returns "" rather than guessing
        invoice: "82766",
        totalAmount: "364.98",
        fallbackDateStr: "2026-08-20",
    });
    assert.equal(keys.dateStr, "2026-08-20");
    // The strong key needs a date READ OFF THE DOCUMENT. A fallback date is our
    // guess, and two unrelated receipts uploaded the same day must not collide
    // on it.
    assert.equal(keys.strong, null);
    assert.equal(keys.weak, "lowes|2026-08-20|364.98|amt");
});

test("an invalid calendar date is not a date", () => {
    for (const bad of ["2026-13-05", "2026-02-30", "not-a-date", ""]) {
        assert.equal(isValidDate(bad), false, bad);
    }
    assert.equal(isValidDate("2026-08-03"), true);
    assert.equal(normalizeDateStr("2026-06-10T00:00:00Z"), "2026-06-10");
    assert.equal(normalizeDateStr("  2026-06-10 "), "2026-06-10");
    assert.equal(normalizeDateStr("June 10"), "");
});

test("checks key on the check number, not the invoice", () => {
    const keys = dedupKeys({
        docType: "check",
        vendor: "Richard Lord",
        date: "2026-08-05",
        invoice: "ignored",
        checkNumber: "4178",
        totalAmount: "1,200.00",
        fallbackDateStr: "2099-01-01",
    });
    assert.equal(keys.ref, "Check4178");
    assert.equal(keys.strong, "2026-08-05|check4178");
    assert.equal(keys.amount, "1200.00");
});

test("a check with no readable number gets no strong key", () => {
    const keys = dedupKeys({
        docType: "check",
        vendor: "Someone",
        date: "2026-08-05",
        checkNumber: "",
        totalAmount: "50.00",
        fallbackDateStr: "2099-01-01",
    });
    assert.equal(keys.ref, "CheckNoNum");
    assert.equal(keys.strong, null);
});

test("placeholder refs are refused; real ones that merely look odd are not", () => {
    // :1571–1580 — the padded forms are exactly what the AI emits when it can't
    // read a number, and they used to become the SHARED key of every unrelated
    // receipt that day.
    assert.equal(refLooksReal("NA 000"), false);
    assert.equal(refLooksReal("0000"), false);
    assert.equal(refLooksReal("Unknown 0000"), false);
    assert.equal(refLooksReal("N/A"), false);
    assert.equal(refLooksReal("NoInv"), false);
    assert.equal(refLooksReal("12"), false);
    assert.equal(refLooksReal("ABC"), false);
    assert.equal(refLooksReal("1111"), false);
    // "INV"/"ORDER"/"REF" are deliberately NOT placeholders — they prefix real numbers.
    assert.equal(refLooksReal("INV-95870"), true);
    assert.equal(refLooksReal("82766"), true);
    assert.equal(refLooksReal("113-9992333-7801840"), true);
});

test("cleanMoney handles currency, commas and accounting negatives", () => {
    assert.equal(cleanMoney("$1,234.56"), "1234.56");
    assert.equal(cleanMoney("-12.50"), "-12.50");
    assert.equal(cleanMoney("(123.45)"), "-123.45");
    assert.equal(cleanMoney(""), "0.00");
    assert.equal(cleanMoney("not a number"), "0.00");
    assert.equal(cleanMoney(null), "0.00");
});

test("sanitize drops punctuation and collapses whitespace, like the archive names", () => {
    assert.equal(sanitize("Lowe's Home Improvement"), "Lowes_Home_Improvement");
    assert.equal(sanitize("CRC - WEST VAN"), "CRC_-_WEST_VAN");
    assert.equal(sanitize(""), "");
});

test("canonicalVendor collapses a chain's spellings and keeps others intact", () => {
    for (const spelling of ["LOWES", "Lowe's Home Improvement", "Lowes Home Centers LLC S1632MC3"]) {
        assert.equal(canonicalVendor(spelling), "lowes", spelling);
    }
    assert.equal(canonicalVendor("Amazon.com"), "amazon");
    assert.equal(canonicalVendor("CRC - WEST VAN"), "crcwestvan");
    assert.equal(canonicalVendor("Grover Electric Plumbing Supply"), "groverelectricplumbingsupply");
});

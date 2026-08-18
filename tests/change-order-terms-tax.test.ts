import test from "node:test";
import assert from "node:assert/strict";

import {
    allocateCoScheduleGross,
    canonicalCoTaxTerms,
    coTaxFingerprint,
    coTaxLabel,
    effectiveCoTaxInfo,
    fixedCoScheduleValidationError,
} from "../src/lib/co-tax";

test("canonical tax terms normalize effective percent and name for a stable fingerprint", () => {
    assert.deepEqual(
        canonicalCoTaxTerms({
            taxExempt: false,
            taxRatePercent: "8.8750",
            taxRateName: "  Seattle exact rate  ",
        }),
        {
            taxExempt: false,
            taxRatePercent: 8.875,
            taxRateName: "Seattle exact rate",
        },
    );
    assert.equal(
        coTaxFingerprint({ taxExempt: false, taxRatePercent: "8.8750", taxRateName: " Seattle exact rate " }),
        coTaxFingerprint({ taxExempt: false, taxRatePercent: 8.875, taxRateName: "Seattle exact rate" }),
    );
});

test("canonical tax terms use the effective default and zero rate for exemptions", () => {
    assert.deepEqual(canonicalCoTaxTerms({ taxExempt: false, taxRatePercent: null, taxRateName: null }), {
        taxExempt: false,
        taxRatePercent: 8.8,
        taxRateName: null,
    });
    assert.deepEqual(canonicalCoTaxTerms({ taxExempt: true, taxRatePercent: 12.345, taxRateName: "Certificate" }), {
        taxExempt: true,
        taxRatePercent: 0,
        taxRateName: "Certificate",
    });
});

test("effective tax uses live terms for Draft/null legacy and stored tuple after send", () => {
    const live = { taxExempt: false, taxRatePercent: 10.125, taxRateName: "Live estimate" };
    const stored = {
        termsTaxExempt: false,
        termsTaxRatePercent: 8.875,
        termsTaxRateName: "Sent terms",
    };

    assert.deepEqual(effectiveCoTaxInfo({ status: "Draft", ...stored }, live), live);
    assert.deepEqual(effectiveCoTaxInfo({ status: "Sent", ...stored }, live), {
        taxExempt: false,
        taxRatePercent: 8.875,
        taxRateName: "Sent terms",
    });
    assert.deepEqual(effectiveCoTaxInfo({ status: "Approved", termsTaxExempt: null }, live), live);
});

test("tax label preserves the full precision used by the money math", () => {
    assert.equal(
        coTaxLabel({ taxExempt: false, taxRatePercent: 8.875, taxRateName: "Seattle exact rate" }),
        "Seattle exact rate (8.875%)",
    );
});

test("gross schedule allocation matches fixed billing and leaves the cent remainder on the final row", () => {
    const rows = allocateCoScheduleGross(
        10,
        [{ amount: 3.33 }, { amount: 3.33 }, { amount: 3.34 }],
        { taxExempt: false, taxRatePercent: 8.875, taxRateName: "Seattle exact rate" },
    );

    assert.deepEqual(rows.map((row) => row.pretaxCents), [333, 333, 334]);
    assert.deepEqual(rows.map((row) => row.taxCents), [30, 29, 30]);
    assert.deepEqual(rows.map((row) => row.grossCents), [363, 362, 364]);
    assert.equal(rows.reduce((sum, row) => sum + row.grossCents, 0), 1089);
});

test("gross schedule tax allocation is cumulative so every row stays nonnegative and totals stay exact", () => {
    const rows = allocateCoScheduleGross(
        1,
        Array.from({ length: 20 }, (_, index) => ({ id: `row-${index}`, amount: 0.05 })),
        { taxExempt: false, taxRatePercent: 10, taxRateName: "Ten percent" },
    );

    assert.equal(rows.reduce((sum, row) => sum + row.pretaxCents, 0), 100);
    assert.equal(rows.reduce((sum, row) => sum + row.taxCents, 0), 10);
    assert.equal(rows.reduce((sum, row) => sum + row.grossCents, 0), 110);
    assert.equal(rows.every((row) => row.pretaxCents >= 0 && row.taxCents >= 0 && row.grossCents >= 0), true);
    assert.deepEqual(rows.map((row) => row.taxCents).slice(0, 4), [1, 0, 1, 0]);
});

test("fixed schedule validation centrally rejects one row, nonpositive rows, and cent sum drift", () => {
    assert.equal(fixedCoScheduleValidationError(1_000, []), null);
    assert.equal(
        fixedCoScheduleValidationError(1_000, [{ amount: 10 }]),
        "Fixed change-order splits require at least two schedule rows",
    );
    assert.equal(
        fixedCoScheduleValidationError(1_000, [{ amount: 10 }, { amount: 0 }]),
        "Every fixed change-order schedule amount must be greater than zero",
    );
    assert.equal(
        fixedCoScheduleValidationError(1_000, [{ amount: 4 }, { amount: 5.99 }]),
        "Change-order schedule amounts are out of sync with the signed subtotal",
    );
    assert.equal(fixedCoScheduleValidationError(1_000, [{ amount: 4 }, { amount: 6 }]), null);
});

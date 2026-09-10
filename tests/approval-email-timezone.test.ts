/**
 * The internal "✅ Estimate Approved" email used to render its Signed At cell
 * with a bare `approvedAt.toLocaleString()`. Production runs in UTC, so on
 * 2026-09-10 the EST-00514 notification read "9/10/2026, 5:52:08 PM" for a
 * signature taken at 10:52 AM Pacific — seven hours out, with nothing on the
 * page saying which clock it was.
 *
 * Two things are pinned here: that formatCompanyDateTime renders a company-local
 * wall clock WITH its zone label and cannot throw on bad configuration, and that
 * the notification's Signed At cell actually uses it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { formatCompanyDateTime, DEFAULT_COMPANY_TIME_ZONE } from "../src/lib/tz-date";

const PT = "America/Los_Angeles";

// The exact instant from the EST-00514 report: 10:52:08 AM PDT on 2026-09-10.
const EST_00514_SIGNED_AT = new Date("2026-09-10T17:52:08.000Z");

test("the EST-00514 instant renders as 10:52 AM Pacific, not the 5:52 PM UTC clock", () => {
    const rendered = formatCompanyDateTime(EST_00514_SIGNED_AT, PT);
    assert.equal(rendered, "Sep 10, 2026, 10:52 AM PDT");
    // The old bug in one assertion: the UTC hour must not survive into the output.
    assert.ok(!rendered.includes("5:52"), `UTC clock leaked into ${rendered}`);
});

test("the zone label is present and tracks DST rather than being a fixed string", () => {
    const summer = formatCompanyDateTime(new Date("2026-09-10T17:52:08.000Z"), PT);
    const winter = formatCompanyDateTime(new Date("2026-12-10T17:52:08.000Z"), PT);
    assert.ok(summer.endsWith(" PDT"), summer);
    assert.ok(winter.endsWith(" PST"), winter);
    // Same UTC hour, one hour apart locally — proof the offset is real, not baked in.
    assert.ok(summer.includes("10:52 AM"), summer);
    assert.ok(winter.includes("9:52 AM"), winter);
});

test("the timeZone argument is honored, so this is not just hard-coded Pacific", () => {
    assert.equal(formatCompanyDateTime(EST_00514_SIGNED_AT, "America/New_York"), "Sep 10, 2026, 1:52 PM EDT");
    assert.equal(formatCompanyDateTime(EST_00514_SIGNED_AT, "UTC"), "Sep 10, 2026, 5:52 PM UTC");
});

test("an invalid, empty, or missing zone falls back to the company default instead of throwing", () => {
    const expected = formatCompanyDateTime(EST_00514_SIGNED_AT, DEFAULT_COMPANY_TIME_ZONE);
    assert.equal(expected, "Sep 10, 2026, 10:52 AM PDT");
    for (const bad of ["Not/A_Zone", "", "   ", null, undefined]) {
        assert.equal(
            formatCompanyDateTime(EST_00514_SIGNED_AT, bad as string | null | undefined),
            expected,
            `zone ${JSON.stringify(bad)} should fall back to ${DEFAULT_COMPANY_TIME_ZONE}`
        );
    }
});

test("an unusable date yields an empty string rather than 'Invalid Date' in a customer-adjacent email", () => {
    assert.equal(formatCompanyDateTime(new Date("nonsense"), PT), "");
});

test("the output carries no exotic spaces, so it compares equal across ICU versions", () => {
    // ICU 72 switched the separator before AM/PM to U+202F; normalizing keeps the
    // rendered string stable between this machine's Node and CI's.
    const rendered = formatCompanyDateTime(EST_00514_SIGNED_AT, PT);
    assert.ok(!/[\u202f\u00a0]/.test(rendered), JSON.stringify(rendered));
});

test("the internal approval notification's Signed At cell no longer uses a bare toLocaleString", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/lib/actions.ts"), "utf8");
    const signedAtRows = source.split("\n").filter((line) => line.includes(">Signed At<"));
    assert.equal(signedAtRows.length, 1, "expected exactly one Signed At cell in actions.ts");

    const row = signedAtRows[0];
    assert.ok(
        row.includes("formatCompanyDateTime(approvedAt"),
        `Signed At cell must format through formatCompanyDateTime: ${row.trim()}`
    );
    assert.ok(
        !/approvedAt\s*\.\s*toLocaleString\s*\(/.test(row),
        `Signed At cell must not render approvedAt with a bare toLocaleString: ${row.trim()}`
    );
    // The zone has to come from the company setting, not a literal.
    assert.ok(
        /formatCompanyDateTime\(approvedAt,\s*await resolveCompanyTimeZone\(\)\)/.test(row),
        `Signed At cell must resolve the company time zone: ${row.trim()}`
    );
    assert.ok(
        /import \{[^}]*formatCompanyDateTime[^}]*\} from "\.\/company-timezone";/.test(source),
        "actions.ts must import formatCompanyDateTime"
    );
});

/**
 * The internal "✅ Estimate Approved" email used to render its Signed At cell
 * with a bare `approvedAt.toLocaleString()`. Production runs in UTC, so on
 * 2026-09-10 the EST-00514 notification read "9/10/2026, 5:52:08 PM" for a
 * signature taken at 10:52 AM Pacific — seven hours out, with nothing on the
 * page saying which clock it was.
 *
 * The CLIENT's copy of the same approval carried the date-only half of that bug:
 * its Date cell called `approvedAt.toLocaleDateString("en-US", ...)` with no
 * timeZone, so a signature taken after 5pm Pacific is already tomorrow in UTC —
 * and the customer was told they signed on a day they did not.
 *
 * Three things are pinned here: that formatCompanyDateTime renders a company-local
 * wall clock WITH its zone label and cannot throw on bad configuration, that the
 * internal notification's Signed At cell actually uses it, and that the client
 * email's Date cell reports the company's calendar day — still date-only, because
 * that email deliberately shows no clock time.
 *
 * A fourth thing, added after review: resolving that zone must never be able to
 * fail the approval. The estimate's status is committed to "Approved" ~80 lines
 * above the lookup, and getCachedCompanySettings() is an unstable_cache that often
 * runs zero queries — so pairing it with a resolver that ALWAYS hits the database
 * would turn a transient DB blip into an approval that is saved but never emails
 * the client, never emails the team, and never files the signed PDF (that filing
 * comes after both emails). The resolve is fail-soft; the last three tests pin it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { formatCompanyDateTime, DEFAULT_COMPANY_TIME_ZONE } from "../src/lib/tz-date";

const PT = "America/Los_Angeles";
// Resolved from this file rather than process.cwd(), so the suite reads the same
// actions.ts whichever directory the runner happens to be launched from.
const ACTIONS_PATH = new URL("../src/lib/actions.ts", import.meta.url);

// The exact instant from the EST-00514 report: 10:52:08 AM PDT on 2026-09-10.
const EST_00514_SIGNED_AT = new Date("2026-09-10T17:52:08.000Z");

// 6:30 PM Pacific on Sept 10 — already Sept 11 in UTC. Production runs in UTC,
// so this is exactly the instant where an unzoned toLocaleDateString tells the
// client they signed tomorrow.
const EVENING_SIGNATURE = new Date("2026-09-11T01:30:00.000Z");

function actionsSource(): string {
    return fs.readFileSync(ACTIONS_PATH, "utf8");
}

function clientDateCellRow(): string {
    const rows = actionsSource().split("\n").filter((line) => line.includes(">Date<"));
    assert.equal(rows.length, 1, "expected exactly one client-facing Date cell in actions.ts");
    return rows[0];
}

/**
 * Production runs in UTC; this machine does not. A test that reproduces the bug
 * only on a UTC host is a test that passes for the wrong reason everywhere else —
 * strip `timeZone` from the source on a Pacific box and an unzoned
 * toLocaleDateString still answers "September 10". So pin the process default
 * zone to UTC for the duration of the render, which is exactly what prod sees.
 */
function withUtcProcessZone<T>(fn: () => T): T {
    const previous = process.env.TZ;
    process.env.TZ = "UTC";
    try {
        return fn();
    } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    }
}

/**
 * Render the client email's Date cell by lifting the expression straight out of
 * actions.ts, so these tests exercise the SHIPPED options object rather than a
 * copy of it that is free to drift. Deleting `timeZone` from the source is what
 * makes them fail.
 */
function renderClientDateCell(timeZone: string, instant: Date): string {
    const row = clientDateCellRow();
    const expression = /\$\{(approvedAt\.toLocaleDateString\([^)]*\))\}/.exec(row);
    assert.ok(expression, `client Date cell must render approvedAt inline: ${row.trim()}`);
    const render = new Function("approvedAt", "companyTimeZone", `return ${expression[1]};`);
    return withUtcProcessZone(() => render(instant, timeZone)) as string;
}

/**
 * The one line in approveEstimate that resolves the zone shared by both emails.
 */
function zoneResolveRow(): string {
    const rows = actionsSource()
        .split("\n")
        .filter((line) => /const \[settings, companyTimeZone\] = await Promise\.all\(/.test(line));
    assert.equal(rows.length, 1, "expected exactly one companyTimeZone resolve in approveEstimate");
    return rows[0];
}

/**
 * Lift the SECOND element of that Promise.all — the resolve call plus whatever is
 * chained onto it — straight out of the source, so the behavioural tests below run
 * the SHIPPED expression instead of a copy of it. Quote-aware, so a bracket inside
 * the warn message cannot truncate the scan.
 */
function resolveZoneExpression(): string {
    const row = zoneResolveRow();
    const start = row.indexOf("resolveCompanyTimeZone(");
    assert.ok(start >= 0, `expected resolveCompanyTimeZone() in: ${row.trim()}`);
    let depth = 0;
    let quote: string | null = null;
    for (let i = start; i < row.length; i++) {
        const ch = row[i];
        if (quote !== null) {
            if (ch === "\\") i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "}") depth--;
        else if (ch === "]") {
            if (depth === 0) return row.slice(start, i);
            depth--;
        }
    }
    return assert.fail(`could not delimit the companyTimeZone expression in: ${row.trim()}`);
}

/**
 * Evaluate that expression against a stubbed resolver and a stubbed default, so
 * the fallback is proved by running it rather than by reading it.
 */
async function runResolveExpression(resolver: () => Promise<string>, fallback: string): Promise<unknown> {
    const logged: unknown[][] = [];
    const sink = (...args: unknown[]) => {
        logged.push(args);
    };
    const factory = new Function(
        "resolveCompanyTimeZone",
        "DEFAULT_COMPANY_TIME_ZONE",
        "console",
        `return ${resolveZoneExpression()};`
    );
    return await factory(resolver, fallback, { warn: sink, error: sink, log: sink });
}

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
    const source = actionsSource();
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
        /formatCompanyDateTime\(approvedAt,\s*companyTimeZone\)/.test(row),
        `Signed At cell must use the resolved company time zone: ${row.trim()}`
    );
    assert.ok(
        /import \{[^}]*formatCompanyDateTime[^}]*\} from "\.\/company-timezone";/.test(source),
        "actions.ts must import formatCompanyDateTime"
    );
});

test("control: pinned to UTC like production, an UNZONED render of this instant does say Sept 11", () => {
    // Without this control the test below can pass on a Pacific developer box
    // even with the fix reverted, because the host default zone happens to be
    // the right answer. This proves the harness actually reproduces prod.
    assert.equal(withUtcProcessZone(() => Intl.DateTimeFormat().resolvedOptions().timeZone), "UTC");
    const unzoned = withUtcProcessZone(() =>
        EVENING_SIGNATURE.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    );
    assert.equal(unzoned, "September 11, 2026");
});

test("the client's approved-estimate Date cell dates an evening signature by the company's calendar day", () => {
    const rendered = renderClientDateCell(PT, EVENING_SIGNATURE);
    assert.equal(rendered, "September 10, 2026");
    // The old bug in one assertion: 6:30 PM Pacific must not be reported to the
    // client as the next day just because UTC has already rolled over.
    assert.ok(!rendered.includes("September 11"), `UTC calendar day leaked into ${rendered}`);
});

test("the client Date cell honors the resolved zone rather than hard-coding one", () => {
    // 9:30 PM on Sept 10 in New York, but already Sept 11 in UTC — two different
    // answers prove the zone argument is actually consulted.
    assert.equal(renderClientDateCell("America/New_York", EVENING_SIGNATURE), "September 10, 2026");
    assert.equal(renderClientDateCell("UTC", EVENING_SIGNATURE), "September 11, 2026");
});

test("the client Date cell stays date-only — no clock time, no zone label", () => {
    const rendered = renderClientDateCell(PT, EVENING_SIGNATURE);
    assert.ok(!/\d:\d\d/.test(rendered), `client Date cell must not show a time: ${rendered}`);
    assert.ok(!/(PDT|PST|EDT|UTC|GMT)/.test(rendered), `client Date cell must not show a zone label: ${rendered}`);
});

test("the client Date cell passes a timeZone, and that zone is resolved from CompanySettings", () => {
    const row = clientDateCellRow();
    assert.ok(
        /toLocaleDateString\("en-US",\s*\{[^}]*timeZone\s*:/.test(row),
        `client Date cell options must include timeZone: ${row.trim()}`
    );
    assert.ok(
        /timeZone\s*:\s*companyTimeZone\b/.test(row),
        `client Date cell must use the resolved company zone, not a literal: ${row.trim()}`
    );
    // Resolved ONCE, above both emails, so the client's Date cell and the internal
    // Signed At cell can never disagree about which clock they are printing.
    // Deliberately open-ended after the resolve call: it carries a fail-soft
    // .catch(), pinned by the next test. What this pins is that there is exactly
    // one resolve, taken alongside the settings read, feeding both emails.
    assert.ok(
        /const \[settings, companyTimeZone\] = await Promise\.all\(\[getCachedCompanySettings\(\), resolveCompanyTimeZone\(\)/.test(
            actionsSource()
        ),
        "approveEstimate must resolve companyTimeZone once via resolveCompanyTimeZone()"
    );
});

test("the zone resolve is fail-soft, so a DB blip cannot strand an already-approved estimate", async () => {
    const row = zoneResolveRow();
    assert.ok(
        /resolveCompanyTimeZone\(\)\s*\.catch\(/.test(row),
        `resolveCompanyTimeZone() must carry a fail-soft .catch(): ${row.trim()}`
    );
    // getCachedCompanySettings() is an unstable_cache and can serve this with zero
    // queries; the resolve always touches the database. A rejecting resolver must
    // yield a usable zone rather than throw past the two emails and the PDF filing.
    const resolved = await runResolveExpression(async () => {
        throw new Error("db down");
    }, DEFAULT_COMPANY_TIME_ZONE);
    assert.equal(resolved, DEFAULT_COMPANY_TIME_ZONE);
});

test("the fallback is the shared default-zone constant, not a literal copy of it", async () => {
    // A sentinel the source cannot have hard-coded: if the catch returned a zone
    // string literal instead of the imported constant, this is what fails.
    const sentinel = "Test/Sentinel_Zone";
    assert.equal(
        await runResolveExpression(async () => {
            throw new Error("db down");
        }, sentinel),
        sentinel
    );
    assert.ok(
        /import \{[^}]*DEFAULT_COMPANY_TIME_ZONE[^}]*\} from "\.\/company-timezone";/.test(actionsSource()),
        "actions.ts must import DEFAULT_COMPANY_TIME_ZONE"
    );
});

test("a successful resolve still wins — the fallback does not swallow the configured zone", async () => {
    assert.equal(
        await runResolveExpression(async () => "America/New_York", DEFAULT_COMPANY_TIME_ZONE),
        "America/New_York"
    );
});

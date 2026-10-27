/**
 * Project Overview / Vision cover page through the MCP connector (update_estimate /
 * get_estimate). These are the DB-free parts: the argument normalizer and the
 * "nothing to update" gate. tests/estimate-overview-db.test.ts drives the real write,
 * the read-back and the PDF against Postgres.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    looksLikeRichHtml,
    normalizeOverviewBody,
    normalizeOverviewTitle,
    overviewOnCoverPage,
    plainTextToOverviewHtml,
} from "../src/lib/estimate-overview";
import { updateEstimateFromPhases } from "../src/lib/gpt-estimate";

test("omitted overviewBody means unchanged, null and blank mean clear", () => {
    assert.equal(normalizeOverviewBody(undefined), undefined);
    assert.equal(normalizeOverviewBody(null), null);
    assert.equal(normalizeOverviewBody(""), null);
    assert.equal(normalizeOverviewBody("   \n\t "), null);
});

test("editor HTML with no text clears instead of saving an empty cover page", () => {
    assert.equal(normalizeOverviewBody("<p></p>"), null);
    assert.equal(normalizeOverviewBody("<p>&nbsp;</p><p> </p>"), null);
});

test("editor HTML passes through untouched apart from outer whitespace", () => {
    const html = "<h2>Scope</h2><p>Open the <strong>kitchen</strong> to the family room.</p><ul><li>New island</li></ul>";
    assert.equal(normalizeOverviewBody(`  ${html}\n`), html);
    assert.equal(looksLikeRichHtml(html), true);
});

test("plain text becomes paragraphs, with single newlines as line breaks", () => {
    const text = "We are opening the kitchen.\r\n\r\nPhase one: demo.\nPhase two: framing.\n\n\nFinish work last.";
    assert.equal(
        normalizeOverviewBody(text),
        "<p>We are opening the kitchen.</p><p>Phase one: demo.<br>Phase two: framing.</p><p>Finish work last.</p>",
    );
});

test("plain text is escaped, so markup in it is shown literally rather than rendered", () => {
    const out = plainTextToOverviewHtml(`Budget < $50k & "tight" <script>alert(1)</script>`);
    assert.equal(out, "<p>Budget &lt; $50k &amp; &quot;tight&quot; &lt;script&gt;alert(1)&lt;/script&gt;</p>");
    assert.equal(looksLikeRichHtml(`Budget <b>bold</b>`), false);
});

test("plain text that merely starts with an angle bracket is not mistaken for HTML and cleared", () => {
    assert.equal(looksLikeRichHtml("<phase 1> demo"), false);
    assert.equal(looksLikeRichHtml("<pre>no</pre>"), false);
    assert.equal(normalizeOverviewBody("<phase 1> demo and framing"), "<p>&lt;phase 1&gt; demo and framing</p>");
    assert.equal(looksLikeRichHtml(`<p class="x">ok</p>`), true);
    assert.equal(looksLikeRichHtml("<H2>ok</H2>"), true);
});

test("title: omitted is unchanged, null or blank resets to the default heading, else trimmed", () => {
    assert.equal(normalizeOverviewTitle(undefined), undefined);
    assert.equal(normalizeOverviewTitle(null), null);
    assert.equal(normalizeOverviewTitle("  "), null);
    assert.equal(normalizeOverviewTitle("  Project Vision "), "Project Vision");
});

test("the cover page renders only when it is enabled AND has text", () => {
    assert.equal(overviewOnCoverPage({ overviewEnabled: true, overviewBody: "<p>x</p>" }), true);
    assert.equal(overviewOnCoverPage({ overviewEnabled: false, overviewBody: "<p>x</p>" }), false);
    assert.equal(overviewOnCoverPage({ overviewEnabled: true, overviewBody: null }), false);
});

test("the 'nothing to update' error tells the caller the overview arguments exist", async () => {
    // Returns before any database read. That an overview-only call gets PAST this gate and
    // writes is proven against Postgres in estimate-overview-db.test.ts.
    const empty = await updateEstimateFromPhases({ estimate: "EST-DOES-NOT-EXIST" });
    assert.equal(empty.ok, false);
    assert.match((empty as { error: string }).error, /Nothing to update.*overviewEnabled \/ overviewTitle \/ overviewBody/);
});

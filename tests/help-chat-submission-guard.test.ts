/**
 * Help-widget input hardening (review round 5, item 10).
 *
 * These two endpoints became reachable by every activated staff account and by
 * the crew app's Bearer token in this phase, and every submission opens a
 * GitHub issue — so the payload is bounded and the caller is throttled.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    checkHelpSubmission,
    HELP_DESCRIPTION_MAX,
    HELP_SUBMISSIONS_PER_HOUR,
    HELP_THROTTLE_WINDOW_MS,
    HELP_TITLE_MAX,
    isThrottled,
    readJsonBody,
    throttleWindowStart,
} from "../src/lib/help-chat/submission-guard";

test("a title or description over the limit is REFUSED, not silently truncated", () => {
    const ok = checkHelpSubmission({ title: "t", description: "d" });
    assert.equal(ok.ok, true);

    const longTitle = checkHelpSubmission({ title: "x".repeat(HELP_TITLE_MAX + 1), description: "d" });
    assert.equal(longTitle.ok, false);
    assert.equal((longTitle as { status: number }).status, 400);

    // Exactly at the limit is fine — an off-by-one here rejects real reports.
    assert.equal(checkHelpSubmission({ title: "x".repeat(HELP_TITLE_MAX), description: "d" }).ok, true);

    const longBody = checkHelpSubmission({ title: "t", description: "x".repeat(HELP_DESCRIPTION_MAX + 1) });
    assert.equal(longBody.ok, false);
    assert.equal(checkHelpSubmission({ title: "t", description: "x".repeat(HELP_DESCRIPTION_MAX) }).ok, true);
});

test("missing, blank and non-string fields are all 400", () => {
    for (const body of [
        {},
        { title: "t" },
        { description: "d" },
        { title: "   ", description: "d" },
        { title: "t", description: "   " },
        { title: 42, description: "d" },
        { title: "t", description: { nope: true } },
    ]) {
        const result = checkHelpSubmission(body as never);
        assert.equal(result.ok, false, JSON.stringify(body));
        assert.equal((result as { status: number }).status, 400);
    }
});

test("accepted fields come back trimmed, with optionals normalised to null", () => {
    const result = checkHelpSubmission({ title: "  Bug  ", description: "  It broke  ", steps: "   " });
    assert.deepEqual(result, {
        ok: true,
        title: "Bug",
        description: "It broke",
        steps: null,
        currentPage: null,
    });
});

test("a malformed body is a 400, never a 500", async () => {
    // The crew app retries 5xx, so an unparseable payload would become a loop.
    const thrower = { json: async () => { throw new SyntaxError("Unexpected token"); } };
    assert.deepEqual(await readJsonBody(thrower), { ok: false });
    // A body that parses but is not an object is equally unusable.
    assert.deepEqual(await readJsonBody({ json: async () => null }), { ok: false });
    assert.deepEqual(await readJsonBody({ json: async () => "a string" }), { ok: false });
    const good = await readJsonBody({ json: async () => ({ title: "t" }) });
    assert.equal(good.ok, true);
});

test("the throttle is five per hour, counted from a one-hour window", () => {
    assert.equal(HELP_SUBMISSIONS_PER_HOUR, 5);
    assert.equal(HELP_THROTTLE_WINDOW_MS, 3_600_000);
    assert.equal(isThrottled(4), false);
    assert.equal(isThrottled(5), true, "the fifth submission is the last one allowed");
    assert.equal(isThrottled(9), true);

    const now = new Date("2026-09-02T12:00:00.000Z");
    assert.equal(throttleWindowStart(now).toISOString(), "2026-09-02T11:00:00.000Z");
});

test("both routes parse safely, validate, and throttle before creating an issue", () => {
    for (const route of ["bug-fix", "request"]) {
        const source = readFileSync(
            path.join(__dirname, "..", "src", "app", "api", "help-chat", route, "route.ts"),
            "utf8"
        );
        assert.match(source, /readJsonBody\(req\)/, route);
        assert.match(source, /checkHelpSubmission\(parsed\.body\)/, route);
        assert.match(source, /isThrottled\(recent\)/, route);
        assert.doesNotMatch(source, /await req\.json\(\)/, `${route} must not parse the body unguarded`);
        // The throttle has to come BEFORE the GitHub call, or the limit does
        // not actually limit anything expensive.
        assert.ok(
            source.indexOf("isThrottled(recent)") < source.indexOf("createHelpChatGitHubIssue("),
            `${route}: throttle must precede issue creation`
        );
    }
});

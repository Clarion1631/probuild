/**
 * Phase 4 cron surface: the auth gate and the two fail-soft destinations.
 *
 * Why these three things and nothing else:
 *
 *   - The AUTH GATE fails CLOSED. In any deployed environment a missing
 *     CRON_SECRET must produce 401, not "no secret configured, let it through".
 *     Three routes copy the same six-line check, so three routes get the same
 *     test — a copied guard is exactly the kind that silently loses a clause.
 *
 *   - The two DESTINATIONS are env vars a human still has to set
 *     (MAIN_OFFICE_CHAT_WEBHOOK, PIPELINE_DIGEST_TO). Unset must be a logged
 *     skip, never a throw: an unconfigured digest is an ops task, not a
 *     production incident.
 *
 *   - The CARD TEXT is pure, so the wording rules (a job with no percent shows
 *     "no % yet", not 0%; a drifted override carries a review flag) are checked
 *     without a webhook.
 *
 * No Prisma is needed: src/lib/prisma.ts is a lazy proxy, so importing these
 * modules never opens a connection, and nothing below reaches a query.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { GET as recalcGet } from "../src/app/api/cron/percent-complete-recalc/route";
import { GET as marginCardGet } from "../src/app/api/cron/monday-margin-card/route";
import { GET as draggingGet } from "../src/app/api/cron/dragging-line/route";
import { buildMarginCardText, type MarginDigestJob } from "../src/lib/margin-digest";
import { postTextToWebhook } from "../src/lib/chat-webhook";

const ROUTES: Array<[string, (req: Request) => Promise<Response>]> = [
    ["percent-complete-recalc", recalcGet as never],
    ["monday-margin-card", marginCardGet as never],
    ["dragging-line", draggingGet as never],
];

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

function request(headers: Record<string, string> = {}) {
    return new Request("https://probuild.test/api/cron/x", { headers });
}

// ── auth gate ───────────────────────────────────────────────────────────────

for (const [name, handler] of ROUTES) {
    test(`${name}: 401 with no Authorization header when VERCEL_ENV is set`, async () => {
        process.env.VERCEL_ENV = "production";
        process.env.CRON_SECRET = "s3cret";
        const res = await handler(request());
        assert.equal(res.status, 401);
    });

    test(`${name}: 401 with the wrong bearer token`, async () => {
        process.env.VERCEL_ENV = "production";
        process.env.CRON_SECRET = "s3cret";
        const res = await handler(request({ authorization: "Bearer nope" }));
        assert.equal(res.status, 401);
    });

    test(`${name}: fails CLOSED — 401 when CRON_SECRET is not configured at all`, async () => {
        process.env.VERCEL_ENV = "production";
        delete process.env.CRON_SECRET;
        const res = await handler(request({ authorization: "Bearer anything" }));
        assert.equal(res.status, 401);
    });
}

// ── fail-soft destinations ──────────────────────────────────────────────────

test("an unset Chat webhook is a skip with a reason, not a throw", async () => {
    const result = await postTextToWebhook(undefined, "hello");
    assert.deepEqual(result, { sent: false, reason: "no webhook configured" });
});

test("a blank Chat webhook is a skip, not a throw", async () => {
    const result = await postTextToWebhook("   ", "hello");
    assert.equal(result.sent, false);
});

test("a webhook pointed anywhere but Google Chat is refused (SSRF guard)", async () => {
    const result = await postTextToWebhook("https://evil.example.com/v1/spaces/x", "hello");
    assert.equal(result.sent, false);
    assert.match(result.reason ?? "", /google chat/i);
});

// ── card wording ────────────────────────────────────────────────────────────

// Spread the override LAST rather than using `??` per field: an explicit
// `percentComplete: null` is the whole point of one of these cases, and `??`
// would silently swap it back for the default.
function job(over: Partial<MarginDigestJob> = {}): MarginDigestJob {
    return {
        id: "p1",
        name: "Berg ADU",
        url: "https://probuild.test/projects/p1/financial-overview",
        percentComplete: 62,
        source: "AUTO",
        auto: 62,
        asOfLabel: null,
        needsReview: false,
        earnedMargin: 12_400,
        ...over,
    };
}

const MONDAY = new Date("2026-09-07T14:00:00Z");

test("an auto job reads auto %, earned margin, and a link", () => {
    const text = buildMarginCardText([job()], MONDAY);
    assert.match(text, /Berg ADU/);
    assert.match(text, /auto 62%/);
    assert.match(text, /\$12,400/);
    assert.match(text, /<https:\/\/probuild\.test\/projects\/p1\/financial-overview\|adjust>/);
});

test("a manual override shows BOTH the auto value and the manual one with its date", () => {
    const text = buildMarginCardText(
        [job({ source: "MANUAL", percentComplete: 60, auto: 62, asOfLabel: "8/25" })],
        MONDAY
    );
    assert.match(text, /auto 62%/);
    assert.match(text, /manual 60% \(8\/25\)/);
});

test("a job with no percent complete says so — never 0%", () => {
    const text = buildMarginCardText([job({ percentComplete: null, auto: null, earnedMargin: null })], MONDAY);
    assert.match(text, /no % yet \(estimate uncoded or no schedule\)/);
    assert.doesNotMatch(text, /0%/);
    // Still linked: the point of the line is that somebody can go fix it.
    assert.match(text, /\|adjust>/);
});

test("a job with a percent but no contract still shows its percent on the card", () => {
    // earnedMargin is null because contract value is $0, NOT because the
    // percentage is missing. The line must not fall into the "no % yet" branch.
    const text = buildMarginCardText(
        [job({ source: "MANUAL", percentComplete: 60, auto: 62, earnedMargin: null })],
        MONDAY
    );
    assert.match(text, /manual 60%/);
    assert.doesNotMatch(text, /no % yet/);
    assert.match(text, /earned margin —/);
});

test("a drifted override carries a review flag", () => {
    const text = buildMarginCardText([job({ source: "MANUAL", percentComplete: 60, auto: 71, needsReview: true })], MONDAY);
    assert.match(text, /auto moved >5 pts since the override/);
});

test("an undrifted override carries no review flag", () => {
    const text = buildMarginCardText([job({ source: "MANUAL", percentComplete: 60, auto: 62 })], MONDAY);
    assert.doesNotMatch(text, /auto moved/);
});

test("no active jobs still produces a message rather than an empty post", () => {
    const text = buildMarginCardText([], MONDAY);
    assert.match(text, /No active jobs/);
});

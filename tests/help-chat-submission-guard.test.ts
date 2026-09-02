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

const LF = String.fromCharCode(10);
import {
    checkHelpSubmission,
    helpChatResponse,
    hourBucket,
    reserveHelpRequest,
    isMobileSubmission,
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
        conversationId: null,
        submissionId: null,
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
        assert.match(source, /reserveHelpRequest\(/, route);
        assert.doesNotMatch(source, /await req\.json\(\)/, `${route} must not parse the body unguarded`);
        // The throttle has to come BEFORE the GitHub call, or the limit does
        // not actually limit anything expensive.
        // The row must exist BEFORE the external call: a GitHub failure then
        // cannot lose the report, and a retry updates that row instead of
        // filing a duplicate.
        assert.ok(
            source.indexOf("reserveHelpRequest(") < source.indexOf("createHelpChatGitHubIssue("),
            `${route}: the throttle+row reservation must precede issue creation`
        );
        // Round 16 moved the raw UPDATE behind completeUnderLease, which fences
        // it on the lease token. Still an update of the reserved row, never a
        // second insert.
        assert.match(source, /completeUnderLease\(requestId, leaseToken/, `${route} must update the reserved row, not insert a second`);
    }
});

test("currentPage and conversationId are bounded and shape-checked", () => {
    // Both are echoed into a GitHub issue, so neither is free text.
    assert.equal(checkHelpSubmission({ title: "t", description: "d", currentPage: "/projects/abc?tab=1" }).ok, true);
    assert.equal(checkHelpSubmission({ title: "t", description: "d", currentPage: "https://evil.test" }).ok, false);
    assert.equal(checkHelpSubmission({ title: "t", description: "d", currentPage: "not-a-path" }).ok, false);
    // The crew app sends the SCREEN it was on, not a route. A path-only rule
    // 400'd every bug report from the phone.
    assert.equal(checkHelpSubmission({ title: "t", description: "d", currentPage: "mobile:Time Clock" }).ok, true);
    assert.equal(checkHelpSubmission({ title: "t", description: "d", currentPage: "mobile:Unknown" }).ok, true);
    assert.equal(checkHelpSubmission({ title: "t", description: "d", currentPage: "mobile:" }).ok, false);
    // Bounded: at most six words, each at most 120 chars.
    assert.equal(checkHelpSubmission({ title: "t", description: "d", currentPage: "mobile:a b c d e f g" }).ok, false);
    assert.equal(checkHelpSubmission({ title: "t", description: "d", currentPage: "/" + "x".repeat(600) }).ok, false);

    assert.equal(checkHelpSubmission({ title: "t", description: "d", conversationId: "ckabc123" }).ok, true);
    assert.equal(checkHelpSubmission({ title: "t", description: "d", conversationId: "x".repeat(65) }).ok, false);
    assert.equal(checkHelpSubmission({ title: "t", description: "d", conversationId: "has spaces" }).ok, false);
});


// ---- The exact body the crew app posts ------------------------------------
// gtr-probuild-mobile apps/mobile/lib/bugReport.ts builds this; if it stops
// validating here, every bug report from the phone becomes a 400.

const MOBILE_PAYLOAD = {
    title: "Mobile bug: the Save button does nothing",
    description: [
        "**What happened**\nTapped Save and nothing happened",
        "**Reported from the ProBuild crew app**\n- Screen: Time Clock\n- App version: 1.1.1\n- Platform: ios 18.2",
    ].join("\n\n"),
    currentPage: "mobile:Time Clock",
};

test("the crew app's exact payload validates and is classified as a BUG", () => {
    const result = checkHelpSubmission(MOBILE_PAYLOAD);
    assert.equal(result.ok, true);
    assert.equal((result as { currentPage: string }).currentPage, "mobile:Time Clock");
    // /api/help-chat/request labels everything "Feature Request" — a crew report
    // is a bug, and it posts there only because that is the endpoint its Bearer
    // token can reach.
    assert.equal(isMobileSubmission(MOBILE_PAYLOAD.currentPage), true);
    assert.equal(isMobileSubmission("/projects/abc"), false);
    assert.equal(isMobileSubmission(null), false);
});

test("the request route classifies a mobile submission as a bug, with bug labels", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "help-chat", "request", "route.ts"),
        "utf8"
    );
    assert.match(source, /const fromMobile = fromMobileClient \|\| isMobileSubmission\(currentPage\)/);
    assert.match(source, /type: fromMobile \? "bug" : "feature_request"/);
    assert.match(source, /labelPrefix: fromMobile \? "Bug Fix" : "Feature Request"/);
    assert.match(source, /fromMobile \? \["bug-fix", "from-mobile"\]/);
});

test("submissionId is optional, bounded, and makes a retry idempotent", () => {
    // The crew app does not send one today, so requiring it would break it.
    assert.equal(checkHelpSubmission({ title: "t", description: "d" }).ok, true);
    assert.equal(checkHelpSubmission({ title: "t", description: "d", submissionId: "abc-123" }).ok, true);
    assert.equal(checkHelpSubmission({ title: "t", description: "d", submissionId: "x".repeat(65) }).ok, false);
    assert.equal(checkHelpSubmission({ title: "t", description: "d", submissionId: "has space" }).ok, false);

    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "help-chat", "submission-guard.ts"), "utf8");
    const fn = source.slice(source.indexOf("export async function reserveHelpRequest"));
    // The idempotency lookup comes FIRST: a client retrying a request that
    // actually succeeded must not be charged another slot for it.
    assert.ok(
        fn.indexOf("findUnique") < fn.indexOf("HelpSubmissionQuota"),
        "the submissionId lookup must precede the counter"
    );
});

test("the idempotency key is scoped PER USER, not globally", () => {
    // Clients choose these values. A globally unique key means two users who
    // pick the same one collide — and the loser's lookup returns SOMEBODY
    // ELSE'S report, which is a data leak, not just a bug.
    const schema = readFileSync(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model HelpRequest"));
    const body = model.slice(0, model.indexOf(LF + "}"));
    assert.match(body, /@@unique\(\[userId, submissionId\]\)/);
    assert.doesNotMatch(body, /submissionId\s+String\?\s+@unique/, "must not be globally unique");

    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "help-chat", "submission-guard.ts"), "utf8");
    assert.match(source, /userId_submissionId: \{ userId: input\.userId, submissionId: input\.submissionId \}/);

    // And the migration/apply script agree with the schema.
    const migration = readFileSync(
        path.join(__dirname, "..", "prisma", "migrations", "20260901000000_payroll_phase5", "migration.sql"),
        "utf8"
    );
    assert.match(migration, /"HelpRequest_userId_submissionId_key" ON "HelpRequest"\("userId", "submissionId"\)/);
});

test("the throttle is a conditional UPDATE on a counter row, not a count-then-insert", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "help-chat", "submission-guard.ts"), "utf8");
    const fn = source.slice(source.indexOf("export async function reserveHelpRequest"));
    // Five concurrent requests all read the same count and all inserted. A
    // conditional UPDATE lets the database decide, once.
    assert.match(fn, /UPDATE "HelpSubmissionQuota"/);
    assert.match(fn, /SET "count" = "count" \+ 1/);
    assert.match(fn, /AND "count" < \$\{HELP_SUBMISSIONS_PER_HOUR\}/);
    assert.match(fn, /RETURNING "count"/);
    assert.match(fn, /ON CONFLICT \("userId", "hourBucket"\) DO NOTHING/, "insert-on-missing first");
});

test("the hour bucket is the truncated hour", () => {
    assert.equal(hourBucket(new Date("2026-09-02T14:37:12.500Z")).toISOString(), "2026-09-02T14:00:00.000Z");
    assert.equal(hourBucket(new Date("2026-09-02T15:00:00.000Z")).toISOString(), "2026-09-02T15:00:00.000Z");
});

test("the slot and the row commit together, or neither does", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "help-chat", "submission-guard.ts"), "utf8");
    const fn = source.slice(source.indexOf("export async function reserveHelpRequest"));
    // They were two separate statements: a failure in between either burned a
    // slot with no row to show for it, or created a row the counter never saw.
    // One transaction, over an injectable client that defaults to prisma.
    assert.match(fn, /client\.\$transaction\(async \(tx\) => \{/);
    assert.match(fn, /= prisma as never/);
    const tx = fn.slice(fn.indexOf("$transaction"));
    // The order INVERTED in review round 15, deliberately: the HelpRequest
    // insert now comes FIRST so that a replay (which conflicts and returns no
    // row) never reaches the counter. Charging the quota first meant a client
    // retrying its own report could throttle itself out of it.
    assert.ok(tx.indexOf('INSERT INTO "HelpRequest"') < tx.indexOf('UPDATE "HelpSubmissionQuota"'));
    // Throwing is what rolls the slot back when the limit is gone.
    assert.match(fn, /throw new HelpThrottledError\(\)/);
});

test("a retry resumes a submission stranded mid-flight instead of returning early", () => {
    // If the previous attempt died before it could open the issue, returning
    // the `submitting` row would strand that report forever.
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "help-chat", "submission-guard.ts"), "utf8");
    assert.match(source, /HELP_SUBMITTING_STALE_MS/);
    // providerState ALONE decides. Keying off status stranded every
    // 'submitted_no_issue' row: GitHub was down, the report was saved, and no
    // retry would ever finish it because the status had already moved on.
    assert.match(source, /existing\.providerState !== "created" && age > HELP_SUBMITTING_STALE_MS/);
    assert.doesNotMatch(source, /existing\.status === "submitting" &&/);
    // A resume must not consume a second slot — it was already paid for.
    const fn = source.slice(source.indexOf("export async function reserveHelpRequest"));
    assert.ok(
        fn.indexOf("resume: stale") < fn.indexOf("HelpSubmissionQuota"),
        "the resume path returns before the counter is touched"
    );

    for (const route of ["request", "bug-fix"]) {
        const routeSource = readFileSync(
            path.join(__dirname, "..", "src", "app", "api", "help-chat", route, "route.ts"),
            "utf8"
        );
        assert.match(routeSource, /reserved\.existing && !reserved\.resume/, route);
    }
});

test("a mobile caller with no submissionId is refused, with a coded error", () => {
    // The app retries on network failure. Without an idempotency key every retry
    // is a new report and a new GitHub issue, so there is no safe way to serve
    // it — the web widget (a human clicking once) keeps the key optional.
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "help-chat", "request", "route.ts"),
        "utf8"
    );
    // Derived from HOW THEY AUTHENTICATED, never from the posted body: a body
    // field cannot establish anything about the client.
    assert.match(source, /const fromMobileClient = isMobileClient\(auth\)/);
    assert.match(source, /fromMobileClient && !submissionId/);
    assert.match(source, /MOBILE_SUBMISSION_ID_REQUIRED/);
    assert.match(source, /status: 400/);
});

test("a resume asks GitHub before filing, using the submission marker", () => {
    // A resume happens precisely because the last attempt's outcome is unknown:
    // it may have created the issue and died before recording it.
    const guard = readFileSync(path.join(__dirname, "..", "src", "lib", "help-chat", "submission-guard.ts"), "utf8");
    assert.match(guard, /probuild-submission:\$\{requestId\}/);

    const route = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "help-chat", "request", "route.ts"),
        "utf8"
    );
    assert.match(route, /reserved\.resume \? await findIssueByMarker\(marker, deadline\) : null/);
    assert.match(route, /alreadyFiled \?\?/, "only file when the search found nothing");
    // The marker goes INTO the body, or the search could never find it.
    assert.match(route, /metadata: \[[\s\S]{0,200}marker,/);
    // providerState records the outcome so the next resume knows.
    // Round 16: the same either/or, expressed through the fenced writer so a
    // superseded attempt cannot record its own outcome.
    assert.match(route, /completeUnderLease\(requestId, leaseToken, \{ filed: false, status: "submitted_no_issue" \}\)/);
    assert.match(route, /filed: true,\s*\n\s*issueNumber: ghIssue\.number/);
});

test("BOTH help routes reconcile with the provider before filing", () => {
    // The bug-fix route had the row-first ordering but not the reconciliation,
    // so a crash between "GitHub created the issue" and "we recorded it" left a
    // pending row that a retry would file a SECOND issue for.
    for (const route of ["request", "bug-fix"]) {
        const source = readFileSync(
            path.join(__dirname, "..", "src", "app", "api", "help-chat", route, "route.ts"),
            "utf8"
        );
        assert.match(source, /const marker = submissionMarker\(requestId\);/, route);
        assert.match(source, /reserved\.resume \? await findIssueByMarker\(marker, deadline\) : null/, route);
        assert.match(source, /alreadyFiled \?\?/, route);
        assert.match(source, /marker,/, `${route} must put the marker in the issue body`);
        // providerState / providerIssueRef are written by completeUnderLease now.
        assert.match(source, /completeUnderLease\(/, route);
        assert.match(source, /issueNumber: ghIssue\.number/, route);
        // The search must happen BEFORE the create, or it proves nothing.
        assert.ok(
            source.indexOf("findIssueByMarker(marker)") < source.indexOf("createHelpChatGitHubIssue("),
            `${route}: reconcile before filing`
        );
    }
});

test("a crash between provider and DB leaves a row a retry can finish", () => {
    // The failure this protocol exists for: the issue exists, our row does not
    // know it. providerState stays 'pending', so the retry resumes — and the
    // marker search finds the issue instead of opening a second one.
    const bugFix = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "help-chat", "bug-fix", "route.ts"),
        "utf8"
    );
    assert.match(bugFix, /completeUnderLease\(requestId, leaseToken, \{ filed: false, status: "submitted_no_issue" \}\)/);
    assert.match(bugFix, /filed: true/);
    // 'pending' vs 'created' now lives in ONE place, so the two routes cannot
    // drift on what a half-finished submission looks like.
    const guardSource = readFileSync(path.join(__dirname, "..", "src", "lib", "help-chat", "submission-guard.ts"), "utf8");
    assert.match(guardSource, /"providerState" = 'created'/);
    assert.match(guardSource, /"providerState" = 'pending'/);
});

test("the client type comes from the auth result, never the posted body", async () => {
    const { isMobileClient } = await import("../src/lib/help-chat/submission-guard");
    assert.equal(isMobileClient({ via: "mobile-jwt" }), true);
    assert.equal(isMobileClient({ via: "next-auth" }), false);
    assert.equal(isMobileClient(null), false);
    assert.equal(isMobileClient({}), false);
    // Anyone can post currentPage: "mobile:..." — it labels the issue, it does
    // not establish who is calling.
    const guard = readFileSync(path.join(__dirname, "..", "src", "lib", "help-chat", "submission-guard.ts"), "utf8");
    assert.match(guard, /export function isMobileClient/);
    assert.match(guard, /auth\?\.via === "mobile-jwt"/);
});

test("the provider lease is a compare-and-set, taken before any GitHub call", () => {
    const guard = readFileSync(path.join(__dirname, "..", "src", "lib", "help-chat", "submission-guard.ts"), "utf8");
    const fn = guard.slice(guard.indexOf("export async function claimProviderLease"));
    const body = fn.slice(0, fn.indexOf(String.fromCharCode(10) + "}"));
    // Only if nobody holds it, or the previous holder's lease has expired.
    assert.match(body, /providerLeaseExpiresAt" IS NULL OR "providerLeaseExpiresAt" < /);
    assert.match(body, /providerState" IS DISTINCT FROM 'created'/);
    // Round 16: the claim hands back a FENCING TOKEN, not a boolean. A late
    // completion from a superseded attempt is rejected by matching on it.
    assert.match(body, /return claimed === 1 \? token : null;/);
    assert.match(guard, /WHERE "id" = \$\{requestId\} AND "providerLeaseToken" = \$\{leaseToken\}/);

    for (const route of ["request", "bug-fix"]) {
        const source = readFileSync(
            path.join(__dirname, "..", "src", "app", "api", "help-chat", route, "route.ts"),
            "utf8"
        );
        assert.match(source, /await claimProviderLease\(requestId\)/, route);
        // Two attempts reaching this point at once would BOTH file, because
        // neither issue exists yet when they both search for the marker.
        assert.ok(
            source.indexOf("claimProviderLease(requestId)") < source.indexOf("findIssueByMarker("),
            `${route}: claim the lease before looking, let alone filing`
        );
        assert.ok(
            source.indexOf("claimProviderLease(requestId)") < source.indexOf("createHelpChatGitHubIssue("),
            `${route}: claim the lease before creating`
        );
    }
});


// ---------------------------------------------------------------------------
// Review round 15, items 3 and 4: one atomic reservation, and a 202 for a
// report that is saved but not filed.
// ---------------------------------------------------------------------------

/**
 * A fake client standing in for one Postgres connection. `insertWins` is what
 * that connection's `INSERT ... ON CONFLICT DO NOTHING` returns: a row when it
 * won the race, nothing when another connection got there first.
 */
function fakeClient(options: { insertWins: boolean; existing?: any; quota?: boolean }) {
    const sql: string[] = [];
    const tx = {
        $queryRaw: (strings: TemplateStringsArray) => {
            const text = strings.join("?");
            sql.push(text);
            if (text.includes('INSERT INTO "HelpRequest"')) {
                return Promise.resolve(options.insertWins ? [{ id: "new-row" }] : []);
            }
            if (text.includes('"HelpSubmissionQuota"')) {
                return Promise.resolve(options.quota === false ? [] : [{ count: 1 }]);
            }
            return Promise.resolve([]);
        },
        $executeRaw: (strings: TemplateStringsArray) => {
            sql.push(strings.join("?"));
            return Promise.resolve(1);
        },
        helpRequest: {
            findUnique: () => Promise.resolve(options.existing ?? null),
        },
    };
    return {
        sql,
        client: { $transaction: <T,>(fn: (t: any) => Promise<T>) => fn(tx) },
    };
}

const SUBMISSION = {
    userId: "u1",
    type: "bug",
    question: "t",
    response: "d",
    currentPage: "mobile:Time Clock",
    conversationId: null,
    submissionId: "abc123",
};

test("two concurrent requests with the same submissionId BOTH succeed on one row", async () => {
    // The winner inserts.
    const winner = fakeClient({ insertWins: true });
    const first = await reserveHelpRequest(SUBMISSION, winner.client as never);

    // The loser's INSERT returns nothing (ON CONFLICT DO NOTHING) and it reads
    // the committed row instead. Under the old read-then-insert BOTH callers
    // found nothing, both inserted, and the loser got a unique-violation 500.
    const loser = fakeClient({
        insertWins: false,
        existing: { id: "new-row", status: "submitting", createdAt: new Date(), providerState: "pending" },
    });
    const second = await reserveHelpRequest(SUBMISSION, loser.client as never);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.ok && first.id, "new-row");
    assert.equal(second.ok && second.id, "new-row", "both callers end up on the SAME report");
    assert.equal(second.ok && second.existing, true);

    // And the reservation really is one statement, not a read followed by a write.
    assert.match(winner.sql[0], /INSERT INTO "HelpRequest"[\s\S]*ON CONFLICT \("userId", "submissionId"\) DO NOTHING[\s\S]*RETURNING/);
});

test("a replay does not spend a quota slot — only a genuinely new report does", async () => {
    const fresh = fakeClient({ insertWins: true });
    await reserveHelpRequest(SUBMISSION, fresh.client as never);
    assert.ok(fresh.sql.some((s) => s.includes('"HelpSubmissionQuota"')), "a new report charges the quota");

    const replay = fakeClient({
        insertWins: false,
        existing: { id: "new-row", status: "submitting", createdAt: new Date(), providerState: "pending" },
    });
    await reserveHelpRequest(SUBMISSION, replay.client as never);
    assert.ok(
        !replay.sql.some((s) => s.includes('"HelpSubmissionQuota"')),
        "a retry must not be able to throttle the user out of their own report"
    );
});

test("the quota rolls the new row back with it when the slot is gone", async () => {
    const throttled = fakeClient({ insertWins: true, quota: false });
    const result = await reserveHelpRequest(SUBMISSION, throttled.client as never);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "throttled");
    // Both statements ran in ONE $transaction callback, so the throw undoes the insert.
    assert.ok(throttled.sql.some((s) => s.includes('INSERT INTO "HelpRequest"')));
});

test("a report that is saved but NOT filed answers 202, not 200", () => {
    const pending = helpChatResponse({ body: { request: { id: "r1" } }, filed: false, submissionId: "abc123" });
    assert.equal(pending.status, 202);

    const filed = helpChatResponse({ body: { request: { id: "r1" } }, filed: true, submissionId: "abc123" });
    assert.equal(filed.status, 200);
});

test("the 202 carries back the submissionId the client must retry with", async () => {
    const pending = helpChatResponse({ body: {}, filed: false, submissionId: "abc123" });
    const body = await pending.json();
    assert.equal(body.status, "pending");
    assert.equal(body.submissionId, "abc123", "without this the client cannot resume the SAME report");

    const filed = await helpChatResponse({ body: {}, filed: true, submissionId: "abc123" }).json();
    assert.equal(filed.status, "filed");
});

test("every not-yet-filed exit of BOTH help routes goes through the 202 helper", () => {
    for (const route of ["src/app/api/help-chat/request/route.ts", "src/app/api/help-chat/bug-fix/route.ts"]) {
        const source = readFileSync(path.join(process.cwd(), route), "utf8");
        // The duplicate branch and the lease branch are the two places a report
        // that may not be filed was reported as terminal.
        assert.match(source, /reserved\.existing && !reserved\.resume[\s\S]{0,400}helpChatResponse\(/, route);
        assert.match(source, /claimProviderLease\(requestId\)[\s\S]{0,400}helpChatResponse\(/, route);
        // Both decide on the STORED providerState, never on "we got this far".
        assert.match(source, /filed: (reserved\.providerState|inFlight\?\.providerState) === "created"/, route);
    }
});

test("a pending row stays resumable, so a later retry finishes it", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/help-chat/submission-guard.ts"), "utf8");
    // The durable completion path: providerState is the signal, and anything
    // that is not "created" is picked back up by the next attempt carrying the
    // same submissionId.
    assert.match(source, /existing\.providerState !== "created" && age > HELP_SUBMITTING_STALE_MS/);
});

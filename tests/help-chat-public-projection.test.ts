/**
 * A HELP REQUEST SAYS ONLY WHAT THE REPORTER NEEDS TO HEAR.
 *
 * The hole (round 10, finding 5). Every help-chat response returned the whole
 * HelpRequest row. That row carries the PROVIDER LEASE: `providerLeaseToken` is
 * the fencing token that decides which concurrent attempt is allowed to call
 * GitHub, and `providerLeaseExpiresAt` is when it can be stolen. It is a
 * capability — `completeUnderLease` accepts anything holding it — and it was in
 * the body of an ordinary bug report, next to `providerState`,
 * `providerIssueRef`, `externalIssueRef` and `slackMessageTs`.
 *
 * One projection now stands in front of every response, asserted here as an
 * ALLOWLIST: a denylist of the five names we know about is wrong the moment a
 * sixth workflow column is added, and this row has grown one in nearly every
 * round of this review.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    PUBLIC_HELP_REQUEST_FIELDS,
    publicGithubIssue,
    toPublicHelpRequest,
} from "../src/lib/help-chat/submission-guard";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-help-chat-projection";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";

/** A row shaped like the real one, every workflow column populated so there is something to leak. */
function storedRow() {
    return {
        id: "hr-1",
        userId: "u-1",
        type: "bug",
        question: "It broke",
        response: "Steps to reproduce: ...",
        currentPage: "mobile",
        status: "submitted",
        conversationId: null,
        submissionId: "abc-g1",
        changeDescription: null,
        changeLocation: "https://github.com/Clarion1631/probuild/issues/7",
        externalIssueRef: "github-issue:7",
        providerIssueRef: "7",
        providerState: "created",
        providerLeaseToken: "lease-token-nobody-should-see",
        providerLeaseExpiresAt: new Date("2026-09-03T12:00:00.000Z"),
        slackMessageTs: "1725000000.0001",
        completedAt: null,
        verifiedAt: null,
        createdAt: new Date("2026-09-03T11:00:00.000Z"),
    };
}

test("the projection is an ALLOWLIST — nothing outside it survives", () => {
    const projected = toPublicHelpRequest(storedRow()) as Record<string, unknown>;
    assert.deepEqual(
        Object.keys(projected).sort(),
        [...PUBLIC_HELP_REQUEST_FIELDS].sort(),
        "exactly the public fields, no more"
    );

    // Named individually too, because these are the ones that mattered.
    for (const secret of [
        "providerLeaseToken",
        "providerLeaseExpiresAt",
        "providerState",
        "providerIssueRef",
        "externalIssueRef",
        "changeLocation",
        "slackMessageTs",
        "userId",
    ]) {
        assert.ok(!(secret in projected), `${secret} must not reach the client`);
    }

    // THE CONTROL: the stored row really does carry all of them, so the
    // assertions above are about the projection and not about an empty fixture.
    const stored = storedRow() as Record<string, unknown>;
    assert.equal(stored.providerLeaseToken, "lease-token-nobody-should-see");
    assert.ok(Object.keys(stored).length > Object.keys(projected).length);
});

test("what the reporter DOES get is enough to be useful", () => {
    // Without this the projection could be an empty object and still pass above.
    const projected = toPublicHelpRequest(storedRow()) as Record<string, unknown>;
    assert.equal(projected.id, "hr-1");
    assert.equal(projected.question, "It broke");
    assert.equal(projected.response, "Steps to reproduce: ...");
    assert.equal(projected.status, "submitted");
    assert.equal(projected.submissionId, "abc-g1");
    assert.equal(toPublicHelpRequest(null), null);
    assert.equal(toPublicHelpRequest(undefined), null);
});

test("the GitHub issue still reaches the client — through its own channel", () => {
    // A replay has to be able to say which issue the first attempt filed. It
    // used to say it by leaking the row; `githubIssue` is the field the widget
    // already reads.
    assert.deepEqual(publicGithubIssue(storedRow()), {
        number: 7,
        url: "https://github.com/Clarion1631/probuild/issues/7",
    });
    assert.equal(publicGithubIssue({ providerIssueRef: null }), null);
    assert.equal(publicGithubIssue(null), null);
    // Junk in the column is not an issue number.
    assert.equal(publicGithubIssue({ providerIssueRef: "not-a-number" }), null);
    assert.equal(publicGithubIssue({ providerIssueRef: "0" }), null);
});

test("every help-chat response goes through the projection", () => {
    // The unit tests above prove the RULE; this proves it is the one every
    // surface applies. A route that returns the row directly is how the five
    // responses in these two files leaked in the first place.
    const SRC = path.join(__dirname, "..", "src");
    for (const file of [
        "app/api/help-chat/request/route.ts",
        "app/api/help-chat/bug-fix/route.ts",
        "app/api/help-chat/history/route.ts",
    ]) {
        const source = readFileSync(path.join(SRC, file), "utf8");
        assert.match(source, /toPublicHelpRequest\(/, `${file} must project its responses`);
        // No raw row survives as a response body value.
        assert.ok(
            !/\brequest: (prior|inFlight|lost|saved|request)\b/.test(source),
            `${file} still hands a raw row back`
        );
        assert.ok(!/^\s+request,$/m.test(source), `${file} still hands a raw row back by shorthand`);
    }
});

test("finishing a submission RELEASES the lease", () => {
    // The token is a capability; an attempt that has finished has no use for
    // one, and leaving it on the row is what made the leak worth having.
    const guard = readFileSync(
        path.join(__dirname, "..", "src", "lib", "help-chat", "submission-guard.ts"),
        "utf8"
    );
    const fn = guard.slice(guard.indexOf("export async function completeUnderLease"));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    assert.equal(
        (body.match(/"providerLeaseToken" = NULL/g) || []).length,
        2,
        "both the filed and the pending branch clear it"
    );
    assert.equal((body.match(/"providerLeaseExpiresAt" = NULL/g) || []).length, 2);
    // ...and the fencing is still the WHERE, which is evaluated against the
    // pre-update row, so releasing it in the same statement is safe.
    assert.equal(
        (body.match(/AND "providerLeaseToken" = \$\{leaseToken\}/g) || []).length,
        2,
        "a superseded attempt is still rejected"
    );
});

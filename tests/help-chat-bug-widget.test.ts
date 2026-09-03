/**
 * Bug widget access (Phase 5 spec G5 / test 5).
 *
 * Two halves, because the gate is two things:
 *  1. the WHO — src/lib/help-chat/bug-widget-auth.ts, tested as a matrix;
 *  2. the CAN-IT-EVEN-REACH-THE-ROUTE — src/proxy.ts. Before Phase 5 neither
 *     help-chat path was allowlisted, so a phone's Bearer POST was answered
 *     with a 307 to /login and never reached any gate at all (the same failure
 *     mode as the skip-lunch bug pinned in tests/proxy-mobile-routes.test.ts).
 *
 * The 401 (no credentials) and the Bearer-token cases live in
 * authenticateMobileOrSession, which needs a database; they are asserted here
 * at the seam the routes actually use — a null actor is exactly what that
 * function's failure produces — plus a source check that both routes call it.
 * A full request-level test needs the CI Postgres and is not attempted here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    authorizeBugWidgetUser,
    bugFixIssueLabels,
    BUG_WIDGET_ROLES,
    canTriggerBugWidgetAgent,
} from "../src/lib/help-chat/bug-widget-auth";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-help-chat-tests";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

test("every active staff role may file — this used to be ADMIN-only", () => {
    for (const role of BUG_WIDGET_ROLES) {
        assert.deepEqual(authorizeBugWidgetUser({ role, status: "ACTIVATED" }), { ok: true }, role);
    }
    // EMPLOYEE is a legacy role value that prod rows can still carry; somebody
    // stuck on one must still be able to report the bug that is blocking them.
    assert.deepEqual(BUG_WIDGET_ROLES, ["ADMIN", "MANAGER", "FIELD_CREW", "EMPLOYEE", "FINANCE"]);
});

test("no authenticated user is 401; a disabled or pending account is 403", () => {
    assert.deepEqual(authorizeBugWidgetUser(null), { ok: false, status: 401, error: "Unauthorized" });
    assert.equal(authorizeBugWidgetUser({ role: "FIELD_CREW", status: "DISABLED" }).ok, false);
    assert.equal(
        (authorizeBugWidgetUser({ role: "FIELD_CREW", status: "DISABLED" }) as { status: number }).status,
        403
    );
    // PENDING is an unaccepted invitation, not a staff member. The check is
    // positive (=== ACTIVATED), so a future status value fails closed too.
    assert.equal(authorizeBugWidgetUser({ role: "ADMIN", status: "PENDING" }).ok, false);
    assert.equal(authorizeBugWidgetUser({ role: "CLIENT", status: "ACTIVATED" }).ok, false);
});

// ── Filing does not equal triggering an agent (round-31 gate, item 3) ───────
//
// Every ACTIVATED role may file a bug report (test above). But the report
// used to always carry "agent-task" — the label GitHub Actions watches to
// hand the issue to Phantom, which then acts on the repo unattended. Ordinary
// crew could reach that by filing a bug report from the widget. Only
// ADMIN/MANAGER may trigger it now; everyone else still gets a real issue,
// routed to a human via needs-triage.

test("only ADMIN/MANAGER can trigger the agent pipeline — every other filer role cannot", () => {
    for (const role of BUG_WIDGET_ROLES) {
        const expected = role === "ADMIN" || role === "MANAGER";
        assert.equal(canTriggerBugWidgetAgent({ role, status: "ACTIVATED" }), expected, role);
    }
    assert.equal(canTriggerBugWidgetAgent(null), false);
});

test("a FIELD_CREW or EMPLOYEE bug report is filed WITHOUT the agent-task label", () => {
    for (const role of ["FIELD_CREW", "EMPLOYEE", "FINANCE"] as const) {
        const labels = bugFixIssueLabels({ role, status: "ACTIVATED" });
        assert.ok(!labels.includes("agent-task"), `${role} must not reach agent-task`);
        assert.deepEqual(labels, ["bug-fix", "needs-triage"], role);
    }
});

test("ADMIN/MANAGER bug reports still get agent-task — the automation trigger is not removed entirely", () => {
    for (const role of ["ADMIN", "MANAGER"] as const) {
        assert.deepEqual(bugFixIssueLabels({ role, status: "ACTIVATED" }), ["bug-fix", "agent-task"], role);
    }
});

test("the bug-fix route resolves its GitHub labels from bugFixIssueLabels(auth.user), not a hardcoded array", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "help-chat", "bug-fix", "route.ts"),
        "utf8"
    );
    assert.match(source, /labels: bugFixIssueLabels\(auth\.user\)/);
    assert.doesNotMatch(source, /labels: \["bug-fix", "agent-task"\]/, "must not hand every filer role automation");
});

test("both routes authenticate through authenticateMobileOrSession, not getServerSession", () => {
    for (const route of ["bug-fix", "request"]) {
        const source = readFileSync(
            path.join(__dirname, "..", "src", "app", "api", "help-chat", route, "route.ts"),
            "utf8"
        );
        assert.match(source, /authenticateMobileOrSession\(req\)/, route);
        assert.match(source, /authorizeBugWidgetUser\(auth\.user\)/, route);
        assert.doesNotMatch(source, /getServerSession/, `${route} must not fall back to a session-only gate`);
        assert.doesNotMatch(source, /role !== "ADMIN"/, `${route} must not keep the old admin-only gate`);
    }
});

test("both help-chat submit paths are on the proxy's Bearer allowlist, exactly", async () => {
    const { isMobileAuthenticatedRoute } = await import("../src/proxy");
    for (const allowed of [
        "/api/help-chat/bug-fix",
        "/api/help-chat/bug-fix/",
        "/api/help-chat/request",
        "/api/help-chat/request/",
    ]) {
        assert.equal(isMobileAuthenticatedRoute(allowed), true, allowed);
    }
    for (const denied of [
        "/api/help-chat",
        "/api/help-chat/",
        "/api/help-chat/chat",
        "/api/help-chat/bug-fix/extra",
        "/api/help-chat/requestx",
        "/api/help-chat/bug-fixx",
    ]) {
        assert.equal(isMobileAuthenticatedRoute(denied), false, denied);
    }
});

test("a Bearer header still cannot smuggle a Server Action past the proxy on these paths", async () => {
    const { default: proxy } = await import("../src/proxy");
    const { NextRequest } = await import("next/server");
    const event = { waitUntil() {} } as any;
    const make = (headers: Record<string, string>) =>
        new NextRequest("https://probuild.test/api/help-chat/request", { method: "POST", headers });

    const plain = await proxy(make({ authorization: "Bearer fake" }), event);
    assert.ok(plain instanceof Response, "proxy returns a response for the Bearer request");
    assert.equal(plain.headers.get("x-middleware-next"), "1");

    const action = await proxy(make({ authorization: "Bearer fake", "next-action": "deadbeef" }), event);
    assert.ok(action instanceof Response);
    assert.notEqual(action.headers.get("x-middleware-next"), "1");
    assert.ok([302, 303, 307, 308, 401, 403].includes(action.status), `got ${action.status}`);
});

import { withAuth } from "next-auth/middleware";
import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import { isStaffAccountEnabled } from "@/lib/staff-status";

// These shared web/mobile API handlers always call authenticateMobileOrSession,
// so they can safely receive bearer requests without a browser session. Keep
// this allowlist exact: a generic Bearer shortcut would bypass proxy auth for
// pages and Server Actions that rely on this boundary.
const MOBILE_AUTHENTICATED_ROUTE_PATTERNS = [
    /^\/api\/calendar\/sync\/?$/,
    /^\/api\/manager\/dashboard\/?$/,
    /^\/api\/manager\/(?:jobs|employees)(?:\/[^/]+)?\/?$/,
    // /api/time-entries, /api/time-entries/[id], and the two per-entry sub-routes the
    // crew app calls with a Bearer token: [id]/meal-skip (skip-lunch request/decision)
    // and [id]/logistics (voice-dump clean-up). Both handlers call
    // authenticateMobileOrSession. Without them here the proxy answered the app's
    // POST with a 307 to /login — the "Couldn't send" skip-lunch failure (2026-08-30).
    /^\/api\/time-entries(?:\/[^/]+(?:\/(?:meal-skip|logistics))?)?\/?$/,
    // The help widget's two submit endpoints. Both call
    // authenticateMobileOrSession and then their own ACTIVATED-staff check
    // (src/lib/help-chat/bug-widget-auth.ts), so bypassing the proxy hands auth
    // to the route rather than removing it — the app's "Report a bug" screen
    // posts here with a Bearer token. Exact match: no descendant of
    // /api/help-chat/ inherits this.
    /^\/api\/help-chat\/(?:bug-fix|request)\/?$/,
    /^\/api\/files\/(?:signed-upload|register)\/?$/,
    /^\/api\/(?:expenses|receipts\/parse)\/?$/,
    /^\/api\/rooms\/scan-import\/?$/,
    /^\/api\/rooms\/[^/]+\/(?:usdz|ai-furnish)\/?$/,
    /^\/api\/projects\/?$/,
    /^\/api\/projects\/[^/]+\/(?:cost-codes|buckets|estimate-items|estimates)\/?$/,
];

// api/selections/item-comments is reachable by BOTH portal clients (no
// NextAuth session — just the client_portal_token cookie) and staff. It
// self-authorizes both sides internally via assertDecisionActorAccess, the
// same way every api/portal/* route does — bypassing the proxy here does not
// bypass auth, it hands auth to the route handler instead.
// api/selections/ai-sort is staff-only, but it must ALSO bypass the proxy:
// the route does its own getCurrentUserWithPermissions()+canAccessProject
// check and returns a clean 403 for a portal client or unauthenticated
// caller (docs/superpowers/plans/2026-07-30-selection-ai-sort.md) — without
// this bypass, withAuth's redirect-to-/login would intercept the request
// first and a portal client would never see the 403 the route promises.
// api/selections/link-schedule is the same shape (staff-only, self-
// authorizing, must return a clean 403) for the schedule-linking AI
// suggestion route (docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md).
// api/pdf/estimates only redirects to the self-gating portal estimate page;
// api/pdf/invoices and api/pdf/change-orders (incl. the billing sub-route)
// self-authorize in the handler via src/lib/pdf-route-auth (staff session or
// matching portal client), so portal clients can fetch their documents
// without a staff session.
// api/office-tasks/ingest is a machine-to-machine endpoint (GTR Automations
// bot) that self-authenticates with a Bearer secret (OFFICE_TASKS_INGEST_SECRET)
// and must return a clean 401, not a redirect to /login. Exact-match only —
// future descendants under /api/office-tasks/ must NOT inherit the bypass.
// api/health/pipeline is the same shape: an ops/monitoring read that
// self-authenticates INSIDE the route (Bearer CRON_SECRET, or a staff session
// with financialReports). Without this bypass NextAuth intercepts it first and
// a headless Bearer check gets redirected to /login instead of its JSON.
// Exact-match only — nothing else under /api/health/ inherits it.
// api/receipts/intake and api/receipts/intake/<id>/archived are the same shape
// (Receipt Pipeline v2, docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §3): the Apps
// Script forwarders and the nightly archive mirror self-authenticate with
// x-receipt-intake-secret and need a clean 401 rather than a /login redirect,
// and the mobile app reaches the same POST with a Bearer token. Both are listed
// EXACTLY — the [id]/archived form is spelled out rather than made a descendant
// wildcard, so a future /api/receipts/intake/<id>/anything route does not
// inherit the bypass before anyone has reviewed its gates. Everything else
// under /api/receipts (notably /api/receipts/parse) keeps the proxy boundary.
// api/automation/receipt-requests/threads and .../answers are the qbo-clasp
// bridge for the missing-receipt Chat digest (Phase 2 §4). Same shape again:
// the Apps Script mirror/forwarder self-authenticates with
// x-receipt-intake-secret and needs a clean 401, not a /login redirect. Listed
// EXACTLY — a future /api/automation/receipt-requests/<anything> route must not
// inherit the bypass before its own gates have been reviewed, and the rest of
// /api/automation (the register's mark-reviewed route) keeps the proxy boundary.
// privacy / terms / account-deletion are static legal pages with no data access.
// The app stores require them to be reachable by a logged-out reviewer, and Google
// Play specifically requires a public account-deletion URL.
const PUBLIC_PROXY_BYPASS_PATTERN = /^\/(?:api\/health$|api\/health\/pipeline\/?$|api\/(?:auth|cron|twilio|webhook|payments|portal|integrations|mcp(?:\/|$)|version|pdf\/(?:estimates|invoices|change-orders)|sub-portal|mobile|selections\/(?:item-comments|ai-sort|link-schedule))(?:\/|$)|api\/office-tasks\/ingest\/?$|api\/receipts\/intake\/?$|api\/receipts\/intake\/start\/?$|api\/receipts\/intake\/[^/]+\/(?:archived|finalize)\/?$|api\/automation\/receipt-requests\/(?:threads|answers)\/?$|login(?:\/|$)|portal(?:\/|$)|sub-portal(?:\/|$)|share(?:\/|$)|privacy(?:\/|$)|terms(?:\/|$)|account-deletion(?:\/|$)|support(?:\/|$)|_next\/(?:static|image)(?:\/|$)|favicon\.ico$|.*\.(?:png|jpg|svg|webmanifest)$)/;

/**
 * The cookie that has to be present before a bypassed tree may dispatch a
 * Server Action at all.
 *
 * Round 48 narrowed the action exception to the two client-facing trees. Round
 * 49 found that still far too wide: action ids are GLOBAL, so `/portal` being
 * allowed to dispatch meant a caller with no session at all could POST any
 * action id in the app to `/portal` and have it run — including staff
 * mutations that authorize nothing themselves (`createCatalogItem` and 76
 * others, now gated; see tests/server-action-gates.test.ts). An action id is
 * not an authorization token: it is a public build artefact.
 *
 * So a dispatch through these trees now requires SESSION EVIDENCE. That is
 * PRESENCE, not validity — the proxy runs on the edge and cannot verify a JWT
 * without the signing secret, and it is not the authorization boundary:
 * every action still authorizes itself (the portal ones through
 * `resolveSessionClientId` / `getSubPortalSession`, which DO verify). What
 * this closes is the anonymous vector: no session evidence at all, no
 * dispatch, anywhere in the bypass.
 *
 * EITHER the tree's own token cookie OR a NextAuth session cookie counts,
 * because `resolveSessionClientId` accepts both: path 1 is a NextAuth
 * session (a client who signs in with Google, or staff previewing the
 * portal) and path 2 is the `client_portal_token` magic-link cookie. An
 * earlier version of this check demanded the magic-link cookie alone, which
 * refused every Google-authenticated client — it broke estimate signing on
 * the portal, which is a client-facing money path. A stale or disabled staff
 * cookie is already rejected above, before this runs.
 */
const ANONYMOUS_ACTION_COOKIE: ReadonlyArray<{ pattern: RegExp; cookie: string }> = [
    { pattern: /^\/portal(?:\/|$)/, cookie: "client_portal_token" },
    { pattern: /^\/sub-portal(?:\/|$)/, cookie: "sub_portal_token" },
];

/**
 * The ONLY bypassed paths allowed to dispatch an anonymous Server Action.
 *
 * Next's action IDs are GLOBAL: a `next-action` POST to any path that reaches
 * the app can invoke any action in the app. The proxy bypass runs BEFORE the
 * route handler, so a route that authenticates inside itself — the ops health
 * reads with their Bearer/staff-session check, the machine-to-machine ingest
 * endpoints — is not the boundary for an action dispatch: its handler never
 * runs at all. This used to be scoped to the four legal pages, which left every
 * other bypassed path (health included) as an open action dispatcher.
 *
 * `portal` and `sub-portal` are the two trees that genuinely serve anonymous
 * actions (25 and 1 files importing actions respectively); those actions
 * authorize through their own client/token checks. `share` imports none, and
 * `login` is a client component that posts to NextAuth, so neither needs it.
 *
 * Kept as the list of trees that MAY dispatch; ANONYMOUS_ACTION_COOKIE above
 * says what each of them must present first.
 */
export const ANONYMOUS_ACTION_PATTERN = /^\/(?:portal|sub-portal)(?:\/|$)/;

/**
 * Is this an action dispatch?
 *
 * The header is what Next actually routes on. The content-type is
 * belt-and-braces: no legitimate client sends `text/x-component` on a REQUEST,
 * so treating it as an action keeps a future dispatch shape from arriving
 * through a path that only ever inspected the header.
 */
export function isServerActionRequest(req: any): boolean {
    if (typeof req?.headers?.get?.("next-action") === "string") return true;
    const contentType = req?.headers?.get?.("content-type");
    return typeof contentType === "string" && contentType.toLowerCase().includes("text/x-component");
}

// Test-only action dispatchers that get the proxy bypass below. Explicit, not a
// prefix match: the proxy checks only the environment gates, never the route's
// `x-e2e-secret`, so a prefix would silently extend that bypass to any future
// /api/test-only/* file before anyone reviewed its own gates. Each route here
// implements the identical four gates internally.
const TEST_ONLY_DISPATCHER_PATHS = new Set([
    "/api/test-only/contract-actions",
    "/api/test-only/portal-estimate-actions",
]);

/**
 * True for a path that skips the proxy AND may never dispatch a Server Action.
 *
 * Expressed against the ALLOWLIST above rather than a list of its own. It used
 * to be a denylist of machine endpoints, which is the wrong shape for a global
 * action namespace — every bypassed path nobody thought to list was a live
 * anonymous dispatcher — and keeping a second list here would reintroduce
 * exactly that: two rules, drifting, with the safe-looking one out of date.
 *
 * A named export rather than an inline `.test()` so the rule can be asserted
 * directly — a guard nobody can call is a guard nobody can prove.
 */
export function isMachineOnlyBypass(pathname: string) {
    return PUBLIC_PROXY_BYPASS_PATTERN.test(pathname)
        && !ANONYMOUS_ACTION_PATTERN.test(pathname);
}

export function isPublicProxyBypass(pathname: string) {
    return PUBLIC_PROXY_BYPASS_PATTERN.test(pathname);
}

/** True when the route handler at `pathname` verifies mobile Bearer tokens itself. */
export function isMobileAuthenticatedRoute(pathname: string) {
    return MOBILE_AUTHENTICATED_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

/**
 * May this bypassed path dispatch a Server Action at all?
 *
 * Exported so it can be tested directly: reaching this branch through the
 * whole proxy requires a real signed NextAuth JWT (the stale-staff-cookie check
 * above decodes one), which a unit test cannot mint, so a test driven only
 * through the front door could never exercise the NextAuth arm of this rule.
 * The rule itself is the part worth pinning.
 *
 * EITHER the tree's own token cookie OR a NextAuth session cookie counts,
 * because `resolveSessionClientId` accepts both: path 1 is a NextAuth session
 * (a client who signs in with Google, or staff previewing the portal) and path
 * 2 is the `client_portal_token` magic-link cookie. An earlier version demanded
 * the magic-link cookie alone, which refused every Google-authenticated client
 * and broke estimate SIGNING on the portal — a client-facing money path.
 */
/**
 * The refusal a BLOCKED action dispatch gets, and why it is distinguishable.
 *
 * `e2e/financial-action-auth.spec.ts` proves that an unauthenticated caller
 * cannot run privileged actions. That proof only means something if a DENIAL
 * can be told apart from Next answering "I have never heard of that action id"
 * — otherwise a typo in an action id would look exactly like a successful
 * defence, and the whole block would pass while proving nothing.
 *
 * Next signals the unknown-id case itself (404, "Failed to find Server
 * Action"). This refusal happens EARLIER, at the edge, before Next sees the id
 * at all, so it says so explicitly rather than returning a bare 403 that could
 * be mistaken for an action's own authorization error.
 */
export const SERVER_ACTION_BLOCKED_REASON = "server-action-blocked";

function serverActionBlocked() {
    return new NextResponse(SERVER_ACTION_BLOCKED_REASON, {
        status: 403,
        headers: { "x-probuild-refusal": SERVER_ACTION_BLOCKED_REASON },
    });
}

export function mayDispatchAction(req: any, pathname: string): boolean {
    const tree = ANONYMOUS_ACTION_COOKIE.find((t) => t.pattern.test(pathname));
    if (!tree) return false;
    if (req?.cookies?.get?.(tree.cookie)?.value) return true;
    return hasNextAuthSessionCookie(req);
}

function hasNextAuthSessionCookie(req: any) {
    const requestCookies = req.cookies?.getAll?.() ?? [];
    return requestCookies.some(({ name }: { name: string }) =>
        name === "next-auth.session-token"
        || name.startsWith("next-auth.session-token.")
        || name === "__Secure-next-auth.session-token"
        || name.startsWith("__Secure-next-auth.session-token.")
    );
}

export default async function proxy(req: any, event: any) {
    const pathname = req.nextUrl?.pathname;
    const isServerAction = isServerActionRequest(req);

    // FIRST, before every other branch including the development bypass.
    //
    // Next's action IDs are GLOBAL, so any path the proxy waves through is a
    // place an anonymous caller can POST a `next-action` header and have Next
    // dispatch someone else's action — the endpoint's own shared-secret check
    // never runs for an action dispatch, so its gate protects nothing. This has
    // to be evaluated BEFORE any bypass returns `next()`, and the dev bypass is
    // the earliest of those: it returns for everything, so a check placed after
    // it is simply absent in development. Ordinary page/API Server Actions are
    // untouched — only machine endpoints are refused.
    if (isServerAction && typeof pathname === "string" && isMachineOnlyBypass(pathname)) {
        return new NextResponse("Forbidden", { status: 403 });
    }

    // Bypass authentication entirely during development for local testing
    if (process.env.NODE_ENV === 'development') {
        // Allow all requests to pass through without authentication in development
        // The client-side AppLayout will then mock the session.
        return NextResponse.next();
    }

    // Public portal routes must remain reachable without a staff session, but a
    // stale staff cookie must never use those routes to bypass the production
    // auth matcher and replay a Server Action. Anonymous portal actions still
    // authorize through their own client/token checks inside the action.
    if (isServerAction && hasNextAuthSessionCookie(req)) {
        const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
        if (!token?.email || (token as any).accountDisabled === true || !await isStaffAccountEnabled(token.email)) {
            return new NextResponse("Forbidden", { status: 403 });
        }
    }

    // Test-only action dispatchers (src/app/api/test-only/*/route.ts — currently
    // contract-actions and portal-estimate-actions). They exist so an
    // UNAUTHENTICATED (or otherwise-scoped) request reaches the action itself
    // and is refused by the action's OWN gate — a proxy redirect to /login would
    // prove nothing about that gate, which is exactly what
    // e2e/contract-auth-runtime.spec.ts and the portal-estimate-actions runtime
    // tests in e2e/portal-estimate-access.spec.ts have to pin.
    //
    // The conditions here MUST stay identical to testOnlyRoutesEnabled() in each
    // of those routes, and `!isServerAction` is load-bearing on top of them.
    // Codex flagged the earlier version (contract-actions only): it checked only
    // PLAYWRIGHT_TEST_SECRET while the route also checked VERCEL_ENV, so the two
    // supposedly-matching gates did not match, and it waved through a request
    // carrying a `next-action` header that the checks above had deliberately
    // just scrutinised. An anonymous caller has no session cookie, so the
    // stale-cookie check above does not cover them. Bypassing the proxy is
    // never allowed to also mean bypassing the Server Action boundary.
    //
    // An explicit allowlist, NOT a `/api/test-only/` prefix match. The proxy does
    // not verify `x-e2e-secret` — only the route handlers do — so a prefix match
    // would pre-authorize any future test-only route the moment someone adds the
    // file, before it has been reviewed for gates of its own. Adding a route here
    // is the deliberate step that grants it the bypass.
    if (
        !isServerAction
        && process.env.E2E_TEST_ROUTES === "1"
        && !!process.env.PLAYWRIGHT_TEST_SECRET
        // Affirmative, not merely "not production" — see the same clause in the
        // routes. Every other condition is satisfied by an ABSENT variable, so a
        // self-hosted production server (no VERCEL_ENV) passed them all.
        && (process.env.NODE_ENV !== "production" || process.env.CI === "true")
        && process.env.VERCEL_ENV !== "production"
        && typeof pathname === "string"
        && TEST_ONLY_DISPATCHER_PATHS.has(pathname)
    ) {
        return NextResponse.next();
    }

    // A bypassed path is readable by anyone; that is not the same as being an
    // action endpoint. Refused BEFORE the bypass below, for every bypassed path
    // except the two trees that genuinely serve anonymous actions — otherwise
    // the ops health reads, the webhook and ingest endpoints, the PDF routes and
    // the static legal pages all double as anonymous dispatchers for every
    // action in the app.
    if (isServerAction && typeof pathname === "string" && isPublicProxyBypass(pathname)) {
        // Which tree is this, and does the caller hold its session cookie? A
        // path that is not one of the two client-facing trees can never
        // dispatch; one that is still needs the cookie.
        if (!mayDispatchAction(req, pathname)) {
            return serverActionBlocked();
        }
    }

    if (typeof pathname === "string" && isPublicProxyBypass(pathname)) {
        return NextResponse.next();
    }

    // Approved shared API routes verify mobile JWTs in their own handlers. Do not
    // extend this to arbitrary Bearer requests: many web routes rely on Proxy as
    // their authentication boundary.
    // `!isServerAction` is load-bearing (Codex gate, PR #434): the crew app never
    // dispatches Server Actions, and a Bearer header must not let an anonymous caller
    // replay a global action ID against an allowlisted path — the route handler's token
    // check never runs for an action dispatch.
    const authHeader = req.headers?.get?.("authorization");
    const handlerVerifiesBearer = typeof pathname === "string" && isMobileAuthenticatedRoute(pathname);
    if (
        !isServerAction
        && handlerVerifiesBearer
        && typeof authHeader === "string"
        && authHeader.toLowerCase().startsWith("bearer ")
    ) {
        return NextResponse.next();
    }

    // Existing authentication logic for other environments
    const authMiddleware = withAuth({
        pages: {
            signIn: "/login",
        },
        callbacks: {
            async authorized({ token }) {
                if (!token?.email || token.accountDisabled === true) return false;
                return isStaffAccountEnabled(token.email);
            },
        },
    });

    return authMiddleware(req as any, event);
}

export const config = {
    matcher: [
        {
            source: "/:path*",
            has: [{ type: "header", key: "next-action" }],
        },
        /*
         * Match all request paths except for the ones starting with:
         * - api/auth (NextAuth endpoints)
         * - api/cron (System automated cron tasks)
         * - api/twilio (Twilio webhooks — validated by Twilio signature, not session)
         * - api/webhook (Stripe webhooks)
         * - api/payments (Client portal payment sessions)
         * - api/portal (Public backend handlers for documents)
         * - api/integrations (Machine-to-machine ingest — own shared-secret auth)
         * - api/mcp (ChatGPT MCP connector — own shared-secret auth)
         * - api/health (Exact public web-process deployment/liveness probe)
         * - api/version (Deployment-id probe for the stale-tab refresh banner)
         * - api/selections/item-comments (self-authorizes staff + portal internally)
         * - api/selections/ai-sort (staff-only; self-authorizes, must return a
         *   clean 403 to a portal client rather than a login redirect)
         * - api/selections/link-schedule (staff-only; self-authorizes, same
         *   403-not-redirect requirement as ai-sort)
         * - login (The login page itself)
         * - portal (Client portal, if public/token-based)
         * - sub-portal (Subcontractor portal, magic-link auth)
         * - share (Public token-gated room design viewer)
         * - privacy, terms, account-deletion, support (Public legal/support pages —
         *   the app stores require a logged-out reviewer to be able to load them)
         * - _next/static (Static files)
         * - _next/image (Image optimization)
         * - favicon.ico, public folder images, etc
         * - manifest.webmanifest (PWA manifest — must be fetchable for install)
         */
        "/((?!api/health$|api/health/pipeline$|api/auth|api/cron|api/twilio|api/webhook|api/payments|api/portal|api/integrations|api/mcp/|api/version|api/pdf/estimates(?:/|$)|api/pdf/invoices(?:/|$)|api/pdf/change-orders(?:/|$)|api/sub-portal|api/mobile|api/selections/item-comments|api/selections/ai-sort|api/selections/link-schedule|login|portal|sub-portal|share|privacy|terms|account-deletion|support|_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg|.*\\.webmanifest).*)",
    ],
};

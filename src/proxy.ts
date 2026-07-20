import { withAuth } from "next-auth/middleware";
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
    /^\/api\/time-entries(?:\/[^/]+)?\/?$/,
    /^\/api\/files\/(?:signed-upload|register)\/?$/,
    /^\/api\/(?:expenses|receipts\/parse)\/?$/,
    /^\/api\/rooms\/scan-import\/?$/,
    /^\/api\/rooms\/[^/]+\/(?:usdz|ai-furnish)\/?$/,
    /^\/api\/projects\/?$/,
    /^\/api\/projects\/[^/]+\/(?:cost-codes|buckets|estimate-items|estimates)\/?$/,
];

export default async function middleware(req: any, event: any) {
    // Bypass authentication entirely during development for local testing
    if (process.env.NODE_ENV === 'development') {
        // Allow all requests to pass through without authentication in development
        // The client-side AppLayout will then mock the session.
        return NextResponse.next();
    }

    // Approved shared API routes verify mobile JWTs in their own handlers. Do not
    // extend this to arbitrary Bearer requests: many web routes rely on Proxy as
    // their authentication boundary.
    const authHeader = req.headers?.get?.("authorization");
    const pathname = req.nextUrl?.pathname;
    const handlerVerifiesBearer = typeof pathname === "string"
        && MOBILE_AUTHENTICATED_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
    if (
        handlerVerifiesBearer
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
         * - api/version (Deployment-id probe for the stale-tab refresh banner)
         * - login (The login page itself)
         * - portal (Client portal, if public/token-based)
         * - sub-portal (Subcontractor portal, magic-link auth)
         * - share (Public token-gated room design viewer)
         * - _next/static (Static files)
         * - _next/image (Image optimization)
         * - favicon.ico, public folder images, etc
         * - manifest.webmanifest (PWA manifest — must be fetchable for install)
         */
        "/((?!api/auth|api/cron|api/twilio|api/webhook|api/payments|api/portal|api/integrations|api/mcp/|api/version|api/pdf/estimates|api/pdf/invoices|api/sub-portal|api/mobile|login|portal|sub-portal|share|_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg|.*\\.webmanifest).*)",
    ],
};

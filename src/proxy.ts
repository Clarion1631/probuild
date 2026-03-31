import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default async function middleware(req: any, event: any) {
    // Bypass authentication entirely during development for local testing
    if (process.env.NODE_ENV === 'development') {
        // Allow all requests to pass through without authentication in development
        // The client-side AppLayout will then mock the session.
        return NextResponse.next();
    }

    // Existing authentication logic for other environments
    const authMiddleware = withAuth({
        pages: {
            signIn: "/login",
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
         * - api/webhook (Stripe webhooks)
         * - api/payments (Client portal payment sessions)
         * - api/portal (Public backend handlers for documents)
         * - login (The login page itself)
         * - portal (Client portal, if public/token-based)
         * - sub-portal (Subcontractor portal, magic-link auth)
         * - _next/static (Static files)
         * - _next/image (Image optimization)
         * - favicon.ico, public folder images, etc
         */
        "/((?!api/auth|api/cron|api/webhook|api/payments|api/portal|api/sub-portal|login|portal|sub-portal|_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg).*)",
    ],
};

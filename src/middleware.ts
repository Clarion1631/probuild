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
         * - api/webhook (Stripe webhooks)
         * - api/payments (Client portal payment sessions)
         * - login (The login page itself)
         * - portal (Client portal, if public/token-based)
         * - _next/static (Static files)
         * - _next/image (Image optimization)
         * - favicon.ico, public folder images, etc
         */
        "/((?!api/auth|api/webhook|api/payments|login|portal|_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg).*)",
    ],
};

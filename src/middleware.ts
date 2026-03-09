import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default async function middleware(req: any) {
    // Bypass authentication entirely during development for local testing
    if (process.env.NODE_ENV === 'development') {
        // Allow all requests to pass through without authentication in development
        // The client-side AppLayout will then mock the session.
        return NextResponse.next();
    }

    // Existing authentication logic for other environments
    return withAuth({
        pages: {
            signIn: "/login",
        },
    })(req);
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - api/auth (NextAuth endpoints)
         * - api/public (if you have any public APIs)
         * - login (The login page itself)
         * - portal (Client portal, if public/token-based)
         * - _next/static (Static files)
         * - _next/image (Image optimization)
         * - favicon.ico, public folder images, etc
         */
        "/((?!api/auth|api/webhook|login|portal|_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg).*)",
    ],
};

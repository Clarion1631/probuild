import { withAuth } from "next-auth/middleware";

export default withAuth({
    pages: {
        signIn: "/login",
    },
});

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
